import type { PersonId } from "../config";
import type { Ledger, NodeRow } from "../ledger/ledger";
import { isRich } from "./status";
import { ALL_DOMAINS, type NodeCandidate, type OntologyView, type PersonCandidates } from "./types";

export interface LedgerOntologyOptions {
  exploitCooldownDays: number;
  liveEventWindowDays: number;
  exploitCandidateLimit: number;
  exploreCandidateLimit: number;
  offLimitsLimit: number;
  factsPerCandidate: number;
}

export const DEFAULT_ONTOLOGY_OPTIONS: LedgerOntologyOptions = {
  exploitCooldownDays: 14,
  liveEventWindowDays: 3,
  exploitCandidateLimit: 5,
  exploreCandidateLimit: 3,
  offLimitsLimit: 8,
  factsPerCandidate: 4,
};

function daysBetween(a: string, b: string): number {
  return Math.abs((new Date(`${a}T00:00:00Z`).getTime() - new Date(`${b}T00:00:00Z`).getTime()) / 86_400_000);
}

export class LedgerOntology implements OntologyView {
  private readonly opts: LedgerOntologyOptions;

  constructor(
    private readonly ledger: Ledger,
    opts: Partial<LedgerOntologyOptions> = {},
  ) {
    this.opts = { ...DEFAULT_ONTOLOGY_OPTIONS, ...opts };
  }

  nodeExists(person: PersonId, nodeId: number): boolean {
    return this.ledger.nodesFor(person).some((n) => n.id === nodeId);
  }

  candidates(person: PersonId, today: string): PersonCandidates {
    const nodes = this.ledger.nodesFor(person);
    const factsByNode = new Map(nodes.map((n) => [n.id, this.ledger.nodeFactsFor(n.id)]));

    const domainCounts = Object.fromEntries(ALL_DOMAINS.map((d) => [d, 0])) as PersonCandidates["domainCounts"];
    for (const n of nodes) {
      if (n.status === "open") domainCounts[n.domain]++;
    }

    const inCooldown = (n: NodeRow) =>
      n.lastAsked !== null && daysBetween(n.lastAsked, today) < this.opts.exploitCooldownDays;

    const isLive = (n: NodeRow) => {
      if (n.eventDate !== null && daysBetween(n.eventDate, today) <= this.opts.liveEventWindowDays) return true;
      const facts = factsByNode.get(n.id)!;
      const newest = facts[facts.length - 1];
      return newest !== undefined && daysBetween(newest.observedDate, today) <= 2;
    };

    const richOf = (n: NodeRow) => {
      const facts = factsByNode.get(n.id)!;
      return isRich({ factCount: facts.length, distinctDays: new Set(facts.map((f) => f.observedDate)).size });
    };

    const eligible = nodes.filter((n) => n.status === "open" && !inCooldown(n));
    // Never-asked rich first, then never-asked thin, then asked by staleness.
    // The review killed yield-descending: NULL yields sort last, so it buried
    // exactly the new material exploitation exists to reach. LIVE nodes jump
    // the whole queue: an event just passed beats everything.
    const rank = (n: NodeRow): number => {
      if (isLive(n)) return 0;
      if (n.lastAsked === null) return richOf(n) ? 1 : 2;
      return 3;
    };
    const staleness = (n: NodeRow) => (n.lastAsked === null ? "" : n.lastAsked);
    const exploitRows = [...eligible].sort((x, y) => rank(x) - rank(y) || staleness(x).localeCompare(staleness(y)) || x.id - y.id);

    const toCandidate = (n: NodeRow): NodeCandidate => {
      const facts = factsByNode.get(n.id)!;
      return {
        id: n.id,
        domain: n.domain,
        subdomain: n.subdomain,
        summary: n.summary,
        rich: richOf(n),
        live: isLive(n),
        lastAsked: n.lastAsked,
        timesAsked: n.timesAsked,
        facts: facts.slice(-this.opts.factsPerCandidate).map((f) => ({ date: f.observedDate, text: f.text })),
      };
    };

    // Thinnest open-node domains first; zero-node domains always qualify, so
    // the explore list is never empty by construction.
    const explore = [...ALL_DOMAINS]
      .sort((a, b) => domainCounts[a] - domainCounts[b] || ALL_DOMAINS.indexOf(a) - ALL_DOMAINS.indexOf(b))
      .slice(0, this.opts.exploreCandidateLimit);

    const excluded = nodes.filter((n) => n.status !== "open" || inCooldown(n));
    const offLimits = excluded
      .sort((x, y) => (y.lastAsked ?? "").localeCompare(x.lastAsked ?? ""))
      .slice(0, this.opts.offLimitsLimit)
      .map((n) => ({
        domain: n.domain,
        subdomain: n.subdomain,
        reason: n.status !== "open" ? n.status : `asked ${n.lastAsked}`,
      }));

    return {
      domainCounts,
      exploit: exploitRows.slice(0, this.opts.exploitCandidateLimit).map(toCandidate),
      explore,
      offLimits,
    };
  }
}
