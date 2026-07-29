#!/usr/bin/env bun
import { loadConfigFile } from "../src/config";
import { Ledger } from "../src/ledger/ledger";
import { OpenRouterClient } from "../src/llm/openrouter";
import { SupermemoryClient } from "../src/memory/supermemory";
import { rebuildMemory } from "../src/rebuild/rebuild";

export interface RebuildArgs {
  configPath: string;
  person: "a" | "b" | undefined;
  dryRun: boolean;
  yes: boolean;
}

export function parseRebuildArgs(argv: string[]): RebuildArgs {
  const configPath = argv.find((a) => !a.startsWith("--")) ?? "config.json";
  const personArg = argv.find((a) => a.startsWith("--person="))?.split("=")[1];
  if (personArg !== undefined && personArg !== "a" && personArg !== "b") {
    throw new Error(`--person must be "a" or "b", got "${personArg}"`);
  }
  return {
    configPath,
    person: personArg,
    dryRun: argv.includes("--dry-run"),
    yes: argv.includes("--yes"),
  };
}

/** Kept separate from parseRebuildArgs so that function's contract (and the
 * object shape tests/rebuildCli.test.ts asserts with toEqual) never has to
 * change to gain a new flag. `--ledger=<path>` lets a rebuild run against a
 * restored backup database without touching config.json's ledgerPath. */
export function parseLedgerOverride(argv: string[]): string | undefined {
  return argv.find((a) => a.startsWith("--ledger="))?.split("=")[1];
}

// Only run the CLI body when executed directly (not when imported by tests).
if (import.meta.main) {
  const log = (msg: string) => console.error(`[${new Date().toISOString()}] ${msg}`);
  const { configPath, person, dryRun, yes } = parseRebuildArgs(process.argv.slice(2));
  const ledgerOverride = parseLedgerOverride(process.argv.slice(2));

  const target = person ? `person ${person}` : "BOTH participants";
  if (!dryRun && !yes) {
    console.error(
      `This will PERMANENTLY DELETE all derived memory for ${target} and rebuild it from the ledger.\n` +
        `Stop the daemon first (concurrent extraction can race with this script).\n` +
        `Re-run with --yes to proceed, or --dry-run to preview.`,
    );
    process.exit(1);
  }

  const config = await loadConfigFile(configPath);
  const ledger = Ledger.open(ledgerOverride ?? config.ledgerPath);
  const llm = new OpenRouterClient(config.openrouter.apiKey, config.extraction.model);
  // Supermemory is wiped alongside the graph on a normal rebuild (it is still
  // live until cutover), but NEVER when --ledger points somewhere other than
  // the configured ledger: a rebuild of a backup copy must not reach out and
  // destroy live data in an external service it isn't rebuilding.
  const memory = ledgerOverride
    ? undefined
    : new SupermemoryClient(config.supermemory.baseUrl, config.supermemory.apiKey);
  if (ledgerOverride) log(`ledger override ${ledgerOverride}: leaving Supermemory untouched`);

  const result = await rebuildMemory({ ledger, llm, memory, log }, { person, dryRun });
  log(`done: ${result.processed} processed, ${result.failed} failed, people: ${result.peopleWiped.join(", ") || "none (dry-run)"}`);
  for (const a of result.attributed) {
    log(`  attributed ${a.date} person ${a.person} -> node ${a.nodeId} (${a.facts} facts)`);
  }
  for (const d of result.declined) {
    log(`  declined ${d.date} person ${d.person}: ${d.reason}`);
  }
  ledger.close();
}
