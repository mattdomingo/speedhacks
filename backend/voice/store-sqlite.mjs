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
    CREATE TABLE IF NOT EXISTS dial_event_handled (id TEXT PRIMARY KEY, handled_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS caregiver_message (
      id TEXT PRIMARY KEY, patient_number TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('alert', 'summary')),
      local_date TEXT NOT NULL, status TEXT NOT NULL, outcome TEXT, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS caregiver_message_by_patient ON caregiver_message (patient_number, kind, created_at);
  `);
  const cutoff = days => new Date(Date.now() - days * 86_400_000).toISOString();
  return {
    pruneDialEvents(retentionDays) {
      db.prepare('DELETE FROM dial_event_handled WHERE handled_at < ?').run(cutoff(retentionDays));
      return db.prepare('DELETE FROM dial_event WHERE received_at < ?').run(cutoff(retentionDays)).changes;
    },
    // A delivery's side effects completed; redeliveries of the same event id are then skipped.
    dialEventHandled(id) {
      return Boolean(db.prepare('SELECT 1 FROM dial_event_handled WHERE id = ?').get(id));
    },
    markDialEventHandled(id) {
      db.prepare('INSERT OR IGNORE INTO dial_event_handled VALUES (?, ?)').run(id, new Date().toISOString());
    },
    // Claims the patient's one summary for a local day; false when it was already claimed.
    claimCaregiverSummary(patientNumber, localDate, now) {
      return db.prepare(`INSERT OR IGNORE INTO caregiver_message VALUES (?, ?, 'summary', ?, 'sending', NULL, ?)`)
        .run(`summary:${patientNumber}:${localDate}`, patientNumber, localDate, now).changes === 1;
    },
    // Admits an alert only while fewer than `max` were admitted for the patient since `since` (one statement, so atomic).
    claimCaregiverAlert(id, patientNumber, localDate, now, since, max) {
      return db.prepare(`INSERT INTO caregiver_message SELECT ?, ?, 'alert', ?, 'sending', NULL, ?
        WHERE (SELECT count(*) FROM caregiver_message WHERE patient_number = ? AND kind = 'alert' AND created_at > ?) < ?`)
        .run(id, patientNumber, localDate, now, patientNumber, since, max).changes === 1;
    },
    finishCaregiverMessage(id, status, outcome) {
      db.prepare('UPDATE caregiver_message SET status = ?, outcome = ? WHERE id = ?').run(status, outcome, id);
    },
    caregiverMessages(patientNumber, localDate) {
      return db.prepare('SELECT * FROM caregiver_message WHERE patient_number = ? AND local_date = ? ORDER BY created_at')
        .all(patientNumber, localDate);
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
    // A conditional UPSERT serializes admission across all database connections. A locked
    // caller produces no returned row, including when the supplied PIN is correct.
    recordPinAttempt(callerHash, correct, windowSeconds, maxFailures) {
      const now = Date.now();
      return Boolean(db.prepare(`INSERT INTO caller_pin_failure VALUES (?, ?, ?)
        ON CONFLICT(caller_hash) DO UPDATE SET
          failures = CASE WHEN excluded.failures = 0 THEN 0
            WHEN window_start <= ? THEN 1 ELSE failures + 1 END,
          window_start = CASE WHEN failures = 0 OR window_start <= ? THEN excluded.window_start ELSE window_start END
        WHERE failures < ? OR window_start <= ?
        RETURNING failures`).get(callerHash, correct ? 0 : 1, now,
        now - windowSeconds * 1000, now - windowSeconds * 1000, maxFailures, now - windowSeconds * 1000));
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
      return db.prepare(`SELECT * FROM reminders WHERE status = 'calling' AND call_id IS NOT NULL AND updated_at < ?
        ORDER BY updated_at LIMIT ?`).all(before, limit);
    },
    // Calls whose placement timed out: Dial may or may not have placed them.
    unconfirmedCalls(limit = 5) {
      return db.prepare(`SELECT * FROM reminders WHERE status = 'calling' AND call_id IS NULL
        ORDER BY updated_at LIMIT ?`).all(limit);
    },
  };
}
