import type { PersonId } from "../config";
import type { Ledger } from "../ledger/ledger";
import type { LlmClient } from "../llm/types";
import type { Memory } from "../memory/types";
import { processPending, type DayFiling } from "../extraction/pipeline";

export interface RebuildDeps {
  ledger: Ledger;
  llm: LlmClient;
  /** Retired by the structured ontology; kept optional so a caller that
   * still constructs one (for the harmless wipe-on-rebuild call) compiles,
   * and so a graph-only rebuild can omit it entirely. */
  memory?: Memory;
  log: (msg: string) => void;
  now?: () => string;
  summaryLlm?: LlmClient;
}

export interface RebuildOptions {
  /** Restrict to a single person; omit to rebuild both. */
  person?: PersonId;
  /** Report what would happen without wiping/clearing/reprocessing. */
  dryRun?: boolean;
}

export interface AttributedYield {
  date: string;
  person: PersonId;
  nodeId: number;
  facts: number;
}

export interface DeclinedAttribution {
  date: string;
  person: PersonId;
  reason: string;
}

export interface RebuildResult {
  peopleWiped: PersonId[];
  processed: number;
  failed: number;
  attributed: AttributedYield[];
  declined: DeclinedAttribution[];
}

const ALL_PEOPLE: PersonId[] = ["a", "b"];

/** Given one day's per-node fact counts, decide which node (if any) earns
 * the day's yield attribution. Argmax, not string matching: the original
 * backfill plan (matching free prompt text to LLM-named subdomains) was
 * unimplementable, since generation_log.topic is NULL on every historical
 * row. Exactly one node with the day's maximum fact count, and that max at
 * least 2, is the bar: a tie or a single-fact day is too ambiguous to credit
 * one node over another. */
function attributeDay(factsByNode: Record<number, number>): { nodeId: number; facts: number } | { reason: string } {
  const entries = Object.entries(factsByNode).map(([id, facts]) => ({ nodeId: Number(id), facts }));
  if (entries.length === 0) return { reason: "no facts filed" };
  const max = Math.max(...entries.map((e) => e.facts));
  const winners = entries.filter((e) => e.facts === max);
  if (winners.length > 1) return { reason: `tie at ${max} facts among ${winners.length} nodes` };
  if (max < 2) return { reason: `single-fact max (${max})` };
  return { nodeId: winners[0]!.nodeId, facts: max };
}

/** Wipe a person's derived graph and reprocess every resolved day for them
 * from scratch. Recovers from a bad extraction run (a code/prompt bug, a
 * misconfigured backend) since the ledger is the durable source of truth and
 * the graph is fully rederivable from it. Destructive: callers (the CLI
 * wrapper) must gate this behind an explicit confirmation. After replay,
 * walks each filing in date order and applies argmax yield attribution,
 * since a rebuild otherwise leaves the whole graph presenting as never-asked
 * (every node looks fresh, so the very first exploit pick re-asks whatever
 * was just answered). */
export async function rebuildMemory(
  deps: RebuildDeps,
  opts: RebuildOptions = {},
): Promise<RebuildResult> {
  const people = opts.person ? [opts.person] : ALL_PEOPLE;

  if (opts.dryRun) {
    for (const person of people) {
      deps.log(`[dry-run] would wipe graph for ${person}`);
    }
    deps.log(`[dry-run] would clear extraction bookkeeping and reprocess all resolved days for: ${people.join(", ")}`);
    return { peopleWiped: [], processed: 0, failed: 0, attributed: [], declined: [] };
  }

  for (const person of people) {
    deps.log(`wiping graph for ${person}`);
    // FK order: facts before nodes (node_facts.node_id references nodes),
    // then signals (no FK relationship, order doesn't matter for them).
    deps.ledger.wipeGraph(person);
    if (deps.memory) {
      deps.log(`wiping legacy memory for ${person}`);
      await deps.memory.wipe(person);
    }
    deps.log(`clearing extraction bookkeeping for ${person}`);
    deps.ledger.clearExtractionsFor(person);
  }

  let processed = 0;
  let failed = 0;
  const attributed: AttributedYield[] = [];
  const declined: DeclinedAttribution[] = [];

  // Attribution runs per filing, interleaved with the replay (via onFiling),
  // not in a second pass afterwards. unprocessedResolvedDays orders by date,
  // so the walk is chronological either way, but attribution can deplete a
  // node while addNodeFact reopens a depleted one: attributing only after
  // every day was filed would strand a node depleted that a later day's fact
  // should have reopened.
  const attribute = (filing: DayFiling): void => {
    const decision = attributeDay(filing.factsByNode);
    if ("reason" in decision) {
      declined.push({ date: filing.date, person: filing.person, reason: decision.reason });
      deps.log(`declined attribution ${filing.date} person ${filing.person}: ${decision.reason}`);
      return;
    }
    if (filing.responseChars === null) {
      declined.push({ date: filing.date, person: filing.person, reason: "no answer to fold into yield" });
      deps.log(`declined attribution ${filing.date} person ${filing.person}: no answer to fold into yield`);
      return;
    }
    deps.ledger.recordYieldForNode(decision.nodeId, filing.person, filing.date, filing.responseChars);
    attributed.push({ date: filing.date, person: filing.person, nodeId: decision.nodeId, facts: decision.facts });
    deps.log(`attributed ${filing.date} person ${filing.person} -> node ${decision.nodeId} (${decision.facts} facts)`);
  };

  for (const person of people) {
    const result = await processPending({ ...deps, person, onFiling: attribute });
    processed += result.processed;
    failed += result.failed;
  }

  deps.log(
    `rebuild complete: ${processed} processed, ${failed} failed, ${attributed.length} attributed, ${declined.length} declined, people: ${people.join(", ")}`,
  );
  return { peopleWiped: people, processed, failed, attributed, declined };
}
