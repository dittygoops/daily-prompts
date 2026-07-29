import { beforeEach, describe, expect, test } from "bun:test";
import { Ledger } from "../../src/ledger/ledger";
import { LedgerOntology } from "../../src/ontology/ledgerOntology";

let ledger: Ledger;
let view: LedgerOntology;
const TODAY = "2026-07-29";

beforeEach(() => {
  ledger = Ledger.open(":memory:");
  view = new LedgerOntology(ledger);
});

function node(
  subdomain: string,
  over: Partial<{ domain: string; eventDate: string | null; lastAsked: string | null; status: "open" | "depleted" | "closed"; facts: { date: string; text: string }[] }> = {},
): number {
  const id = ledger.createNode({
    person: "a",
    domain: (over.domain ?? "hobbies-interests") as never,
    subdomain,
    summary: `About ${subdomain}.`,
    eventDate: over.eventDate ?? null,
    at: "t",
  });
  for (const f of over.facts ?? [{ date: "2026-07-10", text: `${subdomain} fact` }]) {
    ledger.addNodeFact({ nodeId: id, kind: "fact", text: f.text, sourceDayId: 1, observedDate: f.date, at: "t" });
  }
  if (over.lastAsked) ledger.recordAsked(id, over.lastAsked, "t");
  if (over.status && over.status !== "open") ledger.setNodeStatus(id, over.status, "t");
  return id;
}

const rich3 = (d: string) => [
  { date: d, text: "one" },
  { date: d, text: "two" },
  { date: d, text: "three" },
];

describe("exploit ordering", () => {
  test("never-asked rich first, then never-asked thin, then asked by staleness", () => {
    node("asked-stale", { lastAsked: "2026-06-01", facts: rich3("2026-06-01") });
    node("thin-new", { facts: [{ date: "2026-07-01", text: "only" }] });
    node("rich-new", { facts: rich3("2026-07-01") });
    const order = view.candidates("a", TODAY).exploit.map((c) => c.subdomain);
    expect(order).toEqual(["rich-new", "thin-new", "asked-stale"]);
  });

  test("a LIVE node jumps the whole queue", () => {
    node("rich-new", { facts: rich3("2026-07-01") });
    node("just-happened", { eventDate: "2026-07-28", facts: [{ date: "2026-07-10", text: "planned" }] });
    const order = view.candidates("a", TODAY).exploit.map((c) => c.subdomain);
    expect(order[0]).toBe("just-happened");
    expect(view.candidates("a", TODAY).exploit[0]!.live).toBe(true);
  });

  test("depleted, closed, and in-cooldown nodes are excluded and appear off limits", () => {
    node("fresh-asked", { lastAsked: "2026-07-25" }); // 4 days ago, inside 14-day cooldown
    node("dead", { status: "depleted" });
    node("done", { status: "closed", eventDate: "2026-07-01" });
    const c = view.candidates("a", TODAY);
    expect(c.exploit).toEqual([]);
    const flagged = c.offLimits.map((o) => o.subdomain).sort();
    expect(flagged).toEqual(["dead", "done", "fresh-asked"]);
  });

  test("no node appears in both exploit and off limits", () => {
    node("asked-long-ago", { lastAsked: "2026-06-01" });
    node("asked-recently", { lastAsked: "2026-07-27" });
    const c = view.candidates("a", TODAY);
    const exploit = new Set(c.exploit.map((x) => x.subdomain));
    for (const o of c.offLimits) expect(exploit.has(o.subdomain)).toBe(false);
  });

  test("candidates carry their most recent dated facts, not just summaries", () => {
    // Summaries alone are altitude retreat by construction: the generator
    // needs the actual material to write a specific question.
    node("guitar", { facts: [
      { date: "2026-07-20", text: "Practices most evenings." },
      { date: "2026-07-25", text: "Wants to busk at the farmers market." },
    ]});
    const c = view.candidates("a", TODAY).exploit[0]!;
    expect(c.facts.map((f) => f.text)).toContain("Wants to busk at the farmers market.");
    expect(c.facts[0]!.date).toBeTruthy();
  });
});

describe("explore candidates", () => {
  test("thinnest domains first and zero-node domains always qualify", () => {
    node("guitar", { domain: "hobbies-interests", facts: rich3("2026-07-01") });
    const c = view.candidates("a", TODAY);
    expect(c.explore).toHaveLength(3);
    expect(c.explore).not.toContain("hobbies-interests");
    // All returned domains have zero open nodes, so the list can never be empty.
    for (const d of c.explore) expect(c.domainCounts[d]).toBe(0);
  });

  test("domain counts only count open nodes", () => {
    node("dead-hobby", { domain: "hobbies-interests", status: "depleted" });
    expect(view.candidates("a", TODAY).domainCounts["hobbies-interests"]).toBe(0);
  });
});

describe("nodeExists", () => {
  test("true for that person's node, false otherwise", () => {
    const id = node("guitar");
    expect(view.nodeExists("a", id)).toBe(true);
    expect(view.nodeExists("b", id)).toBe(false);
    expect(view.nodeExists("a", 9999)).toBe(false);
  });
});
