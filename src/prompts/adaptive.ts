import { z } from "zod";
import type { PersonId } from "../config";
import type { Ledger } from "../ledger/ledger";
import type { LlmClient } from "../llm/types";
import type { Memory } from "../memory/types";
import { addDays } from "../scheduler";
import { recentFeedbackByPerson } from "./feedback";
import { ADAPTIVE_SYSTEM_PROMPT, buildGenerationUserPrompt } from "./generationPrompt";
import { recentPromptHistory } from "./history";
import { decideStance, stanceForPerson, type Stance } from "./stance";
import { NEAR_DUPLICATE_THRESHOLD, nearestPrior } from "../eval/novelty";
import type { DailyPrompts, PromptSource } from "./types";

export interface AdaptivePromptSourceOptions {
  model: string;
  historyWindowDays: number;
  feedbackWindowDays: number;
  contextBudgetChars: number;
  names: Record<PersonId, string>;
}

const personSchema = z.object({
  prompt: z.string().min(1).max(300),
  // Required, not optional: forcing the generator to commit to a stance is
  // the mechanism that makes the explore/exploit ratio measurable at all.
  stance: z.enum(["explore", "exploit"]),
});

const responseSchema = z.object({
  theme: z.string().min(1).max(120).nullable().optional(),
  a: personSchema,
  b: personSchema,
  rationale: z.string().min(1),
  usedIdeaId: z.number().nullable().optional(),
});

const MAX_ATTEMPTS = 2;

/** Generates the day's two prompts, one per person, from one LLM call over
 * both people's memory context, coverage, recent history, and
 * feedback/prompt ideas. Throws on any failure (LLM outage, malformed
 * response, memory backend down) rather than degrading itself, the caller
 * (FallbackPromptSource) is what degrades. Never calls itself "the
 * fallback"; it has none. */
export class AdaptivePromptSource implements PromptSource {
  constructor(
    private readonly memory: Memory,
    private readonly llm: LlmClient,
    private readonly ledger: Ledger,
    private readonly opts: AdaptivePromptSourceOptions,
  ) {}

  async nextPrompts(date: string): Promise<DailyPrompts> {
    const feedbackWindowStart = addDays(date, -this.opts.feedbackWindowDays);

    const [contextA, contextB, coverageA, coverageB] = await Promise.all([
      this.memory.getContext("a", this.opts.contextBudgetChars),
      this.memory.getContext("b", this.opts.contextBudgetChars),
      this.memory.getCoverage("a"),
      this.memory.getCoverage("b"),
    ]);

    const history = recentPromptHistory(this.ledger, date, this.opts.historyWindowDays);
    const feedback = recentFeedbackByPerson(this.ledger, feedbackWindowStart);
    const ideasA = this.ledger.unconsumedPromptIdeas("a").map((i) => ({ id: i.id, text: i.text }));
    const ideasB = this.ledger.unconsumedPromptIdeas("b").map((i) => ({ id: i.id, text: i.text }));

    const dayStance = decideStance({
      recentStances: history.map((h) => h.stance),
      hasThreads: contextA.threads.length > 0 || contextB.threads.length > 0,
    });
    const stanceA: Stance = stanceForPerson(dayStance, contextA.threads.length > 0);
    const stanceB: Stance = stanceForPerson(dayStance, contextB.threads.length > 0);

    const userPrompt = buildGenerationUserPrompt({
      today: date,
      stanceA,
      stanceB,
      names: this.opts.names,
      contextA,
      contextB,
      coverageA,
      coverageB,
      history,
      feedbackA: feedback.a,
      feedbackB: feedback.b,
      ideasA,
      ideasB,
    });

    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const raw = await this.llm.complete(ADAPTIVE_SYSTEM_PROMPT, userPrompt);

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

      // Deterministic repeat guard, per person, since each now has their
      // own history. The system prompt already forbids repeats and the
      // history is right there in the context, and the generator still
      // reproduced a prompt from six days earlier almost verbatim. Retrying
      // costs one call; shipping a duplicate is visible to that person.
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

      const at = new Date().toISOString();
      const theme = shaped.data.theme ?? null;
      this.ledger.recordGeneration({
        date,
        promptId: `gen-${date}-a`,
        promptText: shaped.data.a.prompt,
        model: this.opts.model,
        systemPrompt: ADAPTIVE_SYSTEM_PROMPT,
        userPrompt,
        rawResponse: raw,
        rationale: shaped.data.rationale,
        stance: stanceA, // the assigned stance, which is the ground truth of what was asked for
        person: "a",
        fellBack: false,
        fallbackReason: null,
        at,
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
        stance: stanceB, // the assigned stance, which is the ground truth of what was asked for
        person: "b",
        fellBack: false,
        fallbackReason: null,
        at,
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
