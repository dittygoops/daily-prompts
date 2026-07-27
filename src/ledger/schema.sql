CREATE TABLE IF NOT EXISTS days (
  id INTEGER PRIMARY KEY,
  date TEXT NOT NULL UNIQUE,
  prompt_id TEXT NOT NULL,
  prompt_text TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'dispatched'
    CHECK (state IN ('dispatched','resolved_shared','resolved_partial','resolved_skipped','expired','failed')),
  dispatched_at TEXT,
  resolved_at TEXT
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
  fell_back INTEGER NOT NULL DEFAULT 0,
  fallback_reason TEXT,
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
