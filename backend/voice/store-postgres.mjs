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
    // Counts an attempt and returns the running total atomically (the row lock serializes
    // concurrent upserts), so parallel guesses cannot slip past the lockout.
    async countPinAttempt(callerHash, windowSeconds) {
      const { rows } = await pool.query(`INSERT INTO caller_pin_failure AS f (caller_hash, failures, window_start) VALUES ($1, 1, now())
        ON CONFLICT (caller_hash) DO UPDATE SET
          failures = CASE WHEN f.window_start > now() - make_interval(secs => $2) THEN f.failures + 1 ELSE 1 END,
          window_start = CASE WHEN f.window_start > now() - make_interval(secs => $2) THEN f.window_start ELSE now() END
        RETURNING failures`, [callerHash, windowSeconds]);
      return rows[0].failures;
    },
    async clearPinFailures(callerHash) {
      await pool.query('DELETE FROM caller_pin_failure WHERE caller_hash = $1', [callerHash]);
    },
  };
}
