import type { PersonId } from "../config";
import type { Ledger } from "../ledger/ledger";
import type { LlmClient } from "../llm/types";
import type { Memory } from "../memory/types";
import { normalizeSubdomain } from "../ontology/normalize";
import { extractObservations, type ExtractedFact, type ExtractionInput } from "./extractor";
import { rewriteNodeSummary } from "./summary";

export interface PipelineDeps {
  ledger: Ledger;
  llm: LlmClient;
  /** Retired by the structured ontology: extraction no longer writes here.
   * Optional only so index.ts (which still constructs one) keeps compiling
   * without an edit; nothing in this file reads it. */
  memory?: Memory;
  log: (msg: string) => void;
  now?: () => string;
  /** Restrict processing to one person's pending work (used by a
   * single-person memory rebuild). Omit to process both. */
  person?: PersonId;
  /** LLM used for the summary-rewrite call. Defaults to `llm`; split out so
   * a cheaper/faster model can be used for the one-sentence rewrite without
   * touching extraction. */
  summaryLlm?: LlmClient;
  /** Called immediately after each person-day is filed, before the next day
   * is extracted. A rebuild attributes yield here rather than from the
   * returned `filings` list, because attribution can deplete a node and
   * addNodeFact reopens a depleted node: doing every attribution after every
   * filing would leave a node depleted that a later day's fact should have
   * reopened. Interleaving keeps replay equivalent to living the days. */
  onFiling?: (filing: DayFiling) => void;
}

/** One person-day's filed material, attributed by node, for a rebuild's
 * argmax attribution pass. Present even for zero-fact days (empty
 * factsByNode) so a rebuild can still walk every processed day in order. */
export interface DayFiling {
  dayId: number;
  person: PersonId;
  date: string;
  factsByNode: Record<number, number>;
  responseChars: number | null;
}

export interface PipelineResult {
  processed: number;
  failed: number;
  filings: DayFiling[];
}

/** Scan the ledger for resolved days with pending extraction work, extract
 * facts/signals/ideas for each, and file them into the graph. Every (day,
 * person) is isolated in its own try/catch so one bad item never blocks the
 * rest of the batch. Retry accounting is entirely the ledger's job (the
 * 3-attempt cap already lives in unprocessedResolvedDays' query); this
 * function only reports outcomes via markExtraction. */
export async function processPending(deps: PipelineDeps): Promise<PipelineResult> {
  const now = deps.now ?? (() => new Date().toISOString());
  const summaryLlm = deps.summaryLlm ?? deps.llm;
  let processed = 0;
  let failed = 0;
  const filings: DayFiling[] = [];

  for (const { dayId, person } of deps.ledger.unprocessedResolvedDays(deps.person)) {
    try {
      const { input, responseChars } = buildInput(deps.ledger, dayId, person);
      const { facts, signals, promptIdeas } = await extractObservations(input, deps.llm, deps.log);

      // Committed synchronously before this line returns: an LLM call must
      // never sit inside a sync sqlite transaction, so summary rewrites
      // happen strictly after filing, never inside fileExtraction.
      const factsByNode = fileExtraction(deps.ledger, dayId, person, input.date, facts, signals, promptIdeas, now);

      deps.log(
        `extracted day ${dayId} person ${person}: ${facts.length} facts, ${signals.length} signals, ${promptIdeas.length} prompt ideas`,
      );
      processed++;
      const filing: DayFiling = { dayId, person, date: input.date, factsByNode, responseChars };
      filings.push(filing);

      await maybeRewriteSummaries(deps.ledger, person, input.date, factsByNode, summaryLlm, deps.log, now);
      deps.onFiling?.(filing);
    } catch (err) {
      deps.ledger.markExtraction(dayId, person, "failed", null, now());
      deps.log(`EXTRACTION FAILED day ${dayId} person ${person}: ${err}`);
      failed++;
    }
  }

  return { processed, failed, filings };
}

/** For each node that received facts this day: rewrite its summary if the
 * fact count just crossed the richness threshold (3), or if it has an
 * event_date already in the past (a closed event's material deserves a
 * settled summary, not the live-in-progress wording). Own try/catch per
 * node: a failed rewrite must never fail an already-committed extraction. */
async function maybeRewriteSummaries(
  ledger: Ledger,
  person: PersonId,
  date: string,
  factsByNode: Record<number, number>,
  summaryLlm: LlmClient,
  log: (msg: string) => void,
  now: () => string,
): Promise<void> {
  const SUMMARY_REWRITE_AT_FACTS = 3;
  const nodes = ledger.nodesFor(person);
  for (const [key, addedCount] of Object.entries(factsByNode)) {
    const nodeId = Number(key);
    try {
      const node = nodes.find((n) => n.id === nodeId);
      if (!node) continue;
      const totalCount = ledger.nodeFactCount(nodeId);
      const countBefore = totalCount - addedCount;
      const crossedRichness = countBefore < SUMMARY_REWRITE_AT_FACTS && totalCount >= SUMMARY_REWRITE_AT_FACTS;
      const eventAlreadyPassed = node.eventDate !== null && node.eventDate < date;
      if (!crossedRichness && !eventAlreadyPassed) continue;

      const facts = ledger.nodeFactsFor(nodeId).map((f) => ({ date: f.observedDate, text: f.text }));
      const newSummary = await rewriteNodeSummary(
        { id: node.id, domain: node.domain, subdomain: node.subdomain, summary: node.summary },
        facts,
        summaryLlm,
        log,
      );
      ledger.updateNodeSummary(nodeId, newSummary, now());
    } catch (err) {
      log(`SUMMARY REWRITE FAILED node ${nodeId}: ${err}`);
    }
  }
}

/** Files one person-day's extracted material and marks extraction done, all
 * inside one transaction: a crash mid-way must leave the day still pending
 * with nothing filed, never half a day's facts land. Returns per-node fact
 * counts for the caller's filings entry (a rebuild's attribution pass). */
function fileExtraction(
  ledger: Ledger,
  dayId: number,
  person: PersonId,
  date: string,
  facts: ExtractedFact[],
  signals: { kind: "mood_signal" | "prompt_preference"; text: string }[],
  promptIdeas: string[],
  now: () => string,
): Record<number, number> {
  return ledger.transaction(() => {
    const at = now();
    const factsByNode: Record<number, number> = {};
    // Belt-and-braces exact-key dedup: the extractor already collapses
    // near-duplicate newNode proposals within its own response, but this
    // guards the actual UNIQUE(person, subdomain) constraint, which would
    // otherwise throw on two facts naming the same new subject.
    const createdThisTransaction = new Map<string, number>();

    for (const fact of facts) {
      let nodeId: number;
      if ("nodeId" in fact.target) {
        nodeId = fact.target.nodeId;
      } else {
        const subdomain = normalizeSubdomain(fact.target.newNode.subdomain);
        const existing = createdThisTransaction.get(subdomain);
        if (existing !== undefined) {
          nodeId = existing;
        } else {
          nodeId = ledger.createNode({
            person,
            domain: fact.target.newNode.domain,
            subdomain: fact.target.newNode.subdomain,
            summary: fact.target.newNode.summary,
            eventDate: null,
            at,
          });
          createdThisTransaction.set(subdomain, nodeId);
        }
      }
      ledger.addNodeFact({ nodeId, kind: fact.kind, text: fact.text, sourceDayId: dayId, observedDate: date, at });
      factsByNode[nodeId] = (factsByNode[nodeId] ?? 0) + 1;
    }

    for (const signal of signals) {
      ledger.addSignal({ person, kind: signal.kind, text: signal.text, observedDate: date, at });
    }

    for (const idea of promptIdeas) {
      ledger.addPromptIdea(person, idea, dayId, at);
    }

    // Comparable to the old memory-backed count: total observations filed.
    ledger.markExtraction(dayId, person, "done", facts.length + signals.length, at);

    return factsByNode;
  });
}

function buildInput(ledger: Ledger, dayId: number, person: PersonId): { input: ExtractionInput; responseChars: number | null } {
  const day = ledger.day(dayId);
  const personDay = ledger.personDay(dayId, person);
  const feedback = ledger
    .messagesForDay(dayId)
    .filter((m) => m.kind === "feedback" && m.person === person)
    .map((m) => m.text);
  const existingNodes = ledger
    .nodesFor(person)
    .map((n) => ({ id: n.id, domain: n.domain, subdomain: n.subdomain, summary: n.summary }));

  const input: ExtractionInput = {
    dayId,
    date: day.date,
    // The question THIS person was asked. days.prompt_text now holds the
    // day's shared theme, and telling the extractor the theme was the
    // question corrupts its reading of the answer. The fallback covers only
    // rows predating the per-person migration's backfill.
    promptText: personDay.prompt_text ?? day.prompt_text,
    person,
    response: personDay.state === "answered" ? personDay.response_text : null,
    // v0 simplification (accepted, not distinguished): a literal SKIP and a
    // resolved_partial day's never-answered person are both framed to the
    // extractor as "skipped" - the practical difference isn't acted on
    // anywhere downstream yet.
    skipped: personDay.state !== "answered",
    feedback,
    existingNodes,
  };
  const responseChars = personDay.state === "answered" && personDay.response_text !== null ? personDay.response_text.length : null;
  return { input, responseChars };
}
