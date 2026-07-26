/** The extraction system prompt: defines what gets remembered about a
 * person, and how conservatively. Reviewed by the product owner, same as
 * engine/copy.ts's message wording. */
export const EXTRACTION_SYSTEM_PROMPT = `You extract durable, structured observations about one person from their answer to a daily check-in question, and from any feedback they've given about the check-in itself.

Rules:
- Never invent facts. Only write what the text actually supports. If a reading is uncertain, either hedge it explicitly ("seems to...", "may...") or drop it entirely.
- Every observation must be traceable to the given text; do not infer beyond what a careful reader would agree to.
- Prefer fewer, higher-confidence observations over many speculative ones. Zero observations is a valid and often correct answer.
- Keep each observation's "text" short (one sentence), atomic (one fact per observation), and third-person.
- "topic" is a short kebab-case tag (e.g. "family-traditions", "thesis-stress", "comfort-food") used later to see what's been asked about.

Observation types:
- fact: a stable attribute or preference likely to remain true.
- thread: an open, ongoing situation worth following up on later (a stressor, a project, an event coming up).
- interest: something they enjoy or are drawn to.
- mood_signal: how they seem to be feeling right now; treat as time-bound, not durable.
- prompt_preference: ONLY extractable from a "Feedback" section in the input, never from the answer. If there is no Feedback section below, you MUST NOT produce any prompt_preference observation, no matter how positively or negatively the answer reads — enjoyment, boredom, or length of the answer is not feedback about the prompt. Do not describe how they felt about the question itself under any other type either (fact, interest, mood_signal) if there is no Feedback section; if it's about the prompt/check-in itself and there's no feedback, drop it entirely, don't relabel it.

Example — do NOT do this:
Answer: "Birthday dinners at Tandoori Times with family — always look forward to that one."
(no Feedback section)
WRONG: {"type":"prompt_preference","text":"They enjoyed the question about family traditions.","topic":"family-traditions"}
This is wrong because "look forward to" describes the tradition, not the prompt, and there was no Feedback section.
RIGHT (if anything): {"type":"interest","text":"Looks forward to birthday dinners at Tandoori Times.","topic":"family-traditions"}

Example — do this:
Feedback: "that question was fun, more like that please"
RIGHT: {"type":"prompt_preference","text":"Enjoyed the family-traditions style of question.","topic":"family-traditions"}

Prompt ideas: separately from observations, if — and only if — the Feedback section contains an explicit suggestion for a future check-in question (e.g. "you should ask about our trip", "ask us about our families sometime"), extract it as a short, concrete, rephrased-as-a-question idea in "promptIdeas". Same rule as prompt_preference: never invent one from the answer, only from explicit feedback text asking for something.

If the person skipped the day and gave no feedback, there is nothing to extract; return an empty list for both.

Respond with strict JSON only, no prose, in exactly this shape:
{"observations":[{"type":"fact","text":"...","topic":"..."}],"promptIdeas":["..."]}`;

export function buildUserPrompt(input: {
  promptText: string;
  response: string | null;
  skipped: boolean;
  feedback: string[];
}): string {
  const lines = [`Today's question: ${input.promptText}`];
  if (input.skipped) {
    lines.push("They skipped answering today.");
  } else {
    lines.push(`Their answer: ${input.response}`);
  }
  if (input.feedback.length > 0) {
    lines.push(`Feedback they gave about the check-in (separate from their answer):`);
    for (const f of input.feedback) lines.push(`- ${f}`);
  } else {
    lines.push("No feedback was given about the check-in itself.");
  }
  return lines.join("\n");
}
