import { z } from "zod";
import type { LlmClient } from "../llm/types";
import { JUDGE_SYSTEM_PROMPT, buildJudgeUserPrompt } from "./rubric";

const judgmentSchema = z.object({
  answerable: z.boolean(),
  answerableReason: z.string().min(1),
  singleQuestion: z.boolean(),
  singleQuestionReason: z.string().min(1),
  appropriateLength: z.boolean(),
  appropriateLengthReason: z.string().min(1),
  emotionallySafe: z.boolean(),
  emotionallySafeReason: z.string().min(1),
});

export type Judgment = z.infer<typeof judgmentSchema>;

/** One retry, matching AdaptivePromptSource: judges occasionally return a
 * verdict with blank reasons or stray prose around the JSON, and a whole
 * eval run should not die on one flaky completion. */
const MAX_ATTEMPTS = 2;

export async function judgePrompt(promptText: string, llm: LlmClient): Promise<Judgment> {
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const raw = await llm.complete(JUDGE_SYSTEM_PROMPT, buildJudgeUserPrompt(promptText));
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      lastError = new Error(`judgePrompt: LLM response was not valid JSON: ${raw.slice(0, 200)}`);
      continue;
    }
    const shaped = judgmentSchema.safeParse(parsed);
    if (!shaped.success) {
      lastError = new Error(`judgePrompt: LLM response failed rubric schema: ${shaped.error.message}`);
      continue;
    }
    return shaped.data;
  }
  throw lastError!;
}

export function passesAll(judgment: Judgment): boolean {
  return judgment.answerable && judgment.singleQuestion && judgment.appropriateLength && judgment.emotionallySafe;
}
