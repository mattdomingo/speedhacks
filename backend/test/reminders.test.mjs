import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { once } from 'node:events';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createApp } from '../app.mjs';
import { readConfig } from '../config.mjs';
import { localInstant } from '../time.mjs';
import { spokenTime } from '../voice/reminders.mjs';
import { createDial } from '../voice/dial.mjs';
import { PHONE_STYLE } from '../voice/phone-style.mjs';
import { testStore, TEST_DATABASE_URL } from './helpers.mjs';

const PATIENT = '+14155550123';
const STEPH = '+12408962183';
const config = readConfig({
  DIAL_MCP_TOKEN: 'd'.repeat(64), CAMERA_TOKEN: 'c'.repeat(64), CRON_SECRET: 'r'.repeat(64),
  DIAL_API_KEY: 'sk_test', DIAL_WEBHOOK_SECRET: 'w'.repeat(32), DEMO_CALLER_NUMBER: PATIENT, DEMO_MODE: 'false',
  TIMEZONE: 'America/Los_Angeles', DATABASE_URL: TEST_DATABASE_URL,
});
const NO_ANALYTICS = { toolCall() {}, rejected() {}, sync() {}, dialEvent() {} };
const START = Date.parse('2026-10-11T20:00:00Z');

function fakeDial() {
  const dial = {
    calls: [], texts: [], polls: [], callStatus: {}, messages: {}, failCall: null, failText: null,
    async placeCall(args) {
      dial.calls.push(args);
      if (dial.failCall) throw dial.failCall;
      return { id: `call-${dial.calls.length}` };
    },
    async getCall(id) { return { id, status: dial.callStatus[id] }; },
    // Dial's view of calls actually placed (for lookups after an ambiguous failure).
    placed: [], lookups: 0,
    async listCalls() { dial.lookups++; return [...dial.placed].reverse(); },
    async listMessages() { return []; },
    async sendText(args) {
      dial.texts.push(args);
      if (dial.failText) throw dial.failText;
      const message = { id: `msg-${dial.texts.length}`, direction: 'outbound', deliveryState: 'pending' };
      dial.messages[message.id] = message;
      await dial.onSend?.(message);
      return dial.sendResponse ?? message;
    },
    async getMessage(id, args) {
      dial.polls.push({ id, ...args });
      if (dial.failPoll) throw dial.failPoll;
      const message = dial.messages[id];
      await dial.onPoll?.(message);
      return dial.omitMessages ? undefined : message;
    },
  };
  return dial;
}

async function fixture(t, overrides = {}) {
  const store = await testStore(t);
  const clock = { now: START };
  const dial = fakeDial();
  const server = createApp({ ...config, ...overrides }, store, undefined,
    { dial, now: () => clock.now, analytics: NO_ANALYTICS }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
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
const dispatch = url => fetch(`${url}/cron/dial-reminders`, { headers: { Authorization: `Bearer ${config.CRON_SECRET}` } });

function webhook(url, event, { secret = config.DIAL_WEBHOOK_SECRET, t = Math.floor(Date.now() / 1000) } = {}) {
  const body = JSON.stringify(event);
  const v1 = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  return fetch(`${url}/webhooks/dial`, {
    method: 'POST', body,
    headers: { 'Content-Type': 'application/json', 'X-Dial-Event-ID': event.id, 'X-Dial-Signature': `t=${t},v1=${v1}` },
  });
}
const ended = (callId, status, id = `evt-${callId}-${status}`) => ({
  id, object: 'event', type: 'call.ended', data: { callId, status, direction: 'outbound', durationSeconds: 12 },
});
const messageEvent = (messageId, deliveryState, id = `evt-${messageId}-${deliveryState}`, extra = {}) => ({
  id, object: 'event', type: 'message.status_changed',
  data: { messageId, deliveryState, changed: 'delivery', readState: 'unsupported', ...extra },
});
async function reminderRow(store, id) {
  return store.db ? store.db.prepare('SELECT * FROM reminders WHERE id = ?').get(id)
    : (await store.sql('SELECT * FROM reminders WHERE id = $1', [id])).rows[0];
}
async function setText(client, text = 'Synthetic reminder') {
  const reply = await client.callTool({ name: 'set_reminder', arguments: { text, in_minutes: 1, channel: 'text' } });
  assert.equal(reply.isError, undefined);
  return reply.structuredContent.reminder.id;
}

test('local reminder times convert through daylight saving and reject impossible dates', () => {
  const zone = 'America/Los_Angeles';
  assert.equal(localInstant('2026-10-11T15:00', zone).toISOString(), '2026-10-11T22:00:00.000Z');
  assert.equal(localInstant('2026-01-15T09:00', zone).toISOString(), '2026-01-15T17:00:00.000Z');
  assert.equal(localInstant('2026-03-08T03:30', zone).toISOString(), '2026-03-08T10:30:00.000Z');
  assert.equal(localInstant('2026-02-30T10:00', zone), null);
  assert.equal(spokenTime(Date.parse('2026-10-11T22:05:00Z'), zone), 'Sunday, October 11 at 3:05 PM');
});

test('configuration defaults to Steph\'s line and keeps reminders off without a Dial key', () => {
  const base = readConfig({ DIAL_MCP_TOKEN: config.DIAL_MCP_TOKEN, CAMERA_TOKEN: config.CAMERA_TOKEN, DIAL_API_KEY: '' });
  assert.equal(base.STEPH_NUMBER, STEPH);
  assert.equal(base.DIAL_API_KEY, undefined);
  assert.throws(() => readConfig({ ...config, STEPH_NUMBER: '2408962183' }));
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

test('reminder requests that cannot be honored come back as spoken errors; reminders stay off without Dial', async t => {
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
  const { url: offUrl, store } = await fixture(t, { DIAL_API_KEY: undefined });
  const off = await connect(t, offUrl, onCall());
  assert.deepEqual((await off.listTools()).tools.map(tool => tool.name),
    ['get_schedule', 'search_messages', 'find_object', 'who_is', 'care_instructions']);
  // Without Dial, webhooks never read the reminders table, which may not exist yet.
  store.reminderByCall = () => { throw new Error('reminders table read'); };
  assert.equal((await webhook(offUrl, ended('call-x', 'completed'))).status, 200);
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

test('reminders fail closed on PIN storage errors while the clock stays available', async t => {
  const { url, store } = await fixture(t, { CALLER_PIN: '4821' });
  const client = await connect(t, url, onCall());
  const args = { text: 'Call Sarah', in_minutes: 5 };
  const missing = await client.callTool({ name: 'set_reminder', arguments: args });
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /PIN is required/);
  await store.sql('DROP TABLE caller_pin_failure');
  const broken = await client.callTool({ name: 'set_reminder', arguments: { ...args, pin: '4821' } });
  assert.equal(broken.isError, true);
  assert.match(broken.content[0].text, /^Memory lookup failed/);
  assert.doesNotMatch(broken.content[0].text, /caller_pin_failure|relation|table/i);
  assert.equal((await client.callTool({ name: 'whats_today', arguments: {} })).isError, undefined);
  assert.equal((await store.upcomingReminders(PATIENT)).length, 0);
});

test('dispatch is cron-authenticated and calls once per due reminder', async t => {
  const { url, dial, clock, store } = await fixture(t);
  assert.equal((await fetch(`${url}/cron/dial-reminders`)).status, 401);
  assert.equal((await fetch(`${url}/cron/dial-reminders`, { headers: { Authorization: `Bearer ${config.DIAL_MCP_TOKEN}` } })).status, 401);
  const client = await connect(t, url, onCall());
  await client.callTool({ name: 'set_reminder', arguments: { text: 'Take the <b>blue</b> pill', in_minutes: 5 } });
  assert.deepEqual(await (await dispatch(url)).json(), { called: 0, submitted: 0, failed: 0, settled: 0, unconfirmed: 0 });
  clock.now += 5 * 60_000;
  assert.deepEqual(await (await dispatch(url)).json(), { called: 1, submitted: 0, failed: 0, settled: 0, unconfirmed: 0 });
  assert.equal((await (await dispatch(url)).json()).called, 0);
  assert.equal(dial.calls.length, 1);
  const [call] = dial.calls;
  assert.equal(call.to, PATIENT);
  assert.equal(call.from, STEPH);
  assert.match(call.idempotencyKey, /^reminder-[0-9a-f-]{36}$/);
  assert.match(call.instruction, /<reminder>Take the bblue\/b pill<\/reminder>/);
  assert.match(call.instruction, /AI assistant/);
  assert.ok(call.instruction.endsWith(PHONE_STYLE));
  assert.equal((await store.reminderByCall('call-1')).status, 'calling');
  for (const off of [{ CRON_SECRET: undefined }, { DIAL_API_KEY: undefined }]) {
    assert.equal((await dispatch((await fixture(t, off)).url)).status, 503);
  }
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
  assert.deepEqual(await (await webhook(url, ended('call-1', 'no-answer'))).json(), { received: true, duplicate: false });
  assert.deepEqual(await (await webhook(url, ended('call-1', 'no-answer'))).json(), { received: true, duplicate: true });
  assert.equal((await webhook(url, ended('call-1', 'no-answer', 'evt-redelivered'))).status, 200);
  assert.equal(dial.texts.length, 1);
  assert.equal(dial.texts[0].to, PATIENT);
  assert.equal(dial.texts[0].from, STEPH);
  const missed = await store.reminderByCall('call-1');
  assert.equal(missed.status, 'missed');
  assert.equal(missed.outcome, 'no-answer');
  assert.equal(missed.message_status, 'pending');
  await webhook(url, messageEvent('msg-1', 'delivered'));
  assert.equal((await store.reminderByCall('call-1')).status, 'missed');
  assert.equal((await store.reminderByCall('call-1')).message_status, 'delivered');
  await webhook(url, ended('call-2', 'completed'));
  assert.equal((await store.reminderByCall('call-2')).status, 'delivered');
  assert.equal(dial.texts.length, 1);
  assert.equal((await webhook(url, { id: 'evt-ping', type: 'webhook.ping', data: {} })).status, 200);
});

test('text reminders send once and are never retried after a failure', async t => {
  const { url, dial, clock, store } = await fixture(t);
  const client = await connect(t, url, onCall());
  await client.callTool({ name: 'set_reminder', arguments: { text: 'Garden club at 4', in_minutes: 1, channel: 'text' } });
  await client.callTool({ name: 'set_reminder', arguments: { text: 'Bring umbrella', in_minutes: 2, channel: 'text' } });
  clock.now += 60_000;
  assert.equal((await (await dispatch(url)).json()).submitted, 1);
  assert.equal((await store.reminderByMessage('msg-1')).status, 'texting');
  assert.equal((await store.reminderByMessage('msg-1')).message_status, 'pending');
  assert.equal(dial.texts[0].body, 'Steph (AI assistant) reminder: Garden club at 4');
  dial.failText = Object.assign(new Error('Dial POST messages failed with 500'), { status: 500 });
  clock.now += 60_000;
  assert.equal((await (await dispatch(url)).json()).failed, 1);
  clock.now += 10 * 60_000;
  await dispatch(url);
  assert.equal(dial.texts.length, 2);
  assert.equal((await store.upcomingReminders(PATIENT)).length, 0);
});

test('definite transient refusals look the call up, then retry with the same key, then give up', async t => {
  const { url, dial, clock } = await fixture(t);
  const client = await connect(t, url, onCall());
  await client.callTool({ name: 'set_reminder', arguments: { text: 'Doctor at 3', in_minutes: 1 } });
  dial.failCall = Object.assign(new Error('Dial POST calls failed with 503 (unavailable)'), { status: 503, ambiguous: false });
  clock.now += 60_000;
  await dispatch(url);
  await dispatch(url);
  assert.equal(dial.calls.length, 1, 'a held lease blocks an immediate retry');
  assert.equal(dial.lookups, 1, 'Dial is asked whether the call exists before any retry');
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
  assert.equal((await store.reminderByCall('call-1')).outcome, 'busy');
  assert.equal((await store.reminderByCall('call-1')).message_status, 'pending');
  assert.equal(dial.texts.length, 1);
});

test('only signed delivery receipts settle accepted texts, and terminal states cannot regress', async t => {
  const { url, dial, clock, store } = await fixture(t);
  const client = await connect(t, url, onCall());
  const first = await setText(client);
  const second = await setText(client);
  clock.now += 60_000;
  await dispatch(url);
  const firstRow = await reminderRow(store, first);
  const secondRow = await reminderRow(store, second);
  assert.equal(firstRow.status, 'texting');
  assert.equal(firstRow.message_status, 'pending');
  const failed = messageEvent(firstRow.message_id, 'failed');
  assert.equal((await webhook(url, failed, { secret: 'wrong' })).status, 401);
  assert.equal((await reminderRow(store, first)).message_status, 'pending');
  await webhook(url, messageEvent(firstRow.message_id, 'delivered', 'evt-inbound', { direction: 'inbound' }));
  assert.equal((await reminderRow(store, first)).message_status, 'pending');
  await webhook(url, failed);
  await webhook(url, messageEvent(secondRow.message_id, 'delivered'));
  await webhook(url, messageEvent(firstRow.message_id, 'pending'));
  await webhook(url, messageEvent(secondRow.message_id, 'pending'));
  await webhook(url, failed);
  assert.equal((await reminderRow(store, first)).status, 'failed');
  assert.equal((await reminderRow(store, first)).message_status, 'failed');
  assert.equal((await reminderRow(store, second)).status, 'delivered');
  assert.equal((await reminderRow(store, second)).message_status, 'delivered');
  clock.now += 20 * 60_000;
  await dispatch(url);
  assert.equal(dial.texts.length, 2);
});

test('an early signed receipt is replayed by exact message ID after the send response', async t => {
  const { url, dial, clock, store } = await fixture(t);
  const client = await connect(t, url, onCall());
  const id = await setText(client);
  dial.onSend = async message => {
    assert.equal(await store.reminderByMessage(message.id), undefined);
    await webhook(url, messageEvent(message.id, 'failed'));
    // The receipt must survive unrelated traffic beyond dialEvents()'s default limit.
    for (let i = 0; i < 25; i++) await webhook(url, { id: `evt-extra-${i}`, type: 'webhook.ping' });
  };
  clock.now += 60_000;
  await dispatch(url);
  const row = await reminderRow(store, id);
  assert.equal(row.message_id, 'msg-1');
  assert.equal(row.status, 'failed');
  assert.equal(row.message_status, 'failed');
  assert.equal(dial.texts.length, 1);
});

test('polling recovers lost receipts without a webhook secret and cannot overwrite a concurrent receipt', async t => {
  const { url, dial, clock, store } = await fixture(t, { DIAL_WEBHOOK_SECRET: undefined });
  const client = await connect(t, url, onCall());
  const id = await setText(client);
  clock.now += 60_000;
  await dispatch(url);
  dial.messages['msg-1'] = { id: 'msg-1', direction: 'outbound', deliveryState: 'delivered' };
  clock.now += 2 * 60_000;
  assert.equal((await (await dispatch(url)).json()).settled, 1);
  assert.equal((await reminderRow(store, id)).status, 'delivered');
  assert.equal(dial.polls[0].since, new Date(START).toISOString());
  assert.equal(dial.texts.length, 1);

  const concurrent = await fixture(t);
  const other = await connect(t, concurrent.url, onCall());
  const otherId = await setText(other);
  concurrent.clock.now += 60_000;
  await dispatch(concurrent.url);
  concurrent.dial.onPoll = async message => {
    await webhook(concurrent.url, messageEvent(message.id, 'delivered'));
  };
  concurrent.clock.now += 2 * 60_000;
  await dispatch(concurrent.url); // The delayed poll still returns its earlier pending snapshot.
  assert.equal((await reminderRow(concurrent.store, otherId)).message_status, 'delivered');
  assert.equal((await reminderRow(concurrent.store, otherId)).status, 'delivered');
});

test('ambiguous send errors, missing IDs and persistence failures never cause a duplicate text', async t => {
  for (const failure of ['timeout', 'server', 'missing-id', 'persist']) {
    const { url, dial, clock, store } = await fixture(t);
    const client = await connect(t, url, onCall());
    const id = await setText(client);
    if (failure === 'timeout') dial.failText = new Error('Synthetic timeout');
    if (failure === 'server') dial.failText = Object.assign(new Error('Synthetic server error'), { status: 503 });
    if (failure === 'missing-id') dial.sendResponse = { deliveryState: 'pending' };
    if (failure === 'persist') {
      const update = store.updateReminderMessage.bind(store);
      let first = true;
      store.updateReminderMessage = (...args) => {
        if (first) { first = false; throw new Error('Synthetic database interruption'); }
        return update(...args);
      };
    }
    clock.now += 60_000;
    await dispatch(url);
    const row = await reminderRow(store, id);
    assert.equal(row.status, 'texting', failure);
    assert.equal(row.message_status, 'unknown', failure);
    assert.equal(row.message_id, null, failure);
    clock.now += 30 * 60_000;
    await Promise.all([dispatch(url), dispatch(url), dispatch(url)]);
    assert.equal(dial.texts.length, 1, failure);
  }
});

test('a crash after claiming a text and before sending does not turn its lease into a resend', async t => {
  const { url, dial, clock, store } = await fixture(t);
  const client = await connect(t, url, onCall());
  const id = await setText(client);
  clock.now += 60_000;
  const claimed = await store.claimDueReminders(new Date(clock.now).toISOString(), new Date(clock.now + 120_000).toISOString());
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0].status, 'texting');
  clock.now += 30 * 60_000;
  await dispatch(url);
  assert.equal(dial.texts.length, 0);
  assert.equal((await reminderRow(store, id)).message_status, 'unknown');
});

test('definitive text rejection fails once; ambiguous fallback failure retains the missed call', async t => {
  const { url, dial, clock, store } = await fixture(t);
  const client = await connect(t, url, onCall());
  const id = await setText(client);
  dial.failText = Object.assign(new Error('Synthetic rejection'), { status: 403 });
  clock.now += 60_000;
  await dispatch(url);
  assert.equal((await reminderRow(store, id)).status, 'failed');
  assert.equal((await reminderRow(store, id)).message_status, 'failed');
  await client.callTool({ name: 'set_reminder', arguments: { text: 'Synthetic call reminder', in_minutes: 1 } });
  clock.now += 60_000;
  await dispatch(url);
  dial.failText = Object.assign(new Error('Synthetic uncertain send'), { status: 503 });
  await Promise.all(Array.from({ length: 8 }, (_, i) => webhook(url, ended('call-1', 'no-answer', `evt-concurrent-${i}`))));
  const missed = await store.reminderByCall('call-1');
  assert.equal(missed.status, 'missed');
  assert.equal(missed.outcome, 'no-answer');
  assert.equal(missed.message_status, 'unknown');
  clock.now += 30 * 60_000;
  await dispatch(url);
  assert.equal(dial.texts.length, 2);
});

test('send response states distinguish queued, failed and unknown instead of assuming delivery', async t => {
  for (const [response, expected] of [
    [{ deliveryState: 'failed' }, 'failed'],
    [{ status: 'undelivered' }, 'failed'],
    [{ status: 'sent' }, 'pending'],
    [{ deliveryState: 'unconfirmed' }, 'unknown'],
    [{}, 'unknown'],
    [{ direction: 'inbound', deliveryState: 'delivered' }, 'unknown'],
  ]) {
    const { url, dial, clock, store } = await fixture(t);
    const client = await connect(t, url, onCall());
    const id = await setText(client);
    dial.sendResponse = { id: 'msg-1', ...response };
    clock.now += 60_000;
    await dispatch(url);
    const row = await reminderRow(store, id);
    assert.equal(row.message_status, expected, JSON.stringify(response));
    assert.notEqual(row.status, 'delivered');
    clock.now += 10 * 60_000;
    await dispatch(url);
    assert.equal(dial.texts.length, 1);
  }
});

test('missing or errored status polls retain state, rotate the bounded queue and never resend', async t => {
  const { url, dial, clock, store } = await fixture(t);
  const client = await connect(t, url, onCall());
  const ids = [];
  for (let i = 0; i < 7; i++) ids.push(await setText(client));
  clock.now += 60_000;
  await dispatch(url);
  await dispatch(url);
  dial.omitMessages = true;
  clock.now += 2 * 60_000;
  await dispatch(url);
  const firstPolls = [...dial.polls];
  dial.failPoll = new Error('Synthetic provider unavailable');
  clock.now += 2 * 60_000;
  await dispatch(url);
  assert.equal(new Set(dial.polls.map(poll => poll.id)).size, 7);
  assert.ok(firstPolls.every(poll => poll.since === new Date(START).toISOString()));
  for (const id of ids) {
    assert.equal((await reminderRow(store, id)).status, 'texting');
    assert.equal((await reminderRow(store, id)).message_status, 'pending');
  }
  assert.equal(dial.texts.length, 7);
});

test('Dial polling filters outbound history and matches the exact ID without exposing recipients in errors', async () => {
  const requests = [];
  const dial = createDial('synthetic', async (url, options) => {
    requests.push({ url: new URL(url), options });
    return Response.json({ messages: [
      { id: 'other-id', direction: 'outbound', deliveryState: 'delivered' },
      { id: 'wanted', direction: 'inbound', deliveryState: 'delivered' },
      { id: 'wanted', direction: 'outbound', deliveryState: 'pending' },
    ] });
  });
  const options = { to: PATIENT, since: new Date(START).toISOString() };
  assert.equal((await dial.getMessage('wanted', options)).deliveryState, 'pending');
  assert.equal(await dial.getMessage('absent', options), undefined);
  assert.equal(requests[0].url.pathname, '/api/v1/messages');
  assert.equal(requests[0].url.searchParams.get('contact'), PATIENT);
  assert.equal(requests[0].url.searchParams.get('direction'), 'outbound');
  assert.equal(requests[0].url.searchParams.get('since'), options.since);
  const rejected = createDial('synthetic', async () => Response.json({}, { status: 401 }));
  await assert.rejects(rejected.getMessage('wanted', options), error => {
    assert.equal(error.status, 401);
    assert.doesNotMatch(error.message, /14155550123|contact|since/);
    return true;
  });
});
