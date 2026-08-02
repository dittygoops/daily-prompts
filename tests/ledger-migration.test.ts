import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger } from "../src/ledger/ledger";

// The 2026-08-02 synthesis design's nodes rebuild (spec "Migration"). A naive
// `DROP TABLE nodes` fails once node_facts rows reference it (proven in the
// adversarial review); this test builds exactly that scenario against a
// temp-file database (WAL, not :memory:, so the on-disk foreign_key_check
// this test runs is meaningful) and proves the FK-off rebuild survives it,
// preserves every row, leaves foreign_key_check empty, and is idempotent.
describe("nodes rebuild migration", () => {
  test("migrates old-schema nodes with FK rows present, preserving data, ending FK-clean, and idempotent on a second open", () => {
    const path = join(tmpdir(), `daily-prompts-nodes-rebuild-${Date.now()}.db`);
    try {
      const old = new Database(path, { create: true, strict: true });
      old.exec("PRAGMA foreign_keys = ON;");
      old.exec(`CREATE TABLE nodes (
        id INTEGER PRIMARY KEY,
        person TEXT NOT NULL CHECK (person IN ('a','b')),
        domain TEXT NOT NULL CHECK (domain IN (
          'career-academics','childhood','family','relationships-friends',
          'hobbies-interests','health-body','daily-life','beliefs-values',
          'plans-future','other'
        )),
        subdomain TEXT NOT NULL,
        summary TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','depleted','closed')),
        event_date TEXT,
        last_asked TEXT,
        times_asked INTEGER NOT NULL DEFAULT 0,
        avg_yield_chars REAL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (person, subdomain)
      );`);
      old.exec(`CREATE TABLE node_facts (
        id INTEGER PRIMARY KEY,
        node_id INTEGER NOT NULL REFERENCES nodes(id),
        kind TEXT NOT NULL CHECK (kind IN ('fact','thread','interest')),
        text TEXT NOT NULL,
        source_day_id INTEGER NOT NULL,
        observed_date TEXT NOT NULL,
        created_at TEXT NOT NULL
      );`);
      old.exec(`INSERT INTO nodes
        (id, person, domain, subdomain, summary, status, event_date, last_asked, times_asked, avg_yield_chars, created_at, updated_at)
        VALUES (1, 'a', 'hobbies-interests', 'guitar', 'Learning guitar.', 'open', NULL, NULL, 0, NULL, 't1', 't1')`);
      old.exec(`INSERT INTO nodes
        (id, person, domain, subdomain, summary, status, event_date, last_asked, times_asked, avg_yield_chars, created_at, updated_at)
        VALUES (2, 'b', 'daily-life', 'car-2027', 'New car plans.', 'depleted', '2027-01-01', '2026-07-20', 3, 120.5, 't2', 't2')`);
      old.exec(`INSERT INTO node_facts (id, node_id, kind, text, source_day_id, observed_date, created_at)
        VALUES (1, 1, 'fact', 'Practices daily.', 5, '2026-07-15', 't1')`);
      old.exec(`INSERT INTO node_facts (id, node_id, kind, text, source_day_id, observed_date, created_at)
        VALUES (2, 2, 'thread', 'Test driving a Civic.', 6, '2026-07-20', 't2')`);
      old.close();

      const migrated = Ledger.open(path);
      const nodesA = migrated.nodesFor("a");
      const nodesB = migrated.nodesFor("b");
      expect(nodesA).toHaveLength(1);
      expect(nodesB).toHaveLength(1);
      // Ids preserved across the rebuild: node_facts.node_id still resolves.
      expect(nodesA[0]).toMatchObject({ id: 1, subdomain: "guitar", budget: null, family: null });
      expect(nodesB[0]).toMatchObject({ id: 2, subdomain: "car-2027", timesAsked: 3 });
      expect(migrated.nodeFactsFor(1)).toHaveLength(1);
      expect(migrated.nodeFactsFor(2)).toHaveLength(1);
      expect(migrated.nodeFactsFor(1)[0]).toMatchObject({ text: "Practices daily." });
      migrated.close();

      const check = new Database(path, { readonly: true });
      const violations = check.query(`PRAGMA foreign_key_check`).all();
      expect(violations).toEqual([]);
      const nodesSql = (
        check.query(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'nodes'`).get() as
          | { sql: string }
          | undefined
      )?.sql;
      expect(nodesSql).toContain("tastes-preferences");
      check.close();

      // Idempotent: reopening a database that already carries the
      // 'tastes-preferences' CHECK must skip the rebuild entirely (the
      // guard) rather than erroring on a second attempt, and must not
      // duplicate or drop any row.
      const reopened = Ledger.open(path);
      expect(reopened.nodesFor("a")).toHaveLength(1);
      expect(reopened.nodesFor("b")).toHaveLength(1);
      expect(reopened.nodeFactsFor(1)).toHaveLength(1);
      reopened.close();
    } finally {
      for (const suffix of ["", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
    }
  });

  test("a fresh database gets the 11-domain form directly and never runs the rebuild", () => {
    const path = join(tmpdir(), `daily-prompts-nodes-fresh-${Date.now()}.db`);
    try {
      const ledger = Ledger.open(path);
      const id = ledger.createNode({
        person: "a", domain: "tastes-preferences", subdomain: "coffee-order",
        summary: "s", eventDate: null, at: "t",
      });
      expect(ledger.nodesFor("a").find((n) => n.id === id)?.domain).toBe("tastes-preferences");
      ledger.close();
    } finally {
      for (const suffix of ["", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
    }
  });
});
