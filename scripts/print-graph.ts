#!/usr/bin/env bun
// Read-only: opens the ledger and only ever SELECTs. This is the acceptance
// gate for a rebuild (docs/superpowers/specs/2026-07-29, "Migration" step
// 5) - "read the resulting graph by hand" is otherwise impossible once the
// graph lives in a few normalized tables instead of one flat document list.
import type { PersonId } from "../src/config";
import { loadConfigFile } from "../src/config";
import { Ledger, type NodeRow } from "../src/ledger/ledger";

const ALL_PEOPLE: PersonId[] = ["a", "b"];

function fmt(value: string | number | null): string {
  return value === null ? "-" : String(value);
}

// The default token window (spec Constants: tokenWindowDays 3), used only to
// bucket a node's tokens as pending/spent/expired for display. Not imported
// from config.ts: this script is a read-only diagnostic, and the real
// eligibility window used by the selector always comes from the live config,
// which this file does not load. Matches config.ts's zod default exactly.
const DISPLAY_TOKEN_WINDOW_DAYS = 3;

/** Renders one person's graph as a tree: domains (grouped, sorted), nodes
 * under each domain (sorted by subdomain) with their dated facts in order
 * (multi-homed facts tagged with their other homes, resolved threads tagged
 * with their resolution date), then a tokens section bucketed by status,
 * then a signals section, then a totals line and a trailing seeds line.
 * Pure and side-effect-free so it is testable against an in-memory ledger
 * without touching stdout. 2026-08-02 synthesis design: nodes.status and
 * avg_yield_chars are gone (budget/family replace them), so this no longer
 * reads either column. */
export function renderGraph(ledger: Ledger, person: PersonId, today: string): string {
  const nodes = ledger.nodesFor(person);
  const lines: string[] = [`=== person ${person} ===`];

  const byDomain = new Map<string, NodeRow[]>();
  for (const n of nodes) {
    const list = byDomain.get(n.domain) ?? [];
    list.push(n);
    byDomain.set(n.domain, list);
  }
  const domains = [...byDomain.keys()].sort();

  let totalFacts = 0;
  const tokenLines: string[] = [];
  for (const domain of domains) {
    lines.push(domain);
    const domainNodes = [...byDomain.get(domain)!].sort((a, b) => a.subdomain.localeCompare(b.subdomain));
    for (const n of domainNodes) {
      const facts = ledger.nodeFactsFor(n.id);
      totalFacts += facts.length;
      lines.push(
        `  [${n.id}] ${n.subdomain}  budget=${fmt(n.budget)}  family=${fmt(n.family)}  last_asked=${fmt(n.lastAsked)}  asked=${n.timesAsked}  facts=${facts.length}`,
      );
      for (const f of facts) {
        // "Every home INCLUDING the primary" (spec impl decision 18): the
        // extra homes worth flagging are every OTHER node, so the current
        // node's own id is excluded from the [+nodes ...] tag.
        const otherHomes = ledger.subjectsForFact(f.id).filter((id) => id !== n.id);
        const homesTag = otherHomes.length > 0 ? ` [+nodes ${otherHomes.join(", ")}]` : "";
        const resolvedTag = f.resolvedAt !== null ? ` [resolved ${f.resolvedAt}]` : "";
        lines.push(`   - [${f.observedDate}] ${f.text}${homesTag}${resolvedTag}`);
      }

      for (const t of ledger.tokensForNode(n.id)) {
        const status =
          t.spentAt !== null
            ? "spent"
            : daysBefore(today, t.eventDate) >= DISPLAY_TOKEN_WINDOW_DAYS
              ? "expired"
              : "pending";
        tokenLines.push(`  [${n.id}] ${status} ${t.eventDate}`);
      }
    }
  }

  lines.push("tokens:");
  lines.push(...tokenLines);

  const moods = ledger.recentSignals(person, "mood_signal", null, today);
  const preferences = ledger.recentSignals(person, "prompt_preference", null, today);
  lines.push("signals:");
  for (const s of moods) lines.push(`  [mood_signal ${s.observedDate}] ${s.text}`);
  for (const s of preferences) lines.push(`  [prompt_preference ${s.observedDate}] ${s.text}`);

  lines.push(
    `totals: ${nodes.length} nodes across ${domains.length} domains, ${totalFacts} facts, ${moods.length + preferences.length} signals`,
  );

  const seeds = ledger.allSeeds();
  // "Ever used", not windowed: a diagnostic dump should not silently hide a
  // seed this person was asked long ago, so the since-date is an epoch floor
  // rather than the selector's real seedReuseDays window.
  const used = ledger.usedSeedIdsWithin(person, "0001-01-01");
  lines.push(`seeds: ${seeds.length} loaded, ${used.size} used by ${person}`);

  return lines.join("\n");
}

/** Whole days from `eventDate` up to `today`. Dates are plain YYYY-MM-DD, so
 * Date.parse is exact. */
function daysBefore(today: string, eventDate: string): number {
  return Math.round((Date.parse(today) - Date.parse(eventDate)) / 86_400_000);
}

function parsePersonFilter(argv: string[]): PersonId | undefined {
  const arg = argv.find((a) => a.startsWith("--person="))?.split("=")[1];
  if (arg !== undefined && arg !== "a" && arg !== "b") {
    throw new Error(`--person must be "a" or "b", got "${arg}"`);
  }
  return arg;
}

function parseLedgerOverride(argv: string[]): string | undefined {
  return argv.find((a) => a.startsWith("--ledger="))?.split("=")[1];
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const configPath = argv.find((a) => !a.startsWith("--")) ?? "config.json";
  const ledgerOverride = parseLedgerOverride(argv);
  const person = parsePersonFilter(argv);

  const config = await loadConfigFile(configPath);
  const ledger = Ledger.open(ledgerOverride ?? config.ledgerPath);
  const today = new Date().toISOString().slice(0, 10);

  for (const p of person ? [person] : ALL_PEOPLE) {
    console.log(renderGraph(ledger, p, today));
  }
  ledger.close();
}
