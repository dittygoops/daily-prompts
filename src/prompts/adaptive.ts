import { z } from "zod";
import type { PersonId } from "../config";
import type { Ledger } from "../ledger/ledger";
import type { LlmClient } from "../llm/types";
import type { Candidate, Lane, Selection, SelectionConstants, SelectionInput } from "../selection/types";
import { addDays } from "../scheduler";
import { recentFeedbackByPerson } from "./feedback";
import {
  ADAPTIVE_SYSTEM_PROMPT,
  buildGenerationUserPrompt,
  type AssignedNodeTarget,
  type AssignedTarget,
  type WriterPersonInput,
} from "./generationPrompt";
import { recentPromptHistory } from "./history";
import { NEAR_DUPLICATE_THRESHOLD, nearestPrior, openingStem } from "../eval/novelty";
import type { DailyPrompts, PromptSource } from "./types";

/** The selection module's public surface this package depends on. Injected
 * rather than imported directly from src/selection's implementation files:
 * those (buildSelectionInput, selectPair, the anchor check) are owned by a
 * different package this wave and this file must not touch them, only their
 * fixed shapes in src/selection/types.ts. buildSelectionInput/selectPair are
 * pure functions of (ledger state, date) per the spec, so a caller wires the
 * real module's exports here in production and a fake in tests. */
export interface SelectionDeps {
  buildSelectionInput(date: string): SelectionInput;
  selectPair(input: SelectionInput): Selection;
  /** Spec "the writer's contract": the written question must share at least
   * one content word with its target node's subdomain, summary, or facts
   * (deterministic, reuses contentWords). Seeds are anchored by
   * construction and never passed here. */
  checkAnchor(promptText: string, target: AssignedNodeTarget, minSharedWords: number): boolean;
}

export interface AdaptivePromptSourceOptions {
  model: string;
  historyWindowDays: number;
  feedbackWindowDays: number;
  names: Record<PersonId, string>;
  constants: SelectionConstants;
}

const personSchema = z.object({
  prompt: z.string().min(1).max(300),
  // Exactly one of these matches the assigned target, by strict equality
  // against the Candidate selectPair produced (spec "the writer's
  // contract"): a node id for lanes followup/exploit, a seed id for lane
  // explore. A miss is a rejected generation; a FINAL-attempt miss throws
  // rather than shipping unattributed (impl decision 3).
  targetNodeId: z.number().int().nullable(),
  seedId: z.number().int().nullable(),
});

const responseSchema = z.object({
  theme: z.string().min(1).max(120).nullable().optional(),
  a: personSchema,
  b: personSchema,
  rationale: z.string().min(1),
  usedIdeaId: z.number().nullable().optional(),
});

// Rejection reasons this loop can hit: JSON parse, schema shape, strict
// target mismatch, an anchor miss, a near-duplicate text, a reused opening
// frame, a repeated theme. Four attempts gives every guard a real second
// try without letting a stuck generation burn the LLM budget unbounded.
const MAX_ATTEMPTS = 4;

/** How many recent questions the opening-frame check looks back over. */
const STEM_MEMORY_DAYS = 3;

/** How many recent days' shared angles the theme-repeat guard checks
 * against. Matches the old topic-repeat guard's window; that guard itself
 * is gone (selection's W2-W4 windows now own subject non-repeat), but the
 * day-level theme is still the model's own free text and still repeats. */
const THEME_MEMORY_DAYS = 6;

/** `stance` stays the two-value exploit/explore label recorded to
 * generation_log for backward compatibility (impl decision 4: the
 * finer-grained truth lives in `lane`, which W5's exploit-run cap reads). */
const laneStance = (lane: Lane): "explore" | "exploit" => (lane === "explore" ? "explore" : "exploit");

function nodeTargetFrom(
  ledger: Ledger,
  id: number,
  domain: string,
  family: string | null,
  subdomain: string,
  summary: string,
): AssignedNodeTarget {
  const facts = ledger.nodeFactsFor(id).map((f) => ({ date: f.observedDate, kind: f.kind, text: f.text }));
  return { kind: "node", id, domain, family, subdomain, summary, facts };
}

/** Builds one person's ASSIGNED TARGET from their Candidate. A followup
 * (lane 0) candidate carries only a token, not a SelectableNode (Candidate's
 * own contract: exactly one of node/seed/token is non-null); the token's
 * target IS a node, just gated by the token rather than budget, so its facts
 * are read straight from the ledger by the token's nodeId. */
function assignedTargetFor(ledger: Ledger, person: PersonId, candidate: Candidate): AssignedTarget {
  if (candidate.node !== null) {
    const n = candidate.node;
    return nodeTargetFrom(ledger, n.id, n.domain, n.family, n.subdomain, n.summary);
  }
  if (candidate.token !== null) {
    const node = ledger.nodesFor(person).find((n) => n.id === candidate.token!.nodeId);
    if (!node) {
      throw new Error(
        `AdaptivePromptSource: followup token ${candidate.token.id} references missing node ${candidate.token.nodeId}`,
      );
    }
    return nodeTargetFrom(ledger, node.id, node.domain, node.family, node.subdomain, node.summary);
  }
  if (candidate.seed !== null) {
    return { kind: "seed", id: candidate.seed.id, domain: candidate.seed.domain, family: candidate.seed.family, text: candidate.seed.text };
  }
  // A well-formed Selection always carries one of node/seed/token; a
  // selector bug that ships none is a loud failure here, not a silent null
  // reaching the writer.
  throw new Error(`AdaptivePromptSource: candidate for ${person} carries neither node, token, nor seed`);
}

/** The node id a candidate's declared targetNodeId must strictly equal, for
 * lanes followup/exploit (both target a node; only the eligibility gate
 * differs). Null for lane explore, where the target is a seed instead. */
function expectedNodeId(candidate: Candidate): number | null {
  return candidate.node?.id ?? candidate.token?.nodeId ?? null;
}

/** Generates the day's two prompts, one per person, from one LLM call: code
 * (selectPair) already chose each person's subject, so the model only
 * writes the sentence and echoes back which target it wrote for. Throws on
 * any failure (LLM outage, malformed response, a final-attempt target
 * mismatch) rather than degrading itself; the caller (FallbackPromptSource)
 * is what degrades. Never calls itself "the fallback"; it has none. */
export class AdaptivePromptSource implements PromptSource {
  constructor(
    private readonly selection: SelectionDeps,
    private readonly llm: LlmClient,
    private readonly ledger: Ledger,
    private readonly opts: AdaptivePromptSourceOptions,
  ) {}

  async nextPrompts(date: string): Promise<DailyPrompts> {
    const selectionInput = this.selection.buildSelectionInput(date);
    const sel = this.selection.selectPair(selectionInput);

    const feedbackWindowStart = addDays(date, -this.opts.feedbackWindowDays);
    const moodsA = this.ledger.recentSignals("a", "mood_signal", 7, date).map((s) => `[${s.observedDate}] ${s.text}`);
    const moodsB = this.ledger.recentSignals("b", "mood_signal", 7, date).map((s) => `[${s.observedDate}] ${s.text}`);
    const prefsA = this.ledger.recentSignals("a", "prompt_preference", null, date).map((s) => s.text);
    const prefsB = this.ledger.recentSignals("b", "prompt_preference", null, date).map((s) => s.text);
    const feedback = recentFeedbackByPerson(this.ledger, feedbackWindowStart);
    const ideasA = this.ledger.unconsumedPromptIdeas("a").map((i) => ({ id: i.id, text: i.text }));
    const ideasB = this.ledger.unconsumedPromptIdeas("b").map((i) => ({ id: i.id, text: i.text }));

    const history = recentPromptHistory(this.ledger, date, this.opts.historyWindowDays);
    const recentThemes = this.ledger.recentThemes(THEME_MEMORY_DAYS);

    const targetA = assignedTargetFor(this.ledger, "a", sel.a);
    const targetB = assignedTargetFor(this.ledger, "b", sel.b);

    const writerA: WriterPersonInput = {
      name: this.opts.names.a,
      lane: sel.a.lane,
      target: targetA,
      background: sel.background.a,
      moods: moodsA,
      prefs: prefsA,
      feedback: feedback.a,
      ideas: ideasA,
    };
    const writerB: WriterPersonInput = {
      name: this.opts.names.b,
      lane: sel.b.lane,
      target: targetB,
      background: sel.background.b,
      moods: moodsB,
      prefs: prefsB,
      feedback: feedback.b,
      ideas: ideasB,
    };

    const userPrompt = buildGenerationUserPrompt({
      today: date,
      a: writerA,
      b: writerB,
      history,
      recentThemes,
    });

    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      // A blind retry reuses the identical prompt and hopes sampling saves
      // it; telling the model why it was rejected is what makes a retry
      // better than a reroll.
      const attemptPrompt =
        lastError === null
          ? userPrompt
          : `${userPrompt}\n\nYOUR PREVIOUS ATTEMPT WAS REJECTED: ${lastError.message.replace("AdaptivePromptSource: ", "")}. Correct exactly that and answer again.`;
      const raw = await this.llm.complete(ADAPTIVE_SYSTEM_PROMPT, attemptPrompt);

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        lastError = new Error(`AdaptivePromptSource: LLM response was not valid JSON: ${raw.slice(0, 200)}`);
        continue;
      }
      const shaped = responseSchema.safeParse(parsed);
      if (!shaped.success) {
        lastError = new Error(`AdaptivePromptSource: LLM response missing a valid per-person prompt`);
        continue;
      }

      // Strict-equality target validation. This is THE enforceable link
      // between what code assigned and what the model wrote: a Set-free
      // exact match, not a fuzzy one. On the FINAL attempt a mismatch
      // throws (impl decision 3), replacing the old ship-unattributed path:
      // an unattributed ask corrupts every downstream window (W1-W5, the
      // audits), which is worse than losing the day to the static bank.
      const validateTarget = (
        person: "a" | "b",
        candidate: Candidate,
        decl: { targetNodeId: number | null; seedId: number | null },
      ): string | null => {
        if (candidate.lane === "explore") {
          if (candidate.seed === null) return `person ${person} explore candidate carries no seed (selector bug)`;
          if (decl.seedId !== candidate.seed.id) {
            return `person ${person} declared seedId ${decl.seedId}, assigned target is seed ${candidate.seed.id}`;
          }
          if (decl.targetNodeId !== null) return `person ${person} declared both targetNodeId and seedId`;
        } else {
          const expected = expectedNodeId(candidate);
          if (expected === null) return `person ${person} ${candidate.lane} candidate carries no node (selector bug)`;
          if (decl.targetNodeId !== expected) {
            return `person ${person} declared targetNodeId ${decl.targetNodeId}, assigned target is node ${expected}`;
          }
          if (decl.seedId !== null) return `person ${person} declared both targetNodeId and seedId`;
        }
        return null;
      };
      const targetErrA = validateTarget("a", sel.a, shaped.data.a);
      const targetErrB = validateTarget("b", sel.b, shaped.data.b);
      if (targetErrA !== null || targetErrB !== null) {
        if (attempt < MAX_ATTEMPTS) {
          lastError = new Error(`AdaptivePromptSource: ${targetErrA ?? targetErrB}`);
          continue;
        }
        throw new Error(
          `AdaptivePromptSource: FINAL-attempt target mismatch, refusing to ship unattributed: ${targetErrA ?? targetErrB}`,
        );
      }

      // Anchor check (spec F12, restored): a followup/exploit question must
      // share at least one content word with its target's subdomain,
      // summary, or facts, the structural guard against altitude retreat on
      // exploit days. Seeds are anchored by construction and skipped. A
      // failure retries like any wording guard below (no final-attempt
      // exception, unlike the target check above): the question still ships
      // on the final attempt, just without this guard's blessing.
      const anchorFails = (candidate: Candidate, target: AssignedTarget, prompt: string): boolean =>
        candidate.lane !== "explore" &&
        target.kind === "node" &&
        !this.selection.checkAnchor(prompt, target, this.opts.constants.anchorMinSharedWords);
      const anchorFailA = anchorFails(sel.a, targetA, shaped.data.a.prompt);
      const anchorFailB = anchorFails(sel.b, targetB, shaped.data.b.prompt);
      if ((anchorFailA || anchorFailB) && attempt < MAX_ATTEMPTS) {
        lastError = new Error(
          `AdaptivePromptSource: person ${anchorFailA ? "A" : "B"}'s question shares no content word with its assigned target`,
        );
        continue;
      }

      // Deterministic repeat guard, per person, since each now has their
      // own history. Retrying costs one call; shipping a duplicate is
      // visible to that person.
      const priorTextsA = history.map((h) => h.a.text);
      const priorTextsB = history.map((h) => h.b.text);
      const nearestA = nearestPrior(shaped.data.a.prompt, priorTextsA);
      const nearestB = nearestPrior(shaped.data.b.prompt, priorTextsB);
      const duplicate =
        (nearestA && nearestA.similarity >= NEAR_DUPLICATE_THRESHOLD && { person: "A", match: nearestA }) ||
        (nearestB && nearestB.similarity >= NEAR_DUPLICATE_THRESHOLD && { person: "B", match: nearestB });
      if (duplicate && attempt < MAX_ATTEMPTS) {
        lastError = new Error(
          `AdaptivePromptSource: person ${duplicate.person}'s generated prompt near-duplicates "${duplicate.match.text}" (${duplicate.match.similarity.toFixed(2)})`,
        );
        continue;
      }

      // Repeated shared angle. The two per-person targets can be entirely
      // different subjects while the day's declared theme repeats a recent
      // one almost verbatim.
      const themeText = shaped.data.theme ?? null;
      const nearestTheme = themeText ? nearestPrior(themeText, recentThemes) : null;
      if (nearestTheme && nearestTheme.similarity >= NEAR_DUPLICATE_THRESHOLD && attempt < MAX_ATTEMPTS) {
        lastError = new Error(
          `AdaptivePromptSource: theme "${themeText}" repeats "${nearestTheme.text}" (${nearestTheme.similarity.toFixed(2)})`,
        );
        continue;
      }

      // Reused sentence frame. openingStem exists precisely because
      // content-word overlap cannot see shared scaffolding.
      const recentStemsA = priorTextsA.slice(0, STEM_MEMORY_DAYS).map((t) => openingStem(t));
      const recentStemsB = priorTextsB.slice(0, STEM_MEMORY_DAYS).map((t) => openingStem(t));
      const stemA = openingStem(shaped.data.a.prompt);
      const stemB = openingStem(shaped.data.b.prompt);
      const reusedFrame =
        (recentStemsA.includes(stemA) && { person: "A", stem: stemA }) ||
        (recentStemsB.includes(stemB) && { person: "B", stem: stemB }) ||
        (stemA === stemB && { person: "both", stem: stemA });
      if (reusedFrame && attempt < MAX_ATTEMPTS) {
        lastError = new Error(
          `AdaptivePromptSource: person ${reusedFrame.person} reused the opening frame "${reusedFrame.stem}..."`,
        );
        continue;
      }

      const at = new Date().toISOString();
      const theme = shaped.data.theme ?? null;

      // One transaction where possible (spec deliverable): both people's
      // generation_log rows plus whichever budget/token write their lane
      // requires commit together, so a crash mid-write never leaves one
      // person's ask recorded without its bookkeeping.
      this.ledger.transaction(() => {
        this.ledger.recordGeneration({
          date,
          promptId: `gen-${date}-a`,
          promptText: shaped.data.a.prompt,
          model: this.opts.model,
          systemPrompt: ADAPTIVE_SYSTEM_PROMPT,
          userPrompt,
          rawResponse: raw,
          rationale: shaped.data.rationale,
          stance: laneStance(sel.a.lane),
          topic: null,
          targetNodeId: sel.a.lane === "explore" ? null : expectedNodeId(sel.a),
          targetDomain: null,
          person: "a",
          fellBack: false,
          fallbackReason: null,
          at,
          lane: sel.a.lane,
          seedId: sel.a.lane === "explore" ? (sel.a.seed?.id ?? null) : null,
          askDomain: sel.a.domain,
          askFamily: sel.a.family,
        });
        this.ledger.recordGeneration({
          date,
          promptId: `gen-${date}-b`,
          promptText: shaped.data.b.prompt,
          model: this.opts.model,
          systemPrompt: ADAPTIVE_SYSTEM_PROMPT,
          userPrompt,
          rawResponse: raw,
          rationale: shaped.data.rationale,
          stance: laneStance(sel.b.lane),
          topic: null,
          targetNodeId: sel.b.lane === "explore" ? null : expectedNodeId(sel.b),
          targetDomain: null,
          person: "b",
          fellBack: false,
          fallbackReason: null,
          at,
          lane: sel.b.lane,
          seedId: sel.b.lane === "explore" ? (sel.b.seed?.id ?? null) : null,
          askDomain: sel.b.domain,
          askFamily: sel.b.family,
        });

        // recordAsk for lane-1 (exploit) targets only: a token ask (lane 0)
        // bypasses budget entirely per spec, so it must never decrement it.
        if (sel.a.lane === "exploit" && sel.a.node !== null) this.ledger.recordAsk(sel.a.node.id, date, at);
        if (sel.b.lane === "exploit" && sel.b.node !== null) this.ledger.recordAsk(sel.b.node.id, date, at);
        // spendToken for lane-0 (followup) targets: spend = spent_at in the
        // ask's own transaction (spec).
        if (sel.a.lane === "followup" && sel.a.token !== null) this.ledger.spendToken(sel.a.token.id, at);
        if (sel.b.lane === "followup" && sel.b.token !== null) this.ledger.spendToken(sel.b.token.id, at);
      });

      const usedId = shaped.data.usedIdeaId;
      if (usedId != null) {
        const isUnconsumed = [...ideasA, ...ideasB].some((i) => i.id === usedId);
        if (isUnconsumed) this.ledger.markPromptIdeaUsed(usedId, null, at);
      }

      return {
        theme,
        prompts: {
          a: { id: `gen-${date}-a`, text: shaped.data.a.prompt },
          b: { id: `gen-${date}-b`, text: shaped.data.b.prompt },
        },
      };
    }
    throw lastError!;
  }
}
