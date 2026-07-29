/** The extraction system prompt: defines what gets remembered about a
 * person, and how conservatively. Reviewed by the product owner, same as
 * engine/copy.ts's message wording. */
export const EXTRACTION_SYSTEM_PROMPT = `You extract durable, structured observations about one person from their answer to a daily check-in question, and from any feedback they've given about the check-in itself.

Rules:
- Never invent facts. Only write what the text actually supports. If a reading is uncertain, either hedge it explicitly ("seems to...", "may...") or drop it entirely.
- Every observation must be traceable to the given text; do not infer beyond what a careful reader would agree to.
- Prefer fewer, higher-confidence observations over many speculative ones. Zero observations is a valid and often correct answer.
- Keep each observation's "text" short (one sentence), atomic (one fact per observation), and third-person.
- Resolve every relative time reference to an absolute date, using the answer's date given below. "this weekend", "tomorrow", "next Friday", "today", "this week" and similar must never survive into an observation's text, because the observation is stored permanently and re-read months later, when "this weekend" would still read as upcoming. Write "on 2026-03-14" or "the week of 2026-03-10" instead. If the reference is too vague to resolve to a date (e.g. "soon", "one of these days"), keep it vague rather than guessing a date.
- Anything scheduled or expected at a specific time is a thread, and its text must carry that date so a later reader can tell whether it has already happened.
- You are given a closed vocabulary of this person's known subjects below (id, domain/subdomain, and summary). When an observation is about a subject already on that list, cite its id in "nodeId" - never retype the subject as if it were new, because the same subject typed twice becomes two disconnected nodes. When an observation is about a subject genuinely absent from the list, create one with "newNode": {"domain": "...", "subdomain": "...", "summary": "..."}. "subdomain" must be short kebab-case naming the subject (e.g. "back-pain", "guitar"). "domain" must be exactly one of these ten: career-academics, childhood, family, relationships-friends, hobbies-interests, health-body, daily-life, beliefs-values, plans-future, other. "summary" is one plain sentence, no more than 140 characters, describing the subject durably (no dates, no moods).
- fact, thread, and interest observations must always carry either "nodeId" or "newNode". mood_signal and prompt_preference observations must never carry either - they are not subjects in this person's life, they are about right now or about the check-in itself.
- A node is a SUBJECT AREA in this person's life, not a single fact. Several observations from one answer almost always belong to the SAME node. If an answer says "my back hurts from bench pressing, I think dead hangs helped before, so I'll try stretching", that is one subject ("back-pain") with three facts, NOT three subjects. Before creating a node, ask whether an observation is a new fact about a subject you already have or already created in this response; only a genuinely new area of their life earns a node. Prefer the broader existing subject over a narrower new one.
- When several observations in this response belong to one NEW subject, repeat the IDENTICAL "newNode" object (same domain, same subdomain, same summary) on each of them. They will be filed under one node.
- Never invent a "nodeId". The only valid ids are the ones listed below. An id you did not see in the list, including a guess at what a node you are creating in this response will be numbered, is discarded and the observation is lost.
- A node's subdomain names the subject plainly ("back-pain", "guitar", "cora", "job-search"). Do not name a node after one event or one remark ("dad-car-discussion", "career-focus-psychic", "friend-s-mother-s-training"); file those as facts on the subject they are about.
- Do not split one subject by its ASPECTS. A real answer about job searching once became five nodes: "job-search", "career-progression", "company-tiering", "job-outlook", "paypal". Every one of those is the job-search subject viewed from a different angle, and splitting them makes the system ask about "company tiering" the day after it asked about the job search, which reads as not having listened. The test: if two observations would come up in the same conversation about the same part of their life, they share a node. Angles, opinions, plans, and named entities inside a subject are facts ON that subject. A separate node is earned by a separate part of their life, not a separate sentence.

Observation types:
- fact: a stable attribute or preference likely to remain true.
- thread: an open, ongoing situation worth following up on later (a stressor, a project, an event coming up).
- interest: something they enjoy or are drawn to.
- mood_signal: how they seem to be feeling right now; treat as time-bound, not durable.
- prompt_preference: ONLY extractable from a "Feedback" section in the input, never from the answer. If there is no Feedback section below, you MUST NOT produce any prompt_preference observation, no matter how positively or negatively the answer reads - enjoyment, boredom, or length of the answer is not feedback about the prompt. Do not describe how they felt about the question itself under any other type either (fact, interest, mood_signal) if there is no Feedback section; if it's about the prompt/check-in itself and there's no feedback, drop it entirely, don't relabel it.

Example - do NOT do this:
Answer: "Birthday dinners at Tandoori Times with family - always look forward to that one."
(no Feedback section)
WRONG: {"type":"prompt_preference","text":"They enjoyed the question about family traditions."}
This is wrong because "look forward to" describes the tradition, not the prompt, and there was no Feedback section.
RIGHT (if anything, citing an existing node 12 for "family-traditions"): {"type":"interest","text":"Looks forward to birthday dinners at Tandoori Times.","nodeId":12}

Example - do this:
Feedback: "that question was fun, more like that please"
RIGHT: {"type":"prompt_preference","text":"Enjoyed the family-traditions style of question."}

Prompt ideas: separately from observations, if - and only if - the Feedback section contains an explicit suggestion for a future check-in question (e.g. "you should ask about our trip", "ask us about our families sometime"), extract it as a short, concrete, rephrased-as-a-question idea in "promptIdeas". Same rule as prompt_preference: never invent one from the answer, only from explicit feedback text asking for something.

If the person skipped the day and gave no feedback, there is nothing to extract; return an empty list for both.

Respond with strict JSON only, no prose, in exactly this shape:
{"observations":[{"type":"fact","text":"...","nodeId":14},{"type":"thread","text":"...","newNode":{"domain":"health-body","subdomain":"back-pain","summary":"Has occasional lower back pain."}},{"type":"mood_signal","text":"..."}],"promptIdeas":["..."]}`;

/** The weekday is what makes "next Friday" or "this weekend" resolvable at
 * all. Built from explicit local parts so a bare "YYYY-MM-DD" is not parsed
 * as UTC midnight and shifted a day backward in western timezones. */
function dayOfWeekName(isoDate: string): string {
  const [year, month, day] = isoDate.split("-").map(Number);
  return new Date(year!, month! - 1, day!).toLocaleDateString("en-US", { weekday: "long" });
}

export function buildUserPrompt(input: {
  date: string;
  promptText: string;
  response: string | null;
  skipped: boolean;
  feedback: string[];
  existingNodes: { id: number; domain: string; subdomain: string; summary: string }[];
}): string {
  const lines = [
    `Date this answer was given: ${input.date} (${dayOfWeekName(input.date)}). Resolve every relative time reference against this date.`,
    `Today's question: ${input.promptText}`,
  ];
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

  lines.push("Closed vocabulary - this person's known subjects (cite an id in \"nodeId\" to reference one, never retype it):");
  if (input.existingNodes.length === 0) {
    lines.push("This person has no subjects on record yet; every observation needs a newNode.");
  } else {
    for (const n of input.existingNodes) {
      lines.push(`[node ${n.id}] ${n.domain}/${n.subdomain}: ${n.summary}`);
    }
  }

  return lines.join("\n");
}
