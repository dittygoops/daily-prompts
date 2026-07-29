import { describe, expect, test } from "bun:test";
import { parseLedgerOverride, parseRebuildArgs } from "../scripts/rebuild-memory";

describe("parseLedgerOverride", () => {
  test("returns undefined when --ledger= is not passed", () => {
    expect(parseLedgerOverride(["config.json", "--yes"])).toBeUndefined();
  });

  test("returns the path when --ledger= is passed", () => {
    expect(parseLedgerOverride(["config.json", "--ledger=/tmp/backup.db", "--yes"])).toBe("/tmp/backup.db");
  });

  test("does not interfere with other flags", () => {
    expect(parseLedgerOverride(["--dry-run", "--person=a", "--ledger=./backup/ledger.db"])).toBe("./backup/ledger.db");
  });
});

describe("parseRebuildArgs contract stays exactly the same shape (unedited baseline test)", () => {
  test("default case returns exactly the four original fields", () => {
    expect(parseRebuildArgs(["config.json"])).toEqual({
      configPath: "config.json",
      person: undefined,
      dryRun: false,
      yes: false,
    });
  });
});
