import { z } from "zod";

const e164 = z
  .string()
  .regex(/^\+[1-9]\d{6,14}$/, "must be E.164, e.g. +14805551234");

const participantSchema = z.object({
  name: z.string().min(1),
  phone: e164,
});

const rawConfigSchema = z.object({
  participants: z.object({ a: participantSchema, b: participantSchema }),
  dispatchTime: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "must be 24h HH:MM, e.g. 08:30"),
  timezone: z.string().refine(
    (tz) => {
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: tz });
        return true;
      } catch {
        return false;
      }
    },
    { message: "must be a valid IANA timezone, e.g. America/Phoenix" },
  ),
  settleWindowSeconds: z.number().int().positive().default(150),
  ledgerPath: z.string().min(1).default("./ledger.db"),
  extraction: z
    .object({
      model: z.string().min(1).default("google/gemini-2.5-flash"),
      pollMinutes: z.number().int().positive().default(5),
    })
    .default({ model: "google/gemini-2.5-flash", pollMinutes: 5 }),
  generation: z
    .object({
      model: z.string().min(1).default("google/gemini-2.5-flash"),
      historyWindowDays: z.number().int().positive().default(14),
      feedbackWindowDays: z.number().int().positive().default(14),
      contextBudgetChars: z.number().int().positive().default(3000),
    })
    .default({
      model: "google/gemini-2.5-flash",
      historyWindowDays: 14,
      feedbackWindowDays: 14,
      contextBudgetChars: 3000,
    }),
  nudge: z
    .object({
      afterHours: z.number().positive().default(4),
      beforeDueHours: z.number().positive().default(4),
      pollMinutes: z.number().int().positive().default(10),
    })
    .default({ afterHours: 4, beforeDueHours: 4, pollMinutes: 10 }),
  weeklyRecap: z
    .object({
      enabled: z.boolean().default(false),
      dayOfWeek: z.number().int().min(0).max(6).default(0),
      pollMinutes: z.number().int().positive().default(15),
      model: z.string().min(1).default("google/gemini-2.5-flash"),
    })
    .default({ enabled: false, dayOfWeek: 0, pollMinutes: 15, model: "google/gemini-2.5-flash" }),
  personality: z
    .object({
      // Defaults to "off", not "playful", on purpose: a schema default of
      // "playful" would silently turn the whole feature on the next time an
      // existing config.json (written before this block existed) restarts
      // with no personality key at all. This project has already had a
      // feature fire unannounced to a participant that way. "playful" is
      // the owner's preferred steady state, but that gets set explicitly in
      // config.json, never assumed by the schema.
      intensity: z.enum(["off", "subtle", "playful"]).default("off"),
      // Independently switchable from the rest of the effect policy: an
      // animal image is an outbound network fetch that can fail or hang,
      // while other effects are a local vendor flag lookup, and the two
      // have different annoyance profiles if they misfire. Ignored entirely
      // when intensity is "off".
      animalImage: z.boolean().default(true),
      // dog.ceo draws from the full breed list, which includes some
      // distinctly odd-looking ones. Cats by default after the owner saw a
      // dhole; "both" restores the original random mix across all sources.
      animalKind: z.enum(["cats", "dogs", "both"]).default("cats"),
      // Hard outer wall-clock deadline for the whole animal image fetch.
      // HttpAnimalImageSource.fetch (src/media/animals.ts) makes up to 3
      // attempts, and each attempt makes two independently timed HTTP calls
      // (a provider `resolve`, then `downloadImage`), each with its own 8s
      // AbortSignal.timeout. Those can compound to roughly 48s across 3
      // attempts, not 24s: the loop does not retry on error, only a recency
      // id collision causes a re-loop, so a real fetch failure propagates
      // immediately, but a slow-but-successful run can legitimately take
      // close to the full 48s. Dispatch must not stall that long.
      animalTimeoutMs: z.number().int().positive().default(10_000),
    })
    .default({ intensity: "off", animalImage: true, animalKind: "cats", animalTimeoutMs: 10_000 }),
  // Ten constants from the ee-synthesis-design spec's Constants section,
  // every one a window length (days) or a count, never a switch. Unlike
  // personality, defaulting this block on is safe: there is no "off" state
  // to accidentally skip past, only how wide the windows are, so an existing
  // config.json restarting with no selection key gets the spec's verified
  // defaults rather than a feature silently turning on.
  selection: z
    .object({
      settlingDays: z.number().int().positive().default(2),
      subjectCooldownDays: z.number().int().positive().default(14),
      domainCooldownDays: z.number().int().positive().default(4),
      familyCooldownDays: z.number().int().positive().default(7),
      tokenWindowDays: z.number().int().positive().default(3),
      exploitRunCap: z.number().int().positive().default(2),
      budgetCap: z.number().int().positive().default(3),
      candidateDepth: z.number().int().positive().default(8),
      seedReuseDays: z.number().int().positive().default(90),
      anchorMinSharedWords: z.number().int().positive().default(1),
    })
    .default({
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
    }),
});

export interface Config {
  participants: {
    a: { name: string; phone: string };
    b: { name: string; phone: string };
  };
  dispatchTime: { hour: number; minute: number };
  timezone: string;
  settleWindowSeconds: number;
  ledgerPath: string;
  extraction: { model: string; pollMinutes: number };
  generation: { model: string; historyWindowDays: number; feedbackWindowDays: number; contextBudgetChars: number };
  nudge: { afterHours: number; beforeDueHours: number; pollMinutes: number };
  weeklyRecap: { enabled: boolean; dayOfWeek: number; pollMinutes: number; model: string };
  // The "off" | "subtle" | "playful" union is duplicated from EffectIntensity
  // (src/engine/effects.ts) on purpose: this file currently imports nothing
  // but zod and is depended on by nearly everything, so importing from
  // src/engine/ here would invert the dependency direction. The duplication
  // is guarded by a compile-time assertion in tests/config.test.ts.
  personality: { intensity: "off" | "subtle" | "playful"; animalImage: boolean; animalKind: "cats" | "dogs" | "both"; animalTimeoutMs: number };
  selection: {
    settlingDays: number;
    subjectCooldownDays: number;
    domainCooldownDays: number;
    familyCooldownDays: number;
    tokenWindowDays: number;
    exploitRunCap: number;
    budgetCap: number;
    candidateDepth: number;
    seedReuseDays: number;
    anchorMinSharedWords: number;
  };
  spectrum: { projectId: string; projectSecret: string };
  openrouter: { apiKey: string };
  supermemory: { apiKey: string; baseUrl: string };
}

export type PersonId = "a" | "b";

const REQUIRED_ENV = [
  "SPECTRUM_PROJECT_ID",
  "SPECTRUM_PROJECT_SECRET",
  "OPENROUTER_API_KEY",
  "SUPERMEMORY_API_KEY",
] as const;

export function loadConfig(
  raw: unknown,
  env: Record<string, string | undefined>,
): Config {
  const parsed = rawConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const lines = parsed.error.issues.map(
      (issue) => `  config.${issue.path.join(".")}: ${issue.message}`,
    );
    throw new Error(`Invalid config:\n${lines.join("\n")}`);
  }
  const config = parsed.data;

  if (config.participants.a.phone === config.participants.b.phone) {
    throw new Error(
      "Invalid config: participants.a.phone and participants.b.phone must be distinct numbers",
    );
  }

  for (const key of REQUIRED_ENV) {
    if (!env[key]) {
      throw new Error(`Missing required environment variable: ${key}`);
    }
  }

  const [hour, minute] = config.dispatchTime.split(":").map(Number) as [
    number,
    number,
  ];
  return {
    ...config,
    dispatchTime: { hour, minute },
    spectrum: {
      projectId: env.SPECTRUM_PROJECT_ID!,
      projectSecret: env.SPECTRUM_PROJECT_SECRET!,
    },
    openrouter: { apiKey: env.OPENROUTER_API_KEY! },
    supermemory: {
      apiKey: env.SUPERMEMORY_API_KEY!,
      baseUrl: env.SUPERMEMORY_BASE_URL ?? "http://localhost:6767",
    },
  };
}

export async function loadConfigFile(
  path: string,
  env: Record<string, string | undefined> = process.env,
): Promise<Config> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new Error(
      `Config file not found: ${path} (copy config.example.json to config.json and fill it in)`,
    );
  }
  return loadConfig(await file.json(), env);
}
