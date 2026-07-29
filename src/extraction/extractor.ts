import { z } from "zod";
import type { PersonId } from "../config";
import type { NodeDomain } from "../ledger/ledger";
import { normalizeSubdomain } from "../ontology/normalize";
import { ALL_DOMAINS } from "../ontology/types";
import { nearestPrior, NEAR_DUPLICATE_THRESHOLD } from "../eval/novelty";
import type { LlmClient } from "../llm/types";
import { EXTRACTION_SYSTEM_PROMPT, buildUserPrompt } from "./prompt";

/** One node from the person's closed vocabulary, as the extractor sees it.
 * The extractor never invents this list; the pipeline hands it in from
 * `ledger.nodesFor(person)` so the model can only cite ids it was shown. */
export interface ExistingNode {
  id: number;
  domain: NodeDomain;
  subdomain: string;
  summary: string;
}

export interface ExtractionInput {
  dayId: number;
  date: string;
  promptText: string;
  person: PersonId;
  response: string | null;
  skipped: boolean;
  feedback: string[];
  existingNodes: ExistingNode[];
}

/** A fact-kind observation targets either an existing node by id, or asks
 * for a new one. Never both at once by the time this leaves the extractor:
 * guards below resolve the ambiguity before a caller ever sees it. */
export type FactTarget = { nodeId: number } | { newNode: { domain: NodeDomain; subdomain: string; summary: string } };

export interface ExtractedFact {
  kind: "fact" | "thread" | "interest";
  text: string;
  target: FactTarget;
}

/** Moods and preferences are not subjects in a person's life; they never
 * carry a node target, per the ontology spec's split between nodes and
 * signals. */
export interface ExtractedSignal {
  kind: "mood_signal" | "prompt_preference";
  text: string;
}

export interface ExtractionResult {
  facts: ExtractedFact[];
  signals: ExtractedSignal[];
  /** Explicit prompt-idea suggestions found in feedback, e.g. "ask us about
   * our Tokyo trip". Consumed by System 3 into a durable idea queue. */
  promptIdeas: string[];
}

const rawNewNodeSchema = z.object({
  domain: z.string(),
  subdomain: z.string().min(1),
  summary: z.string().min(1),
});

// Loose on purpose: extra keys (a leftover "topic" from an old prompt
// version, say) must not fail an otherwise-valid item. Domain membership in
// ALL_DOMAINS is checked in code, not here, because an invalid domain gets a
// dedicated validation-retry path distinct from this malformed-JSON retry.
const rawObservationSchema = z.object({
  type: z.enum(["fact", "thread", "interest", "mood_signal", "prompt_preference"]),
  text: z.string().min(1),
  nodeId: z.number().optional(),
  newNode: rawNewNodeSchema.optional(),
});

type RawObservation = z.infer<typeof rawObservationSchema>;

const responseSchema = z.object({
  observations: z.array(z.unknown()),
  promptIdeas: z.array(z.unknown()).optional(),
});

const MAX_ATTEMPTS = 3;
const FACT_KINDS = new Set(["fact", "thread", "interest"]);

function isValidDomain(domain: string): domain is NodeDomain {
  return (ALL_DOMAINS as string[]).includes(domain);
}

/** A node proposed for creation earlier in the same extraction response.
 * Not yet a real node (no id: the pipeline creates it inside its filing
 * transaction), but it must still collapse near-duplicate proposals within
 * one response, or two facts about the same new subject would create two
 * nodes before the pipeline's exact-key dedup ever gets a chance to run. */
interface VirtualNode {
  domain: NodeDomain;
  subdomain: string;
  summary: string;
}

export const MAX_NODE_SUMMARY_CHARS = 140;

function clampSummary(raw: string, log: (msg: string) => void): string {
  const summary = raw.trim();
  if (summary.length <= MAX_NODE_SUMMARY_CHARS) return summary;
  // Cut at the last word boundary inside the budget so the stored sentence
  // does not end mid-word.
  const head = summary.slice(0, MAX_NODE_SUMMARY_CHARS);
  const lastSpace = head.lastIndexOf(" ");
  const clamped = lastSpace > MAX_NODE_SUMMARY_CHARS / 2 ? head.slice(0, lastSpace) : head;
  log(`extractor: newNode summary was ${summary.length} chars, clamped to ${clamped.length}`);
  return clamped;
}

/** Resolves one fact-kind item's target against the closed vocabulary and
 * this response's in-progress new nodes. Returns null to drop the item.
 * Order matters: normalize first, then an exact normalized-subdomain match
 * (real or virtual) attaches immediately - a UNIQUE(person, subdomain)
 * collision can never become a second node - and only then does the softer
 * nearestPrior semantic check run. */
function resolveTarget(
  item: RawObservation,
  input: ExtractionInput,
  virtualNodes: VirtualNode[],
  log: (msg: string) => void,
): FactTarget | null {
  const knownIds = new Map(input.existingNodes.map((n) => [n.id, n]));

  if (item.nodeId !== undefined) {
    if (!knownIds.has(item.nodeId)) {
      log(
        `EXTRACTION DROPPED unknown nodeId ${item.nodeId} for person ${input.person} on ${input.date} (day ${input.dayId})`,
      );
      return null;
    }
    if (item.newNode !== undefined) {
      log(`extractor: item carried both nodeId ${item.nodeId} and newNode; keeping nodeId (matching over creating)`);
    }
    return { nodeId: item.nodeId };
  }

  if (item.newNode === undefined) {
    return null; // a fact-kind item with neither target is unfileable
  }

  if (!isValidDomain(item.newNode.domain)) {
    log(
      `EXTRACTION DROPPED newNode with invalid domain "${item.newNode.domain}" for person ${input.person} on ${input.date} (day ${input.dayId})`,
    );
    return null;
  }

  const domain = item.newNode.domain;
  const subdomain = normalizeSubdomain(item.newNode.subdomain);
  // nodes.summary is specified as one sentence <= 140 chars and sqlite has no
  // CHECK enforcing it, so the invariant has to hold here or it holds nowhere.
  // Truncating beats dropping the fact: an overlong summary is cosmetic, and
  // the summary rewrite replaces it once the node reaches three facts anyway.
  const summary = clampSummary(item.newNode.summary, log);

  const existingExact = input.existingNodes.find((n) => n.subdomain === subdomain);
  if (existingExact) {
    log(`extractor: newNode "${subdomain}" collides exactly with existing node ${existingExact.id}, attaching`);
    return { nodeId: existingExact.id };
  }
  const virtualExact = virtualNodes.find((v) => v.subdomain === subdomain);
  if (virtualExact) {
    return { newNode: virtualExact };
  }

  const priors: { text: string; existingId: number | null; virtual: VirtualNode | null }[] = [
    ...input.existingNodes.map((n) => ({ text: `${n.subdomain} ${n.summary}`, existingId: n.id, virtual: null })),
    ...virtualNodes.map((v) => ({ text: `${v.subdomain} ${v.summary}`, existingId: null, virtual: v })),
  ];
  if (priors.length > 0) {
    const candidate = `${subdomain} ${summary}`;
    const match = nearestPrior(candidate, priors.map((p) => p.text), NEAR_DUPLICATE_THRESHOLD);
    if (match && match.isNearDuplicate) {
      const matched = priors.find((p) => p.text === match.text)!;
      if (matched.existingId !== null) {
        log(`extractor: newNode "${subdomain}" near-duplicate of existing node ${matched.existingId}, attaching`);
        return { nodeId: matched.existingId };
      }
      log(`extractor: newNode "${subdomain}" near-duplicate of a node proposed earlier this response, merging`);
      return { newNode: matched.virtual! };
    }
  }

  const created: VirtualNode = { domain, subdomain, summary };
  virtualNodes.push(created);
  return { newNode: created };
}

function hasInvalidDomainItem(observations: unknown[]): boolean {
  for (const raw of observations) {
    const parsed = rawObservationSchema.safeParse(raw);
    if (parsed.success && parsed.data.newNode !== undefined && !isValidDomain(parsed.data.newNode.domain)) {
      return true;
    }
  }
  return false;
}

/** Extract facts, signals and prompt-idea suggestions for one person's day.
 * Never calls the LLM when there is nothing to extract from (skipped, no
 * feedback). A malformed *response* (unparseable JSON, missing the
 * observations array) is retried in-process up to MAX_ATTEMPTS. Separately,
 * a well-formed response containing a newNode with an invalid domain gets
 * exactly one dedicated validation retry of the whole call; if the retry is
 * still invalid, those items are dropped with a loud log rather than
 * retried again or coerced. */
export async function extractObservations(
  input: ExtractionInput,
  llm: LlmClient,
  log: (msg: string) => void = () => {},
): Promise<ExtractionResult> {
  if (input.skipped && input.feedback.length === 0) {
    return { facts: [], signals: [], promptIdeas: [] };
  }

  const userPrompt = buildUserPrompt(input);

  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const raw = await llm.complete(EXTRACTION_SYSTEM_PROMPT, userPrompt);

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      lastError = new Error(`Extractor: LLM response was not valid JSON: ${raw.slice(0, 200)}`);
      continue;
    }
    const shaped = responseSchema.safeParse(parsed);
    if (!shaped.success) {
      lastError = new Error(`Extractor: LLM response missing "observations" array`);
      continue;
    }

    let rawObservations = shaped.data.observations;
    let rawPromptIdeas = shaped.data.promptIdeas ?? [];

    // Distinct, single validation retry: on top of the malformed-JSON retry
    // loop above, not folded into it. A response can be perfectly
    // well-formed JSON and still name a domain outside the fixed skeleton.
    if (hasInvalidDomainItem(rawObservations)) {
      const retryRaw = await llm.complete(EXTRACTION_SYSTEM_PROMPT, userPrompt);
      try {
        const retryParsed = JSON.parse(retryRaw);
        const retryShaped = responseSchema.safeParse(retryParsed);
        if (retryShaped.success) {
          rawObservations = retryShaped.data.observations;
          rawPromptIdeas = retryShaped.data.promptIdeas ?? rawPromptIdeas;
        }
        // else: retry came back unusable; fall through with the original
        // data and let the per-item domain check below drop the bad items.
      } catch {
        // retry wasn't valid JSON either; same fallback as above.
      }
    }

    const virtualNodes: VirtualNode[] = [];
    const facts: ExtractedFact[] = [];
    const signals: ExtractedSignal[] = [];

    for (const item of rawObservations) {
      const result = rawObservationSchema.safeParse(item);
      if (!result.success) continue; // drop individually malformed items

      if (!FACT_KINDS.has(result.data.type)) {
        // mood_signal / prompt_preference: never subjects, never targeted.
        if (result.data.nodeId !== undefined || result.data.newNode !== undefined) {
          log(`extractor: ignoring node target on ${result.data.type} item (not a subject)`);
        }
        if (result.data.type === "prompt_preference" && input.feedback.length === 0) {
          // Zero-trust guard: the caller already knows definitively whether
          // feedback was given; never rely on the model's own judgment.
          continue;
        }
        signals.push({ kind: result.data.type as "mood_signal" | "prompt_preference", text: result.data.text });
        continue;
      }

      const target = resolveTarget(result.data, input, virtualNodes, log);
      if (target === null) continue;
      facts.push({ kind: result.data.type as "fact" | "thread" | "interest", text: result.data.text, target });
    }

    // Same zero-trust guard as prompt_preference: ideas can only come from
    // feedback, never invented from the answer alone.
    const promptIdeas: string[] = [];
    if (input.feedback.length > 0) {
      for (const item of rawPromptIdeas) {
        if (typeof item === "string" && item.trim().length > 0) promptIdeas.push(item);
      }
    }

    return { facts, signals, promptIdeas };
  }
  throw lastError!;
}
