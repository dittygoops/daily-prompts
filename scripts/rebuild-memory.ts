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

// Only run the CLI body when executed directly (not when imported by tests).
if (import.meta.main) {
  const log = (msg: string) => console.error(`[${new Date().toISOString()}] ${msg}`);
  const { configPath, person, dryRun, yes } = parseRebuildArgs(process.argv.slice(2));

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
  const ledger = Ledger.open(config.ledgerPath);
  const llm = new OpenRouterClient(config.openrouter.apiKey, config.extraction.model);
  const memory = new SupermemoryClient(config.supermemory.baseUrl, config.supermemory.apiKey);

  const result = await rebuildMemory({ ledger, llm, memory, log }, { person, dryRun });
  log(`done: ${JSON.stringify(result)}`);
  ledger.close();
}
