import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createApp } from '../app.mjs';
import { readConfig } from '../config.mjs';
import { openStore } from '../store.mjs';
import { openPostgresStore } from '../postgres.mjs';
import { Client as PostgresClient } from 'pg';
import { seedDemo } from '../demo.mjs';
import { findObject } from '../physical/index.mjs';
import { smokeObjectMemory } from '../../scripts/smoke-object-memory.mjs';

const config = {
  DIAL_MCP_TOKEN: 'd'.repeat(64), CAMERA_TOKEN: 'c'.repeat(64),
  DEMO_CALLER_NUMBER: '+14155550123', DEMO_MODE: 'true',
};

async function fixture(t, overrides = {}, physicalOptions) {
  let reopen;
  if (process.env.TEST_DATABASE_URL) {
    const admin = new PostgresClient({ connectionString: process.env.TEST_DATABASE_URL, connectionTimeoutMillis: 10_000 });
    await admin.connect();
    const schema = `test_${randomUUID().replaceAll('-', '')}`;
    t.after(async () => {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    });
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.query(`SET search_path TO ${schema}`);
    await admin.query(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
    const databaseUrl = new URL(process.env.TEST_DATABASE_URL);
    databaseUrl.searchParams.set('options', `-c search_path=${schema}`);
    reopen = () => openPostgresStore(databaseUrl.toString());
  } else {
    const dir = mkdtempSync(join(tmpdir(), 'speedhacks-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    reopen = () => openStore(dir);
  }
  const store = reopen();
  const server = createApp({ ...config, ...overrides }, store, physicalOptions).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await store.close();
  });
  return { store, reopen, url: `http://127.0.0.1:${server.address().port}` };
}

async function connect(t, url, headers = {}) {
  const client = new Client({ name: 'scaffold-check', version: '0.1.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${config.DIAL_MCP_TOKEN}`, ...headers } },
  }));
  t.after(() => client.close());
  return client;
}

test('configuration fails closed with missing or reused secrets', () => {
  assert.throws(() => readConfig({}));
  assert.throws(() => readConfig({ ...config, CAMERA_TOKEN: config.DIAL_MCP_TOKEN }));
  assert.equal(readConfig(config).PORT, 3000);
  assert.equal(readConfig({ ...config, DATABASE_URL: '' }).DATABASE_URL, undefined);
  assert.throws(() => readConfig({ ...config, VERCEL: '1' }), /DATABASE_URL/);
  assert.throws(() => readConfig({ ...config, DATABASE_URL: 'https://example.com' }));
  assert.equal(readConfig({ ...config, VERCEL: '1', DATABASE_URL: 'postgres://localhost/memory' }).DATABASE_URL,
    'postgres://localhost/memory');
});

test('camera endpoint rejects unauthenticated and malformed uploads', async t => {
  const { url } = await fixture(t);
  assert.equal((await fetch(`${url}/camera/observations`, { method: 'POST' })).status, 401);
  const response = await fetch(`${url}/camera/observations`, {
    method: 'POST', headers: { Authorization: `Bearer ${config.CAMERA_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ object: 'keys', location: 'desk', timestamp: 'invalid' }),
  });
  assert.equal(response.status, 400);
});

test('observations survive reopening and newest timestamp wins, not upload order', async t => {
  const { store, reopen } = await fixture(t);
  await store.observe({ object: 'keys', location: 'new location', timestamp: '2026-01-02T00:00:00Z' });
  await store.observe({ object: 'keys', location: 'old location', timestamp: '2026-01-01T00:00:00Z' });
  const reopened = reopen();
  try {
    assert.equal((await findObject(reopened, ' KEYS ')).evidence[0].location, 'new location');
    assert.equal((await findObject(reopened, 'wallet')).status, 'unknown');
  } finally {
    await reopened.close();
  }
});

test('MCP discovery works without caller headers but cannot retrieve data', async t => {
  const { store, url } = await fixture(t);
  await seedDemo(store);
  const client = await connect(t, url);
  assert.equal((await client.listTools()).tools.length, 5);
  assert.equal((await client.callTool({ name: 'find_object', arguments: { object: 'keys' } })).isError, true);
  assert.equal((await client.callTool({ name: 'search_messages', arguments: {} })).isError, true);
});

test('MCP requires its own secret and negotiates legacy initialization', async t => {
  const { url } = await fixture(t);
  assert.equal((await fetch(`${url}/mcp`, { method: 'POST',
    headers: { Authorization: `Bearer ${config.CAMERA_TOKEN}` } })).status, 401);
  const response = await fetch(`${url}/mcp`, {
    method: 'POST', headers: {
      Authorization: `Bearer ${config.DIAL_MCP_TOKEN}`,
      'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'legacy-client', version: '1' },
    } }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).result.serverInfo.name, 'speedhacks-memory');
});

test('authorized inbound MCP calls retrieve demo evidence and handle unknown objects', async t => {
  const { store, url } = await fixture(t);
  await seedDemo(store);
  const client = await connect(t, url, {
    'X-Dial-User-Number': config.DEMO_CALLER_NUMBER, 'X-Dial-Direction': 'inbound',
  });
  const keys = await client.callTool({ name: 'find_object', arguments: { object: 'keys' } });
  assert.equal(keys.structuredContent.status, 'supported');
  assert.equal(keys.structuredContent.evidence[0].demo, true);
  const absent = await client.callTool({ name: 'find_object', arguments: { object: 'wallet' } });
  assert.equal(absent.structuredContent.status, 'unknown');
  const schedule = await client.callTool({ name: 'get_schedule', arguments: { date: new Date().toISOString().slice(0, 10) } });
  assert.equal(schedule.structuredContent.evidence[0].source, 'calendar');
  const email = await client.callTool({ name: 'search_messages', arguments: { query: 'Maya dinner' } });
  assert.equal(email.structuredContent.evidence[0].source, 'email');
});

test('live MCP excludes retained calendar and email fixtures without deleting them', async t => {
  const { store, url } = await fixture(t, { DEMO_MODE: 'false' });
  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  await seedDemo(store, now);
  const client = await connect(t, url, {
    'X-Dial-User-Number': config.DEMO_CALLER_NUMBER, 'X-Dial-Direction': 'inbound',
  });
  for (const [name, args, source] of [
    ['get_schedule', { date }, 'calendar'],
    ['search_messages', { query: 'Maya dinner' }, 'email'],
  ]) {
    const stored = await store.list(source);
    const empty = (await client.callTool({ name, arguments: args })).structuredContent;
    assert.equal(empty.status, 'unknown');
    assert.deepEqual(empty.evidence, []);
    await store.put({ id: `real-${source}`, source, date, timestamp: now.toISOString(),
      text: 'Maya dinner plans', demo: false });
    const real = (await client.callTool({ name, arguments: args })).structuredContent;
    assert.deepEqual(real.evidence.map(item => item.id), [`real-${source}`]);
    assert.deepEqual((await store.list(source)).filter(item => item.demo), stored, 'stored fixtures remain intact');
  }
});

test('unknown caller and outbound direction cannot access memories', async t => {
  const { store, url } = await fixture(t);
  await seedDemo(store);
  for (const headers of [
    { 'X-Dial-User-Number': '+14155550999', 'X-Dial-Direction': 'inbound' },
    { 'X-Dial-User-Number': config.DEMO_CALLER_NUMBER, 'X-Dial-Direction': 'outbound' },
  ]) {
    const client = await connect(t, url, headers);
    assert.equal((await client.callTool({ name: 'find_object', arguments: { object: 'keys' } })).isError, true);
    assert.equal((await client.callTool({ name: 'search_messages', arguments: {} })).isError, true);
  }
});

test('frame ingestion validates JPEG and preserves newest capture', async t => {
  const { url, store } = await fixture(t);
  const headers = { Authorization: `Bearer ${config.CAMERA_TOKEN}`, 'Content-Type': 'application/json' };
  for (const timestamp of ['2026-01-02T00:00:00Z', '2026-01-01T17:00:00-08:00', '2026-01-01T00:00:00Z']) {
    const response = await fetch(`${url}/camera/frame`, { method: 'POST', headers,
      body: JSON.stringify({ timestamp, jpegBase64: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64') }) });
    assert.equal(response.status, 201);
    assert.equal((await response.json()).inference, 'not_configured');
  }
  assert.equal((await store.latestFrame()).timestamp, '2026-01-01T17:00:00-08:00');
  assert.equal((await fetch(`${url}/camera/frame`)).status, 401);
  assert.equal((await fetch(`${url}/camera/frame`, { headers })).status, 200);
  const invalid = await fetch(`${url}/camera/frame`, { method: 'POST', headers,
    body: JSON.stringify({ timestamp: '2026-01-01T00:00:00Z', jpegBase64: 'bm90IGpwZWc=' }) });
  assert.equal(invalid.status, 400);
});

test('future observations are rejected', async t => {
  const { url } = await fixture(t);
  const response = await fetch(`${url}/camera/observations`, {
    method: 'POST', headers: { Authorization: `Bearer ${config.CAMERA_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ object: 'keys', location: 'desk', timestamp: new Date(Date.now() + 60_000).toISOString() }),
  });
  assert.equal(response.status, 400);
});

test('demo seeding is idempotent across backend starts', async t => {
  const { store } = await fixture(t);
  const count = await seedDemo(store);
  assert.equal(await seedDemo(store), count);
  // Coffee with Priya, Maya's visit, lunch with Sam, and patient B's visit; one email; keys, car and B's glasses.
  assert.equal((await store.list('calendar')).length, 4);
  assert.equal((await store.list('email')).length, 1);
  assert.equal((await store.list('camera')).length, 3);
});

test('failed asynchronous writes return an error, never a successful upload', async t => {
  const { store, url } = await fixture(t);
  store.saveFrame = async () => { throw new Error('Database unavailable'); };
  const response = await fetch(`${url}/camera/frame`, {
    method: 'POST', headers: { Authorization: `Bearer ${config.CAMERA_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ timestamp: '2026-01-01T00:00:00Z', jpegBase64: '/9j/2Q==' }),
  });
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: 'Internal server error' });
});

test('frame integration reaches authenticated MCP with aliases, evidence photographs and freshness', async t => {
  const base = Date.now();
  let now = base;
  const { store, url } = await fixture(t, { DEMO_MODE: 'false', GEMINI_API_KEY: 'test-only' }, {
    now: () => now,
    analyze: async () => ({ detections: [{ object: 'keys', location: 'beside the mug',
      bbox: [100, 100, 200, 200], resting: true, uncertain: false, visibility: 'clear' }] }),
  });
  await seedDemo(store);
  const client = await connect(t, url, { 'X-Dial-User-Number': config.DEMO_CALLER_NUMBER, 'X-Dial-Direction': 'inbound' });
  const lookup = object => client.callTool({ name: 'find_object', arguments: { object } });
  assert.equal((await lookup('my keys')).structuredContent.status, 'unknown');
  const headers = { Authorization: `Bearer ${config.CAMERA_TOKEN}`, 'Content-Type': 'application/json' };
  let capture;
  for (const second of [0, 5]) {
    now = base + second * 1000;
    const response = await fetch(`${url}/camera/frame`, { method: 'POST', headers,
      body: JSON.stringify({ timestamp: new Date(now).toISOString(), jpegBase64: '/9j/2Q==' }) });
    capture = await response.json();
    assert.equal(capture.inference, 'analyzed');
    assert.equal(capture.confirmed, second === 5 ? 1 : 0);
  }
  const answer = (await lookup('my keyring')).structuredContent;
  assert.equal(answer.status, 'supported');
  assert.equal(answer.evidence[0].demo, false);
  assert.equal(answer.evidence[0].timestamp, new Date(now).toISOString());
  assert.equal(answer.camera.status, 'live');
  assert.equal((await lookup('cellphone')).structuredContent.status, 'unknown');
  const smoke = await smokeObjectMemory(url, config.DIAL_MCP_TOKEN, config.DEMO_CALLER_NUMBER);
  assert.equal(smoke['my keys'].status, 'supported');
  assert.equal(smoke.cellphone.status, 'unknown');
  await assert.rejects(smokeObjectMemory('http://example.com', config.DIAL_MCP_TOKEN, config.DEMO_CALLER_NUMBER), /HTTPS/);
  assert.equal((await fetch(`${url}/camera/status`)).status, 401);
  assert.equal((await fetch(`${url}/camera/status`, { headers: { Authorization: `Bearer ${config.DIAL_MCP_TOKEN}` } })).status, 401);
  const evidenceUrl = `${url}/camera/evidence/${capture.frameId}`;
  assert.equal((await fetch(evidenceUrl)).status, 401);
  const photograph = await fetch(evidenceUrl, { headers });
  assert.equal(photograph.headers.get('cache-control'), 'no-store');
  assert.equal(photograph.headers.get('x-captured-at'), answer.evidence[0].timestamp);
  assert.deepEqual(Buffer.from(await photograph.arrayBuffer()), Buffer.from('/9j/2Q==', 'base64'));
  assert.equal((await fetch(`${url}/camera/evidence/${'0'.repeat(64)}`, { headers })).status, 404);
  now += 61_000;
  const stale = (await lookup('keys')).structuredContent;
  assert.equal(stale.status, 'supported');
  assert.equal(stale.camera.status, 'stale');
  assert.deepEqual(stale.evidence, answer.evidence);
});
