#!/usr/bin/env bun
// Filing eval for the 2026-08-02 ee-synthesis-design's extractor extension
// (family, eventDate, alsoAbout). Runs the REAL extractor against the
// paraphrased golden fixtures in tests/golden/filing/fixtures.ts and scores
// subject/kind/family/multi-home/eventDate accuracy against each fixture's
// hand-labeled `expected` block.
//
// This calls a real (paid) LLM, so it refuses to run at all unless invoked
// with an explicit --run flag - a bare `bun scripts/eval-filing.ts` does
// nothing but print usage and exit 1, on the same "no accidental spend"
// principle as this repo's other eval scripts require a config path. --dry
// is the free path: it only validates the fixtures' own shape (every
// expected field internally consistent - no LLM, no ledger, no network).
import { ALL_DOMAINS } from "../src/ontology/types";
import { ALL_FAMILIES, type Family } from "../src/selection/types";
import { extractObservations, type ExtractedFact } from "../src/extraction/extractor";
import { FILING_FIXTURES, type FilingFixture } from "../tests/golden/filing/fixtures";

function usage(): never {
  console.error(
    [
      "Usage:",
      "  bun scripts/eval-filing.ts --dry              # validate fixture shape only, no LLM calls, free",
      "  bun scripts/eval-filing.ts --run [configPath]  # run the real extractor over the fixtures (PAID)",
      "",
      "Refuses to do anything without one of these flags: this script calls a",
      "real LLM under --run and must never fire by accident.",
    ].join("\n"),
  );
  process.exit(1);
}

// ---- --dry: fixture shape validation, no LLM, no network ----

function validateFixtureShape(fixtures: FilingFixture[]): string[] {
  const problems: string[] = [];
  const seenIds = new Set<string>();
  for (const f of fixtures) {
    if (seenIds.has(f.id)) problems.push(`duplicate fixture id "${f.id}"`);
    seenIds.add(f.id);

    if (f.response.trim().length === 0) problems.push(`${f.id}: empty response`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(f.date)) problems.push(`${f.id}: date "${f.date}" is not YYYY-MM-DD`);

    for (const n of f.existingNodes) {
      if (!(ALL_DOMAINS as readonly string[]).includes(n.domain)) {
        problems.push(`${f.id}: existingNodes has invalid domain "${n.domain}"`);
      }
    }

    for (const fam of f.expected.families) {
      if (fam !== null && !(ALL_FAMILIES as readonly string[]).includes(fam)) {
        problems.push(`${f.id}: expected family "${fam}" is not in ALL_FAMILIES`);
      }
    }

    for (const kind of f.expected.kinds) {
      if (!["fact", "thread", "interest"].includes(kind)) {
        problems.push(`${f.id}: expected kind "${kind}" is not a valid fact kind`);
      }
    }

    for (const d of f.expected.eventDates) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) problems.push(`${f.id}: expected eventDate "${d}" is not YYYY-MM-DD`);
    }

    if (f.expected.multiHomes && f.expected.subjects.length < 2) {
      problems.push(`${f.id}: multiHomes true but fewer than 2 expected subjects`);
    }

    // A fixture with zero expected subjects should also expect zero kinds,
    // families, and event dates - "nothing extractable" must be internally
    // consistent, not a fixture that forgot to fill in the rest.
    if (f.expected.subjects.length === 0) {
      if (f.expected.kinds.length > 0) problems.push(`${f.id}: no expected subjects but non-empty expected kinds`);
      if (f.expected.eventDates.length > 0) problems.push(`${f.id}: no expected subjects but non-empty expected eventDates`);
    }
  }
  if (fixtures.length < 8 || fixtures.length > 12) {
    problems.push(`expected 8-12 fixtures, found ${fixtures.length}`);
  }
  return problems;
}

// ---- --run: real extraction + scoring ----

interface FixtureScore {
  id: string;
  subjectAccuracy: number;
  kindAccuracy: number;
  familyAccuracy: number;
  multiHomeCorrect: boolean;
  eventDateAccuracy: number;
}

function subdomainsOf(fact: ExtractedFact): string[] {
  const subdomains: string[] = [];
  const add = (t: ExtractedFact["target"]) => {
    if ("newNode" in t) subdomains.push(t.newNode.subdomain);
  };
  add(fact.target);
  for (const also of fact.alsoAbout) add(also);
  return subdomains;
}

/** Jaccard-style overlap between two string sets, in [0, 1]. 1 when both are
 * empty (nothing expected, nothing found - a correct "flat answer" call). */
function setOverlap<T>(expected: T[], actual: T[]): number {
  const e = new Set(expected);
  const a = new Set(actual);
  if (e.size === 0 && a.size === 0) return 1;
  const intersection = [...e].filter((x) => a.has(x)).length;
  const union = new Set([...e, ...a]).size;
  return union === 0 ? 1 : intersection / union;
}

async function scoreFixture(fixture: FilingFixture, llm: import("../src/llm/types").LlmClient): Promise<FixtureScore> {
  const result = await extractObservations(
    {
      dayId: 0,
      date: fixture.date,
      promptText: fixture.promptText,
      person: fixture.person,
      response: fixture.response,
      skipped: false,
      feedback: [],
      existingNodes: fixture.existingNodes,
    },
    llm,
    () => {},
  );

  const actualSubjects = result.facts.flatMap(subdomainsOf);
  const actualKinds = result.facts.map((f) => f.kind);
  const actualFamilies: (Family | null)[] = result.facts.map((f) => f.family);
  const actualEventDates = result.facts.map((f) => f.eventDate).filter((d): d is string => d !== null);
  const actualMultiHomes = result.facts.some((f) => f.alsoAbout.length > 0);

  return {
    id: fixture.id,
    subjectAccuracy: setOverlap(fixture.expected.subjects, actualSubjects),
    kindAccuracy: setOverlap(fixture.expected.kinds, actualKinds),
    familyAccuracy: setOverlap(fixture.expected.families, actualFamilies),
    multiHomeCorrect: fixture.expected.multiHomes === actualMultiHomes,
    eventDateAccuracy: setOverlap(fixture.expected.eventDates, actualEventDates),
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--dry")) {
    const problems = validateFixtureShape(FILING_FIXTURES);
    if (problems.length > 0) {
      console.error(`${problems.length} fixture shape problem(s):`);
      for (const p of problems) console.error(`  - ${p}`);
      process.exit(1);
    }
    console.log(`${FILING_FIXTURES.length} fixtures, shape OK. (--dry: no LLM calls made)`);
    return;
  }

  if (!args.includes("--run")) usage();

  // Only reached with an explicit --run: this branch calls a real, paid LLM.
  const { loadConfigFile } = await import("../src/config");
  const { OpenRouterClient } = await import("../src/llm/openrouter");
  const configPath = args.find((a) => a !== "--run") ?? "config.json";
  const config = await loadConfigFile(configPath);
  const llm = new OpenRouterClient(config.openrouter.apiKey, config.extraction.model);

  const scores: FixtureScore[] = [];
  for (const fixture of FILING_FIXTURES) {
    scores.push(await scoreFixture(fixture, llm));
  }

  const avg = (nums: number[]) => (nums.length === 0 ? 0 : nums.reduce((a, b) => a + b, 0) / nums.length);
  console.log(`Filing eval: ${scores.length} fixtures`);
  console.log(`  subject accuracy:    ${(avg(scores.map((s) => s.subjectAccuracy)) * 100).toFixed(1)}%`);
  console.log(`  kind accuracy:       ${(avg(scores.map((s) => s.kindAccuracy)) * 100).toFixed(1)}%`);
  console.log(`  family accuracy:     ${(avg(scores.map((s) => s.familyAccuracy)) * 100).toFixed(1)}%`);
  console.log(`  multi-home correct:  ${scores.filter((s) => s.multiHomeCorrect).length}/${scores.length}`);
  console.log(`  eventDate accuracy:  ${(avg(scores.map((s) => s.eventDateAccuracy)) * 100).toFixed(1)}%`);
  console.log("");
  for (const s of scores) {
    console.log(
      `  ${s.id}: subject=${s.subjectAccuracy.toFixed(2)} kind=${s.kindAccuracy.toFixed(2)} family=${s.familyAccuracy.toFixed(2)} multiHome=${s.multiHomeCorrect} eventDate=${s.eventDateAccuracy.toFixed(2)}`,
    );
  }
}

await main();
