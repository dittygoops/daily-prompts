import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config";

const validRaw = {
  participants: {
    a: { name: "Alex", phone: "+14805550111" },
    b: { name: "Sam", phone: "+14805550122" },
  },
  dispatchTime: "08:30",
  timezone: "America/Phoenix",
};

const validEnv = {
  SPECTRUM_PROJECT_ID: "proj-id",
  SPECTRUM_PROJECT_SECRET: "proj-secret",
};

describe("loadConfig", () => {
  test("parses a valid config and applies defaults", () => {
    const config = loadConfig(validRaw, validEnv);
    expect(config.participants.a.name).toBe("Alex");
    expect(config.participants.b.phone).toBe("+14805550122");
    expect(config.dispatchTime).toEqual({ hour: 8, minute: 30 });
    expect(config.settleWindowSeconds).toBe(150);
    expect(config.ledgerPath).toBe("./ledger.db");
    expect(config.spectrum.projectId).toBe("proj-id");
    expect(config.spectrum.projectSecret).toBe("proj-secret");
  });

  test("honors explicit overrides of defaulted fields", () => {
    const config = loadConfig({ ...validRaw, settleWindowSeconds: 60 }, validEnv);
    expect(config.settleWindowSeconds).toBe(60);
  });

  test("rejects a phone number that is not E.164", () => {
    const raw = structuredClone(validRaw);
    raw.participants.b.phone = "480-555-0122";
    expect(() => loadConfig(raw, validEnv)).toThrow(/participants\.b\.phone/);
  });

  test("rejects identical participant phone numbers", () => {
    const raw = structuredClone(validRaw);
    raw.participants.b.phone = raw.participants.a.phone;
    expect(() => loadConfig(raw, validEnv)).toThrow(/distinct/i);
  });

  test("rejects a malformed dispatchTime", () => {
    expect(() => loadConfig({ ...validRaw, dispatchTime: "8:30am" }, validEnv)).toThrow(
      /dispatchTime/,
    );
  });

  test("rejects an unknown IANA timezone", () => {
    expect(() => loadConfig({ ...validRaw, timezone: "Mars/Olympus" }, validEnv)).toThrow(
      /timezone/,
    );
  });

  test("names the missing env var when a Spectrum secret is absent", () => {
    expect(() => loadConfig(validRaw, { SPECTRUM_PROJECT_ID: "x" })).toThrow(
      /SPECTRUM_PROJECT_SECRET/,
    );
  });

  test("reports the offending field for a missing participant", () => {
    const { participants, ...rest } = validRaw;
    const raw = { ...rest, participants: { a: participants.a } };
    expect(() => loadConfig(raw, validEnv)).toThrow(/participants\.b/);
  });
});
