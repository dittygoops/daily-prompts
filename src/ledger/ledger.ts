import { Database } from "bun:sqlite";
import { chmodSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { PersonId } from "../config";
import { normalizeSubdomain } from "../ontology/normalize";
import { shouldDeplete } from "../ontology/status";
import type {
  AskRow,
  AuditId,
  SeedRow,
  SelectableNode,
  TokenRow,
} from "../selection/types";

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
  /** The shared angle tying the day's two questions together. Null when the
   * generator produced none, so no reader mistakes a question for a theme. */
  theme: string | null;
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
  /** The node this question targeted (exploit days), or null. Not a foreign
   * key: this is an append-only audit table and a rebuild that renumbers
   * nodes must never fail its inserts. */
  targetNodeId: number | null;
  /** The domain this question opened (explore days), or null. */
  targetDomain: string | null;
  /** The subject the generator declared for this question, as a short tag.
   * Declared so repetition can be rejected deterministically: content-word
   * similarity cannot see that "get better at" and "area of growth" are the
   * same subject. Null on fallback and pre-topic rows. */
  topic: string | null;
  fellBack: boolean;
  fallbackReason: string | null;
  at: string;
  /** Lane/seed/ask_domain/ask_family (2026-08-02 synthesis design). Optional
   * and defaulted to null in the insert, deliberately deviating from this
   * file's earlier required-field pattern: every existing recordGeneration
   * call site is owned by another package this wave and must keep compiling
   * without passing these. */
  lane?: string | null;
  seedId?: number | null;
  askDomain?: string | null;
  askFamily?: string | null;
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
  person: PersonId | null; topic: string | null; target_node_id: number | null; target_domain: string | null;
  fell_back: number; fallback_reason: string | null; at: string;
  lane: string | null; seed_id: number | null; ask_domain: string | null; ask_family: string | null;
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
  topic: r.topic,
  targetNodeId: r.target_node_id,
  targetDomain: r.target_domain,
  fellBack: r.fell_back === 1,
  fallbackReason: r.fallback_reason,
  at: r.at,
  lane: r.lane,
  seedId: r.seed_id,
  askDomain: r.ask_domain,
  askFamily: r.ask_family,
});

export type NodeDomain =
  | "career-academics" | "childhood" | "family" | "relationships-friends"
  | "hobbies-interests" | "health-body" | "daily-life" | "beliefs-values"
  | "plans-future" | "other" | "tastes-preferences";

/** @deprecated Dropped from the nodes table by the 2026-08-02 synthesis
 * design's rebuild (budget replaces status). Kept only as a type so
 * setNodeStatus's signature still compiles for not-yet-migrated callers. */
export type NodeStatusValue = "open" | "depleted" | "closed";

export interface NodeRow {
  id: number;
  person: PersonId;
  domain: NodeDomain;
  subdomain: string;
  summary: string;
  /** Null on a node created before budget grant existed and never rebuilt.
   * See src/selection/types.ts SelectableNode for the full budget contract. */
  budget: number | null;
  family: string | null;
  eventDate: string | null;
  lastAsked: string | null;
  timesAsked: number;
  createdAt: string;
  updatedAt: string;
}

export interface NodeFactRow {
  id: number;
  nodeId: number;
  kind: "fact" | "thread" | "interest";
  text: string;
  sourceDayId: number;
  observedDate: string;
  /** Set when this thread-kind fact was closed out by resolveOpenThreads
   * (spec "Budget": "Resolution"). Null on facts never resolved, and always
   * null on non-thread kinds since only threads resolve. */
  resolvedAt: string | null;
}

export interface SignalRow {
  id: number;
  person: PersonId;
  kind: "mood_signal" | "prompt_preference";
  text: string;
  observedDate: string;
}

interface TokenDbRow {
  id: number; node_id: number; event_date: string; created_at: string; spent_at: string | null;
}

const toTokenRow = (r: TokenDbRow): TokenRow => ({
  id: r.id, nodeId: r.node_id, eventDate: r.event_date, createdAt: r.created_at, spentAt: r.spent_at,
});

interface AuditLogDbRow {
  id: number; run_date: string; audit: string; person: string | null; subject: string | null;
  detail: string | null; created_at: string;
}

export interface AuditViolationLogRow {
  id: number;
  runDate: string;
  audit: AuditId;
  person: PersonId | null;
  subject: string | null;
  detail: string | null;
  createdAt: string;
}

interface NodeDbRow {
  id: number; person: PersonId; domain: NodeDomain; subdomain: string; summary: string;
  budget: number | null; family: string | null; event_date: string | null; last_asked: string | null;
  times_asked: number; created_at: string; updated_at: string;
}

const toNodeRow = (r: NodeDbRow): NodeRow => ({
  id: r.id, person: r.person, domain: r.domain, subdomain: r.subdomain, summary: r.summary,
  budget: r.budget, family: r.family, eventDate: r.event_date, lastAsked: r.last_asked,
  timesAsked: r.times_asked,
  createdAt: r.created_at, updatedAt: r.updated_at,
});

/** @deprecated Legacy shape for the pre-budget nodes columns (status,
 * avg_yield_chars), used only by the deprecated recordYieldForNode below so
 * that file keeps compiling against NodeDbRow's new (post-rebuild) shape.
 * The columns this reads no longer exist once a database has run the
 * 'tastes-preferences' rebuild, so calling recordYieldForNode against a
 * migrated database throws at runtime; that is expected until its one
 * caller (owned by another package this wave) is removed. */
interface LegacyNodeDbRow {
  id: number; times_asked: number; avg_yield_chars: number | null; status: NodeStatusValue;
}

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
    if (!has("generation_log", "target_node_id")) {
      db.exec("ALTER TABLE generation_log ADD COLUMN target_node_id INTEGER");
    }
    if (!has("generation_log", "target_domain")) {
      db.exec("ALTER TABLE generation_log ADD COLUMN target_domain TEXT");
    }
    if (!has("generation_log", "topic")) {
      db.exec("ALTER TABLE generation_log ADD COLUMN topic TEXT");
    }
    if (!has("days", "theme")) {
      // No backfill: null is the honest value for days that never had one.
      db.exec("ALTER TABLE days ADD COLUMN theme TEXT");
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

    // 2026-08-02 synthesis design's nodes rebuild (spec "Migration"). status
    // and avg_yield_chars cannot be dropped, and budget/family cannot be
    // added, with an additive ALTER: SQLite has no DROP COLUMN-and-CHECK-
    // rewrite in one step, and node_facts.node_id is a live FK into nodes, so
    // this must run the documented FK-off rebuild rather than a naive
    // "DROP TABLE nodes" (proven to fail with FK rows present in the
    // adversarial review). Guarded on the CHECK constraint's own text so a
    // database already rebuilt, or a fresh one that got the 11-domain form
    // directly from schema.sql, skips this entirely and is a no-op.
    const nodesSql =
      (db.query(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'nodes'`).get() as
        | { sql: string }
        | undefined)?.sql ?? "";
    if (!nodesSql.includes("tastes-preferences")) {
      // Outside any transaction: SQLite only honors a foreign_keys toggle
      // between transactions, never inside one.
      db.exec("PRAGMA foreign_keys = OFF;");
      db.exec("BEGIN IMMEDIATE;");
      try {
        db.exec(`CREATE TABLE nodes_new (
          id INTEGER PRIMARY KEY,
          person TEXT NOT NULL CHECK (person IN ('a','b')),
          domain TEXT NOT NULL CHECK (domain IN (
            'career-academics','childhood','family','relationships-friends',
            'hobbies-interests','health-body','daily-life','beliefs-values',
            'plans-future','other','tastes-preferences'
          )),
          subdomain TEXT NOT NULL,
          summary TEXT NOT NULL,
          budget INTEGER,
          family TEXT,
          event_date TEXT,
          last_asked TEXT,
          times_asked INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE (person, subdomain)
        );`);
        // budget/family are NULL for every pre-existing row: the spec's
        // "rebuild grants budgets ... during replay" is a rebuild-script
        // concern (P9), not this migration's; a live database's nodes carry
        // no budget until something re-derives it.
        db.exec(`INSERT INTO nodes_new
          (id, person, domain, subdomain, summary, budget, family, event_date, last_asked, times_asked, created_at, updated_at)
          SELECT id, person, domain, subdomain, summary, NULL, NULL, event_date, last_asked, times_asked, created_at, updated_at
          FROM nodes;`);
        db.exec(`DROP TABLE nodes;`);
        db.exec(`ALTER TABLE nodes_new RENAME TO nodes;`);
        const violations = db.query(`PRAGMA foreign_key_check`).all();
        if (violations.length > 0) {
          db.exec("ROLLBACK;");
          throw new Error(
            `nodes rebuild left ${violations.length} foreign key violation(s); rolled back`,
          );
        }
        db.exec("COMMIT;");
      } catch (err) {
        // A failed CREATE/INSERT/DROP before COMMIT leaves the transaction
        // open; a failed foreign_key_check explicitly rolls back above but
        // reaches here too, so this is idempotent to call on an
        // already-rolled-back transaction.
        try {
          db.exec("ROLLBACK;");
        } catch {
          // No transaction was open (the violations branch already rolled
          // back); nothing further to undo.
        }
        db.exec("PRAGMA foreign_keys = ON;");
        throw err;
      }
      db.exec("PRAGMA foreign_keys = ON;");
    }

    // fact_subjects, followup_tokens, seeds are created AFTER the nodes
    // rebuild above (spec "Migration": "created AFTER the rebuild so the
    // rebuild has only node_facts as a child"), whether or not a rebuild
    // actually ran this time; IF NOT EXISTS makes this a no-op on a database
    // that already has them.
    db.exec(`CREATE TABLE IF NOT EXISTS fact_subjects (
      fact_id INTEGER NOT NULL REFERENCES node_facts(id),
      node_id INTEGER NOT NULL REFERENCES nodes(id),
      PRIMARY KEY (fact_id, node_id)
    );`);
    db.exec(`CREATE TABLE IF NOT EXISTS followup_tokens (
      id INTEGER PRIMARY KEY,
      node_id INTEGER NOT NULL REFERENCES nodes(id),
      event_date TEXT NOT NULL,
      created_at TEXT NOT NULL,
      spent_at TEXT,
      UNIQUE (node_id, event_date)
    );`);
    db.exec(`CREATE TABLE IF NOT EXISTS seeds (
      id INTEGER PRIMARY KEY,
      text TEXT NOT NULL, domain TEXT NOT NULL, family TEXT NOT NULL,
      UNIQUE (text)
    );`);

    // node_facts.resolved_at via guarded ALTER (spec "Schema"), not in the
    // canonical CREATE TABLE, so a fresh database and a migrated one go
    // through the identical code path.
    if (!has("node_facts", "resolved_at")) {
      db.exec("ALTER TABLE node_facts ADD COLUMN resolved_at TEXT");
    }

    // generation_log's dispatch-time snapshot columns (spec F11): guarded
    // ALTERs, not the canonical CREATE TABLE, for the same reason.
    if (!has("generation_log", "lane")) {
      db.exec("ALTER TABLE generation_log ADD COLUMN lane TEXT");
    }
    if (!has("generation_log", "seed_id")) {
      db.exec("ALTER TABLE generation_log ADD COLUMN seed_id INTEGER");
    }
    if (!has("generation_log", "ask_domain")) {
      db.exec("ALTER TABLE generation_log ADD COLUMN ask_domain TEXT");
    }
    if (!has("generation_log", "ask_family")) {
      db.exec("ALTER TABLE generation_log ADD COLUMN ask_family TEXT");
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

  createDay(
    date: string,
    promptId: string,
    promptText: string,
    dispatchedAt: string,
    theme: string | null = null,
  ): DayRow {
    const day = this.db
      .query<DayRow, [string, string, string, string | null, string]>(
        `INSERT INTO days (date, prompt_id, prompt_text, theme, state, dispatched_at)
         VALUES (?, ?, ?, ?, 'dispatched', ?) RETURNING *`,
      )
      .get(date, promptId, promptText, theme, dispatchedAt)!;
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
   * extraction, and hasn't exhausted the retry cap. Ordered by date then id:
   * a rebuild replays this in date order to build the graph and attribute
   * yield chronologically, and day ids are only incidentally chronological
   * (a backfilled or re-dispatched day can get an id out of date order).
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
             ORDER BY d.date, d.id`,
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
             ORDER BY d.date, d.id, p.person`,
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
           (date, prompt_id, prompt_text, model, system_prompt, user_prompt, raw_response, rationale, stance, person, topic, target_node_id, target_domain, fell_back, fallback_reason, at, lane, seed_id, ask_domain, ask_family)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        entry.topic,
        entry.targetNodeId,
        entry.targetDomain,
        entry.fellBack ? 1 : 0,
        entry.fallbackReason,
        entry.at,
        entry.lane ?? null,
        entry.seedId ?? null,
        entry.askDomain ?? null,
        entry.askFamily ?? null,
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

  /** The shared angles of recent days, most recent first. Guarded because
   * the per-person topic tags can all be different ("job-search-skills",
   * "fitness-goals") while the day is about the same thing three days
   * running: the repetition moves up a level into the theme. */
  recentThemes(limit: number): string[] {
    const rows = this.db
      .query<{ theme: string | null }, [number]>(
        `SELECT theme FROM days WHERE theme IS NOT NULL ORDER BY date DESC LIMIT ?`,
      )
      .all(limit);
    return rows.map((r) => r.theme).filter((t): t is string => t !== null);
  }

  /** @deprecated Superseded by the window reads over recentAsks/AskRow
   * (W3 domain cooldown) in the 2026-08-02 synthesis design. Body UNCHANGED,
   * still functional (target_domain is not a dropped column), kept only
   * until its callers move to the new selector. Domains this person's
   * recent explore questions opened, newest first. Feeds the explore
   * cooldown: four childhood explores went out in two days because
   * exploring records no last_asked on anything. */
  recentTargetDomains(person: PersonId, limit: number): string[] {
    const rows = this.db
      .query<{ target_domain: string | null }, [PersonId, number]>(
        `SELECT target_domain FROM generation_log
         WHERE person = ? AND target_domain IS NOT NULL
         ORDER BY date DESC, id DESC LIMIT ?`,
      )
      .all(person, limit);
    return rows.map((r) => r.target_domain).filter((d): d is string => d !== null);
  }

  /** @deprecated Superseded by W4 family cooldown over recentAsks/AskRow in
   * the 2026-08-02 synthesis design. Body UNCHANGED, still functional (topic
   * is not a dropped column), kept only until its callers move to the new
   * selector. Subjects this person's recent questions covered, most recent
   * first. Feeds a deterministic repeat guard: the generator asked four
   * self-improvement questions in six days because content-word similarity
   * cannot tell that "get better at" and "area of growth" are one subject. */
  recentTopics(person: PersonId, limit: number): string[] {
    const rows = this.db
      .query<{ topic: string | null }, [PersonId, number]>(
        `SELECT topic FROM generation_log
         WHERE person = ? AND topic IS NOT NULL
         ORDER BY date DESC, id DESC LIMIT ?`,
      )
      .all(person, limit);
    return rows.map((r) => r.topic).filter((t): t is string => t !== null);
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

  // ---- Structured ontology (docs/superpowers/specs/2026-07-29) ----

  /** Runs `fn` inside one sqlite transaction. Filing one person-day (nodes,
   * facts, signals, prompt ideas, markExtraction) must commit atomically: a
   * crashed retry that ran the extractor twice must never see half of the
   * first attempt's facts land, or the retry double-files. */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  /** Deletes a person's entire graph: fact_subjects, then followup_tokens,
   * then node_facts, then nodes, then signals. FK order (fact_subjects and
   * followup_tokens both reference nodes; node_facts.node_id references
   * nodes) - nodes first would violate the foreign key. Used by a rebuild
   * before replaying the ledger. */
  wipeGraph(person: PersonId): void {
    const tx = this.db.transaction(() => {
      this.db
        .query(`DELETE FROM fact_subjects WHERE node_id IN (SELECT id FROM nodes WHERE person = ?)`)
        .run(person);
      this.db
        .query(`DELETE FROM followup_tokens WHERE node_id IN (SELECT id FROM nodes WHERE person = ?)`)
        .run(person);
      this.db
        .query(`DELETE FROM node_facts WHERE node_id IN (SELECT id FROM nodes WHERE person = ?)`)
        .run(person);
      this.db.query(`DELETE FROM nodes WHERE person = ?`).run(person);
      this.db.query(`DELETE FROM signals WHERE person = ?`).run(person);
    });
    tx();
  }

  nodeFactCount(nodeId: number): number {
    return this.db.query<{ n: number }, [number]>(`SELECT COUNT(*) AS n FROM node_facts WHERE node_id = ?`).get(nodeId)!.n;
  }

  createNode(input: {
    person: PersonId;
    domain: NodeDomain;
    subdomain: string;
    summary: string;
    eventDate: string | null;
    /** Extractor-assigned register (2026-08-02 synthesis design's Families
     * section), or null when the extractor could not confidently place it.
     * Optional (not just nullable) so every pre-existing caller across the
     * tree keeps compiling unchanged; omitted is treated identically to
     * null. Set once, at creation, mirroring grantBudget's "granted once"
     * semantics: nothing in this file writes nodes.family afterward except
     * the migration rebuild's own replay path. */
    family?: string | null;
    at: string;
  }): number {
    // Normalized before the UNIQUE check so "Fitness Goals" and
    // "fitness-goal" are one identity, not two nodes.
    const subdomain = normalizeSubdomain(input.subdomain);
    const row = this.db
      .query<{ id: number }, [PersonId, NodeDomain, string, string, string | null, string | null, string, string]>(
        `INSERT INTO nodes (person, domain, subdomain, summary, event_date, family, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      )
      .get(input.person, input.domain, subdomain, input.summary, input.eventDate, input.family ?? null, input.at, input.at)!;
    return row.id;
  }

  /** Updates an existing node's event_date (spec "Event dates": "a new date
   * on a known subject updates event_date"). Companion to createNode's own
   * eventDate param, which only covers the creation-time case; this is the
   * only other place nodes.event_date is written. Always overwrites rather
   * than comparing against the current value: mintToken's own UNIQUE
   * constraint is what makes re-filing the same date a no-op, so this
   * setter does not need its own idempotence check. */
  setNodeEventDate(nodeId: number, eventDate: string, at: string): void {
    this.db.query(`UPDATE nodes SET event_date = ?, updated_at = ? WHERE id = ?`).run(eventDate, at, nodeId);
  }

  /** Files one fact and homes it onto its primary node, returning the fact's
   * id. Also writes the primary fact_subjects row (spec impl decision 18:
   * "every home INCLUDING the primary"), so subjectsForFact and the
   * newestFactDate/newestUnresolvedThreadDate union reads never need a
   * special case for "the home nobody explicitly recorded". Additional
   * homes (multi-homed facts) are recorded separately via addFactSubject,
   * using the returned id. The old reopen-on-fact status write is gone with
   * nodes.status; there is nothing left here for a new fact to reopen. */
  addNodeFact(input: {
    nodeId: number;
    kind: "fact" | "thread" | "interest";
    text: string;
    sourceDayId: number;
    observedDate: string;
    at: string;
  }): number {
    const row = this.db
      .query<{ id: number }, [number, string, string, number, string, string]>(
        `INSERT INTO node_facts (node_id, kind, text, source_day_id, observed_date, created_at)
         VALUES (?, ?, ?, ?, ?, ?) RETURNING id`,
      )
      .get(input.nodeId, input.kind, input.text, input.sourceDayId, input.observedDate, input.at)!;
    this.db
      .query(`INSERT OR IGNORE INTO fact_subjects (fact_id, node_id) VALUES (?, ?)`)
      .run(row.id, input.nodeId);
    return row.id;
  }

  /** Records an additional home for a fact already filed via addNodeFact
   * (multi-homed facts: the same observation is evidence for more than one
   * subject). Idempotent: re-filing the same (fact, node) pair is a no-op,
   * not an error, since PRIMARY KEY (fact_id, node_id) would otherwise
   * throw on a retry that ran the extractor twice. */
  addFactSubject(factId: number, nodeId: number): void {
    this.db
      .query(`INSERT OR IGNORE INTO fact_subjects (fact_id, node_id) VALUES (?, ?)`)
      .run(factId, nodeId);
  }

  /** Every node a fact is homed on (primary and secondary), ascending id. */
  subjectsForFact(factId: number): number[] {
    const rows = this.db
      .query<{ node_id: number }, [number]>(
        `SELECT node_id FROM fact_subjects WHERE fact_id = ? ORDER BY node_id`,
      )
      .all(factId);
    return rows.map((r) => r.node_id);
  }

  addSignal(input: {
    person: PersonId;
    kind: "mood_signal" | "prompt_preference";
    text: string;
    observedDate: string;
    at: string;
  }): void {
    this.db
      .query(`INSERT INTO signals (person, kind, text, observed_date, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(input.person, input.kind, input.text, input.observedDate, input.at);
  }

  /** Moods are windowed (a mood is not durable); preferences pass null to
   * read the person's standing taste in full. */
  recentSignals(person: PersonId, kind: "mood_signal" | "prompt_preference", windowDays: number | null, today: string): SignalRow[] {
    const rows = windowDays === null
      ? this.db
          .query<{ id: number; person: PersonId; kind: SignalRow["kind"]; text: string; observed_date: string }, [PersonId, string]>(
            `SELECT id, person, kind, text, observed_date FROM signals WHERE person = ? AND kind = ? ORDER BY observed_date`,
          )
          .all(person, kind)
      : this.db
          .query<{ id: number; person: PersonId; kind: SignalRow["kind"]; text: string; observed_date: string }, [PersonId, string, string, number]>(
            `SELECT id, person, kind, text, observed_date FROM signals
             WHERE person = ? AND kind = ? AND observed_date >= date(?, '-' || ? || ' days')
             ORDER BY observed_date`,
          )
          .all(person, kind, today, windowDays);
    return rows.map((r) => ({ id: r.id, person: r.person, kind: r.kind, text: r.text, observedDate: r.observed_date }));
  }

  nodesFor(person: PersonId): NodeRow[] {
    return this.db
      .query<NodeDbRow, [PersonId]>(`SELECT * FROM nodes WHERE person = ? ORDER BY id`)
      .all(person)
      .map(toNodeRow);
  }

  nodeFactsFor(nodeId: number): NodeFactRow[] {
    return this.db
      .query<{ id: number; node_id: number; kind: NodeFactRow["kind"]; text: string; source_day_id: number; observed_date: string; resolved_at: string | null }, [number]>(
        `SELECT id, node_id, kind, text, source_day_id, observed_date, resolved_at FROM node_facts WHERE node_id = ? ORDER BY observed_date, id`,
      )
      .all(nodeId)
      .map((r) => ({ id: r.id, nodeId: r.node_id, kind: r.kind, text: r.text, sourceDayId: r.source_day_id, observedDate: r.observed_date, resolvedAt: r.resolved_at }));
  }

  /** @deprecated nodes.status is dropped by the 2026-08-02 synthesis
   * design's rebuild; budget (grantBudget/recordAsk/resolveOpenThreads/
   * refillBudget) replaces it. Body UNCHANGED so callers owned by other
   * packages this wave keep compiling; throws at runtime against a migrated
   * database ("no such column: status"). */
  setNodeStatus(nodeId: number, status: NodeStatusValue, at: string): void {
    this.db.query(`UPDATE nodes SET status = ?, updated_at = ? WHERE id = ?`).run(status, at, nodeId);
  }

  updateNodeSummary(nodeId: number, summary: string, at: string): void {
    this.db.query(`UPDATE nodes SET summary = ?, updated_at = ? WHERE id = ?`).run(summary, at, nodeId);
  }

  /** A question went out about this node; it must not repeat even if never
   * answered. times_asked deliberately does NOT move here: it increments at
   * finalization together with the yield it feeds, so the count can never
   * drift ahead of the answers behind the mean. */
  recordAsked(nodeId: number, date: string, at: string): void {
    this.db.query(`UPDATE nodes SET last_asked = ?, updated_at = ? WHERE id = ?`).run(date, at, nodeId);
  }

  /** The 2026-08-02 synthesis design's dispatch write, replacing recordAsked
   * for lanes exploit/followup: last_asked, times_asked, and budget all move
   * in the one statement the spec requires ("recordAsk: last_asked,
   * times_asked, budget, one statement"), so there is no window where an
   * ask is recorded but the budget it should have spent is not. Floors at 0
   * rather than going negative: a token ask never calls this at all (lane 0
   * bypasses budget per spec), so the only caller here is lane 1/2 exploit
   * dispatch against a node already known budget > 0, but the floor is kept
   * as a defensive invariant rather than trusted to the caller. */
  recordAsk(nodeId: number, date: string, at: string): void {
    this.db
      .query(
        `UPDATE nodes SET last_asked = ?, updated_at = ?, times_asked = times_asked + 1,
           budget = MAX(COALESCE(budget, 0) - 1, 0)
         WHERE id = ?`,
      )
      .run(date, at, nodeId);
  }

  /** Semantic closure (spec "Budget"): granted once, when a node's creating
   * filing commits, from every fact kind filed onto it in that transaction
   * (primary or secondary home). Never 0; the highest-ranking kind present
   * wins: any thread -> 3, else any interest -> 2, else (fact kinds only)
   * -> 1. Capped so a rebuild replaying a node with an unusually rich
   * founding filing cannot mint more budget than a live grant ever could. */
  grantBudget(nodeId: number, kinds: ("fact" | "thread" | "interest")[], cap: number, at: string): void {
    let budget = 1;
    if (kinds.includes("interest")) budget = 2;
    if (kinds.includes("thread")) budget = 3;
    budget = Math.min(budget, Math.max(cap, 1));
    this.db.query(`UPDATE nodes SET budget = ?, updated_at = ? WHERE id = ?`).run(budget, at, nodeId);
  }

  /** Direct budget write, for the migration rebuild's replay and for tests;
   * ordinary dispatch/resolution/refill flow uses recordAsk/
   * resolveOpenThreads/refillBudget instead so the arithmetic lives in one
   * place each. */
  setNodeBudget(nodeId: number, budget: number, at: string): void {
    this.db.query(`UPDATE nodes SET budget = ?, updated_at = ? WHERE id = ?`).run(budget, at, nodeId);
  }

  /** Resolution (spec "Budget"): after extraction of an answer to a question
   * that targeted node N, if no new thread-kind fact landed on N (via any
   * home), N's open threads are stamped resolved_at AND budget drops to 0 in
   * the same transaction ("resolution zeroes budget"). Threads are resolved
   * across ALL homes via fact_subjects, matching W1's union reading, so a
   * thread multi-homed onto N counts even when N is not its primary node.
   * Returns the count of threads resolved, for callers that want to log it. */
  resolveOpenThreads(nodeId: number, at: string): number {
    const tx = this.db.transaction(() => {
      const result = this.db
        .query(
          `UPDATE node_facts SET resolved_at = ?
           WHERE kind = 'thread' AND resolved_at IS NULL
             AND id IN (SELECT fact_id FROM fact_subjects WHERE node_id = ?)`,
        )
        .run(at, nodeId);
      this.db.query(`UPDATE nodes SET budget = 0, updated_at = ? WHERE id = ?`).run(at, nodeId);
      return result.changes;
    });
    return tx();
  }

  /** Refill (spec "Budget", F5): a new thread-kind fact filed onto N by any
   * filing whatsoever, targeted or not, sets budget = min(cap, max(budget,
   * 0) + 1). `cap` defaults to the spec's budgetCap constant (3) so ordinary
   * callers do not need to thread the config value through; a caller
   * running against a non-default config passes its own cap. */
  refillBudget(nodeId: number, at: string, cap = 3): void {
    this.db
      .query(`UPDATE nodes SET budget = MIN(?, MAX(COALESCE(budget, 0), 0) + 1), updated_at = ? WHERE id = ?`)
      .run(cap, at, nodeId);
  }

  /** Mints a follow-up token for one distinct (node, event_date) (F1: "one
   * token per distinct event per node, so recurring events each earn their
   * follow-up"). Idempotent via the UNIQUE(node_id, event_date) constraint:
   * filing the same event date twice (a retry, or a second mention) mints
   * nothing extra rather than throwing. */
  mintToken(nodeId: number, eventDate: string, at: string): void {
    this.db
      .query(`INSERT OR IGNORE INTO followup_tokens (node_id, event_date, created_at) VALUES (?, ?, ?)`)
      .run(nodeId, eventDate, at);
  }

  /** Spends a token in the same transaction as the ask that fired it (spec:
   * "Spend = spent_at in the ask's transaction"). Guarded on spent_at IS
   * NULL so a double-spend attempt is a no-op, not silent data loss. */
  spendToken(tokenId: number, at: string): void {
    this.db
      .query(`UPDATE followup_tokens SET spent_at = ? WHERE id = ? AND spent_at IS NULL`)
      .run(at, tokenId);
  }

  /** Lane 0 eligibility (spec "Lanes"): unspent tokens whose event_date
   * falls in the signed window [today - windowDays, today), so a future
   * event's token never looks fireable early (F12). */
  fireableTokens(today: string, windowDays: number): TokenRow[] {
    return this.db
      .query<TokenDbRow, [string, number, string]>(
        `SELECT * FROM followup_tokens
         WHERE spent_at IS NULL
           AND event_date >= date(?, '-' || ? || ' days')
           AND event_date < ?
         ORDER BY event_date, id`,
      )
      .all(today, windowDays, today)
      .map(toTokenRow);
  }

  /** Tokens whose event_date fell out of the fireable window while still
   * unspent: a real audit invariant (A5), not "or logged why" (spec). */
  expiredUnspentTokens(today: string, windowDays: number): TokenRow[] {
    return this.db
      .query<TokenDbRow, [string, number]>(
        `SELECT * FROM followup_tokens
         WHERE spent_at IS NULL AND event_date < date(?, '-' || ? || ' days')
         ORDER BY event_date, id`,
      )
      .all(today, windowDays)
      .map(toTokenRow);
  }

  /** Every token for one node, regardless of status, newest event first.
   * Neither fireableTokens nor expiredUnspentTokens covers a future-dated
   * unspent token (an event not yet due), so print-graph's tokens section
   * (pending/spent/expired) reads this instead and buckets by spent_at and
   * event_date itself. */
  tokensForNode(nodeId: number): TokenRow[] {
    return this.db
      .query<TokenDbRow, [number]>(
        `SELECT * FROM followup_tokens WHERE node_id = ? ORDER BY event_date DESC, id DESC`,
      )
      .all(nodeId)
      .map(toTokenRow);
  }

  /** Replaces the entire seed bank in one transaction: the static bank is
   * copied not moved (spec's seed logistics), so a reload always starts from
   * a clean, fully-specified set of rows with the TSV's own stable ids
   * rather than accreting stale entries a later edit removed. */
  replaceSeeds(rows: SeedRow[]): void {
    const tx = this.db.transaction(() => {
      this.db.query(`DELETE FROM seeds`).run();
      for (const row of rows) {
        this.db
          .query(`INSERT INTO seeds (id, text, domain, family) VALUES (?, ?, ?, ?)`)
          .run(row.id, row.text, row.domain, row.family);
      }
    });
    tx();
  }

  allSeeds(): SeedRow[] {
    return this.db.query<SeedRow, []>(`SELECT id, text, domain, family FROM seeds ORDER BY id`).all();
  }

  /** Seed ids this person has been asked since `sinceDate` (spec's
   * seedReuseDays window for lane 2), read from generation_log.seed_id: the
   * bank never drains, it cycles once a seed ages out of the window. */
  usedSeedIdsWithin(person: PersonId, sinceDate: string): Set<number> {
    const rows = this.db
      .query<{ seed_id: number }, [PersonId, string]>(
        `SELECT DISTINCT seed_id FROM generation_log
         WHERE person = ? AND seed_id IS NOT NULL AND date >= ?`,
      )
      .all(person, sinceDate);
    return new Set(rows.map((r) => r.seed_id));
  }

  /** One person's nodes in the shape the selector needs to run every window
   * and lane-1 ordering rule without a further read: newestFactDate and
   * newestUnresolvedThreadDate are both computed across ALL homes via
   * fact_subjects (spec F7's union reading, F4's thread-first ordering).
   * Two per-node subqueries rather than one grouped join: the couple's graph
   * is small (tens of nodes per person), and a straight MAX(...) per node is
   * far easier to verify against the spec's prose than a single query that
   * has to fold both aggregates and the "unresolved" filter together. */
  selectableNodes(person: PersonId): SelectableNode[] {
    const rows = this.db
      .query<NodeDbRow, [PersonId]>(`SELECT * FROM nodes WHERE person = ? ORDER BY id`)
      .all(person);
    return rows.map((r) => {
      const newestFact = this.db
        .query<{ d: string | null }, [number]>(
          `SELECT MAX(nf.observed_date) AS d FROM node_facts nf
           JOIN fact_subjects fs ON fs.fact_id = nf.id
           WHERE fs.node_id = ?`,
        )
        .get(r.id)!;
      const newestThread = this.db
        .query<{ d: string | null }, [number]>(
          `SELECT MAX(nf.observed_date) AS d FROM node_facts nf
           JOIN fact_subjects fs ON fs.fact_id = nf.id
           WHERE fs.node_id = ? AND nf.kind = 'thread' AND nf.resolved_at IS NULL`,
        )
        .get(r.id)!;
      return {
        id: r.id,
        person: r.person,
        domain: r.domain,
        family: r.family,
        subdomain: r.subdomain,
        summary: r.summary,
        budget: r.budget,
        lastAsked: r.last_asked,
        timesAsked: r.times_asked,
        createdAt: r.created_at,
        newestFactDate: newestFact.d,
        newestUnresolvedThreadDate: newestThread.d,
      };
    });
  }

  /** The mandatory window/audit read pattern (spec, every window and audit):
   * one row per (date, person) by max(id), fell_back = 0, person NOT NULL.
   * The live table already holds a hotfix duplicate and seven legacy
   * null-person rows (impl decision 6); this is the one query that encodes
   * the dedup so no window or audit reimplements it slightly differently. */
  recentAsks(sinceDate: string): AskRow[] {
    const rows = this.db
      .query<GenerationLogDbRow, [string]>(
        `SELECT g.* FROM generation_log g
         JOIN (
           SELECT date, person, MAX(id) AS max_id
           FROM generation_log
           WHERE fell_back = 0 AND person IS NOT NULL AND date >= ?
           GROUP BY date, person
         ) m ON m.max_id = g.id
         ORDER BY g.date, g.person`,
      )
      .all(sinceDate);
    return rows.map((r) => ({
      id: r.id,
      date: r.date,
      person: r.person as PersonId,
      targetNodeId: r.target_node_id,
      askDomain: r.ask_domain,
      askFamily: r.ask_family,
      lane: (r.lane as AskRow["lane"]) ?? null,
      seedId: r.seed_id,
    }));
  }

  /** Persists one audit run's violations, one row per finding, idempotent on
   * UNIQUE(run_date, audit, person, subject): a rerun of the nightly poller
   * can never double-count the same finding. */
  recordAuditViolations(
    runDate: string,
    violations: { audit: AuditId; person: PersonId | null; subject: string | null; detail: string | null }[],
    at: string,
  ): void {
    const tx = this.db.transaction(() => {
      for (const v of violations) {
        this.db
          .query(
            `INSERT OR IGNORE INTO audit_log (run_date, audit, person, subject, detail, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(runDate, v.audit, v.person, v.subject, v.detail, at);
      }
    });
    tx();
  }

  auditViolationsSince(sinceDate: string): AuditViolationLogRow[] {
    const rows = this.db
      .query<AuditLogDbRow, [string]>(
        `SELECT * FROM audit_log WHERE run_date >= ? ORDER BY run_date, id`,
      )
      .all(sinceDate);
    return rows.map((r) => ({
      id: r.id,
      runDate: r.run_date,
      audit: r.audit as AuditId,
      person: r.person as PersonId | null,
      subject: r.subject,
      detail: r.detail,
      createdAt: r.created_at,
    }));
  }

  /** @deprecated Median of this person's answered lengths; fed the
   * status/avg_yield_chars depletion math dropped by the 2026-08-02
   * synthesis design's rebuild. Body UNCHANGED and still functional (reads
   * person_days, not nodes), kept only until recordYieldForNode's one caller
   * (owned by another package this wave) is removed. */
  personMedianAnswerChars(person: PersonId): number | null {
    const rows = this.db
      .query<{ len: number }, [PersonId]>(
        `SELECT length(response_text) AS len FROM person_days
         WHERE person = ? AND state = 'answered' AND response_text IS NOT NULL
         ORDER BY len`,
      )
      .all(person);
    if (rows.length === 0) return null;
    const mid = Math.floor(rows.length / 2);
    return rows.length % 2 === 1 ? rows[mid]!.len : (rows[mid - 1]!.len + rows[mid]!.len) / 2;
  }

  /** @deprecated Reads/writes nodes.status and nodes.avg_yield_chars, both
   * dropped by the 2026-08-02 synthesis design's rebuild. Left in place,
   * body UNCHANGED, so callers owned by other packages this wave keep
   * compiling; it throws at runtime against a migrated database. Folds one
   * answer into a node's running mean and runs the depletion check, in one
   * transaction. This is the one copy of the yield math: `recordYield` looks
   * up its generation-log target and delegates here, and a rebuild's argmax
   * attribution (which has no generation_log row to look up, since replay
   * predates any dispatch) calls this directly. */
  recordYieldForNode(
    nodeId: number,
    person: PersonId,
    date: string,
    chars: number,
    opts: { depletionRatio: number; depletionMinAskings: number } = { depletionRatio: 0.5, depletionMinAskings: 2 },
  ): void {
    const tx = this.db.transaction(() => {
      this.db
        .query(
          `UPDATE nodes SET
             avg_yield_chars = ((COALESCE(avg_yield_chars, 0) * times_asked) + ?) / (times_asked + 1),
             times_asked = times_asked + 1,
             last_asked = ?,
             updated_at = ?
           WHERE id = ?`,
        )
        .run(chars, date, new Date().toISOString(), nodeId);

      const node = this.db.query<LegacyNodeDbRow, [number]>(`SELECT * FROM nodes WHERE id = ?`).get(nodeId)!;
      const median = this.personMedianAnswerChars(person);
      if (
        median !== null &&
        shouldDeplete({
          timesAsked: node.times_asked,
          avgYieldChars: node.avg_yield_chars,
          personMedianChars: median,
          depletionRatio: opts.depletionRatio,
          depletionMinAskings: opts.depletionMinAskings,
        })
      ) {
        this.db.query(`UPDATE nodes SET status = 'depleted' WHERE id = ?`).run(nodeId);
      }
    });
    tx();
  }

  /** Folds one answer into the targeted node's running mean and runs the
   * depletion check. No-op when the day had no target (an explore or
   * fallback day). Skips never reach here: a skip is not evidence the well
   * is dry. */
  recordYield(
    date: string,
    person: PersonId,
    chars: number,
    opts: { depletionRatio: number; depletionMinAskings: number } = { depletionRatio: 0.5, depletionMinAskings: 2 },
  ): void {
    const target = this.db
      .query<{ target_node_id: number | null }, [string, PersonId]>(
        `SELECT target_node_id FROM generation_log WHERE date = ? AND person = ? AND target_node_id IS NOT NULL LIMIT 1`,
      )
      .get(date, person);
    if (!target?.target_node_id) return;
    this.recordYieldForNode(target.target_node_id, person, date, chars, opts);
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
