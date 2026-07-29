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

/** Renders one person's graph as a tree: domains (grouped, sorted), nodes
 * under each domain (sorted by subdomain) with their dated facts in order,
 * then a signals section, then a totals line. Pure and side-effect-free so
 * it is testable against an in-memory ledger without touching stdout. */
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
  for (const domain of domains) {
    lines.push(domain);
    const domainNodes = [...byDomain.get(domain)!].sort((a, b) => a.subdomain.localeCompare(b.subdomain));
    for (const n of domainNodes) {
      const facts = ledger.nodeFactsFor(n.id);
      totalFacts += facts.length;
      lines.push(
        `  [${n.id}] ${n.subdomain}  status=${n.status}  last_asked=${fmt(n.lastAsked)}  asked=${n.timesAsked}  yield=${fmt(n.avgYieldChars === null ? null : Math.round(n.avgYieldChars))}  facts=${facts.length}`,
      );
      for (const f of facts) {
        lines.push(`   - [${f.observedDate}] ${f.text}`);
      }
    }
  }

  const moods = ledger.recentSignals(person, "mood_signal", null, today);
  const preferences = ledger.recentSignals(person, "prompt_preference", null, today);
  lines.push("signals:");
  for (const s of moods) lines.push(`  [mood_signal ${s.observedDate}] ${s.text}`);
  for (const s of preferences) lines.push(`  [prompt_preference ${s.observedDate}] ${s.text}`);

  lines.push(
    `totals: ${nodes.length} nodes across ${domains.length} domains, ${totalFacts} facts, ${moods.length + preferences.length} signals`,
  );

  return lines.join("\n");
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
