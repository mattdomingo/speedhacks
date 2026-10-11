import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

// Append-only: each entry runs once, in order, tracked by PRAGMA user_version.
// Never edit a shipped migration; add a new one.
const MIGRATIONS = [
  // 1: original scaffold schema (IF NOT EXISTS keeps pre-versioned databases valid).
  `CREATE TABLE IF NOT EXISTS evidence (
     id TEXT PRIMARY KEY,
     source TEXT NOT NULL,
     timestamp TEXT NOT NULL,
     payload TEXT NOT NULL
   );
   CREATE TABLE IF NOT EXISTS latest_frame (
     slot INTEGER PRIMARY KEY CHECK (slot = 1),
     timestamp TEXT NOT NULL,
     jpeg BLOB NOT NULL
   );`,
  // 2: provenance, Google connection, OAuth handshakes, sync bookkeeping.
  `ALTER TABLE evidence ADD COLUMN origin TEXT NOT NULL DEFAULT 'local';
   CREATE INDEX evidence_source_time ON evidence (source, timestamp);
   CREATE INDEX evidence_origin ON evidence (origin);
   CREATE TABLE google_connection (
     slot INTEGER PRIMARY KEY CHECK (slot = 1),
     email TEXT,
     scope TEXT NOT NULL,
     timezone TEXT,
     refresh_token TEXT NOT NULL,
     status TEXT NOT NULL CHECK (status IN ('connected', 'reconnect_required')),
     connected_at TEXT NOT NULL
   );
   CREATE TABLE oauth_state (
     state TEXT PRIMARY KEY,
     verifier TEXT NOT NULL,
     created_at INTEGER NOT NULL
   );
   CREATE TABLE sync_state (
     name TEXT PRIMARY KEY,
     last_success TEXT,
     last_attempt TEXT NOT NULL,
     last_error TEXT,
     item_count INTEGER NOT NULL DEFAULT 0
   );`,
  // 3: signed Dial webhook events (call.ended, call.transcribed, ...), deduplicated by event id.
  `CREATE TABLE dial_event (
     id TEXT PRIMARY KEY,
     type TEXT NOT NULL,
     created_at TEXT,
     received_at TEXT NOT NULL,
     payload TEXT NOT NULL
   );
   CREATE INDEX dial_event_received ON dial_event (received_at);`,
];

export const SCHEMA_VERSION = MIGRATIONS.length;

function migrate(db) {
  const current = db.prepare('PRAGMA user_version').get().user_version;
  if (current > MIGRATIONS.length) {
    throw new Error(`Database schema v${current} is newer than this build (v${MIGRATIONS.length})`);
  }
  for (let version = current; version < MIGRATIONS.length; version++) {
    transaction(db, () => {
      db.exec(MIGRATIONS[version]);
      db.exec(`PRAGMA user_version = ${version + 1}`);
    });
  }
}

function transaction(db, work) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function utc(timestamp) {
  return new Date(timestamp).toISOString();
}

export function openStore(dataDir) {
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(join(dataDir, 'memory.sqlite'));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
  migrate(db);
  const insert = (mode, record, origin) =>
    db.prepare(`INSERT OR ${mode} INTO evidence (id, source, timestamp, payload, origin) VALUES (?, ?, ?, ?, ?)`)
      .run(record.id, record.source, utc(record.timestamp), JSON.stringify(record), origin);
  return {
    db,
    transaction: work => transaction(db, work),
    put(record) {
      insert('IGNORE', record, 'local');
    },
    list(source) {
      return db.prepare('SELECT payload FROM evidence WHERE source = ? ORDER BY timestamp DESC')
        .all(source).map(row => JSON.parse(row.payload));
    },
    // Replaces every record from one external origin atomically, so deleted or
    // cancelled upstream items disappear instead of lingering as stale evidence.
    replaceOrigin(origin, records) {
      transaction(db, () => {
        db.prepare('DELETE FROM evidence WHERE origin = ?').run(origin);
        for (const record of records) insert('REPLACE', record, origin);
      });
    },
    // Adds records fetched on demand without discarding the synced set.
    upsertOrigin(origin, records) {
      transaction(db, () => {
        for (const record of records) insert('REPLACE', record, origin);
      });
    },
    countByOrigin() {
      return Object.fromEntries(db.prepare('SELECT origin, COUNT(*) AS n FROM evidence GROUP BY origin')
        .all().map(row => [row.origin, row.n]));
    },
    observe(observation) {
      const record = {
        ...observation, id: randomUUID(), source: 'camera', demo: false,
        text: `${observation.object} last seen ${observation.location}`,
      };
      this.put(record);
      return record;
    },
    saveFrame(timestamp, jpeg) {
      db.prepare(`INSERT INTO latest_frame VALUES (1, ?, ?)
        ON CONFLICT(slot) DO UPDATE SET timestamp=excluded.timestamp, jpeg=excluded.jpeg
        WHERE julianday(excluded.timestamp) >= julianday(latest_frame.timestamp)`)
        .run(timestamp, jpeg);
    },
    latestFrame() {
      return db.prepare('SELECT timestamp, jpeg FROM latest_frame WHERE slot = 1').get();
    },
    googleConnection() {
      return db.prepare('SELECT * FROM google_connection WHERE slot = 1').get();
    },
    saveGoogleConnection({ email, scope, timezone, refreshToken }) {
      db.prepare(`INSERT INTO google_connection VALUES (1, ?, ?, ?, ?, 'connected', ?)
        ON CONFLICT(slot) DO UPDATE SET email=excluded.email, scope=excluded.scope,
          timezone=excluded.timezone, refresh_token=excluded.refresh_token,
          status='connected', connected_at=excluded.connected_at`)
        .run(email ?? null, scope, timezone ?? null, refreshToken, new Date().toISOString());
    },
    markGoogleReconnectRequired() {
      db.prepare("UPDATE google_connection SET status = 'reconnect_required' WHERE slot = 1").run();
    },
    // Disconnecting also drops synced Google evidence: no connection, no stale copies.
    deleteGoogleConnection() {
      transaction(db, () => {
        db.prepare('DELETE FROM google_connection').run();
        db.prepare("DELETE FROM evidence WHERE origin LIKE 'google-%'").run();
        db.prepare("DELETE FROM sync_state WHERE name LIKE 'google-%'").run();
      });
    },
    saveOAuthState(state, verifier) {
      const now = Date.now();
      db.prepare('DELETE FROM oauth_state WHERE created_at < ?').run(now - 10 * 60_000);
      db.prepare('INSERT INTO oauth_state VALUES (?, ?, ?)').run(state, verifier, now);
    },
    // Single use: a state is deleted when read, and expires after ten minutes.
    takeOAuthState(state) {
      return transaction(db, () => {
        const row = db.prepare('SELECT verifier, created_at FROM oauth_state WHERE state = ?').get(state);
        db.prepare('DELETE FROM oauth_state WHERE state = ?').run(state);
        return row && Date.now() - row.created_at <= 10 * 60_000 ? row.verifier : undefined;
      });
    },
    recordSync(name, { error, count } = {}) {
      const now = new Date().toISOString();
      db.prepare(`INSERT INTO sync_state (name, last_success, last_attempt, last_error, item_count)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(name) DO UPDATE SET last_attempt=excluded.last_attempt, last_error=excluded.last_error,
          last_success=COALESCE(excluded.last_success, sync_state.last_success),
          item_count=CASE WHEN excluded.last_error IS NULL THEN excluded.item_count ELSE sync_state.item_count END`)
        .run(name, error ? null : now, now, error ?? null, count ?? 0);
    },
    syncState() {
      return db.prepare('SELECT * FROM sync_state ORDER BY name').all();
    },
    // Returns false for a redelivered event so handlers stay idempotent.
    recordDialEvent(event, retentionDays) {
      const now = new Date();
      db.prepare('DELETE FROM dial_event WHERE received_at < ?')
        .run(new Date(now.getTime() - retentionDays * 86_400_000).toISOString());
      return db.prepare('INSERT OR IGNORE INTO dial_event VALUES (?, ?, ?, ?, ?)')
        .run(event.id, event.type, event.createdAt ?? null, now.toISOString(), JSON.stringify(event)).changes === 1;
    },
    dialEvents(limit = 20) {
      return db.prepare('SELECT payload FROM dial_event ORDER BY received_at DESC LIMIT ?')
        .all(limit).map(row => JSON.parse(row.payload));
    },
    // Consistent online snapshot; safe while the server is writing (WAL).
    backup(path) {
      db.prepare('VACUUM INTO ?').run(path);
    },
    ping() {
      return db.prepare('SELECT 1 AS ok').get().ok === 1;
    },
    close() { db.close(); },
  };
}
