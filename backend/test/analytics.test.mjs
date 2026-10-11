import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createAnalytics, pseudonym } from '../analytics/index.mjs';
import { customEventSet } from '../analytics/keewano-events.generated.mjs';
import { createApp } from '../app.mjs';
import { testStore } from './helpers.mjs';
import { seedDemo } from '../demo.mjs';

const config = {
  DIAL_MCP_TOKEN: 'd'.repeat(64), CAMERA_TOKEN: 'c'.repeat(64),
  DEMO_CALLER_NUMBER: '+14155550123', DEMO_MODE: 'true', KEEWANO_API_KEY: 'test-key',
};

function fakeSdk() {
  const sdk = { reports: [], ready: true };
  sdk.init = async options => { sdk.options = options; };
  sdk.isReady = () => sdk.ready;
  sdk.reportUserBatch = async ({ userId, build }) => {
    build({ reportCustomEvent: ({ name, value }) => sdk.reports.push({ userId, name, value }) });
  };
  sdk.shutdown = async () => { sdk.shutdownCalled = true; };
  return sdk;
}

test('caller pseudonyms are stable UUIDs that never contain the phone number', () => {
  const id = pseudonym('secret', '+14155550123');
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(pseudonym('secret', '+14155550123'), id);
  assert.notEqual(pseudonym('other-secret', '+14155550123'), id);
  assert.notEqual(pseudonym('secret', undefined), '00000000-0000-0000-0000-000000000000');
});

test('analytics is a silent no-op without a Keewano key', async () => {
  const sdk = fakeSdk();
  const analytics = createAnalytics({ ...config, KEEWANO_API_KEY: undefined }, { sdk });
  analytics.toolCall({ caller: '+1', tool: 'find_object', ms: 1, result: { evidence: [] } });
  await analytics.shutdown();
  assert.equal(analytics.enabled, false);
  assert.equal(sdk.options, undefined);
  assert.deepEqual(sdk.reports, []);
});

test('analytics failures never reach the caller', () => {
  const sdk = fakeSdk();
  sdk.reportUserBatch = () => { throw new Error('boom'); };
  const analytics = createAnalytics(config, { sdk, log: { warn() {}, error() {} } });
  analytics.toolCall({ caller: '+1', tool: 'find_object', ms: 1, result: { evidence: [] } });
  sdk.ready = false;
  analytics.rejected({ tool: 'find_object', reason: 'unknown_caller' });
});

test('generated Keewano schema matches the committed event list', () => {
  assert.deepEqual(customEventSet.events.map(event => event.id), [2500, 2501, 2502, 2503, 2504, 2505, 2506, 2507, 2508]);
});

test('MCP tool calls report counts, latency and provenance but no personal content', async t => {
  const store = await testStore(t);
  await seedDemo(store);
  const sdk = fakeSdk();
  const analytics = createAnalytics(config, { sdk });
  const server = createApp(config, store, undefined, { analytics }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  assert.equal(sdk.options.persistent, false);
  assert.equal(createAnalytics({ ...config, KEEWANO_DATA_DIR: '/var/lib/keewano' }, { sdk }) && sdk.options.dataDir, '/var/lib/keewano');
  assert.equal(sdk.options.customEventSet, customEventSet);
  const connect = async headers => {
    const client = new Client({ name: 'analytics-check', version: '0.1.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.address().port}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${config.DIAL_MCP_TOKEN}`, ...headers } },
    }));
    t.after(() => client.close());
    return client;
  };
  const caller = await connect({ 'X-Dial-User-Number': config.DEMO_CALLER_NUMBER, 'X-Dial-Direction': 'inbound' });
  await caller.callTool({ name: 'find_object', arguments: { object: 'keys' } });
  await caller.callTool({ name: 'search_messages', arguments: { query: 'passport' } });
  const stranger = await connect({ 'X-Dial-User-Number': '+14155550999', 'X-Dial-Direction': 'inbound' });
  await stranger.callTool({ name: 'find_object', arguments: { object: 'keys' } });

  const user = pseudonym(config.DIAL_MCP_TOKEN, config.DEMO_CALLER_NUMBER);
  const byName = name => sdk.reports.filter(report => report.name === name);
  assert.deepEqual(byName('ToolCalled').map(r => [r.userId, r.value]), [[user, 'find_object'], [user, 'search_messages']]);
  assert.deepEqual(byName('EvidenceOrigin').map(r => r.value), ['find_object:demo']);
  assert.deepEqual(byName('NoEvidence').map(r => r.value), ['search_messages']);
  assert.ok(byName('ToolLatencyMs').every(r => Number.isInteger(r.value) && r.value >= 0));
  const [rejected] = byName('CallerRejected');
  assert.equal(rejected.value, 'find_object:unknown_caller');
  assert.notEqual(rejected.userId, user);
  const serialized = JSON.stringify(sdk.reports);
  for (const secret of ['4155550', 'keys', 'blue mug', 'passport', 'Sarah']) assert.ok(!serialized.includes(secret), secret);
});
