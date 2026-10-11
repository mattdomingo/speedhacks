import { randomUUID } from 'node:crypto';

// Append-only: each entry runs once, in order, recorded in schema_migrations.
// Never edit a shipped migration; add a new one. One statement per string.
const MIGRATIONS = [
  [
    `CREATE TABLE evidence (
       id text PRIMARY KEY,
       source text NOT NULL,
       origin text NOT NULL DEFAULT 'local',
       occurred_at timestamptz NOT NULL,
       payload jsonb NOT NULL
     )`,
    'CREATE INDEX evidence_source_time ON evidence (source, occurred_at DESC)',
    'CREATE INDEX evidence_origin ON evidence (origin)',
    `CREATE TABLE latest_frame (
       slot smallint PRIMARY KEY CHECK (slot = 1),
       captured_at timestamptz NOT NULL,
       captured_label text NOT NULL,
       jpeg bytea NOT NULL
     )`,
    `CREATE TABLE google_connection (
       slot smallint PRIMARY KEY CHECK (slot = 1),
       email text,
       scope text NOT NULL,
       timezone text,
       refresh_token text NOT NULL,
       status text NOT NULL CHECK (status IN ('connected', 'reconnect_required')),
       connected_at timestamptz NOT NULL DEFAULT now()
     )`,
    `CREATE TABLE oauth_state (
       state text PRIMARY KEY,
       verifier text NOT NULL,
       created_at timestamptz NOT NULL DEFAULT now()
     )`,
    `CREATE TABLE sync_state (
       name text PRIMARY KEY,
       last_success timestamptz,
       last_attempt timestamptz NOT NULL,
       last_error text,
       item_count integer NOT NULL DEFAULT 0,
       window_from text,
       window_to text
     )`,
    `CREATE TABLE dial_event (
       id text PRIMARY KEY,
       type text NOT NULL,
       created_at text,
       received_at timestamptz NOT NULL DEFAULT now(),
       payload jsonb NOT NULL
     )`,
    'CREATE INDEX dial_event_received ON dial_event (received_at)',
    // Failed caller-PIN attempts per hashed caller number (lockout window).
    `CREATE TABLE caller_pin_failure (
       caller_hash text PRIMARY KEY,
       failures integer NOT NULL,
       window_start timestamptz NOT NULL
     )`,
  ],
];

export const SCHEMA_VERSION = MIGRATIONS.length;
const MIGRATION_LOCK = 72_410_001;

// Safe under concurrency: serverless instances cold-starting together queue on the advisory lock.
export async function migrate(db) {
  await db.transaction(async tx => {
    await tx.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK]);
    await tx.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    const { rows } = await tx.query('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations');
    const current = Number(rows[0].version);
    if (current > MIGRATIONS.length) {
      throw new Error(`Database schema v${current} is newer than this build (v${MIGRATIONS.length})`);
    }
    for (let version = current; version < MIGRATIONS.length; version++) {
      for (const statement of MIGRATIONS[version]) await tx.query(statement);
      await tx.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version + 1]);
    }
  });
}

// One round trip for a whole batch: rows are passed as a JSON array.
const UPSERT = mode => `
  INSERT INTO evidence (id, source, origin, occurred_at, payload)
  SELECT r->>'id', r->>'source', $1, (r->>'timestamp')::timestamptz, r
  FROM jsonb_array_elements($2::jsonb) AS r
  ON CONFLICT (id) DO ${mode === 'ignore' ? 'NOTHING' : `UPDATE SET source = excluded.source,
    origin = excluded.origin, occurred_at = excluded.occurred_at, payload = excluded.payload`}`;

export function createStore(db) {
  // Migrations run once per process on first use; a failure (e.g. database still waking)
  // is retried by the next request instead of poisoning the instance.
  let ready;
  const ensureReady = () => (ready ??= migrate(db).catch(error => { ready = undefined; throw error; }));
  const query = async (text, params) => { await ensureReady(); return db.query(text, params); };
  const transaction = async work => { await ensureReady(); return db.transaction(work); };

  // Google writes hold a share lock on the connection row; a disconnect (which deletes it)
  // therefore either waits for an in-flight sync or makes it a no-op, never a resurrection.
  // Local origins have no such guard.
  const googleWrite = (origin, before, records) => transaction(async tx => {
    if (origin.startsWith('google-')) {
      const { rows } = await tx.query('SELECT 1 FROM google_connection WHERE slot = 1 FOR SHARE');
      if (!rows.length) return;
    }
    await before(tx);
    if (records.length) await tx.query(UPSERT('update'), [origin, JSON.stringify(records)]);
  });

  return {
    ready: ensureReady,
    async put(record) {
      await query(UPSERT('ignore'), ['local', JSON.stringify([record])]);
    },
    async list(source) {
      const { rows } = await query('SELECT payload FROM evidence WHERE source = $1 ORDER BY occurred_at DESC', [source]);
      return rows.map(row => row.payload);
    },
    // Replaces every record from one external origin atomically, so deleted or
    // cancelled upstream items disappear instead of lingering as stale evidence.
    async replaceOrigin(origin, records) {
      await googleWrite(origin, async tx => {
        await tx.query('DELETE FROM evidence WHERE origin = $1', [origin]);
      }, records);
    },
    // Adds records fetched on demand without discarding the synced set.
    async upsertOrigin(origin, records) {
      await googleWrite(origin, async () => {}, records);
    },
    // A live single-day lookup is authoritative for that day: events cancelled upstream go.
    async replaceCalendarDay(date, records) {
      await googleWrite('google-calendar', async tx => {
        await tx.query(`DELETE FROM evidence WHERE origin = 'google-calendar'
          AND payload->>'date' <= $1 AND COALESCE(payload->>'endDate', payload->>'date') >= $1`, [date]);
      }, records);
    },
    async countByOrigin() {
      const { rows } = await query('SELECT origin, COUNT(*)::int AS n FROM evidence GROUP BY origin');
      return Object.fromEntries(rows.map(row => [row.origin, row.n]));
    },
    async observe(observation) {
      const record = {
        ...observation, id: randomUUID(), source: 'camera', demo: false,
        text: `${observation.object} last seen ${observation.location}`,
      };
      await this.put(record);
      return record;
    },
    // Keeps only the newest capture; an older upload arriving late never overwrites it.
    async saveFrame(timestamp, jpeg) {
      await query(`INSERT INTO latest_frame (slot, captured_at, captured_label, jpeg) VALUES (1, $1, $2, $3)
        ON CONFLICT (slot) DO UPDATE SET captured_at = excluded.captured_at,
          captured_label = excluded.captured_label, jpeg = excluded.jpeg
        WHERE excluded.captured_at >= latest_frame.captured_at`, [timestamp, timestamp, jpeg]);
    },
    async latestFrame() {
      const { rows } = await query('SELECT captured_label AS timestamp, jpeg FROM latest_frame WHERE slot = 1');
      return rows[0];
    },
    async googleConnection() {
      const { rows } = await query('SELECT * FROM google_connection WHERE slot = 1');
      return rows[0];
    },
    async saveGoogleConnection({ email, scope, timezone, refreshToken }) {
      await query(`INSERT INTO google_connection (slot, email, scope, timezone, refresh_token, status)
        VALUES (1, $1, $2, $3, $4, 'connected')
        ON CONFLICT (slot) DO UPDATE SET email = excluded.email, scope = excluded.scope,
          timezone = excluded.timezone, refresh_token = excluded.refresh_token,
          status = 'connected', connected_at = now()`,
      [email ?? null, scope, timezone ?? null, refreshToken]);
    },
    async markGoogleReconnectRequired() {
      await query("UPDATE google_connection SET status = 'reconnect_required' WHERE slot = 1");
    },
    // Disconnecting also drops synced Google evidence: no connection, no stale copies.
    async deleteGoogleConnection() {
      await transaction(async tx => {
        await tx.query('DELETE FROM google_connection');
        await tx.query("DELETE FROM evidence WHERE origin LIKE 'google-%'");
        await tx.query("DELETE FROM sync_state WHERE name LIKE 'google-%'");
      });
    },
    async saveOAuthState(state, verifier) {
      await query("DELETE FROM oauth_state WHERE created_at < now() - interval '10 minutes'");
      await query('INSERT INTO oauth_state (state, verifier) VALUES ($1, $2)', [state, verifier]);
    },
    // Single use: deleting and reading in one statement means a replayed state never matches twice.
    async takeOAuthState(state) {
      const { rows } = await query(`DELETE FROM oauth_state WHERE state = $1
        RETURNING verifier, created_at > now() - interval '10 minutes' AS fresh`, [state]);
      return rows[0]?.fresh ? rows[0].verifier : undefined;
    },
    // Lease for background refreshes: true for exactly one caller per interval across instances.
    async claimSync(name, intervalSeconds) {
      const { rowCount } = await query(`INSERT INTO sync_state (name, last_attempt) VALUES ($1, now())
        ON CONFLICT (name) DO UPDATE SET last_attempt = now()
        WHERE sync_state.last_attempt < now() - make_interval(secs => $2)
        RETURNING name`, [name, intervalSeconds]);
      return rowCount === 1;
    },
    async recordSync(name, { error, count, window } = {}) {
      await query(`INSERT INTO sync_state AS s (name, last_success, last_attempt, last_error, item_count, window_from, window_to)
        VALUES ($1, CASE WHEN $2::text IS NULL THEN now() END, now(), $2, COALESCE($3, 0), $4, $5)
        ON CONFLICT (name) DO UPDATE SET last_attempt = now(), last_error = excluded.last_error,
          last_success = COALESCE(excluded.last_success, s.last_success),
          item_count = CASE WHEN excluded.last_error IS NULL THEN excluded.item_count ELSE s.item_count END,
          window_from = CASE WHEN excluded.last_error IS NULL THEN excluded.window_from ELSE s.window_from END,
          window_to = CASE WHEN excluded.last_error IS NULL THEN excluded.window_to ELSE s.window_to END`,
      [name, error ?? null, count ?? null, window?.from ?? null, window?.to ?? null]);
    },
    async syncState(name) {
      const { rows } = await query(`SELECT *, EXTRACT(EPOCH FROM now() - last_success)::float AS age_seconds
        FROM sync_state WHERE ($1::text IS NULL OR name = $1) ORDER BY name`, [name ?? null]);
      return rows;
    },
    async pinFailures(callerHash, windowSeconds) {
      const { rows } = await query(`SELECT failures FROM caller_pin_failure
        WHERE caller_hash = $1 AND window_start > now() - make_interval(secs => $2)`, [callerHash, windowSeconds]);
      return rows[0]?.failures ?? 0;
    },
    async recordPinFailure(callerHash, windowSeconds) {
      await query(`INSERT INTO caller_pin_failure AS f (caller_hash, failures, window_start) VALUES ($1, 1, now())
        ON CONFLICT (caller_hash) DO UPDATE SET
          failures = CASE WHEN f.window_start > now() - make_interval(secs => $2) THEN f.failures + 1 ELSE 1 END,
          window_start = CASE WHEN f.window_start > now() - make_interval(secs => $2) THEN f.window_start ELSE now() END`,
      [callerHash, windowSeconds]);
    },
    async clearPinFailures(callerHash) {
      await query('DELETE FROM caller_pin_failure WHERE caller_hash = $1', [callerHash]);
    },
    // Returns false for a redelivered event so handlers stay idempotent.
    async recordDialEvent(event, retentionDays) {
      await this.pruneDialEvents(retentionDays);
      const { rowCount } = await query(`INSERT INTO dial_event (id, type, created_at, payload)
        VALUES ($1, $2, $3, $4::jsonb) ON CONFLICT (id) DO NOTHING`,
      [event.id, event.type, event.createdAt ?? null, JSON.stringify(event)]);
      return rowCount === 1;
    },
    async pruneDialEvents(retentionDays) {
      const { rowCount } = await query('DELETE FROM dial_event WHERE received_at < now() - make_interval(days => $1)', [retentionDays]);
      return rowCount;
    },
    async dialEvents(limit = 20) {
      const { rows } = await query('SELECT payload FROM dial_event ORDER BY received_at DESC LIMIT $1', [limit]);
      return rows.map(row => row.payload);
    },
    async ping() {
      const { rows } = await query('SELECT 1 AS ok');
      return rows[0].ok === 1;
    },
    close: () => db.close(),
  };
}
