// Dial webhook events, caller-PIN lockouts and phone reminders for hosted Postgres. Mirrors store-sqlite.mjs;
// tables come from backend/schema.sql (npm run db:init).
export function postgresVoiceStore(pool) {
  return {
    async pruneDialEvents(retentionDays) {
      const { rowCount } = await pool.query('DELETE FROM dial_event WHERE received_at < now() - make_interval(days => $1)', [retentionDays]);
      return rowCount;
    },
    // Returns false for a redelivered event so handlers stay idempotent.
    async recordDialEvent(event, retentionDays) {
      await this.pruneDialEvents(retentionDays);
      const { rowCount } = await pool.query(`INSERT INTO dial_event (id, type, created_at, payload)
        VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING`, [event.id, event.type, event.createdAt ?? null, event]);
      return rowCount === 1;
    },
    async dialEvents(limit = 20) {
      const { rows } = await pool.query('SELECT payload FROM dial_event ORDER BY received_at DESC LIMIT $1', [limit]);
      return rows.map(row => row.payload);
    },
    async pinFailures(callerHash, windowSeconds) {
      const { rows } = await pool.query(`SELECT failures FROM caller_pin_failure
        WHERE caller_hash = $1 AND window_start > now() - make_interval(secs => $2)`, [callerHash, windowSeconds]);
      return rows[0]?.failures ?? 0;
    },
    // The row lock acquired by ON CONFLICT covers the limit check and counter update.
    // A locked caller produces no returned row, even for the correct PIN.
    async recordPinAttempt(callerHash, correct, windowSeconds, maxFailures) {
      const { rowCount } = await pool.query(`INSERT INTO caller_pin_failure AS f (caller_hash, failures, window_start)
        VALUES ($1, CASE WHEN $2 THEN 0 ELSE 1 END, now())
        ON CONFLICT (caller_hash) DO UPDATE SET
          failures = CASE WHEN $2 THEN 0
            WHEN f.window_start <= now() - make_interval(secs => $3) THEN 1 ELSE f.failures + 1 END,
          window_start = CASE WHEN f.failures = 0 OR f.window_start <= now() - make_interval(secs => $3)
            THEN now() ELSE f.window_start END
        WHERE f.failures < $4 OR f.window_start <= now() - make_interval(secs => $3)
        RETURNING failures`, [callerHash, correct, windowSeconds, maxFailures]);
      return rowCount === 1;
    },
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
  };
}
