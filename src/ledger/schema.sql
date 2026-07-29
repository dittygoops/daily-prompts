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
