import { z } from "zod";
import type { PersonId } from "../config";
import type { Ledger } from "../ledger/ledger";
import type { LlmClient } from "../llm/types";
import type { Memory } from "../memory/types";
import { addDays } from "../scheduler";
import { recentFeedbackByPerson } from "./feedback";
import { ADAPTIVE_SYSTEM_PROMPT, buildGenerationUserPrompt } from "./generationPrompt";
import { recentPromptHistory } from "./history";
import { decideStance } from "./stance";
import { NEAR_DUPLICATE_THRESHOLD, nearestPrior } from "../eval/novelty";
import type { Prompt, PromptSource } from "./types";

export interface AdaptivePromptSourceOptions {
  model: string;
  historyWindowDays: number;
  feedbackWindowDays: number;
  contextBudgetChars: number;
  names: Record<PersonId, string>;
}

const responseSchema = z.object({
  prompt: z.string().min(1).max(300),
  // Required, not optional: forcing the generator to commit to a stance is
  // the mechanism that makes the explore/exploit ratio measurable at all.
  stance: z.enum(["explore", "exploit"]),
  rationale: z.string().min(1),
  usedIdeaId: z.number().nullable().optional(),
});

const MAX_ATTEMPTS = 2;

/** Generates one adaptive daily prompt from both people's memory context,
 * coverage, recent history, and feedback/prompt ideas. Throws on any
 * failure (LLM outage, malformed response, memory backend down) rather
 * than degrading itself — the caller (FallbackPromptSource) is what
 * degrades. Never calls itself "the fallback"; it has none. */
export class AdaptivePromptSource implements PromptSource {
  constructor(
    private readonly memory: Memory,
    private readonly llm: LlmClient,
    private readonly ledger: Ledger,
    private readonly opts: AdaptivePromptSourceOptions,
  ) {}

  async nextPrompt(date: string): Promise<Prompt> {
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

    const stance = decideStance({
      recentStances: history.map((h) => h.stance),
      hasThreads: contextA.threads.length > 0 || contextB.threads.length > 0,
    });

    const userPrompt = buildGenerationUserPrompt({
      today: date,
      stance,
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
        lastError = new Error(`AdaptivePromptSource: LLM response missing a valid "prompt" field`);
        continue;
      }

      // Deterministic repeat guard. The system prompt already forbids
      // repeats and the history is right there in the context, and the
      // generator still reproduced a prompt from six days earlier almost
      // verbatim. Retrying costs one call; shipping a duplicate is visible
      // to both people.
      const priorTexts = history.map((h) => h.text);
      const nearest = nearestPrior(shaped.data.prompt, priorTexts);
      if (nearest && nearest.similarity >= NEAR_DUPLICATE_THRESHOLD && attempt < MAX_ATTEMPTS) {
        lastError = new Error(
          `AdaptivePromptSource: generated prompt near-duplicates "${nearest.text}" (${nearest.similarity.toFixed(2)})`,
        );
        continue;
      }

      const at = new Date().toISOString();
      this.ledger.recordGeneration({
        date,
        promptId: `gen-${date}`,
        promptText: shaped.data.prompt,
        model: this.opts.model,
        systemPrompt: ADAPTIVE_SYSTEM_PROMPT,
        userPrompt,
        rawResponse: raw,
        rationale: shaped.data.rationale,
        stance, // the assigned stance, which is the ground truth of what was asked for
        person: null, // still one shared prompt until per-person generation lands
        fellBack: false,
        fallbackReason: null,
        at,
      });

      const usedId = shaped.data.usedIdeaId;
      if (usedId != null) {
        const isUnconsumed = [...ideasA, ...ideasB].some((i) => i.id === usedId);
        if (isUnconsumed) this.ledger.markPromptIdeaUsed(usedId, null, at);
      }

      return { id: `gen-${date}`, text: shaped.data.prompt };
    }
    throw lastError!;
  }
}
