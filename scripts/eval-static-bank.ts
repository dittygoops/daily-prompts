#!/usr/bin/env bun
// Eval harness Phase 0: score the existing static prompt bank against the
// answerability/format/safety axes, plus a deterministic within-bank
// novelty check. Produces docs/eval-baseline-static-bank.md as a reusable
// baseline to compare System 3's generated prompts against later.
import bank from "../data/prompts.json";
import { loadConfigFile } from "../src/config";
import { judgePrompt, passesAll, type Judgment } from "../src/eval/judge";
import { AXES } from "../src/eval/rubric";
import { findExactDuplicates } from "../src/eval/novelty";
import { OpenRouterClient } from "../src/llm/openrouter";

const configPath = process.argv[2] ?? "config.json";
const config = await loadConfigFile(configPath);
const llm = new OpenRouterClient(config.openrouter.apiKey, config.extraction.model);

const dupes = findExactDuplicates(bank);

const results: { id: string; text: string; judgment: Judgment }[] = [];
for (const prompt of bank) {
  const judgment = await judgePrompt(prompt.text, llm);
  results.push({ id: prompt.id, text: prompt.text, judgment });
}

const failing = results.filter((r) => !passesAll(r.judgment));
const passCount = results.length - failing.length;

const lines: string[] = [];
lines.push(`# Eval Baseline: Static Prompt Bank (Phase 0)`);
lines.push("");
lines.push(`Generated ${new Date().toISOString()}. Model: ${config.extraction.model}.`);
lines.push("");
lines.push(`## Summary`);
lines.push("");
lines.push(`- ${bank.length} prompts scored.`);
lines.push(`- ${passCount}/${bank.length} pass all four rubric axes (answerable, single question, appropriate length, emotionally safe).`);
lines.push(`- ${dupes.length} exact within-bank duplicate(s).`);
lines.push("");

if (dupes.length > 0) {
  lines.push(`## Exact duplicates`);
  lines.push("");
  for (const d of dupes) lines.push(`- \`${d.a}\` / \`${d.b}\`: "${d.text}"`);
  lines.push("");
}

if (failing.length > 0) {
  lines.push(`## Failing prompts`);
  lines.push("");
  for (const r of failing) {
    lines.push(`### \`${r.id}\`: "${r.text}"`);
    for (const [axis, reasonKey] of AXES) {
      const pass = r.judgment[axis];
      if (!pass) lines.push(`- **${axis}**: FAIL — ${r.judgment[reasonKey]}`);
    }
    lines.push("");
  }
} else {
  lines.push(`## Failing prompts`);
  lines.push("");
  lines.push(`None.`);
  lines.push("");
}

lines.push(`## Full results`);
lines.push("");
lines.push(`| id | prompt | answerable | single | length | safe |`);
lines.push(`|---|---|---|---|---|---|`);
for (const r of results) {
  const mark = (b: boolean) => (b ? "✅" : "❌");
  lines.push(
    `| \`${r.id}\` | ${r.text} | ${mark(r.judgment.answerable)} | ${mark(r.judgment.singleQuestion)} | ${mark(r.judgment.appropriateLength)} | ${mark(r.judgment.emotionallySafe)} |`,
  );
}
lines.push("");

const report = lines.join("\n");
await Bun.write("docs/eval-baseline-static-bank.md", report);
console.error(`Wrote docs/eval-baseline-static-bank.md (${passCount}/${bank.length} passing, ${dupes.length} duplicates)`);
