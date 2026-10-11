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
CREATE TABLE IF NOT EXISTS dial_events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  received_at TEXT NOT NULL
);
COMMIT;
