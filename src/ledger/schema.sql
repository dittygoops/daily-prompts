CREATE TABLE IF NOT EXISTS days (
  id INTEGER PRIMARY KEY,
  date TEXT NOT NULL UNIQUE,
  prompt_id TEXT NOT NULL,
  -- A human-readable label for the day. Kept for back-compat and for days
  -- that have no theme; the questions themselves live in person_days.
  prompt_text TEXT NOT NULL,
  -- The short shared angle tying the two questions together, when the
  -- generator produced one. Null on fallback and pre-theme days, so a reader
  -- can tell a real theme from a question standing in for one.
  theme TEXT,
  state TEXT NOT NULL DEFAULT 'dispatched'
    CHECK (state IN ('dispatched','resolved_shared','resolved_partial','resolved_skipped','expired','failed')),
  dispatched_at TEXT,
  resolved_at TEXT,
  -- The animal image actually attached to this day's prompt, for recency
  -- de-duplication only. Null means no image went out: fetch failed,
  -- disabled, or the day predates the feature.
  animal_image_id TEXT
);

CREATE TABLE IF NOT EXISTS person_days (
  day_id INTEGER NOT NULL REFERENCES days(id),
  person TEXT NOT NULL CHECK (person IN ('a','b')),
  state TEXT NOT NULL DEFAULT 'awaiting'
    CHECK (state IN ('awaiting','collecting','answered','skipped')),
  response_text TEXT,
  finalized_at TEXT,
  share_sent_at TEXT,
  feedback_ask_sent_at TEXT,
  -- The question is per person: a prompt built from one person's memory is
  -- unanswerable by the other, which reached production once already.
  -- days.prompt_text now holds the day's shared theme, not the question.
  prompt_id TEXT,
  prompt_text TEXT,
  PRIMARY KEY (day_id, person)
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  day_id INTEGER REFERENCES days(id),
  person TEXT CHECK (person IN ('a','b') OR person IS NULL),
  direction TEXT NOT NULL CHECK (direction IN ('in','out')),
  kind TEXT NOT NULL CHECK (kind IN (
    'prompt','answer_part','skip','waiting_notice','share','skip_notice','skip_ack',
    'feedback_ask','feedback','oob_reply','oob_in','unknown_sender','send_failed'
  )),
  text TEXT NOT NULL,
  at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS prompt_usage (
  prompt_id TEXT PRIMARY KEY,
  used_on TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS extractions (
  day_id INTEGER NOT NULL REFERENCES days(id),
  person TEXT NOT NULL CHECK (person IN ('a','b')),
  status TEXT NOT NULL CHECK (status IN ('done','failed')),
  attempts INTEGER NOT NULL DEFAULT 1,
  observation_count INTEGER,
  completed_at TEXT,
  PRIMARY KEY (day_id, person)
);

CREATE TABLE IF NOT EXISTS generation_log (
  id INTEGER PRIMARY KEY,
  date TEXT NOT NULL,
  prompt_id TEXT,
  prompt_text TEXT,
  model TEXT,
  system_prompt TEXT,
  user_prompt TEXT,
  raw_response TEXT,
  rationale TEXT,
  stance TEXT,
  person TEXT,
  topic TEXT,
  fell_back INTEGER NOT NULL DEFAULT 0,
  fallback_reason TEXT,
  at TEXT NOT NULL
  -- lane, seed_id, ask_domain, ask_family (2026-08-02 synthesis design) are
  -- added via guarded ALTER in Ledger.migrateSchema, not here, so both fresh
  -- and existing databases go through one code path.
);

-- Audits (2026-08-02 synthesis design) persist their violations here so a
-- rerun of the nightly poller never double-counts the same finding. Person
-- and subject are plain text, not foreign keys: an audit row must survive a
-- node being renumbered or removed by a later rebuild.
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  run_date TEXT NOT NULL,
  audit TEXT NOT NULL,
  person TEXT,
  subject TEXT,
  detail TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (run_date, audit, person, subject)
);

-- Rolling quality scores for generated prompts (eval harness phase 3), so
-- drift is visible from the ledger itself rather than only when a report is
-- run by hand. One row per generation_log row that produced a prompt.
CREATE TABLE IF NOT EXISTS prompt_scores (
  id INTEGER PRIMARY KEY,
  generation_id INTEGER NOT NULL UNIQUE REFERENCES generation_log(id),
  date TEXT NOT NULL,
  answerable INTEGER NOT NULL,
  single_question INTEGER NOT NULL,
  appropriate_length INTEGER NOT NULL,
  emotionally_safe INTEGER NOT NULL,
  passed_all INTEGER NOT NULL,
  failure_reasons TEXT,
  model TEXT,
  at TEXT NOT NULL
);

-- The structured ontology (docs/superpowers/specs/2026-07-29): a node is a
-- subject in one person's life, a fact is evidence attached to it. UNIQUE is
-- deliberately (person, subdomain) and NOT per-domain: review showed one real
-- answer filing the same subject under three domains, so the subject has one
-- identity per person and the domain is a mutable attribute.
-- 2026-08-02 synthesis design: status and avg_yield_chars are dropped (budget
-- replaces both, see Ledger.grantBudget/recordAsk/resolveOpenThreads/
-- refillBudget) and budget/family are added. A live database reaches this
-- shape via the FK-safe rebuild in Ledger.migrateSchema, guarded on
-- 'tastes-preferences' being present in this CHECK; a fresh database gets it
-- directly here and skips the rebuild entirely.
CREATE TABLE IF NOT EXISTS nodes (
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
);

CREATE TABLE IF NOT EXISTS node_facts (
  id INTEGER PRIMARY KEY,
  node_id INTEGER NOT NULL REFERENCES nodes(id),
  kind TEXT NOT NULL CHECK (kind IN ('fact','thread','interest')),
  text TEXT NOT NULL,
  source_day_id INTEGER NOT NULL,
  observed_date TEXT NOT NULL,
  created_at TEXT NOT NULL
  -- resolved_at is added via guarded ALTER in Ledger.migrateSchema (spec:
  -- "node_facts.resolved_at via guarded ALTER"), not here.
);

-- Moods and prompt preferences are about the person right now or about the
-- check-in itself, not subjects in their life. Kept out of the graph so a
-- durable node summary can never bake in "seems drained this week" and so
-- node counts reflect life content only.
CREATE TABLE IF NOT EXISTS signals (
  id INTEGER PRIMARY KEY,
  person TEXT NOT NULL CHECK (person IN ('a','b')),
  kind TEXT NOT NULL CHECK (kind IN ('mood_signal','prompt_preference')),
  text TEXT NOT NULL,
  observed_date TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS recap_log (
  id INTEGER PRIMARY KEY,
  week_start TEXT NOT NULL,
  week_end TEXT NOT NULL,
  recap_text TEXT NOT NULL,
  model TEXT,
  system_prompt TEXT,
  user_prompt TEXT,
  raw_response TEXT,
  fell_back INTEGER NOT NULL DEFAULT 0,
  fallback_reason TEXT,
  sent_at TEXT NOT NULL,
  UNIQUE (week_start)
);

CREATE TABLE IF NOT EXISTS nudges (
  day_id INTEGER NOT NULL REFERENCES days(id),
  person TEXT NOT NULL CHECK (person IN ('a','b')),
  trigger TEXT NOT NULL CHECK (trigger IN ('no_response','partner_waiting','almost_due')),
  sent_at TEXT NOT NULL,
  PRIMARY KEY (day_id, person, trigger)
);

CREATE TABLE IF NOT EXISTS prompt_ideas (
  id INTEGER PRIMARY KEY,
  person TEXT NOT NULL CHECK (person IN ('a','b')),
  text TEXT NOT NULL,
  suggested_day_id INTEGER REFERENCES days(id),
  suggested_at TEXT NOT NULL,
  used_day_id INTEGER REFERENCES days(id),
  used_at TEXT
);
