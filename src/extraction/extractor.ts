import { z } from "zod";
import type { PersonId } from "../config";
import type { NodeDomain } from "../ledger/ledger";
import { normalizeSubdomain } from "../ontology/normalize";
import { ALL_DOMAINS } from "../ontology/types";
import { nearestPrior, NEAR_DUPLICATE_THRESHOLD } from "../eval/novelty";
import type { LlmClient } from "../llm/types";
import { ALL_FAMILIES, type Family } from "../selection/types";
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
 * guards below resolve the ambiguity before a caller ever sees it. `family`
 * and `eventDate` on the newNode variant are the node's founding values
 * (2026-08-02 synthesis design's "Event dates" and "Families" sections);
 * they are only meaningful the moment a node is created, so they live here
 * rather than as a top-level ExtractedFact field. */
export type FactTarget =
  | { nodeId: number }
  | {
      newNode: {
        domain: NodeDomain;
        subdomain: string;
        summary: string;
        family: Family | null;
        eventDate: string | null;
      };
    };

export interface ExtractedFact {
  kind: "fact" | "thread" | "interest";
  text: string;
  target: FactTarget;
  /** The register this OBSERVATION carries (spec "Families"), independent
   * of whether its target is new or existing: bounded extractor judgment,
   * enum-validated against ALL_FAMILIES, retried once on invalidity, then
   * null with a loud log rather than dropping the observation. */
  family: Family | null;
  /** Resolved absolute date of a genuinely dated occurrence this
   * observation describes (spec "Event dates"), or null. Falls back to the
   * target's own newNode.eventDate when this field is absent but the
   * observation is what created the node, so a date attached only at
   * node-creation time is never lost. */
  eventDate: string | null;
  /** 0-2 additional subjects this fact is also genuinely about (spec
   * "Families": the psychic-party example - Cora AND psychic-readings AND
   * the car). Resolved through the identical nodeId/newNode target
   * machinery as the primary target, deduped against it and against each
   * other. Almost always empty: most facts belong to exactly one subject. */
  alsoAbout: FactTarget[];
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
  // Nullable AND optional: a model that consciously judges "no confident
  // family" writes null, a model that omits the field entirely (older
  // prompt version, or just forgot) is treated identically. Same shape as
  // the observation-level field below, by design (see FactTarget's doc).
  family: z.string().nullable().optional(),
  eventDate: z.string().nullable().optional(),
});

// The same nodeId/newNode shape as a fact observation's own target, used for
// "alsoAbout" entries. Deliberately unbounded here (no .max(2)): capping via
// zod would fail the ENTIRE parent observation's safeParse over one stray
// third entry, discarding real facts over a soft-cap violation. The cap is
// enforced in code instead, by truncating with a log (see the main loop).
const rawAlsoAboutTargetSchema = z.object({
  nodeId: z.number().optional(),
  newNode: rawNewNodeSchema.optional(),
});

// Loose on purpose: extra keys (a leftover "topic" from an old prompt
// version, say) must not fail an otherwise-valid item. Domain and family
// membership are checked in code, not here, because both get a dedicated
// validation-retry path distinct from this malformed-JSON retry.
const rawObservationSchema = z.object({
  type: z.enum(["fact", "thread", "interest", "mood_signal", "prompt_preference"]),
  text: z.string().min(1),
  nodeId: z.number().optional(),
  newNode: rawNewNodeSchema.optional(),
  family: z.string().nullable().optional(),
  eventDate: z.string().nullable().optional(),
  alsoAbout: z.array(rawAlsoAboutTargetSchema).optional(),
});

type RawObservation = z.infer<typeof rawObservationSchema>;
type RawTarget = z.infer<typeof rawAlsoAboutTargetSchema>;

const responseSchema = z.object({
  observations: z.array(z.unknown()),
  promptIdeas: z.array(z.unknown()).optional(),
});

const MAX_ATTEMPTS = 3;
const MAX_ALSO_ABOUT = 2;
const FACT_KINDS = new Set(["fact", "thread", "interest"]);

function isValidDomain(domain: string): domain is NodeDomain {
  return (ALL_DOMAINS as string[]).includes(domain);
}

function isValidFamily(family: string): family is Family {
  return (ALL_FAMILIES as readonly string[]).includes(family);
}

/** Validates a raw family string against the closed vocabulary, degrading to
 * null with a loud log rather than dropping the observation that carries it
 * (family is a soft classification signal, not a fileability requirement,
 * unlike an invalid domain on a newNode which makes the item unfileable). */
function normalizeFamily(
  raw: string | null | undefined,
  context: string,
  log: (msg: string) => void,
): Family | null {
  if (raw === null || raw === undefined) return null;
  if (isValidFamily(raw)) return raw;
  log(`extractor: family "${raw}" invalid for ${context}, defaulting to null`);
  return null;
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
  family: Family | null;
  eventDate: string | null;
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

/** Equality for two resolved FactTargets, used to dedup alsoAbout against
 * the primary target and against itself. Two `newNode` targets are equal by
 * OBJECT REFERENCE, not deep equality: resolveTarget already collapses every
 * near-duplicate newNode proposal within one response onto a single shared
 * VirtualNode object (real or virtual exact-match, or the nearestPrior
 * check), so two independently-resolved targets naming the "same" new
 * subject are guaranteed to point at the identical object by the time this
 * runs. */
function targetsEqual(a: FactTarget, b: FactTarget): boolean {
  if ("nodeId" in a && "nodeId" in b) return a.nodeId === b.nodeId;
  if ("newNode" in a && "newNode" in b) return a.newNode === b.newNode;
  return false;
}

/** Resolves one fact-kind item's target against the closed vocabulary and
 * this response's in-progress new nodes. Returns null to drop the item.
 * Order matters: normalize first, then an exact normalized-subdomain match
 * (real or virtual) attaches immediately - a UNIQUE(person, subdomain)
 * collision can never become a second node - and only then does the softer
 * nearestPrior semantic check run. */
function resolveTarget(
  item: RawTarget,
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

  const family = normalizeFamily(item.newNode.family, `newNode "${subdomain}"`, log);
  const eventDate = item.newNode.eventDate ?? null;
  const created: VirtualNode = { domain, subdomain, summary, family, eventDate };
  virtualNodes.push(created);
  return { newNode: created };
}

function hasInvalidDomainItem(observations: unknown[]): boolean {
  for (const raw of observations) {
    const parsed = rawObservationSchema.safeParse(raw);
    if (!parsed.success) continue;
    if (parsed.data.newNode !== undefined && !isValidDomain(parsed.data.newNode.domain)) return true;
    for (const also of parsed.data.alsoAbout ?? []) {
      if (also.newNode !== undefined && !isValidDomain(also.newNode.domain)) return true;
    }
  }
  return false;
}

/** Mirrors hasInvalidDomainItem, but for family: checks the observation's
 * own family, its newNode's family (if creating), and every alsoAbout
 * entry's newNode family. Triggers the ONE dedicated whole-call retry
 * (spec deliverable 1); unlike an invalid domain this never drops an item,
 * it only decides whether the retry is worth spending. */
function hasInvalidFamilyItem(observations: unknown[]): boolean {
  for (const raw of observations) {
    const parsed = rawObservationSchema.safeParse(raw);
    if (!parsed.success) continue;
    const d = parsed.data;
    if (d.family != null && !isValidFamily(d.family)) return true;
    if (d.newNode?.family != null && !isValidFamily(d.newNode.family)) return true;
    for (const also of d.alsoAbout ?? []) {
      if (also.newNode?.family != null && !isValidFamily(also.newNode.family)) return true;
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

    // Family's own dedicated whole-call retry (spec deliverable 1),
    // structurally mirroring the domain retry above but a distinct pass:
    // an item can have a perfectly valid domain and still name a family
    // outside the closed fifteen. Runs regardless of whether the domain
    // retry already fired, since the two check unrelated fields.
    if (hasInvalidFamilyItem(rawObservations)) {
      const retryRaw = await llm.complete(EXTRACTION_SYSTEM_PROMPT, userPrompt);
      try {
        const retryParsed = JSON.parse(retryRaw);
        const retryShaped = responseSchema.safeParse(retryParsed);
        if (retryShaped.success) {
          rawObservations = retryShaped.data.observations;
          rawPromptIdeas = retryShaped.data.promptIdeas ?? rawPromptIdeas;
        }
        // else: retry unusable; fall through, per-item family normalization
        // below degrades any still-invalid family to null rather than
        // dropping the observation.
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
        // mood_signal / prompt_preference: never subjects, never targeted,
        // and never carry family/eventDate/alsoAbout either - those are not
        // subjects in this person's life (spec deliverable 1: "mood_signal/
        // prompt_preference never carry any of these").
        if (
          result.data.nodeId !== undefined ||
          result.data.newNode !== undefined ||
          result.data.family != null ||
          result.data.eventDate != null ||
          (result.data.alsoAbout?.length ?? 0) > 0
        ) {
          log(`extractor: ignoring node target/family/eventDate/alsoAbout on ${result.data.type} item (not a subject)`);
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

      const family = normalizeFamily(result.data.family, `observation "${result.data.text.slice(0, 40)}"`, log);

      // eventDate falls back to the newNode's own eventDate when the
      // observation didn't repeat it: the field that actually creates the
      // node is the one that must not lose a date attached only there.
      const eventDate =
        result.data.eventDate ?? ("newNode" in target ? target.newNode.eventDate : null);

      let alsoAboutRaw = result.data.alsoAbout ?? [];
      if (alsoAboutRaw.length > MAX_ALSO_ABOUT) {
        log(`extractor: alsoAbout had ${alsoAboutRaw.length} entries, truncating to ${MAX_ALSO_ABOUT}`);
        alsoAboutRaw = alsoAboutRaw.slice(0, MAX_ALSO_ABOUT);
      }
      const alsoAbout: FactTarget[] = [];
      for (const alsoItem of alsoAboutRaw) {
        const alsoTarget = resolveTarget(alsoItem, input, virtualNodes, log);
        if (alsoTarget === null) continue;
        if (targetsEqual(alsoTarget, target)) continue; // dedup against the primary target
        if (alsoAbout.some((existing) => targetsEqual(existing, alsoTarget))) continue; // dedup within alsoAbout
        alsoAbout.push(alsoTarget);
      }

      facts.push({
        kind: result.data.type as "fact" | "thread" | "interest",
        text: result.data.text,
        target,
        family,
        eventDate,
        alsoAbout,
      });
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
