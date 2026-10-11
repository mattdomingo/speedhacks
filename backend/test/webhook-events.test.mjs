import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { once } from 'node:events';
import { createApp } from '../app.mjs';
import { readConfig } from '../config.mjs';
import { testStore, TEST_DATABASE_URL } from './helpers.mjs';

const PATIENT = '+14155550123';
const OTHER = '+14155550999';
const STEPH = '+12408962183';
const SECRET = 'w'.repeat(32);
const config = readConfig({
  DIAL_MCP_TOKEN: 'd'.repeat(64), CAMERA_TOKEN: 'c'.repeat(64), DIAL_WEBHOOK_SECRET: SECRET, DIAL_API_KEY: 'sk_test',
  DEMO_CALLER_NUMBER: PATIENT, CAREGIVER_NUMBER: '+14155550100', TIMEZONE: 'America/Los_Angeles', DATABASE_URL: TEST_DATABASE_URL,
});
const NO_ANALYTICS = { toolCall() {}, rejected() {}, sync() {}, dialEvent() {} };

function fakeDial() {
  const dial = {
    getCalls: 0, texts: [], calls: {},
    async getCall(id) {
      dial.getCalls++;
      if (dial.down) throw Object.assign(new Error('Dial GET calls did not complete (TypeError)'), {});
      return dial.calls[id] ?? null;
    },
    async placeCall() { throw new Error('not used'); },
    async sendText(args) { dial.texts.push(args); return { id: 'm' }; },
    async listCalls() { return []; },
    async listMessages() { return []; },
  };
  return dial;
}

async function fixture(t) {
  const store = await testStore(t);
  const dial = fakeDial();
  const server = createApp(config, store, undefined, { dial, analytics: NO_ANALYTICS }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  return { store, dial, url: `http://127.0.0.1:${server.address().port}` };
}

const sign = (body, { secret = SECRET, at = Math.floor(Date.now() / 1000) } = {}) =>
  `t=${at},v1=${createHmac('sha256', secret).update(`${at}.${body}`).digest('hex')}`;

function deliver(url, event, { body = JSON.stringify(event), signature = sign(body), eventId = event.id, headers = {} } = {}) {
  return fetch(`${url}/webhooks/dial`, {
    method: 'POST', body,
    headers: { 'Content-Type': 'application/json', ...(signature ? { 'X-Dial-Signature': signature } : {}),
      ...(eventId ? { 'X-Dial-Event-ID': eventId } : {}), ...headers },
  });
}

const transcribed = (callId, id = `evt-tr-${callId}`) => ({
  id, object: 'event', type: 'call.transcribed', createdAt: '2026-10-11T22:00:00Z', data: { callId },
});
const ended = (callId, status, extra = {}, id = `evt-end-${callId}`) => ({
  id, object: 'event', type: 'call.ended', createdAt: '2026-10-11T22:00:00Z',
  data: { callId, from: STEPH, to: PATIENT, direction: 'outbound', status, canceled: false, durationSeconds: null,
    transcriptAvailable: false, ...extra },
});
const inboundCall = (id, turns) => ({
  id, from: PATIENT, to: STEPH, direction: 'inbound', duration: 47, createdAt: '2026-10-11T21:59:00Z',
  transcriptTurns: turns.map(([speaker, text], index) => ({ speaker, text, startMs: index * 1000, endMs: index * 1000 + 900 })),
});

async function snapshot(store) {
  const evidence = (await Promise.all(['call', 'call_log', 'caregiver_flag', 'text'].map(source => store.list(source)))).flat();
  return JSON.stringify({ events: await store.dialEvents(100), evidence });
}

test('forged, tampered, re-serialized, stale and unsigned deliveries are rejected with no side effects', async t => {
  const { url, store, dial } = await fixture(t);
  dial.calls.c1 = inboundCall('c1', [['user', 'Where are my keys?']]);
  const event = transcribed('c1');
  const body = JSON.stringify(event);
  const before = await snapshot(store);
  const attempts = {
    'wrong secret': deliver(url, event, { signature: sign(body, { secret: 'x'.repeat(32) }) }),
    'tampered body': deliver(url, event, { body: body.replace('c1', 'c2'), signature: sign(body) }),
    're-serialized body': deliver(url, event, { body: JSON.stringify(event, null, 2), signature: sign(body) }),
    'timestamp over 5 minutes old': deliver(url, event, { signature: sign(body, { at: Math.floor(Date.now() / 1000) - 301 }) }),
    'missing signature header': deliver(url, event, { signature: null }),
    'event id header mismatch': deliver(url, event, { eventId: 'evt-other' }),
  };
  for (const [name, attempt] of Object.entries(attempts)) {
    const status = (await attempt).status;
    assert.ok(status >= 400 && status < 500, `${name}: ${status}`);
  }
  assert.equal(await snapshot(store), before);
  assert.equal(dial.getCalls, 0);
});

test('a duplicate delivery and six retries of one event are processed exactly once', async t => {
  const { url, store, dial } = await fixture(t);
  dial.calls.c1 = inboundCall('c1', [['agent', 'Hi, I am Steph, an AI assistant.'], ['user', 'Where are my keys?'], ['user', 'Thanks!']]);
  const replies = [];
  for (let attempt = 0; attempt < 7; attempt++) replies.push(await (await deliver(url, transcribed('c1'))).json());
  assert.deepEqual(replies.map(reply => reply.duplicate), [false, true, true, true, true, true, true]);
  assert.equal(dial.getCalls, 1);
  assert.deepEqual((await store.list('call')).map(record => record.text).sort(), ['Thanks!', 'Where are my keys?']);
  assert.equal((await store.list('call_log')).length, 1);
});

test('a failed side effect answers 500 so Dial retries, and the retry completes it once', async t => {
  const { url, store, dial } = await fixture(t);
  dial.calls.c1 = inboundCall('c1', [['user', 'What day is it?']]);
  dial.down = true;
  assert.equal((await deliver(url, transcribed('c1'))).status, 500);
  assert.equal((await store.list('call')).length, 0);
  dial.down = false;
  assert.equal((await deliver(url, transcribed('c1'))).status, 200);
  assert.equal((await deliver(url, transcribed('c1'))).status, 200);
  assert.equal((await store.list('call')).length, 1);
  assert.equal(dial.getCalls, 2);
});

test('call.transcribed before call.ended is handled; both orders store the transcript once', async t => {
  const { url, store, dial } = await fixture(t);
  dial.calls.c1 = { ...inboundCall('c1', [['user', 'Who is coming today?']]), direction: 'outbound', from: STEPH, to: PATIENT };
  assert.equal((await deliver(url, transcribed('c1'))).status, 200);
  assert.equal((await deliver(url, ended('c1', 'completed', { transcriptAvailable: true }))).status, 200);
  assert.deepEqual((await store.list('call')).map(record => [record.text, record.patient]), [['Who is coming today?', PATIENT]]);
  assert.equal((await store.list('caregiver_flag')).length, 0);
});

test('unanswered, cancelled and failed calls end without a transcript, flag a missed call, and never crash', async t => {
  const { url, store } = await fixture(t);
  for (const status of ['no-answer', 'busy', 'failed', 'canceled']) {
    const response = await deliver(url, ended(`c-${status}`, status, status === 'canceled' ? { canceled: true } : {}));
    assert.equal(response.status, 200, status);
  }
  // Redelivery adds nothing; a call to a stranger and an inbound call are not caregiver concerns.
  await deliver(url, ended('c-no-answer', 'no-answer', {}, 'evt-redelivered'));
  await deliver(url, ended('c-stranger', 'no-answer', { to: OTHER }));
  await deliver(url, ended('c-inbound', 'no-answer', { direction: 'inbound', from: PATIENT, to: STEPH }));
  const flags = await store.list('caregiver_flag');
  assert.deepEqual(flags.map(flag => flag.status).sort(), ['busy', 'canceled', 'failed', 'no-answer']);
  assert.ok(flags.every(flag => flag.patient === PATIENT && flag.kind === 'missed_call'));
});

test('texts from a known patient become evidence; strangers, groups, pings and unknown types change nothing', async t => {
  const { url, store } = await fixture(t);
  const message = (id, data) => ({ id, type: 'message.received', createdAt: '2026-10-11T22:00:00Z',
    data: { messageId: id, from: PATIENT, to: STEPH, channel: 'sms', groupId: null, body: 'I put my passport in the desk drawer', ...data } });
  for (const event of [
    message('m1'),
    message('m2', { from: OTHER }),
    message('m3', { groupId: 'grp_1', to: null }),
    message('m4', { to: '+14155550000' }),
    { id: 'evt-ping', object: 'event', type: 'webhook.ping', version: 1, createdAt: '2026-10-11T22:00:00Z', relatedObject: null, data: {} },
    { id: 'evt-future', type: 'number.status_changed', data: { status: 'ready' } },
  ]) assert.equal((await deliver(url, event)).status, 200, event.id);
  assert.deepEqual((await store.list('text')).map(record => [record.id, record.patient]), [['text-m1', PATIENT]]);
});

test('burst: 500 deliveries in under 10 s with ~30% duplicates are all acknowledged and each event is handled once', async t => {
  const { url, store, dial } = await fixture(t);
  const unique = 350;
  for (let index = 0; index < unique; index++) dial.calls[`b${index}`] = inboundCall(`b${index}`, [['user', `burst ${index}`]]);
  const deliveries = Array.from({ length: 500 }, (_, index) => transcribed(`b${index < unique ? index : (index * 7) % unique}`));
  const started = performance.now();
  const statuses = [];
  // 25 at a time, like a provider's concurrent retry workers.
  for (let offset = 0; offset < deliveries.length; offset += 25) {
    statuses.push(...await Promise.all(deliveries.slice(offset, offset + 25).map(async event => (await deliver(url, event)).status)));
  }
  const seconds = (performance.now() - started) / 1000;
  t.diagnostic(`webhook burst: 500 deliveries (${unique} unique) in ${seconds.toFixed(2)} s`);
  assert.ok(seconds < 10, `${seconds} s`);
  assert.ok(statuses.every(status => status === 200));
  assert.equal(new Set((await store.list('call')).map(record => record.text)).size, unique);
  assert.equal((await store.list('call')).length, unique);
  assert.ok(dial.getCalls >= unique && dial.getCalls <= unique + 150, `${dial.getCalls} transcript fetches`);
});
