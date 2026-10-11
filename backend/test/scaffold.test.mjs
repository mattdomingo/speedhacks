import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createApp } from '../app.mjs';
import { readConfig } from '../config.mjs';
import { createStore } from '../store.mjs';
import { testStore, TEST_DATABASE_URL } from './helpers.mjs';
import { seedDemo } from '../demo.mjs';
import { findObject } from '../physical/index.mjs';

const config = {
  DIAL_MCP_TOKEN: 'd'.repeat(64), CAMERA_TOKEN: 'c'.repeat(64),
  DEMO_CALLER_NUMBER: '+14155550123', DEMO_MODE: 'true', DATABASE_URL: TEST_DATABASE_URL,
};

async function fixture(t) {
  const store = await testStore(t);
  const server = createApp(config, store).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  return { store, url: `http://127.0.0.1:${server.address().port}` };
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
  assert.throws(() => readConfig({ ...config, DATABASE_URL: undefined }));
  assert.equal(readConfig(config).PORT, 3000);
  const { DATABASE_URL: _url, ...withoutDatabaseUrl } = config;
  assert.equal(readConfig({ ...withoutDatabaseUrl, POSTGRES_URL: TEST_DATABASE_URL }).DATABASE_URL, TEST_DATABASE_URL);
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
  const { store } = await fixture(t);
  await store.observe({ object: 'keys', location: 'new location', timestamp: '2026-01-02T00:00:00Z' });
  await store.observe({ object: 'keys', location: 'old location', timestamp: '2026-01-01T00:00:00Z' });
  const reopened = createStore(store.db);
  assert.equal((await findObject(reopened, ' KEYS ')).evidence[0].location, 'new location');
  assert.equal((await findObject(reopened, 'wallet')).status, 'unknown');
});

test('MCP discovery works without caller headers but cannot retrieve data', async t => {
  const { store, url } = await fixture(t);
  await seedDemo(store);
  const client = await connect(t, url);
  assert.equal((await client.listTools()).tools.length, 3);
  assert.equal((await client.callTool({ name: 'find_object', arguments: { object: 'keys' } })).isError, true);
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
  const email = await client.callTool({ name: 'search_messages', arguments: { query: 'Sarah dinner' } });
  assert.equal(email.structuredContent.evidence[0].source, 'email');
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
  }
});

test('frame ingestion validates JPEG and preserves newest capture', async t => {
  const { url, store } = await fixture(t);
  const headers = { Authorization: `Bearer ${config.CAMERA_TOKEN}`, 'Content-Type': 'application/json' };
  for (const timestamp of ['2026-01-02T00:00:00Z', '2026-01-01T00:00:00Z']) {
    const response = await fetch(`${url}/camera/frame`, { method: 'POST', headers,
      body: JSON.stringify({ timestamp, jpegBase64: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64') }) });
    assert.equal(response.status, 201);
    assert.equal((await response.json()).inference, 'not_configured');
  }
  assert.equal((await store.latestFrame()).timestamp, '2026-01-02T00:00:00Z');
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
