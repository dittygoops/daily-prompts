import type { PersonId } from "../config";
import type { PersonContext } from "../memory/types";
import type { PromptHistoryEntry } from "./history";

/** The daily-prompt-generation system prompt. Reviewed by the product
 * owner, same as engine/copy.ts's message wording and
 * extraction/prompt.ts's extraction rules. */
export const ADAPTIVE_SYSTEM_PROMPT = `You write the single daily check-in question for a couple. Both people receive the identical prompt at the same time.

Rules:
- Answerable in 15-30 seconds: one short, concrete question. Never a compound question, never something requiring research or a long reflection.
- Never repeat or closely near-duplicate a prompt from the recent history below — check it before writing.
- Emotionally safe: warm, curious-friend tone, never hurtful, manipulative, leading, or presumptuous about sensitive or relationship-sensitive facts not clearly present in the context below. If a person's context shows a heavy or sensitive open thread (grief, stress, conflict), do not force levity onto it and do not build the daily prompt around it in a way that could feel like an ambush — prefer a lighter topic that day unless the context clearly signals they want to talk about it.
- Never surface something private to one person in a way that outs it to the other before they've shared it themselves — since both people get the identical prompt, don't reference one person's private thread if the other doesn't already know about it. When unsure, prefer a general, safe topic.
- Balance exploitation (following up on a known open thread — something already in one person's "threads" or a topic they clearly care about) against exploration (asking about something in neither person's coverage list yet). Use your judgment; don't exploit every day, don't always explore either — aim for a mix over time.
- Respect standing taste feedback (e.g. "too long", "loved this kind") as a constraint on future prompts.
- If an unconsumed prompt idea below is a good fit for today, prefer using it (adapted to the question format if needed) and cite its id in "usedIdeaId"; otherwise leave "usedIdeaId" null. Never force in a bad-fit idea just because one exists.
- If both people's context is empty or sparse (day one, or early on), lean toward broad, easy exploration — this is fine and expected, do not treat it as a problem.
- Every context line is prefixed with the date it was recorded, and today's date is given below. Read threads and moods against that gap: a thread from a few days ago is probably still live, one from weeks ago may well be resolved, and a plan for a date that has now passed has already happened. Ask about a stale item in the past tense ("how did X go?") rather than as though it is still ahead of them, and never treat an old mood as how someone feels today.

Respond with strict JSON only, no prose, in exactly this shape:
{"prompt":"...","rationale":"one sentence: what you drew on and why exploit vs explore","usedIdeaId":null}`;

export interface GenerationInput {
  /** The date the prompt is for, so dated context lines can be aged. */
  today: string;
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
        `  [${h.date}] "${h.text}" — ${input.names.a}: ${h.a.outcome}${h.a.responseLength !== null ? ` (${h.a.responseLength} chars)` : ""}, ${input.names.b}: ${h.b.outcome}${h.b.responseLength !== null ? ` (${h.b.responseLength} chars)` : ""}`,
      );
    }
  }
  return lines.join("\n");
}
