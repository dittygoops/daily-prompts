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

export class Ledger {
  private constructor(private readonly db: Database) {}

  static open(path: string): Ledger {
    const db = new Database(path, { create: true, strict: true });
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA foreign_keys = ON;");
    const schemaPath = join(import.meta.dir, "schema.sql");
    db.exec(readFileSync(schemaPath, "utf8"));
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
      this.db
        .query(`INSERT INTO person_days (day_id, person) VALUES (?, ?)`)
        .run(day.id, person);
    }
    return day;
  }

  day(id: number): DayRow {
    const row = this.db.query<DayRow, [number]>(`SELECT * FROM days WHERE id = ?`).get(id);
    if (!row) throw new Error(`No day with id ${id}`);
    return row;
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
}
