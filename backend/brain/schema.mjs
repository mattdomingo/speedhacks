// Steph's per-user tables. One portable DDL runs on SQLite (opened in store.mjs) and Postgres
// (copied verbatim into schema.sql; a test keeps the two identical). Times are UTC ISO-8601 text,
// JSON is text and flags are 0/1, so both adapters compare and decode them the same way.
export const BRAIN_TABLES = `
CREATE TABLE IF NOT EXISTS steph_users (
  id TEXT PRIMARY KEY,
  name TEXT,
  role TEXT NOT NULL DEFAULT 'self' CHECK (role IN ('self', 'caregiver', 'patient')),
  phone TEXT UNIQUE,
  google_email TEXT UNIQUE,
  apple_sub TEXT UNIQUE,
  caregiver_id TEXT,
  owner INTEGER NOT NULL DEFAULT 0,
  time_zone TEXT,
  settings TEXT NOT NULL DEFAULT '{}',
  app_seen_at TEXT,
  setup_completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS steph_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS steph_login_codes (
  code_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS steph_login_intents (
  state TEXT PRIMARY KEY,
  mode TEXT NOT NULL,
  user_id TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS steph_phone_codes (
  user_id TEXT NOT NULL,
  purpose TEXT NOT NULL,
  phone TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, purpose)
);
CREATE TABLE IF NOT EXISTS steph_phone_sends (
  user_id TEXT NOT NULL,
  sent_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS steph_memories (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  type TEXT NOT NULL,
  summary TEXT NOT NULL,
  people TEXT NOT NULL DEFAULT '[]',
  place TEXT,
  time TEXT,
  source TEXT NOT NULL,
  confidence DOUBLE PRECISION NOT NULL DEFAULT 0.8,
  details TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (user_id, source_ref)
);
CREATE INDEX IF NOT EXISTS steph_memories_by_time ON steph_memories (user_id, time);
CREATE TABLE IF NOT EXISTS steph_tombstones (
  user_id TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  deleted_at TEXT NOT NULL,
  PRIMARY KEY (user_id, source_ref)
);
CREATE TABLE IF NOT EXISTS steph_timeline (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('app', 'call', 'sms', 'push')),
  direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  text TEXT NOT NULL,
  at TEXT NOT NULL,
  ref TEXT UNIQUE,
  kind TEXT,
  call_id TEXT,
  seen_at TEXT,
  opened_at TEXT,
  meta TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS steph_timeline_by_user ON steph_timeline (user_id, at);
CREATE TABLE IF NOT EXISTS steph_decisions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  at TEXT NOT NULL,
  item TEXT NOT NULL,
  channel TEXT NOT NULL,
  rule TEXT NOT NULL,
  reason TEXT NOT NULL,
  counted INTEGER NOT NULL DEFAULT 0,
  ref TEXT
);
CREATE INDEX IF NOT EXISTS steph_decisions_by_user ON steph_decisions (user_id, at);
CREATE TABLE IF NOT EXISTS steph_devices (
  apns_token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  environment TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS steph_pending (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  summary TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE TABLE IF NOT EXISTS steph_nudges (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  due_at TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'auto' CHECK (channel IN ('auto', 'call', 'text', 'push', 'app')),
  urgent INTEGER NOT NULL DEFAULT 0,
  info INTEGER NOT NULL DEFAULT 0,
  must_confirm INTEGER NOT NULL DEFAULT 0,
  wake_me INTEGER NOT NULL DEFAULT 0,
  user_asked INTEGER NOT NULL DEFAULT 0,
  grace_minutes INTEGER NOT NULL DEFAULT 15,
  status TEXT NOT NULL DEFAULT 'scheduled',
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_until TEXT,
  call_id TEXT UNIQUE,
  push_id TEXT,
  pushed_at TEXT,
  outcome TEXT,
  dedupe_key TEXT UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS steph_nudges_due ON steph_nudges (status, due_at);
`;
