// Google connection, OAuth handshakes and sync bookkeeping for local SQLite. Mirrors
// store-postgres.mjs; keep both aligned. Evidence provenance lives in the payload's
// `origin` field, so the shared evidence table is unchanged.
import { SCOPES } from './google.mjs';

// 'google-calendar' -> the calendar read scope, and so on for each source.
const scopeFor = origin => SCOPES[origin.replace(/^google-/, '')];
export function sqliteDigitalStore(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS google_connection (
      slot INTEGER PRIMARY KEY CHECK (slot = 1),
      email TEXT, scope TEXT NOT NULL, timezone TEXT, refresh_token TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('connected', 'reconnect_required')),
      connected_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS google_generation (
      slot INTEGER PRIMARY KEY CHECK (slot = 1), generation INTEGER NOT NULL DEFAULT 0
    );
    INSERT OR IGNORE INTO google_generation VALUES (1, 0);
    CREATE TABLE IF NOT EXISTS oauth_state (
      state TEXT PRIMARY KEY, verifier TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sync_state (
      name TEXT PRIMARY KEY, last_success TEXT, last_attempt TEXT NOT NULL, last_error TEXT,
      item_count INTEGER NOT NULL DEFAULT 0, window_from TEXT, window_to TEXT
    );
    CREATE TABLE IF NOT EXISTS google_state (
      key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL
    );
  `);
  // Token-endpoint origin a connection was made against (DEC-015); NULL means real Google.
  if (!db.prepare('PRAGMA table_info(google_connection)').all().some(column => column.name === 'token_origin')) {
    db.exec('ALTER TABLE google_connection ADD COLUMN token_origin TEXT');
  }
  const insert = db.prepare(`INSERT INTO evidence (id, source, timestamp, payload) VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET source=excluded.source, timestamp=excluded.timestamp, payload=excluded.payload`);
  const putState = db.prepare(`INSERT INTO google_state (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`);

  function transaction(work) {
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

  function snapshot() {
    const row = db.prepare(`SELECT c.*, g.generation FROM google_generation g
      LEFT JOIN google_connection c ON c.slot = g.slot WHERE g.slot = 1`).get();
    const generation = String(row.generation);
    return { generation, connection: row.slot === 1 ? { ...row, generation } : undefined };
  }

  // One persisted generation fences credentials, evidence and metadata, including a
  // disconnect followed by a reconnect while an older request is still in flight.
  function withConnection(generation, scope, work) {
    return transaction(() => {
      const current = snapshot();
      if (!current.connection || current.generation !== generation ||
          (scope && !current.connection.scope.split(' ').includes(scope))) return false;
      work();
      return true;
    });
  }

  function clearGoogleData() {
    db.prepare("DELETE FROM evidence WHERE json_extract(payload, '$.origin') LIKE 'google-%'").run();
    db.prepare("DELETE FROM sync_state WHERE name LIKE 'google-%'").run();
    db.prepare('DELETE FROM oauth_state').run();
    // Sync cursors, channels and cached facts belong to the connection; settings outlive it.
    db.prepare("DELETE FROM google_state WHERE key NOT LIKE 'setting:%'").run();
  }

  function googleWrite(origin, before, records, generation) {
    return withConnection(generation, scopeFor(origin), () => {
      before();
      for (const record of records) {
        insert.run(record.id, record.source, record.timestamp, JSON.stringify({ ...record, origin }));
      }
    });
  }

  return {
    // Replaces one origin's records atomically so upstream deletions disappear.
    replaceOrigin(origin, records, generation) {
      return googleWrite(origin, () => db.prepare("DELETE FROM evidence WHERE json_extract(payload, '$.origin') = ?").run(origin), records, generation);
    },
    upsertOrigin(origin, records, generation) {
      return googleWrite(origin, () => {}, records, generation);
    },
    // Incremental changes: upsert some records and delete others by id, atomically.
    patchOrigin(origin, records, removeIds, generation) {
      return googleWrite(origin, () => {
        const remove = db.prepare("DELETE FROM evidence WHERE id = ? AND json_extract(payload, '$.origin') = ?");
        for (const id of removeIds) remove.run(id, origin);
      }, records, generation);
    },
    // A live single-day lookup is authoritative for that day.
    replaceCalendarDay(date, records, generation) {
      return googleWrite('google-calendar', () => db.prepare(`DELETE FROM evidence
        WHERE json_extract(payload, '$.origin') = 'google-calendar' AND json_extract(payload, '$.date') <= ?
          AND COALESCE(json_extract(payload, '$.endDate'), json_extract(payload, '$.date')) >= ?`).run(date, date), records, generation);
    },
    countByOrigin() {
      return Object.fromEntries(db.prepare(`SELECT COALESCE(json_extract(payload, '$.origin'), 'local') AS origin, COUNT(*) AS n
        FROM evidence GROUP BY 1`).all().map(row => [row.origin, row.n]));
    },
    googleSnapshot: snapshot,
    googleConnection() {
      return snapshot().connection;
    },
    saveGoogleConnection({ email, scope, timezone, refreshToken, generation, tokenOrigin }) {
      return transaction(() => {
        if (snapshot().generation !== generation) return undefined;
        db.prepare('UPDATE google_generation SET generation = generation + 1 WHERE slot = 1').run();
        db.prepare(`INSERT INTO google_connection (slot, email, scope, timezone, refresh_token, status, connected_at, token_origin)
          VALUES (1, ?, ?, ?, ?, 'connected', ?, ?)
          ON CONFLICT(slot) DO UPDATE SET email=excluded.email, scope=excluded.scope, timezone=excluded.timezone,
            refresh_token=excluded.refresh_token, status='connected', connected_at=excluded.connected_at,
            token_origin=excluded.token_origin`)
          .run(email ?? null, scope, timezone ?? null, refreshToken, new Date().toISOString(), tokenOrigin ?? null);
        clearGoogleData();
        return snapshot().connection;
      });
    },
    markGoogleReconnectRequired(generation) {
      return withConnection(generation, undefined, () => {
        db.prepare("UPDATE google_connection SET status = 'reconnect_required' WHERE slot = 1").run();
      });
    },
    deleteGoogleConnection() {
      return transaction(() => {
        const previous = snapshot().connection;
        db.prepare('UPDATE google_generation SET generation = generation + 1 WHERE slot = 1').run();
        db.prepare('DELETE FROM google_connection').run();
        clearGoogleData();
        return previous;
      });
    },
    saveOAuthState(state, verifier) {
      return transaction(() => {
        const now = Date.now();
        db.prepare('DELETE FROM oauth_state WHERE created_at < ?').run(now - 10 * 60_000);
        db.prepare('INSERT INTO oauth_state VALUES (?, ?, ?)').run(state, verifier, now);
      });
    },
    // Single use plus a generation captured atomically: a later disconnect invalidates the callback.
    takeOAuthState(state) {
      return transaction(() => {
        const row = db.prepare('SELECT verifier, created_at FROM oauth_state WHERE state = ?').get(state);
        db.prepare('DELETE FROM oauth_state WHERE state = ?').run(state);
        return row && Date.now() - row.created_at <= 10 * 60_000
          ? { verifier: row.verifier, generation: snapshot().generation } : undefined;
      });
    },
    recordSync(name, { error, count, window } = {}, generation) {
      return withConnection(generation, scopeFor(name), () => {
        const now = new Date().toISOString();
        db.prepare(`INSERT INTO sync_state VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(name) DO UPDATE SET last_attempt=excluded.last_attempt, last_error=excluded.last_error,
            last_success=COALESCE(excluded.last_success, sync_state.last_success),
            item_count=CASE WHEN excluded.last_error IS NULL THEN excluded.item_count ELSE sync_state.item_count END,
            window_from=CASE WHEN excluded.last_error IS NULL THEN excluded.window_from ELSE sync_state.window_from END,
            window_to=CASE WHEN excluded.last_error IS NULL THEN excluded.window_to ELSE sync_state.window_to END`)
          .run(name, error ? null : now, now, error ?? null, count ?? 0, window?.from ?? null, window?.to ?? null);
      });
    },
    // Connection-scoped Google state (sync tokens, push channels, extracted Gmail facts, created
    // events, picker sessions) under key prefixes; 'setting:' keys hold user settings.
    googleState(prefix) {
      return db.prepare('SELECT key, value FROM google_state WHERE substr(key, 1, ?) = ? ORDER BY key').all(prefix.length, prefix)
        .map(row => ({ key: row.key, value: JSON.parse(row.value) }));
    },
    saveGoogleState(generation, scope, { put = [], remove = [] } = {}) {
      return withConnection(generation, scope, () => {
        const now = new Date().toISOString();
        const drop = db.prepare('DELETE FROM google_state WHERE key = ?');
        for (const key of remove) drop.run(key);
        for (const { key, value } of put) putState.run(key, JSON.stringify(value), now);
      });
    },
    saveGoogleSetting(name, value) {
      putState.run(`setting:${name}`, JSON.stringify(value), new Date().toISOString());
    },
    syncState(name) {
      return db.prepare('SELECT * FROM sync_state WHERE (? IS NULL OR name = ?) ORDER BY name').all(name ?? null, name ?? null)
        .map(row => ({ ...row, age_seconds: row.last_success ? (Date.now() - Date.parse(row.last_success)) / 1000 : null }));
    },
  };
}
