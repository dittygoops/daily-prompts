import type { PersonId } from "../config";
import type { Ledger } from "../ledger/ledger";
import type { LlmClient } from "../llm/types";
import type { Memory } from "../memory/types";
import { extractObservations, type ExtractionInput } from "./extractor";

export interface PipelineDeps {
  ledger: Ledger;
  llm: LlmClient;
  memory: Memory;
  log: (msg: string) => void;
  now?: () => string;
  /** Restrict processing to one person's pending work (used by a
   * single-person memory rebuild). Omit to process both. */
  person?: PersonId;
}

export interface PipelineResult {
  processed: number;
  failed: number;
}

/** Scan the ledger for resolved days with pending extraction work, extract
 * observations for each, and write them to memory. Every (day, person) is
 * isolated in its own try/catch so one bad item never blocks the rest of
 * the batch. Retry accounting is entirely the ledger's job (the 3-attempt
 * cap already lives in unprocessedResolvedDays' query); this function only
 * reports outcomes via markExtraction. */
export async function processPending(deps: PipelineDeps): Promise<PipelineResult> {
  const now = deps.now ?? (() => new Date().toISOString());
  let processed = 0;
  let failed = 0;

  for (const { dayId, person } of deps.ledger.unprocessedResolvedDays(deps.person)) {
    try {
      const input = buildInput(deps.ledger, dayId, person);
      const { observations, promptIdeas } = await extractObservations(input, deps.llm);
      await deps.memory.add(observations);
      for (const idea of promptIdeas) {
        deps.ledger.addPromptIdea(person, idea, dayId, now());
      }
      deps.ledger.markExtraction(dayId, person, "done", observations.length, now());
      deps.log(
        `extracted day ${dayId} person ${person}: ${observations.length} observations, ${promptIdeas.length} prompt ideas`,
      );
      processed++;
    } catch (err) {
      deps.ledger.markExtraction(dayId, person, "failed", null, now());
      deps.log(`EXTRACTION FAILED day ${dayId} person ${person}: ${err}`);
      failed++;
    }
  }

  return { processed, failed };
}

function buildInput(ledger: Ledger, dayId: number, person: PersonId): ExtractionInput {
  const day = ledger.day(dayId);
  const personDay = ledger.personDay(dayId, person);
  const feedback = ledger
    .messagesForDay(dayId)
    .filter((m) => m.kind === "feedback" && m.person === person)
    .map((m) => m.text);

  return {
    dayId,
    date: day.date,
    promptText: day.prompt_text,
    person,
    response: personDay.state === "answered" ? personDay.response_text : null,
    // v0 simplification (accepted, not distinguished): a literal SKIP and a
    // resolved_partial day's never-answered person are both framed to the
    // extractor as "skipped" — the practical difference isn't acted on
    // anywhere downstream yet.
    skipped: personDay.state !== "answered",
    feedback,
  };
}
