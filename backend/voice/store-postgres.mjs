export function postgresReminderStore(pool) {
  return {
    async createReminder(r) {
      await pool.query(`INSERT INTO reminders (id, patient_number, text, channel, due_at, status, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, 'scheduled', $6, $6)`,
      [r.id, r.patient_number, r.text, r.channel, r.due_at, r.created_at]);
    },
    async upcomingReminders(patientNumber, limit = 10) {
      const { rows } = await pool.query(`SELECT * FROM reminders WHERE patient_number = $1 AND status = 'scheduled'
        ORDER BY due_at LIMIT $2`, [patientNumber, limit]);
      return rows;
    },
    async cancelReminder(patientNumber, id, now) {
      const result = await pool.query(`UPDATE reminders SET status = 'canceled', updated_at = $1
        WHERE id = $2 AND patient_number = $3 AND status = 'scheduled'`, [now, id, patientNumber]);
      return result.rowCount > 0;
    },
    // SKIP LOCKED lets overlapping cron runs claim disjoint reminders.
    async claimDueReminders(now, leaseUntil, limit = 5) {
      const { rows } = await pool.query(`UPDATE reminders SET status = 'sending', attempts = attempts + 1,
        lease_until = $2, updated_at = $1
        WHERE id IN (SELECT id FROM reminders
          WHERE (status = 'scheduled' AND due_at <= $1) OR (status = 'sending' AND lease_until < $1)
          ORDER BY due_at LIMIT $3 FOR UPDATE SKIP LOCKED)
        RETURNING *`, [now, leaseUntil, limit]);
      return rows;
    },
    async updateReminder(id, fromStatus, { status, call_id = null, outcome = null }, now) {
      const result = await pool.query(`UPDATE reminders SET status = $1, call_id = COALESCE($2, call_id),
        outcome = COALESCE($3, outcome), lease_until = NULL, updated_at = $4 WHERE id = $5 AND status = $6`,
      [status, call_id, outcome, now, id, fromStatus]);
      return result.rowCount > 0;
    },
    async reminderByCall(callId) {
      const { rows } = await pool.query('SELECT * FROM reminders WHERE call_id = $1', [callId]);
      return rows[0];
    },
    async unsettledCalls(before, limit = 5) {
      const { rows } = await pool.query(`SELECT * FROM reminders WHERE status = 'calling' AND updated_at < $1
        ORDER BY updated_at LIMIT $2`, [before, limit]);
      return rows;
    },
    async seenDialEvent(id) {
      const { rows } = await pool.query('SELECT 1 FROM dial_events WHERE id = $1', [id]);
      return rows.length > 0;
    },
    async recordDialEvent(id, type, now) {
      await pool.query('INSERT INTO dial_events (id, type, received_at) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING',
        [id, type, now]);
    },
  };
}
