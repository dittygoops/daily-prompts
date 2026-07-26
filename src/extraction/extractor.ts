import { z } from "zod";
import type { PersonId } from "../config";
import type { LlmClient } from "../llm/types";
import type { Observation } from "../memory/types";
import { EXTRACTION_SYSTEM_PROMPT, buildUserPrompt } from "./prompt";

export interface ExtractionInput {
  dayId: number;
  date: string;
  promptText: string;
  person: PersonId;
  response: string | null;
  skipped: boolean;
  feedback: string[];
}

const rawObservationSchema = z.object({
  type: z.enum(["fact", "thread", "interest", "mood_signal", "prompt_preference"]),
  text: z.string().min(1),
  topic: z.string().min(1),
});

const responseSchema = z.object({
  observations: z.array(z.unknown()),
  promptIdeas: z.array(z.unknown()).optional(),
});

const MAX_ATTEMPTS = 3;

export interface ExtractionResult {
  observations: Observation[];
  /** Explicit prompt-idea suggestions found in feedback, e.g. "ask us about
   * our Tokyo trip". Consumed by System 3 into a durable idea queue. */
  promptIdeas: string[];
}

/** Extract observations (and any prompt-idea suggestions) for one person's
 * day. Never calls the LLM when there is nothing to extract from (skipped,
 * no feedback) — saves cost and matches the "zero observations is often
 * correct" rule. Malformed individual observations/ideas are dropped. A
 * malformed *response* (unparseable JSON, or missing the observations
 * array) is retried in-process up to MAX_ATTEMPTS — empirically, some
 * providers intermittently return truncated JSON-mode output unrelated to
 * any token limit — and only throws (for the pipeline to record as a
 * failed attempt) once exhausted. */
export async function extractObservations(
  input: ExtractionInput,
  llm: LlmClient,
): Promise<ExtractionResult> {
  if (input.skipped && input.feedback.length === 0) {
    return { observations: [], promptIdeas: [] };
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

    const snippet = input.skipped ? "(skipped)" : (input.response ?? "");
    const observations: Observation[] = [];
    for (const item of shaped.data.observations) {
      const result = rawObservationSchema.safeParse(item);
      if (!result.success) continue; // drop individually malformed items
      // Zero-trust guard: the caller already knows definitively whether
      // feedback was given (input.feedback), so never rely on the model's
      // own judgment about it. Observed live: the model sometimes infers a
      // prompt_preference from the *answer's* tone alone, violating the
      // system prompt's own rule. Known limitation this doesn't cover:
      // feedback arriving after this extraction already ran (the feedback
      // window stays open ~24h) won't be reflected here or reprocessed.
      if (result.data.type === "prompt_preference" && input.feedback.length === 0) {
        continue;
      }
      observations.push({
        type: result.data.type,
        text: result.data.text,
        topic: result.data.topic,
        person: input.person, // never trust the LLM's own person field
        provenance: { dayId: input.dayId, date: input.date, snippet },
      });
    }

    // Same zero-trust guard as prompt_preference: ideas can only come from
    // feedback, never invented from the answer alone.
    const promptIdeas: string[] = [];
    if (input.feedback.length > 0) {
      for (const item of shaped.data.promptIdeas ?? []) {
        if (typeof item === "string" && item.trim().length > 0) promptIdeas.push(item);
      }
    }

    return { observations, promptIdeas };
  }
  throw lastError!;
}
