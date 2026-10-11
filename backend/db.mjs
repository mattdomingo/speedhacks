import pg from 'pg';
import { attachDatabasePool } from '@vercel/functions';

// A minimal driver surface shared by node-postgres (production) and PGlite (tests):
// query(text, params) -> { rows, rowCount }, transaction(fn(tx)), close().

export function postgres(connectionString, options = {}) {
  // One pool per function instance. On Vercel Fluid compute, attachDatabasePool releases
  // idle clients before the instance suspends; elsewhere it is a no-op.
  const pool = new pg.Pool({ connectionString, max: 5, idleTimeoutMillis: 10_000, ...options });
  pool.on('error', error => console.error(`Postgres pool error: ${error.message}`));
  attachDatabasePool(pool);
  return {
    query: (text, params) => pool.query(text, params),
    async transaction(work) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await work({ query: (text, params) => client.query(text, params) });
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

// In-process Postgres (WASM) for tests and local experiments without a server.
export function pglite(instance) {
  const normalize = result => ({ rows: result.rows, rowCount: result.affectedRows ?? result.rows.length });
  return {
    query: async (text, params) => normalize(await instance.query(text, params)),
    transaction: work => instance.transaction(tx =>
      work({ query: async (text, params) => normalize(await tx.query(text, params)) })),
    close: () => instance.close(),
  };
}
