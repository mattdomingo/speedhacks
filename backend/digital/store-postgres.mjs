// Google connection, OAuth handshakes and sync bookkeeping for hosted Postgres. Mirrors
// store-sqlite.mjs; keep both aligned. Tables come from backend/schema.sql (npm run db:init).
import { SCOPES } from './google.mjs';

const scopeFor = origin => SCOPES[origin === 'google-calendar' ? 'calendar' : 'gmail'];
export function postgresDigitalStore(pool) {
  async function transaction(work) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async function snapshot(client = pool) {
    const { rows: [row] } = await client.query(`SELECT c.*, g.generation::text FROM google_generation g
      LEFT JOIN google_connection c ON c.slot = g.slot WHERE g.slot = 1`);
    return { generation: row.generation, connection: row.slot === 1 ? row : undefined };
  }

  // The generation row survives disconnects. All data/metadata writes share-lock it;
  // lifecycle changes exclusively lock it before replacing credentials or clearing data.
  function withConnection(generation, scope, work) {
    return transaction(async client => {
      const { rows: [current] } = await client.query('SELECT generation::text FROM google_generation WHERE slot = 1 FOR SHARE');
      if (current.generation !== generation) return false;
      const { rows: [row] } = await client.query('SELECT scope FROM google_connection WHERE slot = 1');
      if (!row || (scope && !row.scope.split(' ').includes(scope))) return false;
      await work(client);
      return true;
    });
  }

  async function clearGoogleData(client) {
    await client.query("DELETE FROM evidence WHERE payload->>'origin' LIKE 'google-%'");
    await client.query("DELETE FROM sync_state WHERE name LIKE 'google-%'");
    await client.query('DELETE FROM oauth_state');
  }

  function googleWrite(origin, before, records, generation) {
    return withConnection(generation, scopeFor(origin), async client => {
      await before(client);
      if (!records.length) return;
      await client.query(`INSERT INTO evidence (id, source, timestamp, payload)
        SELECT r->>'id', r->>'source', r->>'timestamp', r || jsonb_build_object('origin', $1::text)
        FROM jsonb_array_elements($2::jsonb) AS r
        ON CONFLICT (id) DO UPDATE SET source=excluded.source, timestamp=excluded.timestamp, payload=excluded.payload`,
      [origin, JSON.stringify(records)]);
    });
  }

  return {
    replaceOrigin(origin, records, generation) {
      return googleWrite(origin, client => client.query("DELETE FROM evidence WHERE payload->>'origin' = $1", [origin]), records, generation);
    },
    upsertOrigin(origin, records, generation) {
      return googleWrite(origin, async () => {}, records, generation);
    },
    replaceCalendarDay(date, records, generation) {
      return googleWrite('google-calendar', client => client.query(`DELETE FROM evidence
        WHERE payload->>'origin' = 'google-calendar' AND payload->>'date' <= $1
          AND COALESCE(payload->>'endDate', payload->>'date') >= $1`, [date]), records, generation);
    },
    async countByOrigin() {
      const { rows } = await pool.query(`SELECT COALESCE(payload->>'origin', 'local') AS origin, COUNT(*)::int AS n
        FROM evidence GROUP BY 1`);
      return Object.fromEntries(rows.map(row => [row.origin, row.n]));
    },
    googleSnapshot: snapshot,
    async googleConnection() {
      return (await snapshot()).connection;
    },
    saveGoogleConnection({ email, scope, timezone, refreshToken, generation, tokenOrigin }) {
      return transaction(async client => {
        const { rows: [current] } = await client.query('SELECT generation::text FROM google_generation WHERE slot = 1 FOR UPDATE');
        if (current.generation !== generation) return undefined;
        await client.query('UPDATE google_generation SET generation = generation + 1 WHERE slot = 1');
        await client.query(`INSERT INTO google_connection (slot, email, scope, timezone, refresh_token, status, token_origin)
          VALUES (1, $1, $2, $3, $4, 'connected', $5)
          ON CONFLICT (slot) DO UPDATE SET email=excluded.email, scope=excluded.scope, timezone=excluded.timezone,
            refresh_token=excluded.refresh_token, status='connected', connected_at=now(), token_origin=excluded.token_origin`,
        [email ?? null, scope, timezone ?? null, refreshToken, tokenOrigin ?? null]);
        await clearGoogleData(client);
        return (await snapshot(client)).connection;
      });
    },
    markGoogleReconnectRequired(generation) {
      return withConnection(generation, undefined, client =>
        client.query("UPDATE google_connection SET status = 'reconnect_required' WHERE slot = 1"));
    },
    deleteGoogleConnection() {
      return transaction(async client => {
        await client.query('SELECT generation FROM google_generation WHERE slot = 1 FOR UPDATE');
        const previous = (await snapshot(client)).connection;
        await client.query('UPDATE google_generation SET generation = generation + 1 WHERE slot = 1');
        await client.query('DELETE FROM google_connection');
        await clearGoogleData(client);
        return previous;
      });
    },
    saveOAuthState(state, verifier) {
      return transaction(async client => {
        await client.query('SELECT generation FROM google_generation WHERE slot = 1 FOR SHARE');
        await client.query("DELETE FROM oauth_state WHERE created_at < now() - interval '10 minutes'");
        await client.query('INSERT INTO oauth_state (state, verifier) VALUES ($1, $2)', [state, verifier]);
      });
    },
    // Claim the state and generation together, so lifecycle changes fence a pending callback.
    takeOAuthState(state) {
      return transaction(async client => {
        const { rows: [current] } = await client.query('SELECT generation::text FROM google_generation WHERE slot = 1 FOR SHARE');
        const { rows } = await client.query(`DELETE FROM oauth_state WHERE state = $1
          RETURNING verifier, created_at > now() - interval '10 minutes' AS fresh`, [state]);
        return rows[0]?.fresh ? { verifier: rows[0].verifier, generation: current.generation } : undefined;
      });
    },
    recordSync(name, { error, count, window } = {}, generation) {
      return withConnection(generation, scopeFor(name), client => client.query(`INSERT INTO sync_state AS s
          (name, last_success, last_attempt, last_error, item_count, window_from, window_to)
        VALUES ($1, CASE WHEN $2::text IS NULL THEN now() END, now(), $2, COALESCE($3, 0), $4, $5)
        ON CONFLICT (name) DO UPDATE SET last_attempt = now(), last_error = excluded.last_error,
          last_success = COALESCE(excluded.last_success, s.last_success),
          item_count = CASE WHEN excluded.last_error IS NULL THEN excluded.item_count ELSE s.item_count END,
          window_from = CASE WHEN excluded.last_error IS NULL THEN excluded.window_from ELSE s.window_from END,
          window_to = CASE WHEN excluded.last_error IS NULL THEN excluded.window_to ELSE s.window_to END`,
      [name, error ?? null, count ?? null, window?.from ?? null, window?.to ?? null]));
    },
    async syncState(name) {
      const { rows } = await pool.query(`SELECT *, EXTRACT(EPOCH FROM now() - last_success)::float AS age_seconds
        FROM sync_state WHERE ($1::text IS NULL OR name = $1) ORDER BY name`, [name ?? null]);
      return rows;
    },
  };
}
