// selectPair (spec "Selection"): the single pure entry point. Composes
// windows, lanes, and pairing over a SelectionInput snapshot into one day's
// Selection. No Date, no Ledger, no random: same input in, same Selection
// out, always (the determinism the spec and the delivery brief both call
// out by name).

import type { PersonId } from "../config";
import { lane0Tokens, lane1Candidates, lane2Candidates } from "./lanes";
import { buildCandidateList, selectNoToken, selectPartner, tokenCandidate } from "./pairs";
import type { Candidate, Selection, SelectableNode, SelectionInput } from "./types";
import { nodeWindowsPass } from "./windows";

const PEOPLE: PersonId[] = ["a", "b"];

/** background = budget-0 and windowed-out nodes (deliverable's own
 * phrasing): the set of this person's nodes that were NOT eligible for
 * lane 1 today, minus whichever node actually got selected (a token
 * candidate bypasses the budget/window checks and so could otherwise show
 * up here despite being the day's actual target). */
function backgroundFor(
  nodes: SelectableNode[],
  today: string,
  asks: SelectionInput["asks"],
  constants: SelectionInput["constants"],
  selectedNodeId: number | null,
): { domain: string; subdomain: string }[] {
  return nodes
    .filter((n) => n.id !== selectedNodeId)
    .filter((n) => n.budget === null || n.budget <= 0 || !nodeWindowsPass(n, today, asks, constants))
    .map((n) => ({ domain: n.domain, subdomain: n.subdomain }));
}

/** Pure function of (ledger state, date): selects both people's candidates
 * for one day, per the spec's Pairing section. Token precedence is
 * verbatim: a person holding a fireable token IS lane 0; pairing only
 * chooses the partner; on a cross-person collision the partner re-selects,
 * never the token; both people holding tokens the same day both fire with
 * cross-person rules waived entirely. Only when neither holds a token does
 * pair enumeration run. */
export function selectPair(input: SelectionInput): Selection {
  const { today, constants } = input;

  const nodesById = new Map<number, SelectableNode>();
  for (const person of PEOPLE) {
    for (const node of input.nodes[person]) nodesById.set(node.id, node);
  }

  const tokens: Record<PersonId, ReturnType<typeof lane0Tokens>> = {
    a: lane0Tokens(input.tokens, nodesById, "a", today, constants.tokenWindowDays),
    b: lane0Tokens(input.tokens, nodesById, "b", today, constants.tokenWindowDays),
  };

  const lists: Record<PersonId, Candidate[]> = {
    a: buildCandidateList(
      "a",
      lane1Candidates(input.nodes.a, "a", today, input.asks, constants),
      lane2Candidates(input.seeds, "a", today, input.asks, input.usedSeedIds.a, constants),
      constants.candidateDepth,
    ),
    b: buildCandidateList(
      "b",
      lane1Candidates(input.nodes.b, "b", today, input.asks, constants),
      lane2Candidates(input.seeds, "b", today, input.asks, input.usedSeedIds.b, constants),
      constants.candidateDepth,
    ),
  };

  let a: Candidate;
  let b: Candidate;
  let relaxations: string[];

  const aHasToken = tokens.a.length > 0;
  const bHasToken = tokens.b.length > 0;

  if (aHasToken && bHasToken) {
    // Double-token day: both fire, cross-person rules waived entirely
    // (spec: "appointments outrank hygiene, including pairing hygiene").
    a = tokenCandidate("a", tokens.a[0]!, nodesById);
    b = tokenCandidate("b", tokens.b[0]!, nodesById);
    relaxations = [];
  } else if (aHasToken) {
    a = tokenCandidate("a", tokens.a[0]!, nodesById);
    const result = selectPartner(a, lists.b);
    b = result.candidate;
    relaxations = result.relaxations;
  } else if (bHasToken) {
    b = tokenCandidate("b", tokens.b[0]!, nodesById);
    const result = selectPartner(b, lists.a);
    a = result.candidate;
    relaxations = result.relaxations;
  } else {
    const result = selectNoToken(lists.a, lists.b);
    a = result.a;
    b = result.b;
    relaxations = result.relaxations;
  }

  const background: Selection["background"] = {
    a: backgroundFor(input.nodes.a, today, input.asks, constants, a.node?.id ?? null),
    b: backgroundFor(input.nodes.b, today, input.asks, constants, b.node?.id ?? null),
  };

  return { a, b, relaxations, background };
}
