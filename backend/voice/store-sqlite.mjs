// Dial webhook events and caller-PIN lockouts for local SQLite. Mirrors store-postgres.mjs.
export function sqliteVoiceStore(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS dial_event (
      id TEXT PRIMARY KEY, type TEXT NOT NULL, created_at TEXT, received_at TEXT NOT NULL, payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS dial_event_received ON dial_event (received_at);
    CREATE TABLE IF NOT EXISTS caller_pin_failure (
      caller_hash TEXT PRIMARY KEY, failures INTEGER NOT NULL, window_start INTEGER NOT NULL
    );
  `);
  const cutoff = days => new Date(Date.now() - days * 86_400_000).toISOString();
  return {
    pruneDialEvents(retentionDays) {
      return db.prepare('DELETE FROM dial_event WHERE received_at < ?').run(cutoff(retentionDays)).changes;
    },
    // Returns false for a redelivered event so handlers stay idempotent.
    recordDialEvent(event, retentionDays) {
      this.pruneDialEvents(retentionDays);
      return db.prepare('INSERT OR IGNORE INTO dial_event VALUES (?, ?, ?, ?, ?)')
        .run(event.id, event.type, event.createdAt ?? null, new Date().toISOString(), JSON.stringify(event)).changes === 1;
    },
    dialEvents(limit = 20) {
      return db.prepare('SELECT payload FROM dial_event ORDER BY received_at DESC LIMIT ?')
        .all(limit).map(row => JSON.parse(row.payload));
    },
    pinFailures(callerHash, windowSeconds) {
      return db.prepare('SELECT failures FROM caller_pin_failure WHERE caller_hash = ? AND window_start > ?')
        .get(callerHash, Date.now() - windowSeconds * 1000)?.failures ?? 0;
    },
    recordPinFailure(callerHash, windowSeconds) {
      const now = Date.now();
      db.prepare(`INSERT INTO caller_pin_failure VALUES (?, 1, ?)
        ON CONFLICT(caller_hash) DO UPDATE SET
          failures = CASE WHEN window_start > ? THEN failures + 1 ELSE 1 END,
          window_start = CASE WHEN window_start > ? THEN window_start ELSE excluded.window_start END`)
        .run(callerHash, now, now - windowSeconds * 1000, now - windowSeconds * 1000);
    },
    clearPinFailures(callerHash) {
      db.prepare('DELETE FROM caller_pin_failure WHERE caller_hash = ?').run(callerHash);
    },
  };
}
