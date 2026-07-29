import bank from "./data/prompts.json";
import { loadConfigFile } from "./src/config";
import { Ledger } from "./src/ledger/ledger";
import { SpectrumChannel } from "./src/channel/spectrum";
import { EngineRuntime } from "./src/engine/runtime";
import { HttpAnimalImageSource, providersFor } from "./src/media/animals";
import { StaticBankPromptSource } from "./src/prompts/staticBank";
import { AdaptivePromptSource } from "./src/prompts/adaptive";
import { FallbackPromptSource } from "./src/prompts/fallback";
import { nextDispatchAt, todayInTz } from "./src/scheduler";
import { OpenRouterClient } from "./src/llm/openrouter";
import { SupermemoryClient } from "./src/memory/supermemory";
import { LedgerOntology } from "./src/ontology/ledgerOntology";
import { processPending } from "./src/extraction/pipeline";
import { scorePending } from "./src/eval/scoring";
import { checkAndSendNudges } from "./src/nudge/pipeline";
import { checkAndSendWeeklyRecap } from "./src/recap/checker";

const log = (msg: string) => console.error(`[${new Date().toISOString()}] ${msg}`);

const configPath = process.argv[2] ?? "config.json";
const config = await loadConfigFile(configPath);
const ledger = Ledger.open(config.ledgerPath);

const channel = await SpectrumChannel.connect({
  projectId: config.spectrum.projectId,
  projectSecret: config.spectrum.projectSecret,
  phones: { a: config.participants.a.phone, b: config.participants.b.phone },
  onUnknown: (address, text, at) =>
    ledger.recordMessage({ dayId: null, person: null, direction: "in", kind: "unknown_sender", text: `${address}: ${text}`, at }),
  log,
});

// System 2 (memory) needs an LLM + memory client before System 3 (adaptive
// prompt generation) can be constructed, which in turn is needed before
// EngineRuntime; so these move ahead of runtime construction now.
const extractionLlm = new OpenRouterClient(config.openrouter.apiKey, config.extraction.model);
const generationLlm = new OpenRouterClient(config.openrouter.apiKey, config.generation.model);
const memory = new SupermemoryClient(config.supermemory.baseUrl, config.supermemory.apiKey);

const staticSource = new StaticBankPromptSource(bank, ledger);
const ontology = new LedgerOntology(ledger);
const adaptiveSource = new AdaptivePromptSource(ontology, generationLlm, ledger, {
  model: config.generation.model,
  historyWindowDays: config.generation.historyWindowDays,
  feedbackWindowDays: config.generation.feedbackWindowDays,
  contextBudgetChars: config.generation.contextBudgetChars,
  names: { a: config.participants.a.name, b: config.participants.b.name },
});
const promptSource = new FallbackPromptSource(adaptiveSource, staticSource, { ledger, log });

const runtime = new EngineRuntime({
  names: { a: config.participants.a.name, b: config.participants.b.name },
  ledger,
  channel,
  promptSource,
  settleWindowSeconds: config.settleWindowSeconds,
  log,
  personality: config.personality,
  animals: new HttpAnimalImageSource({ sources: providersFor(config.personality.animalKind) }),
});

channel.start();
log(`daemon up; participants ${config.participants.a.name} & ${config.participants.b.name}; dispatch ${String(config.dispatchTime.hour).padStart(2, "0")}:${String(config.dispatchTime.minute).padStart(2, "0")} ${config.timezone}`);

// Startup reconciliation: if today's dispatch time has passed and no day row
// exists for today (Mac was asleep/daemon down), dispatch late. Same calendar
// day only; older days expire via the machine at the next dispatch.
async function reconcile(): Promise<void> {
  const now = new Date();
  const today = todayInTz(now, config.timezone);
  const next = nextDispatchAt(now, config.dispatchTime, config.timezone);
  const dispatchStillAheadToday = todayInTz(next, config.timezone) === today;
  if (!dispatchStillAheadToday && !ledger.hasDay(today)) {
    log(`missed today's dispatch while down; dispatching late`);
    await runtime.dispatch(today);
  }
}

async function scheduleLoop(): Promise<never> {
  while (true) {
    const next = nextDispatchAt(new Date(), config.dispatchTime, config.timezone);
    log(`next dispatch at ${next.toISOString()}`);
    // Chunked wait: JS timers do not advance while the Mac sleeps, so a
    // single long setTimeout would fire hours late. Re-check the wall clock
    // at most every minute instead.
    while (Date.now() < next.getTime()) {
      const remaining = next.getTime() - Date.now();
      await new Promise((resolve) => setTimeout(resolve, Math.min(remaining, 60_000)));
    }
    const targetDate = todayInTz(next, config.timezone);
    if (todayInTz(new Date(), config.timezone) !== targetDate) {
      // Slept clean past that calendar day: per policy, never send a stale
      // prompt on a later day; log loudly and move to the next slot.
      log(`MISSED DISPATCH for ${targetDate} entirely (asleep); skipping that day`);
      continue;
    }
    try {
      await runtime.dispatch(targetDate);
      log(`dispatched ${targetDate}`);
    } catch (err) {
      log(`DISPATCH FAILED for ${targetDate}: ${err}`);
    }
  }
}

// Extraction (System 2): a side pipeline that must never take the daemon
// down. Messaging is the core product function; a memory-pipeline bug or an
// OpenRouter/Supermemory outage degrades gracefully (logged loudly, retried
// on the next poll via the ledger's own attempt cap) rather than crashing.
async function runExtraction(): Promise<void> {
  try {
    const result = await processPending({ ledger, llm: extractionLlm, memory, log });
    if (result.processed > 0 || result.failed > 0) {
      log(`extraction pass: ${result.processed} processed, ${result.failed} failed`);
    }
  } catch (err) {
    // processPending isolates per-item failures internally; reaching here
    // means a genuine bug (e.g. a ledger query itself throwing).
    log(`EXTRACTION PASS FAILED: ${err}`);
  }
}

// Rolling prompt scoring (eval harness phase 3): judges each generated
// prompt once and records the verdict, so quality drift is visible in the
// ledger instead of only when a report is run by hand. Shares the
// extraction poller's tick rather than adding a loop of its own; it costs
// one judge call per generated day and no-ops the rest of the time.
async function runScoring(): Promise<void> {
  try {
    const result = await scorePending({ ledger, llm: extractionLlm, model: config.extraction.model, log });
    if (result.scored > 0 || result.failed > 0) {
      log(`prompt scoring pass: ${result.scored} scored, ${result.failed} failed`);
    }
  } catch (err) {
    log(`PROMPT SCORING PASS FAILED: ${err}`);
  }
}

async function extractionLoop(): Promise<never> {
  while (true) {
    await new Promise((resolve) => setTimeout(resolve, config.extraction.pollMinutes * 60_000));
    // Per-iteration try/catch: runExtraction already can't throw, but this
    // guarantees the loop itself can never die and silently stop polling.
    try {
      await runExtraction();
      await runScoring();
    } catch (err) {
      log(`extraction loop iteration crashed unexpectedly: ${err}`);
    }
  }
}

// Nudges: same side-pipeline philosophy as extraction — a poller that
// reads the ledger and sends via the channel directly, never touching
// EngineRuntime/the state machine, and never allowed to take the daemon
// down.
async function runNudgeCheck(): Promise<void> {
  try {
    const result = await checkAndSendNudges({
      ledger,
      channel,
      names: { a: config.participants.a.name, b: config.participants.b.name },
      dispatchTime: config.dispatchTime,
      timezone: config.timezone,
      afterHours: config.nudge.afterHours,
      beforeDueHours: config.nudge.beforeDueHours,
      log,
      intensity: config.personality.intensity,
    });
    if (result.sent > 0) log(`nudge check: ${result.sent} sent`);
  } catch (err) {
    log(`NUDGE CHECK FAILED: ${err}`);
  }
}

async function nudgeLoop(): Promise<never> {
  while (true) {
    await new Promise((resolve) => setTimeout(resolve, config.nudge.pollMinutes * 60_000));
    try {
      await runNudgeCheck();
    } catch (err) {
      log(`nudge loop iteration crashed unexpectedly: ${err}`);
    }
  }
}

// Weekly recap: optional (config.weeklyRecap.enabled). Triggered by state,
// not a clock — a poller (same side-pipeline philosophy as extraction and
// nudges) that fires once the target weekday's dispatch has actually
// resolved, whether both answered, one did, or neither did (expired at the
// next day's dispatch). No separate startup reconciliation needed: the
// first poll tick after any downtime naturally catches up.
const recapLlm = new OpenRouterClient(config.openrouter.apiKey, config.weeklyRecap.model);

async function runRecapCheck(): Promise<void> {
  try {
    const result = await checkAndSendWeeklyRecap({
      ledger,
      channel,
      llm: recapLlm,
      names: { a: config.participants.a.name, b: config.participants.b.name },
      model: config.weeklyRecap.model,
      dayOfWeek: config.weeklyRecap.dayOfWeek,
      timezone: config.timezone,
      log,
      intensity: config.personality.intensity,
    });
    if (result.sent) log(`weekly recap sent`);
  } catch (err) {
    log(`WEEKLY RECAP CHECK FAILED: ${err}`);
  }
}

async function recapLoop(): Promise<never> {
  while (true) {
    await new Promise((resolve) => setTimeout(resolve, config.weeklyRecap.pollMinutes * 60_000));
    try {
      await runRecapCheck();
    } catch (err) {
      log(`recap loop iteration crashed unexpectedly: ${err}`);
    }
  }
}

await reconcile();
await runExtraction(); // startup catch-up: drain any backlog before the main loop takes over
await runScoring(); // same, for any prompts generated while this was down
void extractionLoop(); // fire-and-forget: runs concurrently with dispatch, never blocks it
void nudgeLoop(); // fire-and-forget: same independence guarantee
if (config.weeklyRecap.enabled) {
  await runRecapCheck(); // startup catch-up, same as extraction's
  void recapLoop();
}
await scheduleLoop();
