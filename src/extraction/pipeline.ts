import type { PersonId } from "../config";
import type { Ledger } from "../ledger/ledger";
import type { LlmClient } from "../llm/types";
import type { Memory } from "../memory/types";
import { normalizeSubdomain } from "../ontology/normalize";
import { extractObservations, type ExtractedFact, type ExtractionInput, type FactTarget } from "./extractor";
import { rewriteNodeSummary } from "./summary";

type FactKind = "fact" | "thread" | "interest";

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
  /** The 2026-08-02 synthesis design's budgetCap constant (config's
   * selection.budgetCap, default 3). Threaded through as a plain number
   * rather than importing config here, matching this file's existing
   * pattern of taking small numeric knobs as optional deps (see
   * recordYieldForNode's opts) instead of depending on the config module. */
  budgetCap?: number;
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
  const budgetCap = deps.budgetCap ?? 3;
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
      const factsByNode = fileExtraction(deps.ledger, dayId, person, input.date, facts, signals, promptIdeas, now, budgetCap);

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

/** Resolves a FactTarget to a concrete node id, creating the node when it is
 * a `newNode` target not already created earlier in this same transaction.
 * Shared by both a fact's primary target and its `alsoAbout` secondary
 * targets, since node creation/dedup is identical for both (spec: alsoAbout
 * targets are "resolved through the same near-duplicate creation check").
 * `createdThisTransaction` is the belt-and-braces exact-key dedup already in
 * place before this wave: the extractor collapses near-duplicate newNode
 * proposals within its own response, but this guards the actual
 * UNIQUE(person, subdomain) constraint, which would otherwise throw on two
 * facts (primary or alsoAbout) naming the same new subject. `newlyCreated`
 * collects every node id created this transaction, which is what decides
 * later whether grantBudget runs for it (an existing node's budget must
 * never be re-granted). A newly created node with a founding eventDate also
 * mints its follow-up token immediately (spec: "eventDate on newNode sets
 * the node's event_date and mints a token"). */
function resolveNodeId(
  ledger: Ledger,
  person: PersonId,
  target: FactTarget,
  createdThisTransaction: Map<string, number>,
  newlyCreated: Set<number>,
  at: string,
): number {
  if ("nodeId" in target) return target.nodeId;

  const subdomain = normalizeSubdomain(target.newNode.subdomain);
  const existing = createdThisTransaction.get(subdomain);
  if (existing !== undefined) return existing;

  const nodeId = ledger.createNode({
    person,
    domain: target.newNode.domain,
    subdomain: target.newNode.subdomain,
    summary: target.newNode.summary,
    eventDate: target.newNode.eventDate,
    family: target.newNode.family,
    at,
  });
  createdThisTransaction.set(subdomain, nodeId);
  newlyCreated.add(nodeId);
  if (target.newNode.eventDate !== null) {
    ledger.mintToken(nodeId, target.newNode.eventDate, at);
  }
  return nodeId;
}

function addKind(map: Map<number, Set<FactKind>>, nodeId: number, kind: FactKind): void {
  const set = map.get(nodeId) ?? new Set<FactKind>();
  set.add(kind);
  map.set(nodeId, set);
}

/** Files one person-day's extracted material and marks extraction done, all
 * inside one transaction: a crash mid-way must leave the day still pending
 * with nothing filed, never half a day's facts land. Returns per-node fact
 * counts for the caller's filings entry (a rebuild's attribution pass).
 *
 * Also implements the 2026-08-02 synthesis design's Budget dynamics, all in
 * this same transaction (spec deliverable 3):
 *   - grantBudget once per node newly created this filing, from every kind
 *     (primary or secondary home) filed onto it in this transaction.
 *   - secondary homes recorded via addFactSubject.
 *   - eventDate updates the node's event_date and mints a follow-up token,
 *     whether the target is a brand-new node or an existing nodeId.
 *   - refillBudget for every node (primary or secondary home) that received
 *     a new thread-kind fact this filing, any node, targeted or not.
 *   - resolveOpenThreads (which also zeroes budget) for this day's targeted
 *     node when that node received no new thread this filing - read from
 *     the SAME dedup pattern every window/audit uses (recentAsks), so an
 *     abandoned mid-day generation retry can never masquerade as the ask
 *     that was actually sent. */
function fileExtraction(
  ledger: Ledger,
  dayId: number,
  person: PersonId,
  date: string,
  facts: ExtractedFact[],
  signals: { kind: "mood_signal" | "prompt_preference"; text: string }[],
  promptIdeas: string[],
  now: () => string,
  budgetCap: number,
): Record<number, number> {
  return ledger.transaction(() => {
    const at = now();
    const factsByNode: Record<number, number> = {};
    const createdThisTransaction = new Map<string, number>();
    const newlyCreatedNodeIds = new Set<number>();
    const kindsFiledPerNode = new Map<number, Set<FactKind>>();
    const nodesWithNewThread = new Set<number>();

    for (const fact of facts) {
      const primaryNodeId = resolveNodeId(ledger, person, fact.target, createdThisTransaction, newlyCreatedNodeIds, at);
      const factId = ledger.addNodeFact({
        nodeId: primaryNodeId,
        kind: fact.kind,
        text: fact.text,
        sourceDayId: dayId,
        observedDate: date,
        at,
      });
      // factsByNode counts PRIMARY homes only: it feeds nodeFactCount-driven
      // summary-rewrite triggering (maybeRewriteSummaries below), and
      // nodeFactCount itself only counts node_facts.node_id (the primary
      // home), never fact_subjects' secondary homes. Counting a secondary
      // home here would desync this map from the count it is meant to
      // predict.
      factsByNode[primaryNodeId] = (factsByNode[primaryNodeId] ?? 0) + 1;
      addKind(kindsFiledPerNode, primaryNodeId, fact.kind);
      if (fact.kind === "thread") nodesWithNewThread.add(primaryNodeId);

      // fact.eventDate is already the effective date (the extractor falls
      // back to the newNode's own eventDate when the observation didn't
      // repeat it), so this one check covers both a brand-new node's
      // founding date and an existing node's citation of a new date.
      // mintToken is idempotent via its UNIQUE(node_id, event_date)
      // constraint, so calling it again for a node just created with the
      // same date above is a harmless no-op, not a double mint.
      if (fact.eventDate !== null) {
        ledger.setNodeEventDate(primaryNodeId, fact.eventDate, at);
        ledger.mintToken(primaryNodeId, fact.eventDate, at);
      }

      // alsoAbout: secondary homes for this same fact (spec "Families" -
      // the psychic-party example). Deduped against the primary and against
      // each other already by the extractor, but the equality check here is
      // belt-and-braces against a resolveNodeId collapse producing the same
      // id as the primary (e.g. an alsoAbout entry that turns out to be a
      // near-duplicate of the primary's own newNode).
      for (const also of fact.alsoAbout) {
        const secondaryNodeId = resolveNodeId(ledger, person, also, createdThisTransaction, newlyCreatedNodeIds, at);
        if (secondaryNodeId === primaryNodeId) continue;
        ledger.addFactSubject(factId, secondaryNodeId);
        addKind(kindsFiledPerNode, secondaryNodeId, fact.kind);
        if (fact.kind === "thread") nodesWithNewThread.add(secondaryNodeId);
      }
    }

    // Budget grant: once per node newly created this filing, spec: "never
    // 0, thread 3, interest 2, fact-only 1", from ALL kinds filed onto it
    // (primary or secondary) in this same transaction.
    for (const nodeId of newlyCreatedNodeIds) {
      const kinds = [...(kindsFiledPerNode.get(nodeId) ?? [])];
      ledger.grantBudget(nodeId, kinds, budgetCap, at);
    }

    // Refill: any new thread-kind fact on node N, any home, any filing -
    // including a node's own creating filing, where it is a harmless no-op
    // under grantBudget's cap (a freshly granted budget of 3 refilling to
    // min(cap, 3+1) stays 3).
    for (const nodeId of nodesWithNewThread) {
      ledger.refillBudget(nodeId, at, budgetCap);
    }

    // Resolution: this day's generation_log row for this person, read
    // through the exact same dedup (max id, fell_back = 0, person NOT NULL)
    // every window and audit uses, so a stale or fallback generation
    // attempt can never be mistaken for the ask actually sent.
    const askRow = ledger.recentAsks(date).find((r) => r.date === date && r.person === person);
    if (
      askRow &&
      (askRow.lane === "exploit" || askRow.lane === "followup") &&
      askRow.targetNodeId !== null &&
      !nodesWithNewThread.has(askRow.targetNodeId)
    ) {
      ledger.resolveOpenThreads(askRow.targetNodeId, at);
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
