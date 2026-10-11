// Google connection, OAuth handshakes and sync bookkeeping for local SQLite. Mirrors
// store-postgres.mjs; keep both aligned. Evidence provenance lives in the payload's
// `origin` field, so the shared evidence table is unchanged.
export function sqliteDigitalStore(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS google_connection (
      slot INTEGER PRIMARY KEY CHECK (slot = 1),
      email TEXT, scope TEXT NOT NULL, timezone TEXT, refresh_token TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('connected', 'reconnect_required')),
      connected_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS oauth_state (
      state TEXT PRIMARY KEY, verifier TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sync_state (
      name TEXT PRIMARY KEY, last_success TEXT, last_attempt TEXT NOT NULL, last_error TEXT,
      item_count INTEGER NOT NULL DEFAULT 0, window_from TEXT, window_to TEXT
    );
  `);
  const insert = db.prepare(`INSERT INTO evidence (id, source, timestamp, payload) VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET source=excluded.source, timestamp=excluded.timestamp, payload=excluded.payload`);

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

  // A Google write after a disconnect (which deletes the connection) is a no-op, so a
  // sync that outlives the disconnect cannot resurrect deleted data.
  function googleWrite(origin, before, records) {
    transaction(() => {
      if (!db.prepare('SELECT 1 FROM google_connection WHERE slot = 1').get()) return;
      before();
      for (const record of records) {
        insert.run(record.id, record.source, record.timestamp, JSON.stringify({ ...record, origin }));
      }
    });
  }

  return {
    // Replaces one origin's records atomically so upstream deletions disappear.
    replaceOrigin(origin, records) {
      googleWrite(origin, () => db.prepare("DELETE FROM evidence WHERE json_extract(payload, '$.origin') = ?").run(origin), records);
    },
    upsertOrigin(origin, records) {
      googleWrite(origin, () => {}, records);
    },
    // A live single-day lookup is authoritative for that day.
    replaceCalendarDay(date, records) {
      googleWrite('google-calendar', () => db.prepare(`DELETE FROM evidence
        WHERE json_extract(payload, '$.origin') = 'google-calendar' AND json_extract(payload, '$.date') <= ?
          AND COALESCE(json_extract(payload, '$.endDate'), json_extract(payload, '$.date')) >= ?`).run(date, date), records);
    },
    countByOrigin() {
      return Object.fromEntries(db.prepare(`SELECT COALESCE(json_extract(payload, '$.origin'), 'local') AS origin, COUNT(*) AS n
        FROM evidence GROUP BY 1`).all().map(row => [row.origin, row.n]));
    },
    googleConnection() {
      return db.prepare('SELECT * FROM google_connection WHERE slot = 1').get();
    },
    saveGoogleConnection({ email, scope, timezone, refreshToken }) {
      db.prepare(`INSERT INTO google_connection VALUES (1, ?, ?, ?, ?, 'connected', ?)
        ON CONFLICT(slot) DO UPDATE SET email=excluded.email, scope=excluded.scope, timezone=excluded.timezone,
          refresh_token=excluded.refresh_token, status='connected', connected_at=excluded.connected_at`)
        .run(email ?? null, scope, timezone ?? null, refreshToken, new Date().toISOString());
    },
    markGoogleReconnectRequired() {
      db.prepare("UPDATE google_connection SET status = 'reconnect_required' WHERE slot = 1").run();
    },
    deleteGoogleConnection() {
      transaction(() => {
        db.prepare('DELETE FROM google_connection').run();
        db.prepare("DELETE FROM evidence WHERE json_extract(payload, '$.origin') LIKE 'google-%'").run();
        db.prepare("DELETE FROM sync_state WHERE name LIKE 'google-%'").run();
      });
    },
    saveOAuthState(state, verifier) {
      const now = Date.now();
      db.prepare('DELETE FROM oauth_state WHERE created_at < ?').run(now - 10 * 60_000);
      db.prepare('INSERT INTO oauth_state VALUES (?, ?, ?)').run(state, verifier, now);
    },
    // Single use: read and delete together; expires after ten minutes.
    takeOAuthState(state) {
      return transaction(() => {
        const row = db.prepare('SELECT verifier, created_at FROM oauth_state WHERE state = ?').get(state);
        db.prepare('DELETE FROM oauth_state WHERE state = ?').run(state);
        return row && Date.now() - row.created_at <= 10 * 60_000 ? row.verifier : undefined;
      });
    },
    recordSync(name, { error, count, window } = {}) {
      const now = new Date().toISOString();
      db.prepare(`INSERT INTO sync_state VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(name) DO UPDATE SET last_attempt=excluded.last_attempt, last_error=excluded.last_error,
          last_success=COALESCE(excluded.last_success, sync_state.last_success),
          item_count=CASE WHEN excluded.last_error IS NULL THEN excluded.item_count ELSE sync_state.item_count END,
          window_from=CASE WHEN excluded.last_error IS NULL THEN excluded.window_from ELSE sync_state.window_from END,
          window_to=CASE WHEN excluded.last_error IS NULL THEN excluded.window_to ELSE sync_state.window_to END`)
        .run(name, error ? null : now, now, error ?? null, count ?? 0, window?.from ?? null, window?.to ?? null);
    },
    syncState(name) {
      return db.prepare('SELECT * FROM sync_state WHERE (? IS NULL OR name = ?) ORDER BY name').all(name ?? null, name ?? null)
        .map(row => ({ ...row, age_seconds: row.last_success ? (Date.now() - Date.parse(row.last_success)) / 1000 : null }));
    },
  };
}
