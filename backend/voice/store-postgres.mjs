// Dial webhook events and caller-PIN lockouts for hosted Postgres. Mirrors store-sqlite.mjs;
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
  };
}
