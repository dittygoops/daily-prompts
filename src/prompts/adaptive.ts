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
import { NEAR_DUPLICATE_THRESHOLD, nearestPrior, openingStem } from "../eval/novelty";
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
  // Declared so a topical repeat can be rejected in code. Content-word
  // similarity cannot see that "get better at" and "area of growth" are the
  // same subject, and four such questions went out in six days.
  topic: z.string().min(1).max(60),
});

const responseSchema = z.object({
  theme: z.string().min(1).max(120).nullable().optional(),
  a: personSchema,
  b: personSchema,
  rationale: z.string().min(1),
  usedIdeaId: z.number().nullable().optional(),
});

// Three rejection reasons now (near-duplicate text, repeated subject,
// reused sentence frame), so one retry is not enough headroom.
const MAX_ATTEMPTS = 3;

/** How many of a person's recent subjects are off-limits. Six days of
 * self-improvement questions is what this exists to prevent. */
const TOPIC_MEMORY_DAYS = 6;

/** How many recent questions the opening-frame check looks back over. */
const STEM_MEMORY_DAYS = 3;

const norm = (t: string) => t.trim().toLowerCase();

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

    const recentThemes = this.ledger.recentThemes(TOPIC_MEMORY_DAYS);
    const recentTopicsA = this.ledger.recentTopics("a", TOPIC_MEMORY_DAYS);
    const recentTopicsB = this.ledger.recentTopics("b", TOPIC_MEMORY_DAYS);

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
      recentTopicsA,
      recentTopicsB,
      recentThemes,
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

      // Subject repeat. Jaccard is blind to this: four self-improvement
      // questions went out in six days sharing almost no vocabulary.
      const repeatedTopic =
        (recentTopicsA.some((t) => norm(t) === norm(shaped.data.a.topic)) && { person: "A", topic: shaped.data.a.topic }) ||
        (recentTopicsB.some((t) => norm(t) === norm(shaped.data.b.topic)) && { person: "B", topic: shaped.data.b.topic });
      if (repeatedTopic && attempt < MAX_ATTEMPTS) {
        lastError = new Error(
          `AdaptivePromptSource: person ${repeatedTopic.person}'s topic "${repeatedTopic.topic}" was used in the last ${TOPIC_MEMORY_DAYS} questions`,
        );
        continue;
      }

      // Repeated shared angle. The per-person topic tags can all differ
      // while the day is about the same thing three days running, so the
      // repetition moves up a level into the theme.
      const themeText = shaped.data.theme ?? null;
      const nearestTheme = themeText ? nearestPrior(themeText, recentThemes) : null;
      if (nearestTheme && nearestTheme.similarity >= NEAR_DUPLICATE_THRESHOLD && attempt < MAX_ATTEMPTS) {
        lastError = new Error(
          `AdaptivePromptSource: theme "${themeText}" repeats "${nearestTheme.text}" (${nearestTheme.similarity.toFixed(2)})`,
        );
        continue;
      }

      // Reused sentence frame. openingStem exists precisely because
      // content-word overlap cannot see shared scaffolding, but until now it
      // only ran in the offline report, never at generation time. Eight of
      // nine live questions opened "What's a/an/one...".
      // Wrapped, not passed by reference: map supplies the index as the
      // second argument, which openingStem reads as stemWords, so
      // .map(openingStem) silently makes the first stem empty.
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
      this.ledger.recordGeneration({
        date,
        promptId: `gen-${date}-a`,
        promptText: shaped.data.a.prompt,
        model: this.opts.model,
        systemPrompt: ADAPTIVE_SYSTEM_PROMPT,
        userPrompt,
        rawResponse: raw,
        rationale: shaped.data.rationale,
        stance: stanceA,
        topic: shaped.data.a.topic,
        targetNodeId: null, // wired when generation consumes the ontology (build step 3)
        targetDomain: null,
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
        stance: stanceB,
        topic: shaped.data.b.topic,
        targetNodeId: null, // wired when generation consumes the ontology (build step 3)
        targetDomain: null,
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
