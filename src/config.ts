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
