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
