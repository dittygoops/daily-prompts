import type { PersonId } from "../config";
import type { Ledger } from "../ledger/ledger";
import type { LlmClient } from "../llm/types";
import type { Memory } from "../memory/types";
import { processPending } from "../extraction/pipeline";

export interface RebuildDeps {
  ledger: Ledger;
  llm: LlmClient;
  memory: Memory;
  log: (msg: string) => void;
  now?: () => string;
}

export interface RebuildOptions {
  /** Restrict to a single person; omit to rebuild both. */
  person?: PersonId;
  /** Report what would happen without wiping/clearing/reprocessing. */
  dryRun?: boolean;
}

export interface RebuildResult {
  peopleWiped: PersonId[];
  processed: number;
  failed: number;
}

const ALL_PEOPLE: PersonId[] = ["a", "b"];

/** Wipe a person's derived memory and reprocess every resolved day for them
 * from scratch. Recovers from a bad extraction run (a code/prompt bug, a
 * misconfigured backend) since the ledger is the durable source of truth
 * and memory is fully rederivable from it (PRD F5). Destructive: callers
 * (the CLI wrapper) must gate this behind an explicit confirmation. */
export async function rebuildMemory(
  deps: RebuildDeps,
  opts: RebuildOptions = {},
): Promise<RebuildResult> {
  const people = opts.person ? [opts.person] : ALL_PEOPLE;

  if (opts.dryRun) {
    for (const person of people) {
      deps.log(`[dry-run] would wipe memory for ${person}`);
    }
    deps.log(`[dry-run] would clear extraction bookkeeping and reprocess all resolved days for: ${people.join(", ")}`);
    return { peopleWiped: [], processed: 0, failed: 0 };
  }

  for (const person of people) {
    deps.log(`wiping memory for ${person}`);
    await deps.memory.wipe(person);
    deps.log(`clearing extraction bookkeeping for ${person}`);
    deps.ledger.clearExtractionsFor(person);
  }

  let processed = 0;
  let failed = 0;
  for (const person of people) {
    const result = await processPending({ ...deps, person });
    processed += result.processed;
    failed += result.failed;
  }

  deps.log(`rebuild complete: ${processed} processed, ${failed} failed, people: ${people.join(", ")}`);
  return { peopleWiped: people, processed, failed };
}
