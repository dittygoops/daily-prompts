import type { Ledger } from "../ledger/ledger";
import type { LlmClient } from "../llm/types";
import { judgePrompt, passesAll, type Judgment } from "./judge";
import { AXES } from "./rubric";

export interface ScoringDeps {
  ledger: Ledger;
  llm: LlmClient;
  model: string;
  log: (msg: string) => void;
  now?: () => string;
}

export interface ScoringResult {
  scored: number;
  failed: number;
}


/** Only the failing axes are kept: a passing row's reasons are noise, and
 * the interesting question later is always why something failed. */
function failureReasons(judgment: Judgment): string | null {
  const failed = AXES.filter(([axis]) => !judgment[axis]).map(
    ([axis, reasonKey]) => `${axis}: ${judgment[reasonKey]}`,
  );
  return failed.length > 0 ? failed.join("; ") : null;
}

/** Eval harness phase 3: judge every generated prompt that has not been
 * judged yet and write the verdict to the ledger, so quality drift shows up
 * in the data rather than only when a report is run by hand. Same
 * side-pipeline rules as extraction: each item is isolated so one bad judge
 * call cannot block the batch, and nothing here can take the daemon down. */
export async function scorePending(deps: ScoringDeps): Promise<ScoringResult> {
  const now = deps.now ?? (() => new Date().toISOString());
  let scored = 0;
  let failed = 0;

  for (const row of deps.ledger.unscoredGenerations()) {
    try {
      const judgment = await judgePrompt(row.promptText!, deps.llm);
      deps.ledger.recordPromptScore({
        generationId: row.id,
        date: row.date,
        answerable: judgment.answerable,
        singleQuestion: judgment.singleQuestion,
        appropriateLength: judgment.appropriateLength,
        emotionallySafe: judgment.emotionallySafe,
        passedAll: passesAll(judgment),
        failureReasons: failureReasons(judgment),
        model: deps.model,
        at: now(),
      });
      if (!passesAll(judgment)) {
        deps.log(`prompt score ${row.date}: FAILED an axis (${failureReasons(judgment)})`);
      }
      scored++;
    } catch (err) {
      // Left unscored deliberately: unlike extraction there is no attempt
      // cap, because a score is pure observability. A permanently failing
      // row costs one judge call per poll and never blocks anything.
      deps.log(`PROMPT SCORING FAILED for ${row.date}: ${err}`);
      failed++;
    }
  }

  return { scored, failed };
}
