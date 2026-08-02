import { describe, expect, test } from "bun:test";
import { runAudits } from "../../src/eval/audits";
import { Ledger } from "../../src/ledger/ledger";
import type { SelectionConstants } from "../../src/selection/types";
import type { PersonId } from "../../src/config";

const CONSTANTS: SelectionConstants = {
  settlingDays: 2,
  subjectCooldownDays: 14,
  domainCooldownDays: 4,
  familyCooldownDays: 7,
  tokenWindowDays: 3,
  exploitRunCap: 2,
  budgetCap: 3,
  candidateDepth: 8,
  seedReuseDays: 90,
  anchorMinSharedWords: 1,
};

/** Writes one dispatch-time ask row via recordGeneration, the only path a
 * real dispatch takes (spec: ask_domain/ask_family/lane are written at
 * dispatch and never updated). Defaults keep every field harmless (no
 * target, no lane) so each test only sets what it means to test. */
function ask(
  ledger: Ledger,
  opts: {
    date: string;
    person: PersonId;
    targetNodeId?: number | null;
    askDomain?: string | null;
    askFamily?: string | null;
    lane?: "followup" | "exploit" | "explore" | null;
  },
): void {
  ledger.recordGeneration({
    date: opts.date,
    promptId: `gen-${opts.date}-${opts.person}`,
    promptText: "some question",
    model: "m",
    systemPrompt: "s",
    userPrompt: "u",
    rawResponse: "{}",
    rationale: "r",
    stance: opts.lane === "explore" ? "explore" : "exploit",
    person: opts.person,
    topic: null,
    targetNodeId: opts.targetNodeId ?? null,
    targetDomain: null,
    fellBack: false,
    fallbackReason: null,
    at: `${opts.date}T00:00:00Z`,
    lane: opts.lane ?? null,
    askDomain: opts.askDomain ?? null,
    askFamily: opts.askFamily ?? null,
  });
}

function makeNode(ledger: Ledger, person: PersonId, family: string | null): number {
  const id = ledger.createNode({
    person, domain: "daily-life", subdomain: `node-${Math.random()}`, summary: "s", eventDate: null, at: "t0",
  });
  if (family !== null) {
    // family is written via the migration rebuild's direct column write in
    // real life; setNodeBudget-style direct write keeps the test independent
    // of the extractor. Cheapest path: raw UPDATE is not exposed, so route
    // through grantBudget's sibling would be wrong; reuse createNode's
    // returned id with a targeted SQL-free helper is unavailable, so this
    // test instead asserts A8 using nodes left with a null family by default
    // and never needs to set family explicitly (see A8 tests below).
  }
  return id;
}

describe("runAudits", () => {
  describe("A1 subject cooldown", () => {
    test("fires when the same node is asked twice inside subjectCooldownDays", () => {
      const ledger = Ledger.open(":memory:");
      const nodeId = makeNode(ledger, "a", null);
      ask(ledger, { date: "2026-07-01", person: "a", targetNodeId: nodeId, lane: "exploit" });
      ask(ledger, { date: "2026-07-05", person: "a", targetNodeId: nodeId, lane: "exploit" });
      const violations = runAudits(ledger, "2026-07-05", CONSTANTS);
      expect(violations.filter((v) => v.audit === "A1")).toHaveLength(1);
      expect(violations.find((v) => v.audit === "A1")).toMatchObject({ person: "a", subject: String(nodeId) });
    });

    test("stays silent when the same node's asks are spaced past the cooldown", () => {
      const ledger = Ledger.open(":memory:");
      const nodeId = makeNode(ledger, "a", null);
      ask(ledger, { date: "2026-07-01", person: "a", targetNodeId: nodeId, lane: "exploit" });
      ask(ledger, { date: "2026-07-20", person: "a", targetNodeId: nodeId, lane: "exploit" });
      const violations = runAudits(ledger, "2026-07-20", CONSTANTS);
      expect(violations.filter((v) => v.audit === "A1")).toHaveLength(0);
    });
  });

  describe("A2 domain cooldown", () => {
    test("fires when a person's ask_domain repeats inside domainCooldownDays", () => {
      const ledger = Ledger.open(":memory:");
      ask(ledger, { date: "2026-07-01", person: "a", askDomain: "food", lane: "explore" });
      ask(ledger, { date: "2026-07-02", person: "a", askDomain: "food", lane: "explore" });
      const violations = runAudits(ledger, "2026-07-02", CONSTANTS);
      expect(violations.filter((v) => v.audit === "A2")).toHaveLength(1);
    });

    test("stays silent on a clean domain history", () => {
      const ledger = Ledger.open(":memory:");
      ask(ledger, { date: "2026-07-01", person: "a", askDomain: "food", lane: "explore" });
      ask(ledger, { date: "2026-07-10", person: "a", askDomain: "food", lane: "explore" });
      const violations = runAudits(ledger, "2026-07-10", CONSTANTS);
      expect(violations.filter((v) => v.audit === "A2")).toHaveLength(0);
    });
  });

  describe("A3 family cooldown", () => {
    test("fires when a person's ask_family repeats inside familyCooldownDays", () => {
      const ledger = Ledger.open(":memory:");
      ask(ledger, { date: "2026-07-01", person: "b", askFamily: "money", lane: "explore" });
      ask(ledger, { date: "2026-07-04", person: "b", askFamily: "money", lane: "explore" });
      const violations = runAudits(ledger, "2026-07-04", CONSTANTS);
      expect(violations.filter((v) => v.audit === "A3")).toHaveLength(1);
    });

    test("stays silent on a clean family history", () => {
      const ledger = Ledger.open(":memory:");
      ask(ledger, { date: "2026-07-01", person: "b", askFamily: "money", lane: "explore" });
      ask(ledger, { date: "2026-07-15", person: "b", askFamily: "money", lane: "explore" });
      const violations = runAudits(ledger, "2026-07-15", CONSTANTS);
      expect(violations.filter((v) => v.audit === "A3")).toHaveLength(0);
    });
  });

  describe("A4 same-day couple collision", () => {
    test("fires on a same-day domain collision across the couple", () => {
      const ledger = Ledger.open(":memory:");
      ask(ledger, { date: "2026-07-01", person: "a", askDomain: "food", askFamily: "nostalgia", lane: "explore" });
      ask(ledger, { date: "2026-07-01", person: "b", askDomain: "food", askFamily: "money", lane: "explore" });
      const violations = runAudits(ledger, "2026-07-01", CONSTANTS);
      expect(violations.filter((v) => v.audit === "A4")).toHaveLength(1);
    });

    test("fires on a same-day family collision across the couple", () => {
      const ledger = Ledger.open(":memory:");
      ask(ledger, { date: "2026-07-01", person: "a", askDomain: "food", askFamily: "money", lane: "explore" });
      ask(ledger, { date: "2026-07-01", person: "b", askDomain: "work-school", askFamily: "money", lane: "explore" });
      const violations = runAudits(ledger, "2026-07-01", CONSTANTS);
      expect(violations.filter((v) => v.audit === "A4")).toHaveLength(1);
    });

    test("is exempt on a token day even with a matching domain", () => {
      const ledger = Ledger.open(":memory:");
      ask(ledger, { date: "2026-07-01", person: "a", askDomain: "food", askFamily: "nostalgia", lane: "followup" });
      ask(ledger, { date: "2026-07-01", person: "b", askDomain: "food", askFamily: "money", lane: "explore" });
      const violations = runAudits(ledger, "2026-07-01", CONSTANTS);
      expect(violations.filter((v) => v.audit === "A4")).toHaveLength(0);
    });

    test("stays silent when domains and families both differ", () => {
      const ledger = Ledger.open(":memory:");
      ask(ledger, { date: "2026-07-01", person: "a", askDomain: "food", askFamily: "nostalgia", lane: "explore" });
      ask(ledger, { date: "2026-07-01", person: "b", askDomain: "work-school", askFamily: "money", lane: "explore" });
      const violations = runAudits(ledger, "2026-07-01", CONSTANTS);
      expect(violations.filter((v) => v.audit === "A4")).toHaveLength(0);
    });
  });

  describe("A5 expired unspent tokens", () => {
    test("fires when a token's event_date is older than tokenWindowDays and it is still unspent", () => {
      const ledger = Ledger.open(":memory:");
      const nodeId = makeNode(ledger, "a", null);
      ledger.mintToken(nodeId, "2026-06-01", "t0");
      const violations = runAudits(ledger, "2026-07-01", CONSTANTS);
      expect(violations.filter((v) => v.audit === "A5")).toHaveLength(1);
    });

    test("stays silent once the token is spent", () => {
      const ledger = Ledger.open(":memory:");
      const nodeId = makeNode(ledger, "a", null);
      ledger.mintToken(nodeId, "2026-06-01", "t0");
      const [token] = ledger.expiredUnspentTokens("2026-07-01", CONSTANTS.tokenWindowDays);
      ledger.spendToken(token!.id, "t1");
      const violations = runAudits(ledger, "2026-07-01", CONSTANTS);
      expect(violations.filter((v) => v.audit === "A5")).toHaveLength(0);
    });
  });

  describe("A6 exploit run cap", () => {
    test("fires when a person's followup/exploit lane streak exceeds exploitRunCap", () => {
      const ledger = Ledger.open(":memory:");
      ask(ledger, { date: "2026-07-01", person: "a", lane: "exploit" });
      ask(ledger, { date: "2026-07-02", person: "a", lane: "followup" });
      ask(ledger, { date: "2026-07-03", person: "a", lane: "exploit" });
      const violations = runAudits(ledger, "2026-07-03", CONSTANTS);
      expect(violations.filter((v) => v.audit === "A6")).toHaveLength(1);
    });

    test("stays silent when an explore day breaks up the streak", () => {
      const ledger = Ledger.open(":memory:");
      ask(ledger, { date: "2026-07-01", person: "a", lane: "exploit" });
      ask(ledger, { date: "2026-07-02", person: "a", lane: "explore" });
      ask(ledger, { date: "2026-07-03", person: "a", lane: "exploit" });
      const violations = runAudits(ledger, "2026-07-03", CONSTANTS);
      expect(violations.filter((v) => v.audit === "A6")).toHaveLength(0);
    });

    test("null-lane days are invisible to the run count, not streak breaks", () => {
      const ledger = Ledger.open(":memory:");
      // A fallback day (no lane) sits between two exploit days; because
      // null-lane days are invisible rather than streak-breaking, this is
      // still a 3-day exploit run and must fire, exactly like the case with
      // no gap at all.
      ask(ledger, { date: "2026-07-01", person: "a", lane: "exploit" });
      ask(ledger, { date: "2026-07-02", person: "a", lane: null });
      ask(ledger, { date: "2026-07-03", person: "a", lane: "exploit" });
      ask(ledger, { date: "2026-07-04", person: "a", lane: "exploit" });
      const violations = runAudits(ledger, "2026-07-04", CONSTANTS);
      expect(violations.filter((v) => v.audit === "A6")).toHaveLength(1);
    });
  });

  describe("A8 null-family node rate", () => {
    test("fires a single informational row when the null-family rate exceeds 25 percent", () => {
      const ledger = Ledger.open(":memory:");
      // 3 of 4 nodes carry no family: 75% null, comfortably over the 25%
      // threshold, and every node predates a family assignment (createNode
      // never sets one), so no extra plumbing is needed to null them out.
      for (let i = 0; i < 4; i++) makeNode(ledger, "a", null);
      const violations = runAudits(ledger, "2026-07-01", CONSTANTS);
      expect(violations.filter((v) => v.audit === "A8")).toHaveLength(1);
    });

    test("stays silent when there are no nodes at all", () => {
      const ledger = Ledger.open(":memory:");
      const violations = runAudits(ledger, "2026-07-01", CONSTANTS);
      expect(violations.filter((v) => v.audit === "A8")).toHaveLength(0);
    });
  });

  describe("dedup and idempotent persistence", () => {
    test("a duplicate (date, person) row and a null-person row are ignored, per recentAsks' contract", () => {
      const ledger = Ledger.open(":memory:");
      const nodeId = makeNode(ledger, "a", null);
      ask(ledger, { date: "2026-07-01", person: "a", targetNodeId: nodeId, lane: "exploit" });
      // A second, later row for the same (date, person): recentAsks keeps
      // only the max(id) row, so this must not create a second ask that A1
      // could pair against.
      ask(ledger, { date: "2026-07-01", person: "a", targetNodeId: nodeId, lane: "exploit" });
      ledger.recordGeneration({
        date: "2026-07-01", promptId: "legacy", promptText: "legacy row", model: "m", systemPrompt: "s",
        userPrompt: "u", rawResponse: "{}", rationale: "r", stance: "explore", person: null, topic: null,
        targetNodeId: nodeId, targetDomain: null, fellBack: false, fallbackReason: null, at: "t",
        lane: "exploit", askDomain: null, askFamily: null,
      });
      const violations = runAudits(ledger, "2026-07-01", CONSTANTS);
      expect(violations.filter((v) => v.audit === "A1")).toHaveLength(0);
    });

    test("recordAuditViolations is idempotent per run_date", () => {
      const ledger = Ledger.open(":memory:");
      const nodeId = makeNode(ledger, "a", null);
      ask(ledger, { date: "2026-07-01", person: "a", targetNodeId: nodeId, lane: "exploit" });
      ask(ledger, { date: "2026-07-05", person: "a", targetNodeId: nodeId, lane: "exploit" });
      const violations = runAudits(ledger, "2026-07-05", CONSTANTS);
      ledger.recordAuditViolations("2026-07-05", violations, "t1");
      ledger.recordAuditViolations("2026-07-05", violations, "t2");
      expect(ledger.auditViolationsSince("2026-07-05").filter((v) => v.audit === "A1")).toHaveLength(1);
    });
  });
});
