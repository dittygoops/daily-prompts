import { describe, expect, test } from "bun:test";
import { parseRebuildArgs } from "../scripts/rebuild-memory";

describe("parseRebuildArgs", () => {
  test("defaults: config.json, no person filter, not dry-run, not confirmed", () => {
    expect(parseRebuildArgs([])).toEqual({
      configPath: "config.json",
      person: undefined,
      dryRun: false,
      yes: false,
    });
  });

  test("parses an explicit config path", () => {
    expect(parseRebuildArgs(["other.json"])).toMatchObject({ configPath: "other.json" });
  });

  test("parses --person=a and --person=b", () => {
    expect(parseRebuildArgs(["--person=a"])).toMatchObject({ person: "a" });
    expect(parseRebuildArgs(["--person=b"])).toMatchObject({ person: "b" });
  });

  test("rejects an invalid --person value", () => {
    expect(() => parseRebuildArgs(["--person=c"])).toThrow(/--person/);
  });

  test("parses --dry-run and --yes independent of order/position", () => {
    expect(parseRebuildArgs(["config.json", "--dry-run"])).toMatchObject({ dryRun: true });
    expect(parseRebuildArgs(["--yes", "config.json"])).toMatchObject({ yes: true, configPath: "config.json" });
    expect(parseRebuildArgs(["--person=a", "--yes", "--dry-run"])).toMatchObject({
      person: "a",
      yes: true,
      dryRun: true,
    });
  });
});
