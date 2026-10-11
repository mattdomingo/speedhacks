import { randomBytes } from 'node:crypto';
import { PassThrough } from 'node:stream';
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
