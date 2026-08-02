#!/usr/bin/env bun
// P7: seed bank loader (docs/superpowers/specs/2026-08-02-ee-synthesis-design.md,
// "Feasibility" and "Work breakdown, interfaces, tests, seeds"). Parses
// data/seeds.tsv, validates it against every rule the spec's seed logistics
// name (stable unique ids, closed domain/family vocabularies, the two
// coverage minimums, warmth ordering, and the owner-review stamp gate), and
// only then writes via Ledger.replaceSeeds. `--check` runs every validation
// with no db touched at all, so CI or a pre-commit hook can gate on it
// without a ledger file lying around.
import { readFileSync } from "fs";
import { join } from "path";
import { Ledger } from "../src/ledger/ledger";
import type { NodeDomain } from "../src/ledger/ledger";
import { ALL_FAMILIES, type Family, type SeedRow } from "../src/selection/types";

// Mirrors the 11-domain CHECK in src/ledger/schema.sql / the NodeDomain type
// in src/ledger/ledger.ts. src/ontology/types.ts's ALL_DOMAINS predates the
// 2026-08-02 'tastes-preferences' domain and only lists 10, so it is the
// wrong vocabulary for a seed bank that must cover all 11; this loader keeps
// its own copy rather than importing a stale one.
export const ALL_DOMAINS: readonly NodeDomain[] = [
  "career-academics", "childhood", "family", "relationships-friends",
  "hobbies-interests", "health-body", "daily-life", "beliefs-values",
  "plans-future", "other", "tastes-preferences",
];

const FAMILIES_ALLOWED_1_TO_20: readonly Family[] = ["food", "play", "daily-mechanics", "home"];
const MIN_SEEDS_PER_DOMAIN = 8;
const MIN_FAMILIES_PER_DOMAIN = 4;
const MIN_SEEDS_PER_FAMILY = 6;
const MIN_DOMAINS_PER_FAMILY = 3;

export interface ParsedSeeds {
  reviewedStamp: string;
  rows: SeedRow[];
}

/** Parses the TSV: a `# reviewed: <stamp>` header line, then
 * `id\tdomain\tfamily\ttext` rows. Blank lines and further `#` comment lines
 * are skipped. Throws on any line that doesn't split into exactly 4
 * tab-separated fields with a numeric id, so a malformed row fails loudly
 * rather than silently dropping a column. */
export function parseSeedsFile(content: string): ParsedSeeds {
  const lines = content.split("\n");
  const headerLine = lines.find((l) => l.trim() !== "");
  const headerMatch = headerLine?.match(/^#\s*reviewed:\s*(.+?)\s*$/);
  if (!headerMatch) {
    throw new Error(`seeds.tsv must start with a "# reviewed: <stamp>" header line, got: ${JSON.stringify(headerLine)}`);
  }
  const reviewedStamp = headerMatch[1]!;

  const rows: SeedRow[] = [];
  for (const raw of lines) {
    const line = raw.replace(/\r$/, "");
    if (line.trim() === "" || line.startsWith("#")) continue;
    const fields = line.split("\t");
    if (fields.length !== 4) {
      throw new Error(`malformed seed row (expected 4 tab-separated fields, got ${fields.length}): ${JSON.stringify(line)}`);
    }
    const [idStr, domain, family, text] = fields as [string, string, string, string];
    if (!/^\d+$/.test(idStr)) {
      throw new Error(`seed id must be a non-negative integer, got: ${JSON.stringify(idStr)}`);
    }
    rows.push({ id: Number(idStr), domain, family, text });
  }

  return { reviewedStamp, rows };
}

/** Schema-level validation: unique positive ids, closed domain/family
 * vocabularies. Returns one message per violation; empty means clean. */
export function validateSchema(rows: SeedRow[]): string[] {
  const errors: string[] = [];
  const seenIds = new Set<number>();
  for (const r of rows) {
    if (r.id <= 0) errors.push(`seed id ${r.id} must be positive`);
    if (seenIds.has(r.id)) errors.push(`duplicate seed id ${r.id}`);
    seenIds.add(r.id);
    if (!(ALL_DOMAINS as readonly string[]).includes(r.domain)) {
      errors.push(`seed ${r.id} has unknown domain ${JSON.stringify(r.domain)}`);
    }
    if (!(ALL_FAMILIES as readonly string[]).includes(r.family)) {
      errors.push(`seed ${r.id} has unknown family ${JSON.stringify(r.family)}`);
    }
    if (r.text.trim() === "") errors.push(`seed ${r.id} has empty text`);
  }
  return errors;
}

export interface CoverageRow {
  key: string;
  count: number;
  spanning: number;
  spanned: string[];
  ok: boolean;
}

/** Spec Feasibility: ">= 8 seeds per domain spanning >= 4 families", checked
 * across all 11 domains (a domain with zero seeds is a coverage failure, not
 * a vacuous pass). */
export function computeDomainCoverage(rows: SeedRow[]): CoverageRow[] {
  return ALL_DOMAINS.map((domain) => {
    const members = rows.filter((r) => r.domain === domain);
    const families = [...new Set(members.map((r) => r.family))];
    return {
      key: domain,
      count: members.length,
      spanning: families.length,
      spanned: families,
      ok: members.length >= MIN_SEEDS_PER_DOMAIN && families.length >= MIN_FAMILIES_PER_DOMAIN,
    };
  });
}

/** Spec Feasibility: ">= 6 seeds per family spanning >= 3 domains", checked
 * across all 15 families. */
export function computeFamilyCoverage(rows: SeedRow[]): CoverageRow[] {
  return ALL_FAMILIES.map((family) => {
    const members = rows.filter((r) => r.family === family);
    const domains = [...new Set(members.map((r) => r.domain))];
    return {
      key: family,
      count: members.length,
      spanning: domains.length,
      spanned: domains,
      ok: members.length >= MIN_SEEDS_PER_FAMILY && domains.length >= MIN_DOMAINS_PER_FAMILY,
    };
  });
}

export function validateCoverage(rows: SeedRow[]): string[] {
  const errors: string[] = [];
  for (const row of computeDomainCoverage(rows)) {
    if (!row.ok) {
      errors.push(`domain ${row.key} has ${row.count} seeds spanning ${row.spanning} families (need >=${MIN_SEEDS_PER_DOMAIN} spanning >=${MIN_FAMILIES_PER_DOMAIN})`);
    }
  }
  for (const row of computeFamilyCoverage(rows)) {
    if (!row.ok) {
      errors.push(`family ${row.key} has ${row.count} seeds spanning ${row.spanning} domains (need >=${MIN_SEEDS_PER_FAMILY} spanning >=${MIN_DOMAINS_PER_FAMILY})`);
    }
  }
  return errors;
}

/** The cold-start warmth curve (owner's seed logistics): ids 1-20 restricted
 * to the four gentlest families; nostalgia/people held back until 21;
 * values-beliefs/plans/romance held back until 60. Ordering is by `id`,
 * which doubles as authoring order in this bank (print-seeds.ts's "authoring
 * order" blocks). */
export function validateWarmthOrdering(rows: SeedRow[]): string[] {
  const errors: string[] = [];
  for (const r of rows) {
    if (r.id <= 20 && !(FAMILIES_ALLOWED_1_TO_20 as readonly string[]).includes(r.family)) {
      errors.push(`seed ${r.id} (family ${r.family}) is in ids 1-20, which is restricted to ${FAMILIES_ALLOWED_1_TO_20.join("/")}`);
    }
    if (r.id < 21 && (r.family === "nostalgia" || r.family === "people")) {
      errors.push(`seed ${r.id} (family ${r.family}) appears before id 21`);
    }
    if (r.id < 60 && (r.family === "values-beliefs" || r.family === "plans" || r.family === "romance")) {
      errors.push(`seed ${r.id} (family ${r.family}) appears before id 60`);
    }
  }
  return errors;
}

export interface ReviewStampResult {
  ok: boolean;
  reason?: string;
}

/** The owner-review gate: PENDING always refuses, and a stamp older than
 * the file's last git modification means the file changed since it was last
 * reviewed. Pure function of (stamp, last-git-modified-date) so tests can
 * exercise the rule with fixture strings instead of the real file (which
 * ships PENDING and is expected to stay that way until the owner reviews
 * it). `lastGitModifiedDate` is `git log -1 --format=%cs -- data/seeds.tsv`,
 * or null when the file has no commit yet, in which case only the PENDING
 * check applies. */
export function validateReviewStamp(reviewedStamp: string, lastGitModifiedDate: string | null): ReviewStampResult {
  if (reviewedStamp === "PENDING") {
    return { ok: false, reason: "reviewed stamp is PENDING; the owner must review the bank before it can load" };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(reviewedStamp)) {
    return { ok: false, reason: `reviewed stamp ${JSON.stringify(reviewedStamp)} is not a YYYY-MM-DD date` };
  }
  if (lastGitModifiedDate !== null && reviewedStamp < lastGitModifiedDate) {
    return {
      ok: false,
      reason: `reviewed stamp ${reviewedStamp} is older than the file's last git modification ${lastGitModifiedDate}; re-review after editing`,
    };
  }
  return { ok: true };
}

function gitLastModifiedDate(repoRoot: string, relativePath: string): string | null {
  const proc = Bun.spawnSync(["git", "log", "-1", "--format=%cs", "--", relativePath], { cwd: repoRoot });
  const out = proc.stdout.toString("utf8").trim();
  return out === "" ? null : out;
}

function parseCliArgs(argv: string[]): { ledgerPath: string | undefined; check: boolean } {
  const ledgerPath = argv.find((a) => a.startsWith("--ledger="))?.split("=")[1];
  return { ledgerPath, check: argv.includes("--check") };
}

/** Runs every content validation (schema, coverage, warmth); the review
 * stamp is validated separately by the caller since it needs a git call
 * `--check` may or may not want to make against a real file path. Returns
 * all errors found, empty meaning clean. */
export function validateAll(rows: SeedRow[]): string[] {
  return [...validateSchema(rows), ...validateCoverage(rows), ...validateWarmthOrdering(rows)];
}

if (import.meta.main) {
  const repoRoot = join(import.meta.dir, "..");
  const seedsPath = join(repoRoot, "data", "seeds.tsv");
  const { ledgerPath, check } = parseCliArgs(process.argv.slice(2));

  if (!check && !ledgerPath) {
    console.error("Usage: bun scripts/load-seeds.ts --ledger=PATH [--check]");
    process.exit(1);
  }

  const content = readFileSync(seedsPath, "utf8");
  const { reviewedStamp, rows } = parseSeedsFile(content);

  const contentErrors = validateAll(rows);
  const lastModified = gitLastModifiedDate(repoRoot, "data/seeds.tsv");
  const stamp = validateReviewStamp(reviewedStamp, lastModified);

  const allErrors = [...contentErrors, ...(stamp.ok ? [] : [stamp.reason!])];
  if (allErrors.length > 0) {
    console.error(`data/seeds.tsv failed validation (${allErrors.length} issue(s)):`);
    for (const e of allErrors) console.error(`  - ${e}`);
    process.exit(1);
  }

  console.error(`data/seeds.tsv: ${rows.length} seeds, all validations passed.`);

  if (check) {
    process.exit(0);
  }

  const ledger = Ledger.open(ledgerPath!);
  ledger.replaceSeeds(rows);
  ledger.close();
  console.error(`Loaded ${rows.length} seeds into ${ledgerPath}.`);
}
