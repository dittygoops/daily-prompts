import { z } from "zod";
import type { PersonId } from "../config";
import type { Ledger } from "../ledger/ledger";
import type { LlmClient } from "../llm/types";

const HIGHLIGHT_SYSTEM_PROMPT = `You write the weekly recap for a couple's daily check-in, sent back to both of them.

You produce two things:

1. "topics": a short, general list of themes from the week, as a single comma-separated phrase (e.g. "cooking, weekend plans, a concert"). These are broad categories, NOT the literal questions asked and NOT a recitation of each day. 2-4 items. Empty string if the week was too quiet to name any.

2. "highlight": imagine you're a close friend of this couple who read their answers this week, and now you're telling them the one thing that stuck with you, out loud, across the dinner table. Write exactly what you'd say: 2-3 sentences, casual, specific, second person ("you two", or naming each person naturally). Pick ONE thing, and it must involve BOTH people's answers: the best coincidence, echo, or contrast between something each of them said this week. Never build the highlight around only one person's answer. Only if the week truly has no link between their answers, take one small moment from each person and weave them into a single thought (not two separate blurbs). Skip everything else from the week.

Banned entirely in "highlight": opening with "It's", "It sounds like", "You both mentioned", or "Apparently"; the words "sweet", "lovely", "cherished", "shows", "highlights", "connection"; any final sentence that explains the meaning of what you just said. Say the thing, land it, stop.

Humor rule: a joke is optional, not required. If you joke, aim it at the coincidence or situation, never at the two people. Any sentence whose subject is "you two" doing something in aggregate ("you two structured...", "neither of you can...", "you both always...") is an exaggerated characterization of them: delete it and end on the sharpest concrete detail instead. Never comment on how much they eat, spend, play, or sleep. Never apply exaggeration words ("every", "always", "entire", "all", "apparently") to the couple or their lives. Teasing the universe for lining their answers up is great; teasing them is not. When in doubt, no joke: land on the detail and stop.

These examples show the RANGE of the highlight voice, each is built differently. Your output must not copy the structure, opener, or wording of any of them, invent a shape that fits this week's material:
- "Neither of you planned it, but you answered a question about home with the exact same street food stall. Someone owes someone a trip."
- "Ria spent Tuesday defending pineapple on pizza and Aditya spent Thursday listing his food dealbreakers, and somehow pineapple survived both. Growth."
- "The way you two talk about your grandmothers could be the same person: the unsolicited second helpings, the guilt trips, all of it."
- "You answered the comfort food question three hours apart with the same exact dish, neither of you having seen the other's answer. Different kitchens, same craving."

Shared rules for both fields:
- Only reference things actually present in the provided answers below — never invent details.
- Do not judge or critique either person's answers or engagement.
- If the week was quiet (few or no answers), say so gently and warmly in "highlight", don't fabricate content.

Respond with strict JSON only, no prose, in exactly this shape:
{"topics":"...","highlight":"..."}`;

const responseSchema = z.object({ topics: z.string(), highlight: z.string().min(1) });

const MAX_ATTEMPTS = 2;

/** Claude models often wrap JSON responses in \`\`\`json fences despite
 * "strict JSON only" instructions; strip them before parsing. */
function stripCodeFences(raw: string): string {
  return raw.trim().replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```$/, "");
}

function buildUserPrompt(ledger: Ledger, weekStart: string, weekEnd: string, names: Record<PersonId, string>): string {
  const days = ledger.daysInRange(weekStart, weekEnd);
  const lines = [`Week: ${weekStart} to ${weekEnd}`];
  for (const day of days) {
    const a = ledger.personDay(day.id, "a");
    const b = ledger.personDay(day.id, "b");
    lines.push(`[${day.date}] "${day.prompt_text}"`);
    lines.push(`  ${names.a}: ${a.state === "answered" ? a.response_text : `(${a.state})`}`);
    lines.push(`  ${names.b}: ${b.state === "answered" ? b.response_text : `(${b.state})`}`);
  }
  return lines.join("\n");
}

/** LLM-synthesized highlight of the week's actual answers. Throws on any
 * failure — the caller (src/recap/recap.ts) degrades to the mechanical
 * tier, same fallback philosophy as System 3's FallbackPromptSource. */
export interface WeekHighlight {
  topics: string;
  highlight: string;
}

export async function generateHighlight(
  ledger: Ledger,
  weekStart: string,
  weekEnd: string,
  names: Record<PersonId, string>,
  llm: LlmClient,
  _model: string,
): Promise<WeekHighlight> {
  const userPrompt = buildUserPrompt(ledger, weekStart, weekEnd, names);

  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const raw = await llm.complete(HIGHLIGHT_SYSTEM_PROMPT, userPrompt);
    let parsed: unknown;
    try {
      parsed = JSON.parse(stripCodeFences(raw));
    } catch {
      lastError = new Error(`generateHighlight: LLM response was not valid JSON: ${raw.slice(0, 200)}`);
      continue;
    }
    const shaped = responseSchema.safeParse(parsed);
    if (!shaped.success) {
      lastError = new Error(`generateHighlight: LLM response missing "highlight"`);
      continue;
    }
    return shaped.data;
  }
  throw lastError!;
}
