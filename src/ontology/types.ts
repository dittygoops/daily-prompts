import type { PersonId } from "../config";
import type { NodeDomain } from "../ledger/ledger";

/** One candidate node as generation sees it: the summary names the subject,
 * the dated facts carry the material. Facts are verbatim because summaries
 * alone are altitude retreat by construction: you cannot write "how did the
 * busking plan go?" from "learning guitar, practices regularly". */
export interface NodeCandidate {
  id: number;
  domain: NodeDomain;
  subdomain: string;
  summary: string;
  rich: boolean;
  live: boolean;
  lastAsked: string | null;
  timesAsked: number;
  facts: { date: string; text: string }[];
}

export interface PersonCandidates {
  domainCounts: Record<NodeDomain, number>;
  exploit: NodeCandidate[];
  explore: NodeDomain[];
  offLimits: { domain: NodeDomain; subdomain: string; reason: string }[];
}

/** The read seam generation and the eval harness share. Reads only: writes
 * (fileObservation, recordAsked, recordYield) are ordinary Ledger methods
 * with one caller each and no second implementation. Keeping the read path
 * behind an interface keeps eval fixtures as literal data and keeps the
 * Graphiti escape hatch at one consumer. */
export interface OntologyView {
  candidates(person: PersonId, today: string): PersonCandidates;
  nodeExists(person: PersonId, nodeId: number): boolean;
}

export const ALL_DOMAINS: NodeDomain[] = [
  "career-academics", "childhood", "family", "relationships-friends",
  "hobbies-interests", "health-body", "daily-life", "beliefs-values",
  "plans-future", "other",
];
