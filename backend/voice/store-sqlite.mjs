// Dial webhook events, caller-PIN lockouts and phone reminders for local SQLite. Mirrors store-postgres.mjs.
export function sqliteVoiceStore(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS dial_event (
      id TEXT PRIMARY KEY, type TEXT NOT NULL, created_at TEXT, received_at TEXT NOT NULL, payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS dial_event_received ON dial_event (received_at);
    CREATE TABLE IF NOT EXISTS caller_pin_failure (
      caller_hash TEXT PRIMARY KEY, failures INTEGER NOT NULL, window_start INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS reminders (
      id TEXT PRIMARY KEY, patient_number TEXT NOT NULL, text TEXT NOT NULL,
      channel TEXT NOT NULL CHECK (channel IN ('call', 'text')), due_at TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('scheduled', 'sending', 'calling', 'delivered', 'missed', 'canceled', 'failed')),
      attempts INTEGER NOT NULL DEFAULT 0, lease_until TEXT, call_id TEXT UNIQUE, outcome TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS reminders_by_status ON reminders (status, due_at);
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
    // Counts an attempt and returns the running total in one statement, so concurrent guesses
    // cannot all pass a separate "is it locked yet?" read before any of them is recorded.
    countPinAttempt(callerHash, windowSeconds) {
      const now = Date.now();
      return db.prepare(`INSERT INTO caller_pin_failure VALUES (?, 1, ?)
        ON CONFLICT(caller_hash) DO UPDATE SET
          failures = CASE WHEN window_start > ? THEN failures + 1 ELSE 1 END,
          window_start = CASE WHEN window_start > ? THEN window_start ELSE excluded.window_start END
        RETURNING failures`)
        .get(callerHash, now, now - windowSeconds * 1000, now - windowSeconds * 1000).failures;
    },
    clearPinFailures(callerHash) {
      db.prepare('DELETE FROM caller_pin_failure WHERE caller_hash = ?').run(callerHash);
    },
    // Reminder timestamps are UTC ISO-8601 text, compared the same way in both adapters.
    createReminder(r) {
      db.prepare(`INSERT INTO reminders (id, patient_number, text, channel, due_at, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'scheduled', ?, ?)`)
        .run(r.id, r.patient_number, r.text, r.channel, r.due_at, r.created_at, r.created_at);
    },
    upcomingReminders(patientNumber, limit = 10) {
      return db.prepare(`SELECT * FROM reminders WHERE patient_number = ? AND status = 'scheduled'
        ORDER BY due_at LIMIT ?`).all(patientNumber, limit);
    },
    cancelReminder(patientNumber, id, now) {
      return db.prepare(`UPDATE reminders SET status = 'canceled', updated_at = ?
        WHERE id = ? AND patient_number = ? AND status = 'scheduled'`).run(now, id, patientNumber).changes > 0;
    },
    claimDueReminders(now, leaseUntil, limit = 5) {
      return db.prepare(`UPDATE reminders SET status = 'sending', attempts = attempts + 1, lease_until = ?, updated_at = ?
        WHERE id IN (SELECT id FROM reminders
          WHERE (status = 'scheduled' AND due_at <= ?) OR (status = 'sending' AND lease_until < ?)
          ORDER BY due_at LIMIT ?) RETURNING *`)
        .all(leaseUntil, now, now, now, limit);
    },
    updateReminder(id, fromStatus, { status, call_id = null, outcome = null }, now) {
      return db.prepare(`UPDATE reminders SET status = ?, call_id = COALESCE(?, call_id),
        outcome = COALESCE(?, outcome), lease_until = NULL, updated_at = ? WHERE id = ? AND status = ?`)
        .run(status, call_id, outcome, now, id, fromStatus).changes > 0;
    },
    reminderByCall(callId) {
      return db.prepare('SELECT * FROM reminders WHERE call_id = ?').get(callId);
    },
    unsettledCalls(before, limit = 5) {
      return db.prepare(`SELECT * FROM reminders WHERE status = 'calling' AND updated_at < ?
        ORDER BY updated_at LIMIT ?`).all(before, limit);
    },
  };
}
