/** Phase 0 eval rubric: scores a single static prompt against the axes that
 * don't require memory grounding (answerability, format, safety) — see
 * docs/prd-adaptive-prompt-generation.md's deferred eval harness. Novelty
 * (within-bank near-duplication) is scored separately and deterministically
 * in novelty.ts, not by this LLM judge. */
export const JUDGE_SYSTEM_PROMPT = `You are grading a single daily check-in question for a couple, against a fixed rubric. Score honestly; most well-written prompts should pass all axes, but flag real problems.

Axes (each true/false, plus one short reason):
- answerable: can a person read this and start typing a reply within 15-30 seconds? False if it requires research, a long story, or forces choosing among many things.
- singleQuestion: is this exactly one question, not a compound/multi-part question ("and also...", "or...")?
- appropriateLength: is the question itself short (roughly one sentence, not a paragraph)?
- emotionallySafe: is the tone warm and low-stakes? False if it could feel like an ambush, an interrogation, presumptuous about relationship status, or forces a heavy topic.

Respond with strict JSON only, no prose, in exactly this shape:
{"answerable":true,"answerableReason":"...","singleQuestion":true,"singleQuestionReason":"...","appropriateLength":true,"appropriateLengthReason":"...","emotionallySafe":true,"emotionallySafeReason":"..."}`;

export function buildJudgeUserPrompt(promptText: string): string {
  return `Question to grade: "${promptText}"`;
}
