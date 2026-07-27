import type { PersonId } from "../config";
import type { PersonContext } from "../memory/types";
import type { PromptHistoryEntry } from "./history";
import type { Stance } from "./stance";

/** The daily-prompt-generation system prompt. Reviewed by the product
 * owner, same as engine/copy.ts's message wording and
 * extraction/prompt.ts's extraction rules. */
export const ADAPTIVE_SYSTEM_PROMPT = `You write the single daily check-in question for a couple. Both people receive the identical prompt at the same time.

Rules:
- Answerable in 15-30 seconds: one short, concrete question. Never a compound question, never something requiring research or a long reflection.
- Never repeat or closely near-duplicate a prompt from the recent history below — check it before writing.
- Emotionally safe: warm, curious-friend tone, never hurtful, manipulative, leading, or presumptuous about sensitive or relationship-sensitive facts not clearly present in the context below. If a person's context shows a heavy or sensitive open thread (grief, stress, conflict), do not force levity onto it and do not build the daily prompt around it in a way that could feel like an ambush — prefer a lighter topic that day unless the context clearly signals they want to talk about it.
- Never surface something private to one person in a way that outs it to the other before they've shared it themselves — since both people get the identical prompt, don't reference one person's private thread if the other doesn't already know about it. This protects genuinely sensitive material: health, grief, money trouble, conflict, anything one person is clearly still processing alone. It is NOT a reason to avoid ordinary everyday threads. Hobbies, plans, trips, jobs, what someone is practising or reading are all normal things a couple already talks about, and building the day's question around one of those is the intended behaviour, not a privacy breach.
- Today's stance is assigned to you below and is not yours to choose. Follow it exactly and echo it back in "stance".
  - EXPLOIT means the question must name or directly build on something specific from one person's actual threads, interests, or facts below, so that it would make no sense asked of anybody else. "What are you looking forward to this week?" is NOT an exploit even when someone has plans in their threads; "How did the psychic reading party end up going?" is. If the assigned stance is exploit, pick the single most alive item in either person's context and ask about that thing by name.
  - EXPLORE means opening a topic neither person's coverage list touches yet.
  - Do not exploit a thread that a prompt in the recent history below already asked about. Once a thread has had its day, move to a different one; a second question about the same event reads as not having listened to the answer.
- Vary your sentence structure. Do not reuse the opening frame of any recent prompt below (for instance, following "What's one thing you're..." with another "What's one thing you're..."), even when the subject is different. Reach for a different shape: a "when" question, a "would you rather", a concrete "last time you..." and so on.
- Respect standing taste feedback (e.g. "too long", "loved this kind") as a constraint on future prompts.
- If an unconsumed prompt idea below is a good fit for today, prefer using it (adapted to the question format if needed) and cite its id in "usedIdeaId"; otherwise leave "usedIdeaId" null. Never force in a bad-fit idea just because one exists.
- If both people's context is empty or sparse (day one, or early on), lean toward broad, easy exploration — this is fine and expected, do not treat it as a problem.
- Every context line is prefixed with the date it was recorded, and today's date is given below. Read threads and moods against that gap: a thread from a few days ago is probably still live, one from weeks ago may well be resolved, and a plan for a date that has now passed has already happened. Ask about a stale item in the past tense ("how did X go?") rather than as though it is still ahead of them, and never treat an old mood as how someone feels today.

Respond with strict JSON only, no prose, in exactly this shape:
{"prompt":"...","stance":"explore","rationale":"one sentence: what specifically you drew on, and why that stance","usedIdeaId":null}`;

export interface GenerationInput {
  /** The date the prompt is for, so dated context lines can be aged. */
  today: string;
  /** Decided in code (see stance.ts), not by the model. */
  stance: Stance;
  names: Record<PersonId, string>;
  contextA: PersonContext;
  contextB: PersonContext;
  coverageA: string[];
  coverageB: string[];
  history: PromptHistoryEntry[];
  feedbackA: string[];
  feedbackB: string[];
  ideasA: { id: number; text: string }[];
  ideasB: { id: number; text: string }[];
}

function contextSection(name: string, ctx: PersonContext, coverage: string[], feedback: string[], ideas: { id: number; text: string }[]): string {
  const lines = [`${name}'s context:`];
  lines.push(`  Facts: ${ctx.facts.length > 0 ? ctx.facts.join("; ") : "(none yet)"}`);
  lines.push(`  Open threads: ${ctx.threads.length > 0 ? ctx.threads.join("; ") : "(none yet)"}`);
  lines.push(`  Interests: ${ctx.interests.length > 0 ? ctx.interests.join("; ") : "(none yet)"}`);
  lines.push(`  Recent moods: ${ctx.recentMoods.length > 0 ? ctx.recentMoods.join("; ") : "(none)"}`);
  lines.push(`  Prompt preferences (durable, from feedback): ${ctx.promptPreferences.length > 0 ? ctx.promptPreferences.join("; ") : "(none yet)"}`);
  lines.push(`  Topics already covered: ${coverage.length > 0 ? coverage.join(", ") : "(none yet — everything is unexplored)"}`);
  lines.push(`  Recent raw feedback: ${feedback.length > 0 ? feedback.join("; ") : "(none)"}`);
  lines.push(
    `  Unconsumed prompt ideas they suggested: ${
      ideas.length > 0 ? ideas.map((i) => `[id ${i.id}] ${i.text}`).join("; ") : "(none)"
    }`,
  );
  return lines.join("\n");
}

export function buildGenerationUserPrompt(input: GenerationInput): string {
  const lines: string[] = [];
  lines.push(`Today is ${input.today}. Every dated line below was recorded on the date shown.`);
  lines.push("");
  lines.push(`TODAY'S ASSIGNED STANCE: ${input.stance.toUpperCase()}`);
  lines.push("");
  lines.push(contextSection(input.names.a, input.contextA, input.coverageA, input.feedbackA, input.ideasA));
  lines.push("");
  lines.push(contextSection(input.names.b, input.contextB, input.coverageB, input.feedbackB, input.ideasB));
  lines.push("");
  lines.push("Recent prompt history (most recent first, do not repeat these):");
  if (input.history.length === 0) {
    lines.push("  (none yet — this may be day one)");
  } else {
    for (const h of input.history) {
      lines.push(
        `  [${h.date}] "${h.text}" [stance: ${h.stance ?? "not recorded"}] — ${input.names.a}: ${h.a.outcome}${h.a.responseLength !== null ? ` (${h.a.responseLength} chars)` : ""}, ${input.names.b}: ${h.b.outcome}${h.b.responseLength !== null ? ` (${h.b.responseLength} chars)` : ""}`,
      );
    }
  }
  return lines.join("\n");
}
