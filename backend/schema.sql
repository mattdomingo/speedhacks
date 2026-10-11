BEGIN;
CREATE TABLE IF NOT EXISTS evidence (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  payload JSONB NOT NULL
);
CREATE TABLE IF NOT EXISTS latest_frame (
  slot INTEGER PRIMARY KEY CHECK (slot = 1),
  timestamp TEXT NOT NULL,
  jpeg BYTEA NOT NULL
);
CREATE TABLE IF NOT EXISTS camera_state (
  slot INTEGER PRIMARY KEY CHECK (slot = 1),
  payload JSONB NOT NULL
);
INSERT INTO camera_state VALUES (1, '{}') ON CONFLICT (slot) DO NOTHING;
CREATE TABLE IF NOT EXISTS camera_snapshots (
  object TEXT PRIMARY KEY CHECK (object IN ('keys', 'phone', 'wallet')),
  frame_id TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  jpeg BYTEA NOT NULL
);
-- Google connection (encrypted refresh token), OAuth handshakes, sync bookkeeping.
CREATE TABLE IF NOT EXISTS google_connection (
  slot INTEGER PRIMARY KEY CHECK (slot = 1),
  email TEXT,
  scope TEXT NOT NULL,
  timezone TEXT,
  refresh_token TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('connected', 'reconnect_required')),
  connected_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Token-endpoint origin a connection was made against (DEC-015); NULL means real Google.
ALTER TABLE google_connection ADD COLUMN IF NOT EXISTS token_origin TEXT;
-- Retained across disconnects so late OAuth callbacks and reads cannot reuse an old connection.
CREATE TABLE IF NOT EXISTS google_generation (
  slot INTEGER PRIMARY KEY CHECK (slot = 1),
  generation BIGINT NOT NULL DEFAULT 0
);
INSERT INTO google_generation VALUES (1, 0) ON CONFLICT (slot) DO NOTHING;
CREATE TABLE IF NOT EXISTS oauth_state (
  state TEXT PRIMARY KEY,
  verifier TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sync_state (
  name TEXT PRIMARY KEY,
  last_success TIMESTAMPTZ,
  last_attempt TIMESTAMPTZ NOT NULL,
  last_error TEXT,
  item_count INTEGER NOT NULL DEFAULT 0,
  window_from TEXT,
  window_to TEXT
);
-- Connection-scoped Google state keyed by prefix: calendar sync tokens ('calendar:'), push
-- channels ('channel:'), facts extracted from Gmail ('gmail:', never message bodies), events Steph
-- created ('created:') and Photos Picker sessions ('picker:'). Cleared with the connection, except
-- user settings ('setting:').
CREATE TABLE IF NOT EXISTS google_state (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Signed Dial webhook events (pruned after DIAL_EVENT_RETENTION_DAYS) and caller-PIN lockouts.
CREATE TABLE IF NOT EXISTS dial_event (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  created_at TEXT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  payload JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS dial_event_received ON dial_event (received_at);
CREATE TABLE IF NOT EXISTS caller_pin_failure (
  caller_hash TEXT PRIMARY KEY,
  failures INTEGER NOT NULL,
  window_start TIMESTAMPTZ NOT NULL
);
-- Phone reminders: timestamps are UTC ISO-8601 text so both adapters compare them the same way.
CREATE TABLE IF NOT EXISTS reminders (
  id TEXT PRIMARY KEY,
  patient_number TEXT NOT NULL,
  text TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('call', 'text')),
  due_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('scheduled', 'sending', 'calling', 'delivered', 'missed', 'canceled', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_until TEXT,
  call_id TEXT UNIQUE,
  outcome TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS reminders_by_status ON reminders (status, due_at);
-- Steph (backend/brain/schema.mjs): users, sessions, memories, timeline, decisions, devices, nudges.
-- Keep this block identical to BRAIN_TABLES; backend/test/brain-store.test.mjs checks it.
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
COMMIT;
