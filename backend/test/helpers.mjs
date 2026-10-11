import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { Client } from 'pg';
import { openStore } from '../store.mjs';
import { openPostgresStore } from '../postgres.mjs';

// A fresh store per test on the same adapter the backend would use: SQLite by default, or a
// throwaway schema initialized from schema.sql when TEST_DATABASE_URL is set (CI runs both).
// `sql` runs a statement against that database for tests that need to age or inspect rows.
export async function testStore(t) {
  if (!process.env.TEST_DATABASE_URL) {
    const dir = mkdtempSync(join(tmpdir(), 'speedhacks-'));
    const store = openStore(dir);
    t.after(async () => { await store.close(); rmSync(dir, { recursive: true, force: true }); });
    return Object.assign(store, {
      adapter: 'sqlite', reopen: () => openStore(dir),
      sql: async (text, params = []) => store.db.prepare(text).run(...params),
    });
  }
  const admin = new Client({ connectionString: process.env.TEST_DATABASE_URL, connectionTimeoutMillis: 10_000 });
  await admin.connect();
  const schema = `test_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.query(`SET search_path TO ${schema}`);
  await admin.query(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  const url = new URL(process.env.TEST_DATABASE_URL);
  url.searchParams.set('options', `-c search_path=${schema}`);
  const store = openPostgresStore(url.toString());
  t.after(async () => {
    await store.close();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  });
  return Object.assign(store, {
    adapter: 'postgres', reopen: () => openPostgresStore(url.toString()),
    sql: (text, params = []) => admin.query(text, params),
  });
}

export const TEST_DATABASE_URL = 'postgres://test:test@127.0.0.1:5432/test';

// Mimics Vercel's Node.js request helpers (shouldAddHelpers): the runtime reads the whole body
// before the app runs, replays it on data/end, and exposes a lazily parsed req.body. Express body
// parsers then see a finished request and skip it.
export function vercelHelpers(app) {
  return async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const replay = new PassThrough();
    replay.end(body);
    req.on = req.addListener = ((on, original) => (name, cb) =>
      (name === 'data' || name === 'end' ? on(name, cb) : original(name, cb)))(replay.on.bind(replay), req.on.bind(req));
    req.read = replay.read.bind(replay);
    let parsed;
    Object.defineProperty(req, 'body', {
      configurable: true, enumerable: true,
      get() {
        if (parsed === undefined && /json/.test(req.headers['content-type'] ?? '')) {
          try { parsed = body.length ? JSON.parse(body.toString()) : {}; }
          catch { throw Object.assign(new Error('Invalid JSON'), { statusCode: 400 }); }
        }
        return parsed;
      },
      set(value) { parsed = value; },
    });
    app(req, res);
  };
}
