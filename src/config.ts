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
  spectrum: { projectId: string; projectSecret: string };
}

export type PersonId = "a" | "b";

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

  for (const key of ["SPECTRUM_PROJECT_ID", "SPECTRUM_PROJECT_SECRET"] as const) {
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
