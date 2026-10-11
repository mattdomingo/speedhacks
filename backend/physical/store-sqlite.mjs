import { claimAnalysis, finishAnalysis } from './state.mjs';

export function sqliteCameraStore(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS camera_state (
      slot INTEGER PRIMARY KEY CHECK (slot = 1), payload TEXT NOT NULL
    );
    INSERT OR IGNORE INTO camera_state VALUES (1, '{}');
    CREATE TABLE IF NOT EXISTS camera_snapshots (
      object TEXT PRIMARY KEY CHECK (object IN ('keys', 'phone', 'wallet')),
      frame_id TEXT NOT NULL, timestamp TEXT NOT NULL, jpeg BLOB NOT NULL
    );
  `);
  function transaction(change) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const state = JSON.parse(db.prepare('SELECT payload FROM camera_state WHERE slot = 1').get().payload);
      const result = change(state);
      db.prepare('UPDATE camera_state SET payload = ? WHERE slot = 1').run(JSON.stringify(state));
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  return {
    readCameraState() {
      return JSON.parse(db.prepare('SELECT payload FROM camera_state WHERE slot = 1').get().payload);
    },
    claimCameraFrame(now) {
      return transaction(state => claimAnalysis(state,
        db.prepare('SELECT timestamp, jpeg FROM latest_frame WHERE slot = 1').get(), now));
    },
    finishCameraFrame(token, outcome, now) {
      return transaction(state => {
        if (!finishAnalysis(state, token, outcome, now)) return false;
        for (const record of outcome.records || []) {
          db.prepare(`INSERT INTO evidence VALUES (?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET timestamp=excluded.timestamp, payload=excluded.payload`)
            .run(record.id, record.source, record.timestamp, JSON.stringify(record));
          db.prepare(`INSERT INTO camera_snapshots VALUES (?, ?, ?, ?)
            ON CONFLICT(object) DO UPDATE SET frame_id=excluded.frame_id, timestamp=excluded.timestamp, jpeg=excluded.jpeg`)
            .run(record.object, record.frameId, record.timestamp, outcome.jpeg);
        }
        return true;
      });
    },
    cameraSnapshot(id) {
      return db.prepare('SELECT timestamp, jpeg FROM camera_snapshots WHERE frame_id = ? LIMIT 1').get(id);
    },
  };
}
