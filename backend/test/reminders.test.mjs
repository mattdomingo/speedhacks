import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { createHmac, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { Client as PostgresClient } from 'pg';
import { createApp } from '../app.mjs';
import { readConfig } from '../config.mjs';
import { openStore } from '../store.mjs';
import { openPostgresStore } from '../postgres.mjs';
import { ReminderError, spokenTime, zonedTime } from '../voice/reminders.mjs';
import { verifyDialSignature } from '../voice/dial.mjs';

const PATIENT = '+14155550123';
const STEPH = '+12408962183';
const config = {
  DIAL_MCP_TOKEN: 'd'.repeat(64), CAMERA_TOKEN: 'c'.repeat(64), CRON_SECRET: 'r'.repeat(64),
  DIAL_API_KEY: 'sk_test', DIAL_WEBHOOK_SECRET: 'whsec_test', DEMO_CALLER_NUMBER: PATIENT, DEMO_MODE: 'false',
  STEPH_NUMBER: STEPH, PATIENT_TIME_ZONE: 'America/Los_Angeles',
};
const START = Date.parse('2026-10-11T20:00:00Z');

function fakeDial() {
  const dial = {
    calls: [], texts: [], callStatus: {}, failCall: null, failText: null,
    async placeCall(args) {
      dial.calls.push(args);
      if (dial.failCall) throw dial.failCall;
      return { id: `call-${dial.calls.length}` };
    },
    async getCall(id) { return { id, status: dial.callStatus[id] }; },
    async sendText(args) {
      dial.texts.push(args);
      if (dial.failText) throw dial.failText;
      return { id: `msg-${dial.texts.length}` };
    },
  };
  return dial;
}

async function fixture(t, overrides = {}) {
  let store;
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
    store = openPostgresStore(databaseUrl.toString());
  } else {
    const dir = mkdtempSync(join(tmpdir(), 'speedhacks-reminders-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    store = openStore(dir);
  }
  const clock = { now: START };
  const dial = fakeDial();
  const server = createApp({ ...config, ...overrides }, store, undefined, { dial, now: () => clock.now })
    .listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await store.close();
  });
  return { store, dial, clock, url: `http://127.0.0.1:${server.address().port}` };
}

async function connect(t, url, headers) {
  const client = new Client({ name: 'reminder-check', version: '0.1.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${config.DIAL_MCP_TOKEN}`, ...headers } },
  }));
  t.after(() => client.close());
  return client;
}

const onCall = (direction = 'inbound') => ({
  'X-Dial-User-Number': PATIENT, 'X-Dial-Direction': direction, 'X-Dial-Agent-Number': STEPH,
});
const dispatch = url => fetch(`${url}/dial/dispatch`, { headers: { Authorization: `Bearer ${config.CRON_SECRET}` } });

function webhook(url, event, { id = event.id, secret = config.DIAL_WEBHOOK_SECRET, t = Math.floor(Date.now() / 1000) } = {}) {
  const body = JSON.stringify(event);
  const v1 = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  return fetch(`${url}/dial/webhook`, {
    method: 'POST', body,
    headers: { 'Content-Type': 'application/json', 'X-Dial-Event-ID': id, 'X-Dial-Signature': `t=${t},v1=${v1}` },
  });
}
const ended = (callId, status, id = `evt-${callId}-${status}`) => ({
  id, object: 'event', type: 'call.ended', data: { callId, status, direction: 'outbound', durationSeconds: 12 },
});

test('local reminder times convert through daylight saving and reject impossible dates', () => {
  const zone = 'America/Los_Angeles';
  assert.equal(new Date(zonedTime('2026-10-11T15:00', zone)).toISOString(), '2026-10-11T22:00:00.000Z');
  assert.equal(new Date(zonedTime('2026-01-15T09:00', zone)).toISOString(), '2026-01-15T17:00:00.000Z');
  assert.throws(() => zonedTime('2026-02-30T10:00', zone), ReminderError);
  assert.equal(spokenTime(Date.parse('2026-10-11T22:05:00Z'), zone), 'Sunday, October 11 at 3:05 PM');
});

test('configuration defaults to Steph\'s line and keeps the cron secret separate', () => {
  const base = { DIAL_MCP_TOKEN: config.DIAL_MCP_TOKEN, CAMERA_TOKEN: config.CAMERA_TOKEN };
  assert.equal(readConfig(base).STEPH_NUMBER, STEPH);
  assert.equal(readConfig(base).PATIENT_TIME_ZONE, 'America/Los_Angeles');
  assert.throws(() => readConfig({ ...base, CRON_SECRET: config.CAMERA_TOKEN }), /cron secret/);
  assert.throws(() => readConfig({ ...base, PATIENT_TIME_ZONE: 'Mars/Olympus' }));
});

test('the caller sets, lists and cancels their own reminders by phone', async t => {
  const { url } = await fixture(t);
  const client = await connect(t, url, onCall());
  const today = await client.callTool({ name: 'whats_today', arguments: {} });
  assert.deepEqual(today.structuredContent, {
    now: 'Sunday, October 11 at 1:00 PM', date: '2026-10-11', time: '13:00', time_zone: 'America/Los_Angeles',
  });
  const set = await client.callTool({ name: 'set_reminder', arguments: { text: 'Call Sarah back', at: '2026-10-11T15:00' } });
  assert.equal(set.isError, undefined);
  assert.equal(set.structuredContent.reminder.spoken_time, 'Sunday, October 11 at 3:00 PM');
  assert.equal(set.structuredContent.reminder.due_at, '2026-10-11T22:00:00.000Z');
  await client.callTool({ name: 'set_reminder', arguments: { text: 'Drink water', in_minutes: 10, channel: 'text' } });
  const listed = (await client.callTool({ name: 'list_reminders', arguments: {} })).structuredContent;
  assert.equal(listed.status, 'supported');
  assert.deepEqual(listed.evidence.map(item => [item.text, item.channel, item.source]),
    [['Drink water', 'text', 'reminder'], ['Call Sarah back', 'call', 'reminder']]);
  const id = set.structuredContent.reminder.id;
  assert.equal((await client.callTool({ name: 'cancel_reminder', arguments: { id } })).structuredContent.status, 'canceled');
  assert.equal((await client.callTool({ name: 'cancel_reminder', arguments: { id } })).isError, true);
  assert.equal((await client.callTool({ name: 'list_reminders', arguments: {} })).structuredContent.evidence.length, 1);
});

test('reminder requests that cannot be honored come back as spoken errors', async t => {
  const { url } = await fixture(t);
  const client = await connect(t, url, onCall());
  for (const args of [
    { text: 'x', at: '2026-10-11T12:00' },
    { text: 'x', at: '2026-10-11T15:00', in_minutes: 5 },
    { text: 'x' },
    { text: 'x', at: '2026-12-25T09:00' },
  ]) {
    const reply = await client.callTool({ name: 'set_reminder', arguments: args });
    assert.equal(reply.isError, true, JSON.stringify(args));
    assert.doesNotMatch(reply.content[0].text, /Internal|Error:/);
  }
  const { url: offUrl } = await fixture(t, { DIAL_API_KEY: '' });
  const off = await connect(t, offUrl, onCall());
  const reply = await off.callTool({ name: 'set_reminder', arguments: { text: 'x', in_minutes: 5 } });
  assert.match(reply.content[0].text, /not switched on/);
});

test('reminder tools need the allowlisted caller on Steph\'s line; memories stay inbound-only', async t => {
  const { url } = await fixture(t);
  for (const headers of [
    { ...onCall(), 'X-Dial-User-Number': '+14155550999' },
    { 'X-Dial-User-Number': PATIENT, 'X-Dial-Direction': 'inbound' },
    { ...onCall(), 'X-Dial-Agent-Number': '+14155550100' },
    { ...onCall(), 'X-Dial-Direction': '{{direction}}' },
  ]) {
    const client = await connect(t, url, headers);
    assert.equal((await client.callTool({ name: 'set_reminder', arguments: { text: 'x', in_minutes: 5 } })).isError, true);
  }
  const outbound = await connect(t, url, onCall('outbound'));
  assert.equal((await outbound.callTool({ name: 'set_reminder', arguments: { text: 'Again', in_minutes: 10 } })).isError, undefined);
  assert.equal((await outbound.callTool({ name: 'find_object', arguments: { object: 'keys' } })).isError, true);
});

test('dispatch is cron-authenticated and calls once per due reminder', async t => {
  const { url, dial, clock, store } = await fixture(t);
  assert.equal((await fetch(`${url}/dial/dispatch`)).status, 401);
  assert.equal((await fetch(`${url}/dial/dispatch`, { headers: { Authorization: `Bearer ${config.DIAL_MCP_TOKEN}` } })).status, 401);
  const client = await connect(t, url, onCall());
  await client.callTool({ name: 'set_reminder', arguments: { text: 'Take the <b>blue</b> pill', in_minutes: 5 } });
  assert.deepEqual(await (await dispatch(url)).json(), { called: 0, texted: 0, failed: 0, settled: 0 });
  clock.now += 5 * 60_000;
  assert.deepEqual(await (await dispatch(url)).json(), { called: 1, texted: 0, failed: 0, settled: 0 });
  assert.equal((await (await dispatch(url)).json()).called, 0);
  assert.equal(dial.calls.length, 1);
  const [call] = dial.calls;
  assert.equal(call.to, PATIENT);
  assert.equal(call.from, STEPH);
  assert.match(call.idempotencyKey, /^reminder-[0-9a-f-]{36}$/);
  assert.match(call.instruction, /<reminder>Take the bblue\/b pill<\/reminder>/);
  assert.match(call.instruction, /AI assistant/);
  assert.equal((await store.reminderByCall('call-1')).status, 'calling');
  const { url: offUrl } = await fixture(t, { CRON_SECRET: '' });
  assert.equal((await dispatch(offUrl)).status, 503);
});

test('signed call outcomes settle reminders once and text after a missed call', async t => {
  const { url, dial, clock, store } = await fixture(t);
  const client = await connect(t, url, onCall());
  await client.callTool({ name: 'set_reminder', arguments: { text: 'Feed the cat', in_minutes: 1 } });
  await client.callTool({ name: 'set_reminder', arguments: { text: 'Lock the door', in_minutes: 1 } });
  clock.now += 60_000;
  await dispatch(url);
  assert.equal((await webhook(url, ended('call-1', 'no-answer'), { secret: 'wrong' })).status, 401);
  assert.equal((await webhook(url, ended('call-1', 'no-answer'), { t: Math.floor(Date.now() / 1000) - 600 })).status, 401);
  assert.deepEqual(await (await webhook(url, ended('call-1', 'no-answer'))).json(), { ok: true });
  assert.deepEqual(await (await webhook(url, ended('call-1', 'no-answer'))).json(), { ok: true, duplicate: true });
  assert.equal((await webhook(url, ended('call-1', 'no-answer', 'evt-redelivered'))).status, 200);
  assert.equal(dial.texts.length, 1);
  assert.equal(dial.texts[0].to, PATIENT);
  assert.equal(dial.texts[0].from, STEPH);
  const missed = await store.reminderByCall('call-1');
  assert.equal(missed.status, 'missed');
  assert.equal(missed.outcome, 'no-answer; texted');
  await webhook(url, ended('call-2', 'completed'));
  assert.equal((await store.reminderByCall('call-2')).status, 'delivered');
  assert.equal(dial.texts.length, 1);
  assert.equal((await webhook(url, { id: 'evt-ping', type: 'webhook.ping', data: {} })).status, 200);
});

test('webhook signatures cover the exact bytes and a fresh timestamp', () => {
  const body = Buffer.from('{"id":"evt"}');
  const t = 1_800_000_000;
  const v1 = createHmac('sha256', 'secret').update(`${t}.`).update(body).digest('hex');
  assert.equal(verifyDialSignature('secret', `t=${t},v1=${v1}`, body, t * 1000), true);
  assert.equal(verifyDialSignature('secret', `t=${t},v1=${v1}`, Buffer.from('{"id":"evt" }'), t * 1000), false);
  assert.equal(verifyDialSignature('secret', `t=${t},v1=${v1}`, body, (t + 301) * 1000), false);
  assert.equal(verifyDialSignature('secret', 'garbage', body, t * 1000), false);
  assert.equal(verifyDialSignature('secret', undefined, body, t * 1000), false);
});

test('text reminders send once and are never retried after a failure', async t => {
  const { url, dial, clock, store } = await fixture(t);
  const client = await connect(t, url, onCall());
  await client.callTool({ name: 'set_reminder', arguments: { text: 'Garden club at 4', in_minutes: 1, channel: 'text' } });
  await client.callTool({ name: 'set_reminder', arguments: { text: 'Bring umbrella', in_minutes: 2, channel: 'text' } });
  clock.now += 60_000;
  assert.equal((await (await dispatch(url)).json()).texted, 1);
  assert.equal(dial.texts[0].body, 'Steph (AI assistant) reminder: Garden club at 4');
  dial.failText = Object.assign(new Error('Dial POST messages failed with 500'), { status: 500 });
  clock.now += 60_000;
  assert.equal((await (await dispatch(url)).json()).failed, 1);
  clock.now += 10 * 60_000;
  await dispatch(url);
  assert.equal(dial.texts.length, 2);
  assert.equal((await store.upcomingReminders(PATIENT)).length, 0);
});

test('transient call failures retry with the same idempotency key, then give up', async t => {
  const { url, dial, clock } = await fixture(t);
  const client = await connect(t, url, onCall());
  await client.callTool({ name: 'set_reminder', arguments: { text: 'Doctor at 3', in_minutes: 1 } });
  dial.failCall = Object.assign(new Error('Dial POST calls failed with 503'), { status: 503 });
  clock.now += 60_000;
  await dispatch(url);
  await dispatch(url);
  assert.equal(dial.calls.length, 1, 'a held lease blocks an immediate retry');
  for (let i = 0; i < 4; i++) {
    clock.now += 3 * 60_000;
    await dispatch(url);
  }
  assert.equal(dial.calls.length, 3);
  assert.equal(new Set(dial.calls.map(call => call.idempotencyKey)).size, 1);
});

test('permanent call rejections fail without retrying', async t => {
  const { url, dial, clock } = await fixture(t);
  const client = await connect(t, url, onCall());
  await client.callTool({ name: 'set_reminder', arguments: { text: 'Pay rent', in_minutes: 1 } });
  dial.failCall = Object.assign(new Error('Dial POST calls failed with 402'), { status: 402 });
  clock.now += 60_000;
  await dispatch(url);
  clock.now += 10 * 60_000;
  await dispatch(url);
  assert.equal(dial.calls.length, 1);
});

test('a lost webhook is reconciled from Dial\'s call status before any fallback', async t => {
  const { url, dial, clock, store } = await fixture(t);
  const client = await connect(t, url, onCall());
  await client.callTool({ name: 'set_reminder', arguments: { text: 'Walk the dog', in_minutes: 1 } });
  clock.now += 60_000;
  await dispatch(url);
  dial.callStatus['call-1'] = { state: 'In-Progress', terminationType: null };
  clock.now += 11 * 60_000;
  assert.equal((await (await dispatch(url)).json()).settled, 0);
  assert.equal(dial.texts.length, 0);
  dial.callStatus['call-1'] = { state: 'Terminated', terminationType: 'busy' };
  assert.equal((await (await dispatch(url)).json()).settled, 1);
  assert.equal((await store.reminderByCall('call-1')).outcome, 'busy; texted');
  assert.equal(dial.texts.length, 1);
});
