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
COMMIT;
