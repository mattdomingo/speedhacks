import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../app.mjs';
import { readConfig } from '../config.mjs';
import { createHealth } from '../health.mjs';
import { testStore, TEST_DATABASE_URL } from './helpers.mjs';

const base = { DIAL_MCP_TOKEN: 'd'.repeat(64), CAMERA_TOKEN: 'c'.repeat(64), DATABASE_URL: TEST_DATABASE_URL };
const NO_ANALYTICS = { toolCall() {}, rejected() {}, sync() {}, dialEvent() {} };

async function serve(t, store, config, healthChecks) {
  const server = createApp(config, store, undefined, { analytics: NO_ANALYTICS, healthChecks }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return async () => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/health`);
    return { status: response.status, body: await response.json() };
  };
}

test('health reports each dependency as ok, missing, invalid or error without leaking keys', async t => {
  const store = await testStore(t);
  const config = readConfig({ ...base, ANTHROPIC_API_KEY: 'sk-ant-secret-value', DIAL_API_KEY: 'sk_live_secret_value' });
  const health = await serve(t, store, config, {
    claude: async () => { throw Object.assign(new Error('401 invalid x-api-key sk-ant-secret-value'), { status: 401 }); },
    dial: async () => ({ id: 'acct' }),
  });
  const { status, body } = await health();
  assert.equal(status, 200);
  assert.deepEqual(body, { ok: true, checks: { db: 'ok', claude: 'invalid', gemini: 'missing', dial: 'ok', embeddings: 'missing' },
    steph: { provider: 'claude', model: 'claude-opus-5-5' }, search: 'on-device', demo: false });
  assert.doesNotMatch(JSON.stringify(body), /secret/);
});

test('provider checks are cached for a minute and shared between concurrent requests', async t => {
  const store = await testStore(t);
  let probes = 0;
  const clock = { now: 0 };
  const health = createHealth(readConfig(base), store, { now: () => clock.now, checks: {
    claude: async () => { probes++; await new Promise(resolve => setTimeout(resolve, 20)); },
    dial: async () => { throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }); },
  } });
  const reports = await Promise.all(Array.from({ length: 10 }, () => health()));
  assert.equal(probes, 1);
  assert.ok(reports.every(report => report.checks.claude === 'ok' && report.checks.dial === 'error'));
  clock.now = 59_000;
  await health();
  assert.equal(probes, 1);
  clock.now = 61_000;
  await health();
  assert.equal(probes, 2);
});

test('a database outage turns health to 503 and recovers when the database returns', async t => {
  const store = await testStore(t);
  const realPing = store.ping.bind(store);
  const health = await serve(t, store, readConfig(base), {});
  assert.equal((await health()).status, 200);
  store.ping = async () => { throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' }); };
  const down = await health();
  assert.equal(down.status, 503);
  assert.deepEqual([down.body.ok, down.body.checks.db], [false, 'error']);
  store.ping = realPing;
  assert.equal((await health()).status, 200);
});

test('a Postgres server that is not running reports db error instead of crashing', async t => {
  const { openPostgresStore } = await import('../postgres.mjs');
  const dead = openPostgresStore('postgres://test:test@127.0.0.1:1/none');
  t.after(() => dead.close());
  const health = createHealth(readConfig(base), dead, { checks: {} });
  const report = await health();
  assert.deepEqual([report.ok, report.checks.db], [false, 'error']);
});
