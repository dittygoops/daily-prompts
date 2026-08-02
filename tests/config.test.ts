import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config";
import type { Config } from "../src/config";
import type { EffectIntensity } from "../src/engine/effects";

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
  OPENROUTER_API_KEY: "or-key",
  SUPERMEMORY_API_KEY: "sm-key",
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
    expect(config.extraction.model).toBe("google/gemini-2.5-flash");
    expect(config.extraction.pollMinutes).toBe(5);
    expect(config.generation.model).toBe("google/gemini-2.5-flash");
    expect(config.generation.historyWindowDays).toBe(14);
    expect(config.generation.feedbackWindowDays).toBe(14);
    expect(config.generation.contextBudgetChars).toBe(3000);
    expect(config.nudge.afterHours).toBe(4);
    expect(config.nudge.beforeDueHours).toBe(4);
    expect(config.nudge.pollMinutes).toBe(10);
    expect(config.weeklyRecap.enabled).toBe(false);
    expect(config.weeklyRecap.dayOfWeek).toBe(0);
    expect(config.weeklyRecap.pollMinutes).toBe(15);
    expect(config.weeklyRecap.model).toBe("google/gemini-2.5-flash");
    expect(config.openrouter.apiKey).toBe("or-key");
    expect(config.supermemory.apiKey).toBe("sm-key");
    expect(config.supermemory.baseUrl).toBe("http://localhost:6767");
  });

  test("honors explicit extraction and supermemory overrides", () => {
    const config = loadConfig(
      { ...validRaw, extraction: { model: "google/gemini-2.5-flash-lite", pollMinutes: 10 } },
      { ...validEnv, SUPERMEMORY_BASE_URL: "http://localhost:7000" },
    );
    expect(config.extraction.model).toBe("google/gemini-2.5-flash-lite");
    expect(config.extraction.pollMinutes).toBe(10);
    expect(config.supermemory.baseUrl).toBe("http://localhost:7000");
  });

  test("names the missing env var when OpenRouter or Supermemory keys are absent", () => {
    const { OPENROUTER_API_KEY, ...rest } = validEnv;
    expect(() => loadConfig(validRaw, rest)).toThrow(/OPENROUTER_API_KEY/);
    const { SUPERMEMORY_API_KEY, ...rest2 } = validEnv;
    expect(() => loadConfig(validRaw, rest2)).toThrow(/SUPERMEMORY_API_KEY/);
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

  describe("personality", () => {
    // Guard against a silent feature enable: a schema default of "playful"
    // would turn the feature on for every existing config.json (which has
    // no personality block) the next time the process restarts, with no
    // one having asked for it. intensity must default to "off".
    test("defaults to off when no personality block is present", () => {
      const config = loadConfig(validRaw, validEnv);
      expect(config.personality.intensity).toBe("off");
      expect(config.personality).toEqual({
        intensity: "off",
        animalImage: true,
        animalKind: "cats",
        animalTimeoutMs: 10_000,
      });
    });

    test("honors an explicit personality block", () => {
      const config = loadConfig(
        { ...validRaw, personality: { intensity: "playful", animalImage: false, animalKind: "both", animalTimeoutMs: 3000 } },
        validEnv,
      );
      expect(config.personality).toEqual({
        intensity: "playful",
        animalImage: false,
        animalKind: "both",
        animalTimeoutMs: 3000,
      });
    });

    test("rejects an invalid intensity value", () => {
      expect(() =>
        loadConfig({ ...validRaw, personality: { intensity: "loud" } }, validEnv),
      ).toThrow(/config\.personality\.intensity/);
    });

    // Compile-time only: fails `bunx tsc --noEmit` if the schema's intensity
    // enum and EffectIntensity (src/engine/effects.ts) ever drift apart. The
    // duplication is deliberate (see src/config.ts); this is what catches it
    // going stale.
    test("the personality.intensity enum and EffectIntensity stay in sync (typecheck only)", () => {
      const _forward: EffectIntensity = "playful" as Config["personality"]["intensity"];
      const _backward: Config["personality"]["intensity"] = "playful" as EffectIntensity;
      void _forward;
      void _backward;
      expect(true).toBe(true);
    });
  });

  describe("selection", () => {
    // Every field here is a window length or a count, never a switch, so
    // these defaults (from the ee-synthesis-design spec's Constants section)
    // are safe to apply automatically: an existing config.json written
    // before this block existed just gets the spec's windows, not a new
    // behavior turned on.
    test("defaults to the spec's window and count values when no selection block is present", () => {
      const config = loadConfig(validRaw, validEnv);
      expect(config.selection).toEqual({
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
      });
    });

    test("honors an explicit selection block", () => {
      const config = loadConfig(
        {
          ...validRaw,
          selection: {
            settlingDays: 1,
            subjectCooldownDays: 10,
            domainCooldownDays: 3,
            familyCooldownDays: 5,
            tokenWindowDays: 2,
            exploitRunCap: 3,
            budgetCap: 4,
            candidateDepth: 6,
            seedReuseDays: 60,
            anchorMinSharedWords: 2,
          },
        },
        validEnv,
      );
      expect(config.selection).toEqual({
        settlingDays: 1,
        subjectCooldownDays: 10,
        domainCooldownDays: 3,
        familyCooldownDays: 5,
        tokenWindowDays: 2,
        exploitRunCap: 3,
        budgetCap: 4,
        candidateDepth: 6,
        seedReuseDays: 60,
        anchorMinSharedWords: 2,
      });
    });
  });
});
