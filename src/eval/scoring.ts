import type { Ledger } from "../ledger/ledger";
import type { LlmClient } from "../llm/types";
import type { SelectionConstants } from "../selection/types";
import { runAudits } from "./audits";
import { judgePrompt, passesAll, type Judgment } from "./judge";
import { AXES } from "./rubric";

/** The spec's Constants section verified defaults (docs/superpowers/specs/
 * 2026-08-02-ee-synthesis-design.md), duplicated from config.ts's zod
 * defaults rather than imported: index.ts (owned by another package this
 * wave) does not yet thread config.selection through to scorePending, so
 * this poller needs a value to fall back on until that wiring lands. Kept in
 * lockstep with config.ts's `selection` block by inspection; a caller on a
 * non-default config should pass its own via ScoringDeps.selectionConstants. */
const DEFAULT_SELECTION_CONSTANTS: SelectionConstants = {
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
};

export interface ScoringDeps {
  ledger: Ledger;
  llm: LlmClient;
  model: string;
  log: (msg: string) => void;
  now?: () => string;
  /** Optional so every existing call site (owned by other packages this
   * wave) keeps compiling without passing it; defaults to the spec's
   * verified constants when omitted. */
  selectionConstants?: SelectionConstants;
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

  // Own try/catch, deliberately separate from the scoring loop above: a bug
  // in audit machinery is observability, not a scoring dependency, and must
  // never turn a working scoring pass into a failed one (spec "Audits":
  // "inside the scoring poller's own try/catch").
  try {
    const today = now().slice(0, 10);
    const constants = deps.selectionConstants ?? DEFAULT_SELECTION_CONSTANTS;
    const violations = runAudits(deps.ledger, today, constants);
    if (violations.length > 0) {
      deps.ledger.recordAuditViolations(today, violations, now());
      for (const v of violations) {
        deps.log(
          `AUDIT VIOLATION ${v.audit} person=${v.person ?? "-"} subject=${v.subject ?? "-"}: ${v.detail ?? ""}`,
        );
      }
    }
  } catch (err) {
    deps.log(`AUDIT RUN FAILED: ${err}`);
  }

  return { scored, failed };
}
