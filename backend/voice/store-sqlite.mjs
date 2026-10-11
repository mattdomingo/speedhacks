const CLAIMABLE = `(status = 'scheduled' AND due_at <= ?) OR (status = 'sending' AND lease_until < ?)`;

export function sqliteReminderStore(db) {
  db.exec(`
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
    CREATE TABLE IF NOT EXISTS dial_events (id TEXT PRIMARY KEY, type TEXT NOT NULL, received_at TEXT NOT NULL);
  `);
  return {
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
        WHERE id IN (SELECT id FROM reminders WHERE ${CLAIMABLE} ORDER BY due_at LIMIT ?) RETURNING *`)
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
    seenDialEvent(id) {
      return Boolean(db.prepare('SELECT 1 FROM dial_events WHERE id = ?').get(id));
    },
    recordDialEvent(id, type, now) {
      db.prepare('INSERT OR IGNORE INTO dial_events VALUES (?, ?, ?)').run(id, type, now);
    },
  };
}
