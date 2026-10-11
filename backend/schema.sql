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
COMMIT;
