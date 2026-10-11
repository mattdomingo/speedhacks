import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createRuntime } from '../runtime.mjs';
import { readConfig } from '../config.mjs';
import { testDatabase, TEST_DATABASE_URL } from './helpers.mjs';

const config = readConfig({
  DIAL_MCP_TOKEN: 'd'.repeat(64), CAMERA_TOKEN: 'c'.repeat(64), CRON_SECRET: 'r'.repeat(64),
  DATABASE_URL: TEST_DATABASE_URL, DEMO_MODE: 'true', DEMO_CALLER_NUMBER: '+14155550123',
});

async function serve(t, app) {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}`;
}

test('the Vercel entry runtime migrates and seeds on first request, retrying a sleeping database', async t => {
  const db = await testDatabase(t);
  let failures = 1;
  const waking = { ...db, transaction: work => failures-- > 0 ? Promise.reject(new Error('database is starting')) : db.transaction(work) };
  const { app, store } = createRuntime(config, { db: waking });
  const url = await serve(t, app);
  const first = await fetch(`${url}/health`);
  assert.equal(first.status, 503);
  assert.deepEqual(await first.json(), { ok: false, error: 'Database unavailable' });
  const second = await fetch(`${url}/health`);
  assert.equal(second.status, 200);
  assert.deepEqual(await second.json(), { ok: true, demo: true });
  assert.equal((await store.list('camera'))[0].demo, true);
});

test('the cron route needs the Vercel cron secret', async t => {
  const db = await testDatabase(t);
  const url = await serve(t, createRuntime(config, { db }).app);
  assert.equal((await fetch(`${url}/cron/google-sync`)).status, 401);
  const ok = await fetch(`${url}/cron/google-sync`, { headers: { Authorization: `Bearer ${config.CRON_SECRET}` } });
  assert.equal(ok.status, 200);
  assert.match((await ok.json()).skipped, /not configured/);
  const { CRON_SECRET: _secret, ...noCron } = config;
  const off = await serve(t, createRuntime(noCron, { db }).app);
  assert.equal((await fetch(`${off}/cron/google-sync`, { headers: { Authorization: 'Bearer x' } })).status, 503);
});
