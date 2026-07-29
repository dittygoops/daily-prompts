import type { PersonId } from "../config";
import type { PersonCandidates } from "../ontology/types";
import type { PromptHistoryEntry } from "./history";
import type { Stance } from "./stance";

/** The daily-prompt-generation system prompt. Reviewed by the product
 * owner, same as engine/copy.ts's message wording and
 * extraction/prompt.ts's extraction rules. */
export const ADAPTIVE_SYSTEM_PROMPT = `You write the daily check-in questions for a couple. Each person gets their OWN question, and the two questions share one theme so the day still feels like a single shared ritual rather than two unrelated surveys.

Rules:
- Each person's question must be built from THEIR OWN memory below. Person A's question comes from A's facts, threads, and interests; person B's question comes from B's. Never ask one person about something only the other lived through. A question about a party only one of them attended went out to both live, and the partner's honest reply was "this is her memory, I have no way of responding."
- The two questions must share a theme or thread: one angle, mood, or subject, asked of each person through their own life. Name that shared angle in "theme" as a short label (2 to 6 words). The theme is what makes this one ritual instead of two separate surveys. If today's contexts genuinely have no common angle, pick a broad human theme both questions can hang off rather than forcing a false connection, and never distort either question just to fit the theme.
- Never leak one person's private thread into the OTHER person's question. Each person's question may draw on their own life freely, including things they have not told their partner, because only they will see it. But do not reveal or hint, in A's question, at anything B told us in confidence, and the same in reverse: health, grief, money trouble, conflict, a surprise being planned, anything one of them is still processing alone. Separate questions make this easy to honour, so honour it strictly.
- EVERY QUESTION MUST CARRY ITS OWN SUBJECT. The person answers it, they do not first have to invent what it is about. A question that asks them to nominate a category ("what's an area of growth you're interested in", "what's something you value", "what's a skill you'd like to build") makes them introspect, pick a topic, and characterize themselves before they can type a word, and it reliably produces vague answers. Two real questions from the same day, same theme:
  BAD, sent to one person: "What's a new personal skill or area of growth you're currently interested in developing?" He has to supply the subject.
  GOOD, sent to the other: "How is your progress going with trying to improve your reading skills?" The subject is named; she just reports.
  Test before you write: could they answer by recalling one specific thing, or must they first decide what to talk about? If the latter, rewrite it.
- WHEN A SUBJECT IS USED UP, CHANGE SUBJECT. Do not retreat to a vaguer version of the same one. If their guitar practice and job search are already covered, the answer is a different part of their life (a meal, a place, a person, a thing they own, something that happened), NOT "an area of growth". Abstracting upward looks like novelty to a repetition check while being strictly worse to answer, and it is how one person got four self-improvement questions in six days.
- Answerable in 15-30 seconds: each question is one short, concrete question. Never a compound question, never something requiring research or a long reflection.
- Never repeat or closely near-duplicate a question that person was already asked in their own recent history below. Check their list before writing.
- Emotionally safe: warm, curious-friend tone, never hurtful, manipulative, leading, or presumptuous about sensitive or relationship-sensitive facts not clearly present in the context below. If a person's context shows a heavy or sensitive open thread (grief, stress, conflict), do not force levity onto it and do not build their question around it in a way that could feel like an ambush; prefer a lighter topic for them that day unless their context clearly signals they want to talk about it.
- Each person's stance is assigned to you below and is not yours to choose. Follow it exactly and echo it back in that person's "stance". The two may differ, and when they do that is deliberate.
  - EXPLOIT: pick EXACTLY ONE node from that person's EXPLOIT CANDIDATES list below and cite its id in their "targetNodeId" ("targetExplore" stays null). Build the question on that node's own dated facts, naming the subject, so it would make no sense asked of anybody else. "What are you looking forward to this week?" is NOT an exploit; "How did the psychic reading party end up going?" is. A LIVE marker means the subject just happened or is imminent, and usually deserves the pick. An id not on the list is rejected automatically.
  - EXPLORE: pick EXACTLY ONE domain from that person's EXPLORE CANDIDATES list and cite it in their "targetExplore" ("targetNodeId" stays null). Open that domain through a concrete everyday subject ("what's your favorite thing to cook" explores food while carrying its subject); the carry-its-own-subject rule applies to explore questions with no exemption. A domain not on the list is rejected automatically.
  - Never build a question on anything in a person's OFF LIMITS list. Those subjects were asked recently or came up dry, and a second question about them reads as not having listened.
- Declare each question's subject in that person's "topic" as one short kebab-case tag naming what the question is ABOUT, not its shape: "childhood-food", "commuting", "old-friendships". Their recently used topics are listed below and are rejected automatically, so a repeat costs you the whole generation and you will simply be asked again. Self-improvement, goals, learning, growth, and "getting better at" things are ONE subject, not several: four of those went out in six days because each looked new on its own.
- Vary your sentence structure. Do not reuse the opening frame of any recent question below (for instance, following "What's one thing you're..." with another "What's one thing you're..."), even when the subject is different, and do not give both people the same sentence frame today. Reach for different shapes: a "when" question, a "would you rather", a concrete "last time you..." and so on.
- Respect each person's standing taste feedback (e.g. "too long", "loved this kind") as a constraint on their question.
- If an unconsumed prompt idea below is a good fit for today, prefer using it (adapted to the question format if needed, in the question for whichever person it suits) and cite its id in "usedIdeaId"; otherwise leave "usedIdeaId" null. Never force in a bad-fit idea just because one exists.
- If a person's context is empty or sparse (day one, or early on), lean toward broad, easy exploration for them. This is fine and expected, do not treat it as a problem.
- Every context line is prefixed with the date it was recorded, and today's date is given below. Read threads and moods against that gap: a thread from a few days ago is probably still live, one from weeks ago may well be resolved, and a plan for a date that has now passed has already happened. Ask about a stale item in the past tense ("how did X go?") rather than as though it is still ahead of them, and never treat an old mood as how someone feels today.

Respond with strict JSON only, no prose, in exactly this shape:
{"theme":"short shared label, 2 to 6 words","a":{"prompt":"the question for person A","stance":"explore","topic":"kebab-case-subject","targetNodeId":null,"targetExplore":"daily-life"},"b":{"prompt":"the question for person B","stance":"exploit","topic":"kebab-case-subject","targetNodeId":14,"targetExplore":null},"rationale":"one sentence: what you drew on for each person, and how the two connect","usedIdeaId":null}`;

export interface GenerationInput {
  /** The date the prompt is for, so dated context lines can be aged. */
  today: string;
  /** Decided in code (see stance.ts), one per person. */
  stanceA: Stance;
  stanceB: Stance;
  names: Record<PersonId, string>;
  candidatesA: PersonCandidates;
  candidatesB: PersonCandidates;
  /** Dated mood lines, recency-windowed by the caller. */
  moodsA: string[];
  moodsB: string[];
  prefsA: string[];
  prefsB: string[];
  history: PromptHistoryEntry[];
  feedbackA: string[];
  feedbackB: string[];
  ideasA: { id: number; text: string }[];
  ideasB: { id: number; text: string }[];
  recentTopicsA: string[];
  recentTopicsB: string[];
  recentThemes: string[];
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
    lines.push(`    [${h.date}] "${own.text}" [stance: ${h.stance ?? "not recorded"}] (${own.outcome}${lengthPart})`);
  }
  return lines;
}

function candidateLines(name: string, c: PersonCandidates): string[] {
  const lines: string[] = [];
  const counts = Object.entries(c.domainCounts).map(([d, n]) => `${d}: ${n}`).join(" | ");
  lines.push(`  Their life as we know it (open nodes per area): ${counts}`);
  lines.push(`  EXPLOIT CANDIDATES for ${name} (exploit stance must cite one of these ids in "targetNodeId"):`);
  if (c.exploit.length === 0) {
    lines.push(`    (none today; if their stance says exploit anyway, explore instead and say so in the rationale)`);
  }
  for (const n of c.exploit) {
    const asked = n.lastAsked === null ? "never asked" : `last asked ${n.lastAsked}`;
    const flags = [n.rich ? "rich" : "thin", asked, n.live ? "LIVE" : null].filter(Boolean).join(", ");
    lines.push(`    [node ${n.id}] ${n.domain} / ${n.subdomain} (${flags}): ${n.summary}`);
    for (const f of n.facts) lines.push(`      - [${f.date}] ${f.text}`);
  }
  lines.push(`  EXPLORE CANDIDATES for ${name} (explore stance must cite one of these domains in "targetExplore"):`);
  lines.push(`    ${c.explore.join(" | ")}`);
  if (c.offLimits.length > 0) {
    lines.push(`  OFF LIMITS today (do not build a question on any of these):`);
    for (const o of c.offLimits) lines.push(`    ${o.domain} / ${o.subdomain} (${o.reason})`);
  }
  return lines;
}

function personSection(
  letter: "A" | "B",
  name: string,
  candidates: PersonCandidates,
  moods: string[],
  prefs: string[],
  feedback: string[],
  ideas: { id: number; text: string }[],
  stance: Stance,
  history: PromptHistoryEntry[],
  recentTopics: string[],
): string {
  const lines = [`PERSON ${letter}: ${name}`];
  lines.push(`  ASSIGNED STANCE FOR ${name.toUpperCase()}: ${stance.toUpperCase()}`);
  lines.push(...candidateLines(name, candidates));
  lines.push(`  Recent moods (time-bound, never durable): ${moods.length > 0 ? moods.join("; ") : "(none)"}`);
  lines.push(`  Prompt preferences (durable, from feedback): ${prefs.length > 0 ? prefs.join("; ") : "(none yet)"}`);
  lines.push(`  Recent raw feedback: ${feedback.length > 0 ? feedback.join("; ") : "(none)"}`);
  lines.push(
    `  Topics of their recent questions (DO NOT REPEAT, these are rejected automatically): ${
      recentTopics.length > 0 ? recentTopics.join(", ") : "(none yet)"
    }`,
  );
  lines.push(
    `  Unconsumed prompt ideas they suggested: ${
      ideas.length > 0 ? ideas.map((i) => `[id ${i.id}] ${i.text}`).join("; ") : "(none)"
    }`,
  );
  lines.push(...historyLines(letter, name, history));
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
    `PERSON A is ${input.names.a}. PERSON B is ${input.names.b}. Each person's question must come from their own section below, and only theirs.`,
  );
  lines.push("");
  lines.push(
    personSection("A", input.names.a, input.candidatesA, input.moodsA, input.prefsA, input.feedbackA, input.ideasA, input.stanceA, input.history, input.recentTopicsA),
  );
  lines.push("");
  lines.push(
    personSection("B", input.names.b, input.candidatesB, input.moodsB, input.prefsB, input.feedbackB, input.ideasB, input.stanceB, input.history, input.recentTopicsB),
  );
  return lines.join("\n");
}
