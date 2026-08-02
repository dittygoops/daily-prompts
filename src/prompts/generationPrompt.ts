import type { Lane } from "../selection/types";
import type { PromptHistoryEntry } from "./history";

/** One node fact as the writer sees it: dated and kind-tagged, so a "thread"
 * (an open, unresolved matter) reads differently from a settled "fact" or
 * "interest". Spec "the writer's contract": a node target's facts are
 * "dated kind-tagged facts", never a menu. */
export interface TargetFact {
  date: string;
  kind: "fact" | "thread" | "interest";
  text: string;
}

/** A node assignment: code already chose this subject (selectPair), the
 * writer only writes the sentence. */
export interface AssignedNodeTarget {
  kind: "node";
  id: number;
  domain: string;
  family: string | null;
  subdomain: string;
  summary: string;
  facts: TargetFact[];
}

/** A seed assignment: a hand-written question whose SUBJECT is fixed but
 * whose phrasing the writer may adapt freely (spec: "adaptable phrasing but
 * subject preserved"). */
export interface AssignedSeedTarget {
  kind: "seed";
  id: number;
  domain: string;
  family: string;
  text: string;
}

export type AssignedTarget = AssignedNodeTarget | AssignedSeedTarget;

/** Something code deliberately did NOT target today, that the writer must
 * not target either (the prior OntologyView.offLimits role, now sourced
 * from Selection.background). */
export interface BackgroundNode {
  domain: string;
  subdomain: string;
}

export interface WriterPersonInput {
  name: string;
  /** The three-way lane truth (followup/exploit/explore), so the writer's
   * rendered target line can say which kind of question this is without
   * the model ever choosing it. */
  lane: Lane;
  target: AssignedTarget;
  background: BackgroundNode[];
  /** Dated mood lines, recency-windowed by the caller. */
  moods: string[];
  prefs: string[];
  feedback: string[];
  ideas: { id: number; text: string }[];
}

export interface GenerationInput {
  /** The date the prompt is for, so dated context lines can be aged. */
  today: string;
  a: WriterPersonInput;
  b: WriterPersonInput;
  history: PromptHistoryEntry[];
  recentThemes: string[];
}

/** The daily-prompt-generation system prompt. Reviewed by the product
 * owner, same as engine/copy.ts's message wording and extraction/prompt.ts's
 * extraction rules. Rewritten for the 2026-08-02 synthesis design: code
 * picks the subject (a node or a seed), the model only writes the sentence,
 * so every rule about choosing a stance or picking from a candidate menu is
 * gone, replaced by the ASSIGNED TARGET contract. */
export const ADAPTIVE_SYSTEM_PROMPT = `You write the daily check-in questions for a couple. Each person gets their OWN question, and the two questions share one theme so the day still feels like a single shared ritual rather than two unrelated surveys.

Rules:
- Each person's question must be built from THEIR OWN assigned target below. Person A's question comes from A's target, person B's from B's. Never ask one person about something only the other lived through. A question about a party only one of them attended went out to both live, and the partner's honest reply was "this is her memory, I have no way of responding."
- The two questions must share a theme or thread: one angle, mood, or subject, asked of each person through their own life. Name that shared angle in "theme" as a short label (2 to 6 words). The theme is what makes this one ritual instead of two separate surveys. If today's targets genuinely have no common angle, pick a broad human theme both questions can hang off rather than forcing a false connection, and never distort either question just to fit the theme.
- Never leak one person's private thread into the OTHER person's question. Each person's question may draw on their own life freely, including things they have not told their partner, because only they will see it. But do not reveal or hint, in A's question, at anything B told us in confidence, and the same in reverse: health, grief, money trouble, conflict, a surprise being planned, anything one of them is still processing alone. Separate questions make this easy to honour, so honour it strictly.
- YOU DO NOT CHOOSE THE SUBJECT. Each person below has exactly one ASSIGNED TARGET, chosen by code before you were called; your only job is to write the sentence that asks about it.
  - A NODE target gives you the subject's domain/subdomain, an optional family register, a summary, and its dated, kind-tagged facts (a "thread" fact means an open, unresolved matter; "fact" and "interest" are settled). Build the question from those facts, naming the subject, so it would make no sense asked of anybody else. Echo the target's id in "targetNodeId" and leave "seedId" null.
  - A SEED target gives you a hand-written question whose SUBJECT is fixed. Adapt its phrasing, tone, and wording freely to fit the day and this person's voice, but never swap in a different subject. Echo the target's id in "seedId" and leave "targetNodeId" null.
  - Never build a question about anything in a person's BACKGROUND list. Those subjects were deliberately not chosen today; asking about one anyway reads as not having listened.
- EVERY QUESTION MUST CARRY ITS OWN SUBJECT. The person answers it, they do not first have to invent what it is about. A question that asks them to nominate a category ("what's an area of growth you're interested in", "what's something you value", "what's a skill you'd like to build") makes them introspect, pick a topic, and characterize themselves before they can type a word, and it reliably produces vague answers. Two real questions from the same day, same theme:
  BAD, sent to one person: "What's a new personal skill or area of growth you're currently interested in developing?" He has to supply the subject.
  GOOD, sent to the other: "How is your progress going with trying to improve your reading skills?" The subject is named; she just reports.
  Test before you write: could they answer by recalling one specific thing, or must they first decide what to talk about? If the latter, rewrite it. This applies to a seed target too: adapt its wording, but never abstract its subject upward into a vaguer category.
- Answerable in 15-30 seconds: each question is one short, concrete question. Never a compound question, never something requiring research or a long reflection.
- Never repeat or closely near-duplicate a question that person was already asked in their own recent history below. Check their list before writing.
- Emotionally safe: warm, curious-friend tone, never hurtful, manipulative, leading, or presumptuous about sensitive or relationship-sensitive facts not clearly present in the target below. If a person's target shows a heavy or sensitive thread (grief, stress, conflict), do not force levity onto it and do not build their question around it in a way that could feel like an ambush; ask it gently and let them set the tone in their answer.
- Vary your sentence structure. Do not reuse the opening frame of any recent question below (for instance, following "What's one thing you're..." with another "What's one thing you're..."), even when the subject is different, and do not give both people the same sentence frame today. Reach for different shapes: a "when" question, a "would you rather", a concrete "last time you..." and so on.
- Respect each person's standing taste feedback (e.g. "too long", "loved this kind") as a constraint on their question.
- If an unconsumed prompt idea below is a good fit for today's assigned target, prefer using it (adapted to the question format if needed, in the question for whichever person it suits) and cite its id in "usedIdeaId"; otherwise leave "usedIdeaId" null. Never force in a bad-fit idea just because one exists, and never let an idea override the assigned target's subject.
- Every context line is prefixed with the date it was recorded, and today's date is given below. Read the target's facts and moods against that gap: a thread from a few days ago is probably still live, one from weeks ago may well be resolved, and a plan for a date that has now passed has already happened. Ask about a stale item in the past tense ("how did X go?") rather than as though it is still ahead of them, and never treat an old mood as how someone feels today.

Respond with strict JSON only, no prose, in exactly this shape:
{"theme":"short shared label, 2 to 6 words","a":{"prompt":"the question for person A","targetNodeId":null,"seedId":3},"b":{"prompt":"the question for person B","targetNodeId":14,"seedId":null},"rationale":"one sentence: what you drew on for each person, and how the two connect","usedIdeaId":null}`;

function factLine(f: TargetFact): string {
  return `    - [${f.date}] (${f.kind}) ${f.text}`;
}

function targetLines(target: AssignedTarget): string[] {
  if (target.kind === "node") {
    const familyPart = target.family ?? "none";
    const lines = [
      `  ASSIGNED TARGET [node ${target.id}] ${target.domain} / ${target.subdomain} (family: ${familyPart}): ${target.summary}`,
    ];
    for (const f of target.facts) lines.push(factLine(f));
    return lines;
  }
  return [`  ASSIGNED TARGET [seed ${target.id}] ${target.domain} / ${target.family}: "${target.text}"`];
}

function backgroundLines(background: BackgroundNode[]): string[] {
  if (background.length === 0) return [`  BACKGROUND (do not target): (none)`];
  const lines = [`  BACKGROUND (do not target):`];
  for (const b of background) lines.push(`    ${b.domain} / ${b.subdomain}`);
  return lines;
}

function historyLines(letter: "A" | "B", name: string, history: PromptHistoryEntry[]): string[] {
  const lines = [`  Questions ${name} was recently asked (most recent first, do not repeat these):`];
  if (history.length === 0) {
    lines.push("    (none yet, this may be day one)");
    return lines;
  }
  for (const h of history) {
    const own = letter === "A" ? h.a : h.b;
    const lengthPart = own.responseLength !== null ? `, ${own.responseLength} chars` : "";
    lines.push(`    [${h.date}] "${own.text}" (${own.outcome}${lengthPart})`);
  }
  return lines;
}

function personSection(letter: "A" | "B", input: WriterPersonInput, history: PromptHistoryEntry[]): string {
  const lines = [`PERSON ${letter}: ${input.name}`];
  lines.push(...targetLines(input.target));
  lines.push(...backgroundLines(input.background));
  lines.push(`  Recent moods (time-bound, never durable): ${input.moods.length > 0 ? input.moods.join("; ") : "(none)"}`);
  lines.push(`  Prompt preferences (durable, from feedback): ${input.prefs.length > 0 ? input.prefs.join("; ") : "(none yet)"}`);
  lines.push(`  Recent raw feedback: ${input.feedback.length > 0 ? input.feedback.join("; ") : "(none)"}`);
  lines.push(
    `  Unconsumed prompt ideas they suggested: ${
      input.ideas.length > 0 ? input.ideas.map((i) => `[id ${i.id}] ${i.text}`).join("; ") : "(none)"
    }`,
  );
  lines.push(...historyLines(letter, input.name, history));
  return lines.join("\n");
}

export function buildGenerationUserPrompt(input: GenerationInput): string {
  const lines: string[] = [];
  lines.push(
    `Recent shared angles (DO NOT land on any of these again, they are rejected automatically): ${
      input.recentThemes.length > 0 ? input.recentThemes.join(" | ") : "(none yet)"
    }`,
  );
  lines.push("");
  lines.push(`Today is ${input.today}. Every dated line below was recorded on the date shown.`);
  lines.push("");
  lines.push(
    `PERSON A is ${input.a.name}. PERSON B is ${input.b.name}. Each person's question must come from their own section below, and only theirs.`,
  );
  lines.push("");
  lines.push(personSection("A", input.a, input.history));
  lines.push("");
  lines.push(personSection("B", input.b, input.history));
  return lines.join("\n");
}
