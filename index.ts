import bank from "./data/prompts.json";
import { loadConfigFile } from "./src/config";
import { Ledger } from "./src/ledger/ledger";
import { SpectrumChannel } from "./src/channel/spectrum";
import { EngineRuntime } from "./src/engine/runtime";
import { StaticBankPromptSource } from "./src/prompts/staticBank";
import { nextDispatchAt, todayInTz } from "./src/scheduler";

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

const runtime = new EngineRuntime({
  names: { a: config.participants.a.name, b: config.participants.b.name },
  ledger,
  channel,
  promptSource: new StaticBankPromptSource(bank, ledger),
  settleWindowSeconds: config.settleWindowSeconds,
  log,
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

await reconcile();
await scheduleLoop();
