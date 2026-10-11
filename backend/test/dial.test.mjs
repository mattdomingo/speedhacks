import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { once } from 'node:events';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createApp } from '../app.mjs';
import { readConfig } from '../config.mjs';
import { createServer } from 'node:http';
import { testStore, TEST_DATABASE_URL, vercelHelpers } from './helpers.mjs';
import { seedDemo } from '../demo.mjs';
import { describeHeaders, verifyDialSignature } from '../voice/webhooks.mjs';
import { smokeObjectMemory } from '../../scripts/smoke-object-memory.mjs';
import { checkPin } from '../voice/pin.mjs';

const config = readConfig({
  DIAL_MCP_TOKEN: 'd'.repeat(64), CAMERA_TOKEN: 'c'.repeat(64), DIAL_WEBHOOK_SECRET: 'w'.repeat(32),
  DEMO_CALLER_NUMBER: '+14155550123', DEMO_MODE: 'true', DATABASE_URL: TEST_DATABASE_URL,
});

function sign(body, { secret = config.DIAL_WEBHOOK_SECRET, at = Math.floor(Date.now() / 1000) } = {}) {
  return `t=${at},v1=${createHmac('sha256', secret).update(`${at}.${body}`).digest('hex')}`;
}

async function fixture(t, overrides = {}) {
  const store = await testStore(t);
  await seedDemo(store);
  const events = [];
  const rejected = [];
  const analytics = { toolCall() {}, rejected: event => rejected.push(event), sync() {}, dialEvent: type => events.push(type) };
  const server = createApp({ ...config, ...overrides }, store, undefined, { analytics }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  return { store, events, rejected, url: `http://127.0.0.1:${server.address().port}` };
}

test('Dial signatures are verified over the raw body within the replay window', () => {
  const body = '{"id":"evt_1","type":"call.ended"}';
  assert.equal(verifyDialSignature(config.DIAL_WEBHOOK_SECRET, sign(body), Buffer.from(body)), true);
  assert.equal(verifyDialSignature(config.DIAL_WEBHOOK_SECRET, sign(body), Buffer.from(`${body} `)), false);
  assert.equal(verifyDialSignature(config.DIAL_WEBHOOK_SECRET, sign(body, { secret: 'x'.repeat(32) }), Buffer.from(body)), false);
  const stale = sign(body, { at: Math.floor(Date.now() / 1000) - 301 });
  assert.equal(verifyDialSignature(config.DIAL_WEBHOOK_SECRET, stale, Buffer.from(body)), false);
  assert.equal(verifyDialSignature(config.DIAL_WEBHOOK_SECRET, 'v1=abc,t=1', Buffer.from(body)), false);
  assert.equal(verifyDialSignature(config.DIAL_WEBHOOK_SECRET, undefined, Buffer.from(body)), false);
  const rotated = `${sign(body)},v1=${'0'.repeat(64)}`;
  assert.equal(verifyDialSignature(config.DIAL_WEBHOOK_SECRET, rotated, Buffer.from(body)), true);
});

test('Dial webhook stores signed events once and rejects forgeries', async t => {
  const { url, store, events } = await fixture(t);
  const body = JSON.stringify({ id: 'evt_1', object: 'event', type: 'call.ended', version: 1, data: { callId: 'c1' } });
  const post = (payload, signature) => fetch(`${url}/webhooks/dial`, {
    method: 'POST', body: payload, headers: { 'Content-Type': 'application/json', ...(signature ? { 'X-Dial-Signature': signature } : {}) },
  });
  assert.equal((await post(body)).status, 401);
  assert.equal((await post(body, sign(`${body}x`))).status, 401);
  const first = await post(body, sign(body));
  assert.deepEqual(await first.json(), { received: true, duplicate: false });
  const again = await post(body, sign(body));
  assert.deepEqual(await again.json(), { received: true, duplicate: true });
  assert.equal((await post('not json', sign('not json'))).status, 400);
  assert.deepEqual(events, ['call.ended']);
  assert.equal((await store.dialEvents())[0].data.callId, 'c1');
  const off = await fixture(t, { DIAL_WEBHOOK_SECRET: undefined });
  assert.equal((await fetch(`${off.url}/webhooks/dial`, { method: 'POST', body })).status, 503);
});

test('Dial header names are configurable and diagnostics redact phone numbers', async t => {
  const { url } = await fixture(t, { DIAL_CALLER_HEADER: 'x-caller', DIAL_DIRECTION_HEADER: 'x-call-direction' });
  const client = new Client({ name: 'dial-check', version: '0.1.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: {
    Authorization: `Bearer ${config.DIAL_MCP_TOKEN}`, 'X-Caller': config.DEMO_CALLER_NUMBER, 'X-Call-Direction': 'inbound',
  } } }));
  t.after(() => client.close());
  const keys = await client.callTool({ name: 'find_object', arguments: { object: 'keys' } });
  assert.equal(keys.structuredContent.status, 'supported');

  const described = describeHeaders({
    authorization: 'Bearer secret', 'x-dial-user-number': '+14155550123', 'x-dial-call-id': 'call_abc',
    'x-dial-direction': 'inbound', 'x-dial-caller-name': 'Jane Doe', accept: '*/*',
  });
  assert.equal(described, 'accept, authorization, x-dial-call-id=<8 chars>, x-dial-caller-name=<8 chars>, ' +
    'x-dial-direction=inbound, x-dial-user-number=…0123');
  assert.ok(!described.includes('Jane'));
  assert.ok(!described.includes('secret'));
});

test('with CALLER_PIN set, spoofed caller ID alone retrieves nothing and guessing locks out', async t => {
  const { url, rejected } = await fixture(t, { CALLER_PIN: '4821' });
  const client = new Client({ name: 'pin-check', version: '0.1.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: {
    Authorization: `Bearer ${config.DIAL_MCP_TOKEN}`, 'X-Dial-User-Number': config.DEMO_CALLER_NUMBER, 'X-Dial-Direction': 'inbound',
  } } }));
  t.after(() => client.close());
  const find = pin => client.callTool({ name: 'find_object', arguments: { object: 'keys', ...(pin ? { pin } : {}) } });
  const missing = await find();
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /PIN is required/);
  assert.equal((await find('4821')).structuredContent.status, 'supported');
  for (let i = 0; i < 5; i++) assert.match((await find('0000')).content[0].text, /not correct/);
  const locked = await find('4821');
  assert.equal(locked.isError, true);
  assert.match(locked.content[0].text, /Too many wrong PIN attempts/);
  assert.ok(!JSON.stringify(locked).includes('keys'));
  assert.deepEqual([...new Set(rejected.map(r => r.reason))], ['pin_missing', 'pin_wrong', 'pin_locked']);
  assert.ok(!JSON.stringify(rejected).includes('4821'));
});

test('behind Vercel request helpers, signed webhooks and JSON routes still work', async t => {
  const { store } = await fixture(t);
  const app = createApp(config, store, undefined, { analytics: { toolCall() {}, rejected() {}, sync() {}, dialEvent() {} } });
  const server = createServer(vercelHelpers(app)).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const body = JSON.stringify({ id: 'evt_vercel', type: 'call.transcribed' });
  const hook = await fetch(`${url}/webhooks/dial`, { method: 'POST', body,
    headers: { 'Content-Type': 'application/json', 'X-Dial-Signature': sign(body) } });
  assert.deepEqual(await hook.json(), { received: true, duplicate: false });
  const camera = { Authorization: `Bearer ${config.CAMERA_TOKEN}`, 'Content-Type': 'application/json' };
  const observation = await fetch(`${url}/camera/observations`, { method: 'POST', headers: camera,
    body: JSON.stringify({ object: 'wallet', location: 'hall table', timestamp: '2026-01-01T00:00:00Z' }) });
  assert.equal(observation.status, 201);
  const malformed = await fetch(`${url}/camera/observations`, { method: 'POST', headers: camera, body: '{not json' });
  assert.equal(malformed.status, 400);
});

test('the MCP smoke client keeps working when the backend requires a PIN', async t => {
  const { url } = await fixture(t, { CALLER_PIN: '4821', DEMO_MODE: 'false' });
  await assert.rejects(smokeObjectMemory(url, config.DIAL_MCP_TOKEN, config.DEMO_CALLER_NUMBER), /returned an error/);
  const results = await smokeObjectMemory(url, config.DIAL_MCP_TOKEN, config.DEMO_CALLER_NUMBER, '4821');
  assert.deepEqual(Object.keys(results), ['my keys', 'cellphone', 'wallet']);
});

test('concurrent PIN guesses are counted before comparison, across instances', async t => {
  const store = await testStore(t);
  const second = store.reopen();
  t.after(() => second.close());
  const guesses = Array.from({ length: 20 }, (_, i) => checkPin(i % 2 ? store : second, '4821', config.DEMO_CALLER_NUMBER, String(1000 + i)));
  const outcomes = await Promise.all(guesses);
  assert.ok(outcomes.filter(outcome => outcome === 'pin_wrong').length <= 5);
  assert.equal(outcomes.filter(outcome => outcome !== 'pin_wrong' && outcome !== 'pin_locked').length, 0);
  assert.equal(await checkPin(store, '4821', config.DEMO_CALLER_NUMBER, '4821'), 'pin_locked');
  assert.equal(await checkPin(store, '4821', '+14155550999', '4821'), null, 'other callers are unaffected');
});

test('MCP rejects batched requests and hides PIN-check database errors', async t => {
  const { url, store } = await fixture(t, { CALLER_PIN: '4821' });
  const headers = { Authorization: `Bearer ${config.DIAL_MCP_TOKEN}`, 'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream', 'X-Dial-User-Number': config.DEMO_CALLER_NUMBER, 'X-Dial-Direction': 'inbound' };
  const call = (id, pin) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'find_object', arguments: { object: 'keys', pin } } });
  const batch = await fetch(`${url}/mcp`, { method: 'POST', headers, body: JSON.stringify([call(1, '1000'), call(2, '1001')]) });
  assert.equal(batch.status, 400);
  await store.sql('DROP TABLE caller_pin_failure');
  const broken = await fetch(`${url}/mcp`, { method: 'POST', headers, body: JSON.stringify(call(3, '4821')) });
  const { result } = await broken.json();
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /^Memory lookup failed/);
  assert.ok(!/caller_pin_failure|relation|table/i.test(result.content[0].text));
});

test('the cron prunes expired Dial events even after webhooks are switched off', async t => {
  const { url, store } = await fixture(t, { DIAL_WEBHOOK_SECRET: undefined, CRON_SECRET: 'r'.repeat(64) });
  await store.recordDialEvent({ id: 'old', type: 'call.transcribed' }, 30);
  await store.recordDialEvent({ id: 'new', type: 'call.ended' }, 30);
  const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
  await store.sql(`UPDATE dial_event SET received_at = ${store.adapter === 'sqlite' ? '?' : '$1'} WHERE id = 'old'`, [old]);
  const cron = await fetch(`${url}/cron/google-sync`, { headers: { Authorization: `Bearer ${'r'.repeat(64)}` } });
  assert.equal((await cron.json()).prunedDialEvents, 1);
  assert.deepEqual((await store.dialEvents()).map(event => event.id), ['new']);
});
