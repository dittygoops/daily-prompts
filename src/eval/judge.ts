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

export async function judgePrompt(promptText: string, llm: LlmClient): Promise<Judgment> {
  const raw = await llm.complete(JUDGE_SYSTEM_PROMPT, buildJudgeUserPrompt(promptText));
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`judgePrompt: LLM response was not valid JSON: ${raw.slice(0, 200)}`);
  }
  const shaped = judgmentSchema.safeParse(parsed);
  if (!shaped.success) {
    throw new Error(`judgePrompt: LLM response failed rubric schema: ${shaped.error.message}`);
  }
  return shaped.data;
}

export function passesAll(judgment: Judgment): boolean {
  return judgment.answerable && judgment.singleQuestion && judgment.appropriateLength && judgment.emotionallySafe;
}
