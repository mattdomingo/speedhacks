// Dial webhook events, caller-PIN lockouts and phone reminders for hosted Postgres. Mirrors store-sqlite.mjs;
// tables come from backend/schema.sql (npm run db:init).
export function postgresVoiceStore(pool) {
  return {
    async pruneDialEvents(retentionDays) {
      await pool.query('DELETE FROM dial_event_handled WHERE handled_at < now() - make_interval(days => $1)', [retentionDays])
        .catch(error => { if (error.code !== '42P01') throw error; });
      const { rowCount } = await pool.query('DELETE FROM dial_event WHERE received_at < now() - make_interval(days => $1)', [retentionDays]);
      return rowCount;
    },
    // A delivery's side effects completed; redeliveries of the same event id are then skipped.
    // Before `npm run db:init` adds the table (42P01), every delivery simply runs its idempotent handlers.
    async dialEventHandled(id) {
      try {
        const { rows } = await pool.query('SELECT 1 FROM dial_event_handled WHERE id = $1', [id]);
        return rows.length > 0;
      } catch (error) {
        if (error.code === '42P01') return false;
        throw error;
      }
    },
    async markDialEventHandled(id) {
      await pool.query('INSERT INTO dial_event_handled (id) VALUES ($1) ON CONFLICT (id) DO NOTHING', [id])
        .catch(error => { if (error.code !== '42P01') throw error; });
    },
    // Claims the patient's one summary for a local day; false when it was already claimed.
    async claimCaregiverSummary(patientNumber, localDate, now) {
      const { rowCount } = await pool.query(`INSERT INTO caregiver_message (id, patient_number, kind, local_date, status, created_at)
        VALUES ($1, $2, 'summary', $3, 'sending', $4) ON CONFLICT (id) DO NOTHING`,
      [`summary:${patientNumber}:${localDate}`, patientNumber, localDate, now]);
      return rowCount === 1;
    },
    // Admits an alert only while fewer than `max` were admitted since `since`. The advisory lock
    // serializes concurrent alerts for one patient so the count cannot be read twice.
    async claimCaregiverAlert(id, patientNumber, localDate, now, since, max) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query("SELECT pg_advisory_xact_lock(hashtext('caregiver-alert:' || $1))", [patientNumber]);
        const { rowCount } = await client.query(`INSERT INTO caregiver_message (id, patient_number, kind, local_date, status, created_at)
          SELECT $1, $2, 'alert', $3, 'sending', $4
          WHERE (SELECT count(*) FROM caregiver_message WHERE patient_number = $2 AND kind = 'alert' AND created_at > $5) < $6`,
        [id, patientNumber, localDate, now, since, max]);
        await client.query('COMMIT');
        return rowCount === 1;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },
    async finishCaregiverMessage(id, status, outcome) {
      await pool.query('UPDATE caregiver_message SET status = $1, outcome = $2 WHERE id = $3', [status, outcome, id]);
    },
    async caregiverMessages(patientNumber, localDate) {
      const { rows } = await pool.query(`SELECT * FROM caregiver_message WHERE patient_number = $1 AND local_date = $2
        ORDER BY created_at`, [patientNumber, localDate]);
      return rows;
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
      const { rows } = await pool.query(`UPDATE reminders SET status = CASE channel WHEN 'text' THEN 'texting' ELSE 'sending' END,
        message_status = CASE channel WHEN 'text' THEN 'unknown' ELSE message_status END, attempts = attempts + 1,
        lease_until = CASE channel WHEN 'call' THEN $2 ELSE NULL END, updated_at = $1
        WHERE id IN (SELECT id FROM reminders
          WHERE (status = 'scheduled' AND due_at <= $1) OR (channel = 'call' AND status = 'sending' AND lease_until < $1)
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
    async claimReminderFallback(id, callStatus, now) {
      const { rowCount } = await pool.query(`UPDATE reminders SET status = 'missed', outcome = $2,
        message_status = 'unknown', lease_until = NULL, updated_at = $3 WHERE id = $1 AND status = 'calling'`,
      [id, callStatus, now]);
      return rowCount > 0;
    },
    async updateReminderMessage(id, { message_id = null, message_status }, now) {
      if (!['unknown', 'pending', 'delivered', 'failed'].includes(message_status)) return false;
      const { rowCount } = await pool.query(`UPDATE reminders SET message_id = COALESCE(message_id, $2), message_status = $3,
        status = CASE WHEN status = 'texting' AND $3 IN ('delivered', 'failed') THEN $3 ELSE status END,
        outcome = CASE WHEN status = 'texting' THEN 'text delivery ' || $3 ELSE outcome END, updated_at = $4
        WHERE id = $1 AND status IN ('texting', 'missed') AND message_status IN ('unknown', 'pending')
          AND (message_id IS NULL OR $2::text IS NULL OR message_id = $2)
          AND (message_status = 'unknown' OR $3 <> 'unknown')`, [id, message_id, message_status, now]);
      return rowCount > 0;
    },
    async reminderByMessage(messageId) {
      const { rows } = await pool.query('SELECT * FROM reminders WHERE message_id = $1', [messageId]);
      return rows[0];
    },
    async messageReceipt(messageId) {
      const { rows } = await pool.query(`SELECT payload FROM dial_event WHERE type = 'message.status_changed'
        AND payload#>>'{data,messageId}' = $1
        AND COALESCE(payload#>>'{data,direction}', 'outbound') = 'outbound'
        ORDER BY CASE WHEN COALESCE(payload#>>'{data,deliveryState}', payload#>>'{data,status}')
          IN ('delivered', 'failed', 'undelivered')
          THEN 0 ELSE 1 END, received_at DESC, id DESC LIMIT 1`, [messageId]);
      return rows[0]?.payload;
    },
    async unsettledMessages(before, limit = 5) {
      const { rows } = await pool.query(`SELECT * FROM reminders WHERE message_id IS NOT NULL
        AND message_status IN ('pending', 'unknown') AND status IN ('texting', 'missed') AND updated_at < $1
        ORDER BY updated_at, id LIMIT $2`, [before, limit]);
      return rows;
    },
    async reminderByCall(callId) {
      const { rows } = await pool.query('SELECT * FROM reminders WHERE call_id = $1', [callId]);
      return rows[0];
    },
    async unsettledCalls(before, limit = 5) {
      const { rows } = await pool.query(`SELECT * FROM reminders WHERE status = 'calling' AND call_id IS NOT NULL
        AND updated_at < $1 ORDER BY updated_at LIMIT $2`, [before, limit]);
      return rows;
    },
    // Calls whose placement timed out: Dial may or may not have placed them.
    async unconfirmedCalls(limit = 5) {
      const { rows } = await pool.query(`SELECT * FROM reminders WHERE status = 'calling' AND call_id IS NULL
        ORDER BY updated_at LIMIT $1`, [limit]);
      return rows;
    },
  };
}
