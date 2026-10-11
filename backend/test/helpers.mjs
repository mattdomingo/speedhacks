import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { PGlite } from '@electric-sql/pglite';
import { pglite, postgres } from '../db.mjs';
import { createStore } from '../store.mjs';

let shared;

// An isolated, empty database per test: in-process PGlite by default, or a throwaway schema
// on a real server when TEST_DATABASE_URL is set (CI runs both).
export async function testDatabase(t) {
  const url = process.env.TEST_DATABASE_URL;
  const schema = `test_${randomBytes(6).toString('hex')}`;
  if (!url) {
    // Starting PGlite (WASM) is the slow part, so one instance serves a whole test file;
    // tests in a file run sequentially, each in its own schema.
    shared ??= new PGlite();
    await shared.exec(`CREATE SCHEMA ${schema}; SET search_path TO ${schema}`);
    const db = { ...pglite(shared), close: async () => {} };
    t.after(() => shared.exec(`SET search_path TO public; DROP SCHEMA ${schema} CASCADE`));
    return db;
  }
  const admin = async sql => {
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try { await client.query(sql); } finally { await client.end(); }
  };
  await admin(`CREATE SCHEMA ${schema}`);
  const db = postgres(url, { options: `-c search_path=${schema}` });
  t.after(async () => {
    await db.close().catch(() => {});
    await admin(`DROP SCHEMA ${schema} CASCADE`);
  });
  return db;
}

export async function testStore(t) {
  const db = await testDatabase(t);
  const store = createStore(db);
  await store.ready();
  return Object.assign(store, { db });
}

export const TEST_DATABASE_URL = 'postgres://test:test@127.0.0.1:5432/test';
