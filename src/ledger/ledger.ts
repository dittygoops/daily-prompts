import { Database } from "bun:sqlite";
import { chmodSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { PersonId } from "../config";

export type DayState =
  | "dispatched"
  | "resolved_shared"
  | "resolved_partial"
  | "resolved_skipped"
  | "expired"
  | "failed";

export type PersonState = "awaiting" | "collecting" | "answered" | "skipped";

export type MessageKind =
  | "prompt"
  | "answer_part"
  | "skip"
  | "waiting_notice"
  | "share"
  | "skip_notice"
  | "skip_ack"
  | "feedback_ask"
  | "feedback"
  | "oob_reply"
  | "oob_in"
  | "unknown_sender"
  | "send_failed";

export interface DayRow {
  id: number;
  date: string;
  prompt_id: string;
  prompt_text: string;
  state: DayState;
  dispatched_at: string | null;
  resolved_at: string | null;
}

export interface PersonDayRow {
  day_id: number;
  person: PersonId;
  state: PersonState;
  response_text: string | null;
  finalized_at: string | null;
  share_sent_at: string | null;
  feedback_ask_sent_at: string | null;
  /** The question this person was actually asked. Populated for every row,
   * including migrated ones, so consumers never branch on null. */
  prompt_id: string | null;
  prompt_text: string | null;
}

export interface MessageRow {
  id: number;
  day_id: number | null;
  person: PersonId | null;
  direction: "in" | "out";
  kind: MessageKind;
  text: string;
  at: string;
}

export interface GenerationLogEntry {
  date: string;
  promptId: string | null;
  promptText: string | null;
  model: string | null;
  systemPrompt: string | null;
  userPrompt: string | null;
  rawResponse: string | null;
  rationale: string | null;
  /** "explore" or "exploit", as declared by the generator. Null on fallback
   * rows, where no generator ran to declare anything. */
  stance: string | null;
  /** Which person this prompt was generated for. Null on fallback rows,
   * where neither person got a tailored prompt. */
  person: PersonId | null;
  fellBack: boolean;
  fallbackReason: string | null;
  at: string;
}

export interface GenerationLogRow extends GenerationLogEntry {
  id: number;
}

export interface PromptScoreEntry {
  generationId: number;
  date: string;
  answerable: boolean;
  singleQuestion: boolean;
  appropriateLength: boolean;
  emotionallySafe: boolean;
  passedAll: boolean;
  /** Judge reasons for the failing axes only, so a passing row stays small. */
  failureReasons: string | null;
  model: string | null;
  at: string;
}

export interface PromptScoreRow extends PromptScoreEntry {
  id: number;
}

interface PromptScoreDbRow {
  id: number; generation_id: number; date: string;
  answerable: number; single_question: number; appropriate_length: number;
  emotionally_safe: number; passed_all: number;
  failure_reasons: string | null; model: string | null; at: string;
}

interface GenerationLogDbRow {
  id: number; date: string; prompt_id: string | null; prompt_text: string | null;
  model: string | null; system_prompt: string | null; user_prompt: string | null;
  raw_response: string | null; rationale: string | null; stance: string | null;
  person: PersonId | null; fell_back: number; fallback_reason: string | null; at: string;
}

const toGenerationLogRow = (r: GenerationLogDbRow): GenerationLogRow => ({
  id: r.id,
  date: r.date,
  promptId: r.prompt_id,
  promptText: r.prompt_text,
  model: r.model,
  systemPrompt: r.system_prompt,
  userPrompt: r.user_prompt,
  rawResponse: r.raw_response,
  rationale: r.rationale,
  stance: r.stance,
  person: r.person,
  fellBack: r.fell_back === 1,
  fallbackReason: r.fallback_reason,
  at: r.at,
});

export interface PromptIdeaRow {
  id: number;
  person: PersonId;
  text: string;
  suggestedDayId: number;
  suggestedAt: string;
  usedDayId: number | null;
  usedAt: string | null;
}

export interface RecapLogEntry {
  weekStart: string;
  weekEnd: string;
  recapText: string;
  model: string | null;
  systemPrompt: string | null;
  userPrompt: string | null;
  rawResponse: string | null;
  fellBack: boolean;
  fallbackReason: string | null;
  at: string;
}

export type NudgeTrigger = "no_response" | "partner_waiting" | "almost_due";

export type ExtractionStatus = "done" | "failed";

export interface ExtractionRow {
  dayId: number;
  person: PersonId;
  status: ExtractionStatus;
  attempts: number;
  observationCount: number | null;
  completedAt: string | null;
}

const EXTRACTION_MAX_ATTEMPTS = 3;

export class Ledger {
  private constructor(private readonly db: Database) {}

  /** Additive column migrations. schema.sql's CREATE TABLE IF NOT EXISTS is
   * a no-op against a ledger that already exists, so a column added there
   * would never reach the live database. Each step is guarded by its own
   * existence check so opening is idempotent. */
  private static migrateSchema(db: Database): void {
    const has = (table: string, column: string) =>
      (db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === column);

    if (!has("generation_log", "stance")) {
      db.exec("ALTER TABLE generation_log ADD COLUMN stance TEXT");
    }
    // One generation_log row per person once prompts differ. Nullable: a
    // fallback row represents a day where no per-person generation happened.
    if (!has("generation_log", "person")) {
      db.exec("ALTER TABLE generation_log ADD COLUMN person TEXT");
    }
    if (!has("person_days", "prompt_id")) {
      db.exec("ALTER TABLE person_days ADD COLUMN prompt_id TEXT");
    }
    if (!has("person_days", "prompt_text")) {
      db.exec("ALTER TABLE person_days ADD COLUMN prompt_text TEXT");
    }
    // Backfill from the owning day so historical rows read correctly and no
    // consumer needs a null branch for days that predate per-person prompts.
    db.exec(`UPDATE person_days SET
               prompt_id = COALESCE(prompt_id, (SELECT d.prompt_id FROM days d WHERE d.id = person_days.day_id)),
               prompt_text = COALESCE(prompt_text, (SELECT d.prompt_text FROM days d WHERE d.id = person_days.day_id))
             WHERE prompt_text IS NULL OR prompt_id IS NULL`);
    // No backfill, unlike person_days.prompt_text above: a day that predates
    // this feature genuinely had no image attached, so null is the honest
    // encoding rather than a value to compute.
    if (!has("days", "animal_image_id")) {
      db.exec("ALTER TABLE days ADD COLUMN animal_image_id TEXT");
    }
  }

  static open(path: string): Ledger {
    const db = new Database(path, { create: true, strict: true });
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA foreign_keys = ON;");
    const schemaPath = join(import.meta.dir, "schema.sql");
    db.exec(readFileSync(schemaPath, "utf8"));
    Ledger.migrateSchema(db);
    if (path !== ":memory:") {
      // The ledger holds the couple's entire message history verbatim; keep
      // it out of reach of other local accounts.
      chmodSync(path, 0o600);
    }
    return new Ledger(db);
  }

  close(): void {
    this.db.close();
  }

  createDay(date: string, promptId: string, promptText: string, dispatchedAt: string): DayRow {
    const day = this.db
      .query<DayRow, [string, string, string, string]>(
        `INSERT INTO days (date, prompt_id, prompt_text, state, dispatched_at)
         VALUES (?, ?, ?, 'dispatched', ?) RETURNING *`,
      )
      .get(date, promptId, promptText, dispatchedAt)!;
    for (const person of ["a", "b"] as const) {
      // Seeded from the day's prompt so a day is never in a state where
      // somebody has no question. setPersonPrompt overwrites when the
      // generator produces a tailored one.
      this.db
        .query(`INSERT INTO person_days (day_id, person, prompt_id, prompt_text) VALUES (?, ?, ?, ?)`)
        .run(day.id, person, promptId, promptText);
    }
    return day;
  }

  day(id: number): DayRow {
    const row = this.db.query<DayRow, [number]>(`SELECT * FROM days WHERE id = ?`).get(id);
    if (!row) throw new Error(`No day with id ${id}`);
    return row;
  }

  dayForDate(date: string): DayRow | null {
    return this.db.query<DayRow, [string]>(`SELECT * FROM days WHERE date = ?`).get(date);
  }

  hasDay(date: string): boolean {
    return (
      this.db.query<{ n: number }, [string]>(`SELECT COUNT(*) AS n FROM days WHERE date = ?`).get(date)!
        .n > 0
    );
  }

  openDay(): DayRow | null {
    return this.db
      .query<DayRow, []>(`SELECT * FROM days WHERE state = 'dispatched' ORDER BY id DESC LIMIT 1`)
      .get();
  }

  /** Most recent day regardless of state (used to restore the feedback
   * window after a restart). */
  latestDay(): DayRow | null {
    return this.db.query<DayRow, []>(`SELECT * FROM days ORDER BY id DESC LIMIT 1`).get();
  }

  resolveDay(id: number, state: Exclude<DayState, "dispatched">, at: string): void {
    this.db
      .query(`UPDATE days SET state = ?, resolved_at = ? WHERE id = ?`)
      .run(state, at, id);
  }

  /** Recency avoid-list for the next animal image, newest first. */
  recentAnimalImageIds(limit: number): string[] {
    const rows = this.db
      .query<{ animal_image_id: string }, [number]>(
        `SELECT animal_image_id FROM days WHERE animal_image_id IS NOT NULL ORDER BY id DESC LIMIT ?`,
      )
      .all(limit);
    return rows.map((r) => r.animal_image_id);
  }

  /** Recorded only after an image actually went out, so the avoid-list never
   * contains an image nobody saw. Idempotent: both persons' prompt sends
   * write the same id for the same day. */
  setDayAnimalImage(dayId: number, imageId: string): void {
    this.db.query(`UPDATE days SET animal_image_id = ? WHERE id = ?`).run(imageId, dayId);
  }

  personDay(dayId: number, person: PersonId): PersonDayRow {
    const row = this.db
      .query<PersonDayRow, [number, string]>(
        `SELECT * FROM person_days WHERE day_id = ? AND person = ?`,
      )
      .get(dayId, person);
    if (!row) throw new Error(`No person_day for day ${dayId} person ${person}`);
    return row;
  }

  personState(dayId: number, person: PersonId): PersonState {
    return this.personDay(dayId, person).state;
  }

  personResponse(dayId: number, person: PersonId): string | null {
    return this.personDay(dayId, person).response_text;
  }

  setCollecting(dayId: number, person: PersonId): void {
    this.db
      .query(`UPDATE person_days SET state = 'collecting' WHERE day_id = ? AND person = ? AND state = 'awaiting'`)
      .run(dayId, person);
  }

  finalizeResponse(dayId: number, person: PersonId, text: string, at: string): void {
    this.db
      .query(
        `UPDATE person_days SET state = 'answered', response_text = ?, finalized_at = ?
         WHERE day_id = ? AND person = ?`,
      )
      .run(text, at, dayId, person);
  }

  markSkipped(dayId: number, person: PersonId, at: string): void {
    this.db
      .query(`UPDATE person_days SET state = 'skipped', finalized_at = ? WHERE day_id = ? AND person = ?`)
      .run(at, dayId, person);
  }

  markShareSent(dayId: number, person: PersonId, at: string): void {
    this.db
      .query(`UPDATE person_days SET share_sent_at = ? WHERE day_id = ? AND person = ?`)
      .run(at, dayId, person);
  }

  markFeedbackAskSent(dayId: number, person: PersonId, at: string): void {
    this.db
      .query(`UPDATE person_days SET feedback_ask_sent_at = ? WHERE day_id = ? AND person = ?`)
      .run(at, dayId, person);
  }

  recordMessage(msg: {
    dayId: number | null;
    person: PersonId | null;
    direction: "in" | "out";
    kind: MessageKind;
    text: string;
    at: string;
  }): void {
    this.db
      .query(
        `INSERT INTO messages (day_id, person, direction, kind, text, at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(msg.dayId, msg.person, msg.direction, msg.kind, msg.text, msg.at);
  }

  messagesForDay(dayId: number | null): MessageRow[] {
    if (dayId === null) {
      return this.db
        .query<MessageRow, []>(`SELECT * FROM messages WHERE day_id IS NULL ORDER BY id`)
        .all();
    }
    return this.db
      .query<MessageRow, [number]>(`SELECT * FROM messages WHERE day_id = ? ORDER BY id`)
      .all(dayId);
  }

  markPromptUsed(promptId: string, usedOn: string): void {
    this.db
      .query(`INSERT OR REPLACE INTO prompt_usage (prompt_id, used_on) VALUES (?, ?)`)
      .run(promptId, usedOn);
  }

  usedPromptIds(): Set<string> {
    const rows = this.db
      .query<{ prompt_id: string }, []>(`SELECT prompt_id FROM prompt_usage`)
      .all();
    return new Set(rows.map((r) => r.prompt_id));
  }

  /** Start a fresh no-repeat cycle once the bank is exhausted. */
  clearPromptUsage(): void {
    this.db.query(`DELETE FROM prompt_usage`).run();
  }

  /** Every (day, person) whose day has left `dispatched` and has no `done`
   * extraction, and hasn't exhausted the retry cap. Ordered oldest-first.
   * An optional `person` filter restricts to just that person's rows (used
   * by a single-person memory rebuild). */
  unprocessedResolvedDays(person?: PersonId): { dayId: number; person: PersonId }[] {
    const rows = person
      ? this.db
          .query<
            { day_id: number; person: PersonId },
            [string, string, number]
          >(
            `SELECT d.id AS day_id, ? AS person
             FROM days d
             LEFT JOIN extractions e ON e.day_id = d.id AND e.person = ?
             WHERE d.state != 'dispatched'
               AND (e.day_id IS NULL OR (e.status != 'done' AND e.attempts < ?))
             ORDER BY d.id`,
          )
          .all(person, person, EXTRACTION_MAX_ATTEMPTS)
      : this.db
          .query<
            { day_id: number; person: PersonId },
            [number]
          >(
            `SELECT d.id AS day_id, p.person AS person
             FROM days d
             CROSS JOIN (SELECT 'a' AS person UNION ALL SELECT 'b') p
             LEFT JOIN extractions e ON e.day_id = d.id AND e.person = p.person
             WHERE d.state != 'dispatched'
               AND (e.day_id IS NULL OR (e.status != 'done' AND e.attempts < ?))
             ORDER BY d.id, p.person`,
          )
          .all(EXTRACTION_MAX_ATTEMPTS);
    return rows.map((r) => ({ dayId: r.day_id, person: r.person }));
  }

  markExtraction(
    dayId: number,
    person: PersonId,
    status: ExtractionStatus,
    observationCount: number | null,
    at: string,
  ): void {
    const prior = this.extractionFor(dayId, person);
    const attempts = (prior?.attempts ?? 0) + 1;
    this.db
      .query(
        `INSERT INTO extractions (day_id, person, status, attempts, observation_count, completed_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (day_id, person) DO UPDATE SET
           status = excluded.status,
           attempts = excluded.attempts,
           observation_count = excluded.observation_count,
           completed_at = excluded.completed_at`,
      )
      .run(dayId, person, status, attempts, observationCount, at);
  }

  extractionFor(dayId: number, person: PersonId): ExtractionRow | null {
    const row = this.db
      .query<
        {
          day_id: number;
          person: PersonId;
          status: ExtractionStatus;
          attempts: number;
          observation_count: number | null;
          completed_at: string | null;
        },
        [number, string]
      >(`SELECT * FROM extractions WHERE day_id = ? AND person = ?`)
      .get(dayId, person);
    if (!row) return null;
    return {
      dayId: row.day_id,
      person: row.person,
      status: row.status,
      attempts: row.attempts,
      observationCount: row.observation_count,
      completedAt: row.completed_at,
    };
  }

  /** Wipe all extraction bookkeeping so every resolved day becomes pending
   * again (used by the memory rebuild script). */
  clearAllExtractions(): void {
    this.db.query(`DELETE FROM extractions`).run();
  }

  /** Wipe just one person's extraction bookkeeping (single-person rebuild). */
  clearExtractionsFor(person: PersonId): void {
    this.db.query(`DELETE FROM extractions WHERE person = ?`).run(person);
  }

  /** Days strictly before `beforeDate`, most recent first, capped at
   * `limit`. Used to assemble recent-prompt-history context. */
  recentDays(beforeDate: string, limit: number): DayRow[] {
    return this.db
      .query<DayRow, [string, number]>(
        `SELECT * FROM days WHERE date < ? ORDER BY date DESC LIMIT ?`,
      )
      .all(beforeDate, limit);
  }

  /** Feedback messages on/after `sinceDate`, tagged with the day's date and
   * the person who sent them. */
  feedbackSince(sinceDate: string): { date: string; person: PersonId; text: string }[] {
    return this.db
      .query<
        { date: string; person: PersonId; text: string },
        [string]
      >(
        `SELECT d.date AS date, m.person AS person, m.text AS text
         FROM messages m
         JOIN days d ON d.id = m.day_id
         WHERE m.kind = 'feedback' AND d.date >= ?
         ORDER BY m.id`,
      )
      .all(sinceDate);
  }

  /** Replace one person's question, once the generator has produced a prompt
   * tailored to their own memory. */
  setPersonPrompt(dayId: number, person: PersonId, promptId: string, promptText: string): void {
    this.db
      .query(`UPDATE person_days SET prompt_id = ?, prompt_text = ? WHERE day_id = ? AND person = ?`)
      .run(promptId, promptText, dayId, person);
  }

  recordGeneration(entry: GenerationLogEntry): void {
    this.db
      .query(
        `INSERT INTO generation_log
           (date, prompt_id, prompt_text, model, system_prompt, user_prompt, raw_response, rationale, stance, person, fell_back, fallback_reason, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.date,
        entry.promptId,
        entry.promptText,
        entry.model,
        entry.systemPrompt,
        entry.userPrompt,
        entry.rawResponse,
        entry.rationale,
        entry.stance,
        entry.person,
        entry.fellBack ? 1 : 0,
        entry.fallbackReason,
        entry.at,
      );
  }

  generationLogFor(date: string): GenerationLogRow[] {
    const rows = this.db
      .query<GenerationLogDbRow, [string]>(`SELECT * FROM generation_log WHERE date = ? ORDER BY id`)
      .all(date);
    return rows.map(toGenerationLogRow);
  }

  /** Every generation attempt ever recorded, oldest first. Powers the
   * offline eval harness, which scores generated prompts against the
   * history that preceded each one. */
  allGenerationLog(): GenerationLogRow[] {
    const rows = this.db
      .query<GenerationLogDbRow, []>(`SELECT * FROM generation_log ORDER BY date, id`)
      .all();
    return rows.map(toGenerationLogRow);
  }

  /** Every question THIS person was asked before `date`, oldest first.
   * Novelty has to be measured within one person's own history: comparing a
   * question against the day-level theme, or against the partner's question,
   * measures the wrong thing. Not window-limited, because a repeat from
   * outside the generator's context window is still a repeat to the person
   * receiving it. */
  personPromptsBefore(date: string, person: PersonId): string[] {
    const rows = this.db
      .query<{ prompt_text: string | null }, [PersonId, string]>(
        `SELECT pd.prompt_text FROM person_days pd
         JOIN days d ON d.id = pd.day_id
         WHERE pd.person = ? AND d.date < ?
         ORDER BY d.date`,
      )
      .all(person, date);
    return rows.map((r) => r.prompt_text).filter((t): t is string => t !== null && t.length > 0);
  }

  /** Generated prompts still awaiting a quality score, oldest first.
   * Fallback rows are excluded: those came from the static bank, which has
   * its own scored baseline in docs/eval-baseline-static-bank.md. */
  unscoredGenerations(): GenerationLogRow[] {
    const rows = this.db
      .query<GenerationLogDbRow, []>(
        `SELECT g.* FROM generation_log g
         LEFT JOIN prompt_scores s ON s.generation_id = g.id
         WHERE s.id IS NULL AND g.fell_back = 0 AND g.prompt_text IS NOT NULL
         ORDER BY g.date, g.id`,
      )
      .all();
    return rows.map(toGenerationLogRow);
  }

  /** Idempotent per generation row: a re-run or a restart mid-pass can
   * never double-count a day's score. */
  recordPromptScore(entry: PromptScoreEntry): void {
    this.db
      .query(
        `INSERT OR IGNORE INTO prompt_scores
           (generation_id, date, answerable, single_question, appropriate_length, emotionally_safe, passed_all, failure_reasons, model, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.generationId,
        entry.date,
        entry.answerable ? 1 : 0,
        entry.singleQuestion ? 1 : 0,
        entry.appropriateLength ? 1 : 0,
        entry.emotionallySafe ? 1 : 0,
        entry.passedAll ? 1 : 0,
        entry.failureReasons,
        entry.model,
        entry.at,
      );
  }

  promptScores(): PromptScoreRow[] {
    const rows = this.db
      .query<PromptScoreDbRow, []>(`SELECT * FROM prompt_scores ORDER BY date, id`)
      .all();
    return rows.map((r) => ({
      id: r.id,
      generationId: r.generation_id,
      date: r.date,
      answerable: r.answerable === 1,
      singleQuestion: r.single_question === 1,
      appropriateLength: r.appropriate_length === 1,
      emotionallySafe: r.emotionally_safe === 1,
      passedAll: r.passed_all === 1,
      failureReasons: r.failure_reasons,
      model: r.model,
      at: r.at,
    }));
  }

  /** Record a prompt idea a participant suggested (via feedback). Returns
   * its id so callers can later mark it used. Durable: stays unconsumed
   * indefinitely until explicitly marked used, no expiry window. */
  addPromptIdea(person: PersonId, text: string, suggestedDayId: number, at: string): number {
    const row = this.db
      .query<{ id: number }, [string, string, number, string]>(
        `INSERT INTO prompt_ideas (person, text, suggested_day_id, suggested_at)
         VALUES (?, ?, ?, ?) RETURNING id`,
      )
      .get(person, text, suggestedDayId, at)!;
    return row.id;
  }

  unconsumedPromptIdeas(person: PersonId): PromptIdeaRow[] {
    const rows = this.db
      .query<
        {
          id: number; person: PersonId; text: string; suggested_day_id: number;
          suggested_at: string; used_day_id: number | null; used_at: string | null;
        },
        [string]
      >(`SELECT * FROM prompt_ideas WHERE person = ? AND used_at IS NULL ORDER BY suggested_at`)
      .all(person);
    return rows.map((r) => ({
      id: r.id,
      person: r.person,
      text: r.text,
      suggestedDayId: r.suggested_day_id,
      suggestedAt: r.suggested_at,
      usedDayId: r.used_day_id,
      usedAt: r.used_at,
    }));
  }

  markPromptIdeaUsed(id: number, usedDayId: number | null, at: string): void {
    this.db
      .query(`UPDATE prompt_ideas SET used_day_id = ?, used_at = ? WHERE id = ?`)
      .run(usedDayId, at, id);
  }

  daysInRange(startDate: string, endDate: string): DayRow[] {
    return this.db
      .query<DayRow, [string, string]>(
        `SELECT * FROM days WHERE date >= ? AND date <= ? ORDER BY date`,
      )
      .all(startDate, endDate);
  }

  recordRecap(entry: RecapLogEntry): void {
    this.db
      .query(
        `INSERT INTO recap_log
           (week_start, week_end, recap_text, model, system_prompt, user_prompt, raw_response, fell_back, fallback_reason, sent_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.weekStart,
        entry.weekEnd,
        entry.recapText,
        entry.model,
        entry.systemPrompt,
        entry.userPrompt,
        entry.rawResponse,
        entry.fellBack ? 1 : 0,
        entry.fallbackReason,
        entry.at,
      );
  }

  hasRecapFor(weekStart: string): boolean {
    return (
      this.db
        .query<{ n: number }, [string]>(`SELECT COUNT(*) AS n FROM recap_log WHERE week_start = ?`)
        .get(weekStart)!.n > 0
    );
  }

  hasNudgeBeenSent(dayId: number, person: PersonId, trigger: NudgeTrigger): boolean {
    return (
      this.db
        .query<{ n: number }, [number, string, string]>(
          `SELECT COUNT(*) AS n FROM nudges WHERE day_id = ? AND person = ? AND trigger = ?`,
        )
        .get(dayId, person, trigger)!.n > 0
    );
  }

  recordNudgeSent(dayId: number, person: PersonId, trigger: NudgeTrigger, at: string): void {
    this.db
      .query(
        `INSERT OR IGNORE INTO nudges (day_id, person, trigger, sent_at) VALUES (?, ?, ?, ?)`,
      )
      .run(dayId, person, trigger, at);
  }
}
