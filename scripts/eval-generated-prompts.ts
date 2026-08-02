#!/usr/bin/env bun
// Eval harness Phase 2: score the prompts System 3 actually generated,
// straight out of the ledger's generation_log, against the same rubric the
// static bank was scored with. Novelty here is the near-duplicate check
// against the prompt history that preceded each generation, since not
// repeating itself is the whole point of adaptive generation. Produces
// docs/eval-generated-prompts.md, comparable line-for-line with
// docs/eval-baseline-static-bank.md.
import { loadConfigFile } from "../src/config";
import { judgePrompt, passesAll, type Judgment } from "../src/eval/judge";
import { AXES } from "../src/eval/rubric";
import { NEAR_DUPLICATE_THRESHOLD, nearestPrior, repeatedStems, sameDayStemCollisions, type NearestPriorMatch } from "../src/eval/novelty";
import { Ledger } from "../src/ledger/ledger";
import { OpenRouterClient } from "../src/llm/openrouter";

/** Static-bank Phase 0 headline, hard-coded so the two reports are directly
 * comparable without re-running (and re-paying for) the baseline. */
const STATIC_BANK_BASELINE = { passing: 26, total: 30 };

const configPath = process.argv[2] ?? "config.json";
const config = await loadConfigFile(configPath);
const ledger = Ledger.open(config.ledgerPath);
const llm = new OpenRouterClient(config.openrouter.apiKey, config.extraction.model);

const rows = ledger.allGenerationLog();
const generated = rows.filter((r) => !r.fellBack && r.promptText !== null);
const fellBack = rows.filter((r) => r.fellBack);

interface Scored {
  date: string;
  person: string;
  text: string;
  rationale: string | null;
  stance: string | null;
  lane: string | null;
  model: string | null;
  judgment: Judgment;
  novelty: NearestPriorMatch | null;
}

const scored: Scored[] = [];
for (const row of generated) {
  // Priors are that PERSON's own prior questions, not the day-level text.
  // The day row now holds a shared theme, and comparing a question against a
  // theme label (or against the partner's question) measures the wrong thing.
  // Not window-limited: a repeat from outside the generator's context window
  // is still a repeat to the person receiving it.
  const person = row.person ?? "a";
  const priors = ledger.personPromptsBefore(row.date, person as "a" | "b");
  scored.push({
    date: row.date,
    person: row.person ?? "(shared)",
    text: row.promptText!,
    rationale: row.rationale,
    stance: row.stance,
    lane: row.lane ?? null,
    model: row.model,
    judgment: await judgePrompt(row.promptText!, llm),
    novelty: nearestPrior(row.promptText!, priors),
  });
}

const failing = scored.filter((s) => !passesAll(s.judgment));
const passCount = scored.length - failing.length;
const nearDupes = scored.filter((s) => s.novelty?.isNearDuplicate);


const axisFailures = Object.fromEntries(
  AXES.map(([axis]) => [axis, scored.filter((s) => !s.judgment[axis]).length]),
) as Record<(typeof AXES)[number][0], number>;

/** The three-way lane truth (2026-08-02 synthesis design: followup/exploit/
 * explore) is now recorded explicitly in generation_log.lane at dispatch.
 * Rows predating that column (stance was the only signal then) fall back to
 * classifying the two-value stance, or failing that the free-text rationale;
 * a historical exploit row can never be told apart from a followup row after
 * the fact, so it reports as "exploit", not a guessed "followup". "unclear"
 * still exists for the oldest rows that predate even stance. */
function lane(row: { lane: string | null; stance: string | null; rationale: string | null }): "followup" | "exploit" | "explore" | "unclear" {
  if (row.lane === "followup" || row.lane === "exploit" || row.lane === "explore") return row.lane;
  if (row.stance === "exploit" || row.stance === "explore") return row.stance;
  const rationale = row.rationale;
  if (!rationale) return "unclear";
  const r = rationale.toLowerCase();
  const exploit = /exploit|follow(ing)? up|building on|known thread|open thread|their interest/.test(r);
  const explore = /explor|new topic|uncovered|not (yet )?covered|neither|broaden|fresh/.test(r);
  if (exploit && !explore) return "exploit";
  if (explore && !exploit) return "explore";
  if (exploit && explore) return "unclear";
  return "unclear";
}

const lanes = { followup: 0, exploit: 0, explore: 0, unclear: 0 };
for (const s of scored) lanes[lane(s)]++;

const pct = (n: number, d: number) => (d === 0 ? "n/a" : `${Math.round((n / d) * 100)}%`);
const mark = (b: boolean) => (b ? "✅" : "❌");

const lines: string[] = [];
lines.push(`# Eval: Generated Prompts (Phase 2)`);
lines.push("");
lines.push(`Generated ${new Date().toISOString()}. Judge model: ${config.extraction.model}. Source: \`generation_log\` in the live ledger.`);
lines.push("");
lines.push(`## Summary`);
lines.push("");
lines.push(`- ${rows.length} generation attempt(s) recorded; ${generated.length} produced a generated prompt, ${fellBack.length} fell back to the static bank.`);
lines.push(`- ${passCount}/${scored.length} generated prompts pass all four rubric axes (answerable, single question, appropriate length, emotionally safe).`);
lines.push(`- **Comparison to the static-bank baseline: ${passCount}/${scored.length} (${pct(passCount, scored.length)}) generated vs ${STATIC_BANK_BASELINE.passing}/${STATIC_BANK_BASELINE.total} (${pct(STATIC_BANK_BASELINE.passing, STATIC_BANK_BASELINE.total)}) static bank.**`);
lines.push(`- ${nearDupes.length} generated prompt(s) near-duplicate a prompt that preceded them (Jaccard over content words, threshold ${NEAR_DUPLICATE_THRESHOLD}).`);
lines.push("");

lines.push(`## Aggregate`);
lines.push("");
lines.push(`### Fallback rate`);
lines.push("");
// Counted over distinct dates, not rows: a generated day writes one row per
// person while a fallback day writes one row total, so a row-based rate
// understates fallbacks by up to half.
const allDates = new Set(rows.map((r) => r.date));
const fellBackDates = new Set(fellBack.map((r) => r.date));
lines.push(`${fellBackDates.size}/${allDates.size} (${pct(fellBackDates.size, allDates.size)}) of days fell back to the static bank.`);
if (fellBack.length > 0) {
  lines.push("");
  for (const f of fellBack) lines.push(`- \`${f.date}\`: ${f.fallbackReason ?? "(no reason recorded)"}`);
}
lines.push("");
lines.push(`### Lane mix`);
lines.push("");
lines.push(`Read from the recorded lane column (followup/exploit/explore), falling back to stance and then the rationale for rows predating it:`);
lines.push("");
lines.push(`| lane | count | share |`);
lines.push(`|---|---|---|`);
for (const [k, v] of Object.entries(lanes)) lines.push(`| ${k} | ${v} | ${pct(v, scored.length)} |`);
lines.push("");
lines.push(`### Axis failure distribution`);
lines.push("");
lines.push(`| axis | failures | rate |`);
lines.push(`|---|---|---|`);
for (const [axis] of AXES) lines.push(`| ${axis} | ${axisFailures[axis]} | ${pct(axisFailures[axis], scored.length)} |`);
lines.push("");

lines.push(`## Novelty against prior history`);
lines.push("");
if (scored.length === 0) {
  lines.push(`No generated prompts to check.`);
} else {
  lines.push(`| date | person | prompt | closest prior (theirs) | similarity | near-dup |`);
  lines.push(`|---|---|---|---|---|---|`);
  for (const s of scored) {
    const n = s.novelty;
    lines.push(
      `| ${s.date} | ${s.person} | ${s.text} | ${n ? n.text : "(no prior history)"} | ${n ? n.similarity.toFixed(2) : "n/a"} | ${n ? mark(!n.isNearDuplicate) : "✅"} |`,
    );
  }
}
lines.push("");

lines.push(`### Template repetition`);
lines.push("");
lines.push(
  `Content-word overlap is blind to shared scaffolding, so opening templates are checked separately: two prompts can score near zero on Jaccard while being built from the identical sentence frame.`,
);
lines.push("");
const collisions = sameDayStemCollisions(
  scored.map((s) => ({ date: s.date, person: s.person, text: s.text })),
);
if (collisions.length === 0) {
  lines.push(`No day gave both people the same opening frame.`);
} else {
  for (const c of collisions) {
    lines.push(`- \`${c.date}\` gave both people the frame \`${c.stem}...\`:`);
    for (const p of c.prompts) lines.push(`  - (${p.person}) "${p.text}"`);
  }
}
lines.push("");

const stems = repeatedStems(scored.map((s) => s.text));
if (stems.length === 0) {
  lines.push(`No opening template is reused across the generated prompts.`);
} else {
  for (const s of stems) {
    lines.push(`- \`${s.stem}...\` used ${s.count} times:`);
    for (const t of s.texts) lines.push(`  - "${t}"`);
  }
}
lines.push("");

lines.push(`## Failing prompts`);
lines.push("");
if (failing.length === 0) {
  lines.push(`None.`);
} else {
  for (const s of failing) {
    lines.push(`### \`${s.date}\`: "${s.text}"`);
    for (const [axis, reasonKey] of AXES) {
      if (!s.judgment[axis]) lines.push(`- **${axis}**: FAIL — ${s.judgment[reasonKey]}`);
    }
    lines.push("");
  }
}
lines.push("");

lines.push(`## Full results`);
lines.push("");
lines.push(`| date | prompt | answerable | single | length | safe | novelty | fell back |`);
lines.push(`|---|---|---|---|---|---|---|---|`);
for (const s of scored) {
  const novel = s.novelty ? mark(!s.novelty.isNearDuplicate) : "✅";
  lines.push(
    `| ${s.date} | ${s.text} | ${mark(s.judgment.answerable)} | ${mark(s.judgment.singleQuestion)} | ${mark(s.judgment.appropriateLength)} | ${mark(s.judgment.emotionallySafe)} | ${novel} | no |`,
  );
}
for (const f of fellBack) {
  lines.push(`| ${f.date} | (fell back to static bank) | - | - | - | - | - | yes |`);
}
lines.push("");

lines.push(`## Recorded rationales`);
lines.push("");
for (const s of scored) {
  lines.push(`- \`${s.date}\` (${lane(s)}): ${s.rationale ?? "(none recorded)"}`);
}
lines.push("");

await Bun.write("docs/eval-generated-prompts.md", lines.join("\n"));
ledger.close();
console.error(
  `Wrote docs/eval-generated-prompts.md (${passCount}/${scored.length} passing, ${nearDupes.length} near-duplicates, ${fellBack.length}/${rows.length} fell back)`,
);
