import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createApp } from '../app.mjs';
import { readConfig } from '../config.mjs';
import { createDial } from '../voice/dial.mjs';
import { createReminders } from '../voice/reminders.mjs';
import { testStore, TEST_DATABASE_URL } from './helpers.mjs';

const PATIENT = '+14155550123';
const STEPH = '+12408962183';
const config = readConfig({
  DIAL_MCP_TOKEN: 'd'.repeat(64), CAMERA_TOKEN: 'c'.repeat(64), CRON_SECRET: 'r'.repeat(64),
  DIAL_API_KEY: 'sk_test', DEMO_CALLER_NUMBER: PATIENT, TIMEZONE: 'America/Los_Angeles', DATABASE_URL: TEST_DATABASE_URL,
});
const NO_ANALYTICS = { toolCall() {}, rejected() {}, sync() {}, dialEvent() {} };
const START = Date.parse('2026-10-11T20:00:00Z');

// A fake Dial HTTP API behind the real client: records every request and lets a test decide how
// POST /calls behaves (succeed, hang until the client times out, or answer with an error).
// Never answers; rejects when the client's AbortSignal.timeout fires. That timer is unref'd, so a
// ref'd placeholder keeps the event loop alive until then, as a server's open sockets would.
function hang(signal) {
  return new Promise((_, reject) => {
    const keepAlive = setTimeout(() => {}, 10_000);
    signal.addEventListener('abort', () => { clearTimeout(keepAlive); reject(signal.reason); });
  });
}

function fakeDialApi(clock = { now: Date.now() }) {
  const api = { posts: [], gets: [], placed: [], texts: [], onCall: 'ok', onText: 'ok' };
  api.fetch = async (url, init) => {
    const { pathname, searchParams } = new URL(url);
    const path = pathname.replace('/api/v1', '');
    if (init.method === 'GET') {
      api.gets.push(path);
      if (path === '/calls') {
        const since = searchParams.get('since');
        return Response.json({ calls: api.placed.filter(call => call.to === searchParams.get('contact') &&
          (!since || call.createdAt >= since)).reverse() });
      }
      if (path === '/messages') return Response.json({ messages: api.texts });
      if (path === '/account') return Response.json({ id: 'acct' });
      return Response.json({ call: api.placed.find(call => path.endsWith(call.id)) ?? null });
    }
    const body = JSON.parse(init.body);
    api.posts.push({ path, body, headers: init.headers });
    if (path === '/messages') {
      if (api.onText === 'timeout') return hang(init.signal);
      api.texts.push({ id: `msg-${api.texts.length + 1}`, to: body.to, body: body.body, direction: 'outbound' });
      if (api.onText === 'sent-then-timeout') return hang(init.signal);
      return Response.json({ message: { id: `msg-${api.texts.length}` } }, { status: 201 });
    }
    const call = { id: `call-${api.posts.length}`, to: body.to, from: body.fromNumber, direction: 'outbound',
      instruction: body.outboundInstruction, createdAt: new Date(clock.now).toISOString(), status: { state: 'Queued' } };
    switch (api.onCall) {
      // The call is placed, but the response never arrives (client timeout).
      case 'placed-then-timeout':
        api.placed.push(call);
        return hang(init.signal);
      case 'placed-then-error':
        api.placed.push(call);
        return Response.json({ error: 'backend_error' }, { status: 503 });
      case 'timeout':
        return hang(init.signal);
      case 'calling_disabled':
        return Response.json({ error: 'calling_disabled' }, { status: 409 });
      case 'bad_request':
        return Response.json({ error: { fieldErrors: { to: ['Invalid'] } } }, { status: 400 });
      case 'gateway':
        return new Response('<html>bad gateway</html>', { status: 502 });
      default:
        api.placed.push(call);
        return Response.json({ call }, { status: 201 });
    }
  };
  return api;
}

async function fixture(t, overrides = {}) {
  const store = await testStore(t);
  const clock = { now: START };
  const api = fakeDialApi(clock);
  const dial = createDial('sk_test', api.fetch, { timeoutMs: 50, allowedNumbers: overrides.allowed });
  const server = createApp({ ...config, ...overrides }, store, undefined,
    { dial, now: () => clock.now, analytics: NO_ANALYTICS }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  const client = new Client({ name: 'dial-calls', version: '0.1.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: {
    Authorization: `Bearer ${config.DIAL_MCP_TOKEN}`, 'X-Dial-User-Number': PATIENT, 'X-Dial-Direction': 'inbound',
    'X-Dial-Agent-Number': STEPH,
  } } }));
  t.after(() => client.close());
  const dispatch = async () => (await fetch(`${url}/cron/dial-reminders`, {
    headers: { Authorization: `Bearer ${config.CRON_SECRET}` } })).json();
  return { store, clock, api, client, dispatch };
}

const callPosts = api => api.posts.filter(post => post.path === '/calls');

test('the Dial client classifies failures: timeouts are ambiguous, 409 calling_disabled and 400 are permanent', async () => {
  const api = fakeDialApi();
  const dial = createDial('sk_test', api.fetch, { timeoutMs: 30 });
  const attempt = async mode => {
    api.onCall = mode;
    return dial.placeCall({ to: PATIENT, from: STEPH, instruction: 'x' }).then(() => null, error => error);
  };
  const timeout = await attempt('timeout');
  assert.equal(timeout.ambiguous, true);
  assert.doesNotMatch(timeout.message, /4155550123/);
  const disabled = await attempt('calling_disabled');
  assert.deepEqual([disabled.status, disabled.code, disabled.permanent, disabled.ambiguous], [409, 'calling_disabled', true, false]);
  const invalid = await attempt('bad_request');
  assert.deepEqual([invalid.status, invalid.permanent, invalid.ambiguous], [400, true, false]);
  const gateway = await attempt('gateway');
  assert.deepEqual([gateway.status, gateway.permanent, gateway.ambiguous], [502, false, true]);
  const jsonError = await attempt('placed-then-error');
  assert.deepEqual([jsonError.status, jsonError.permanent, jsonError.ambiguous], [503, false, true]);
});

test('DIAL_ALLOWED_NUMBERS refuses every other destination before any request is made', async () => {
  const api = fakeDialApi();
  const dial = createDial('sk_test', api.fetch, { allowedNumbers: [PATIENT] });
  await assert.rejects(dial.placeCall({ to: '+14155550999', from: STEPH, instruction: 'x' }), { code: 'not_allowed', permanent: true });
  await assert.rejects(dial.sendText({ to: '+14155550999', from: STEPH, body: 'x' }), { code: 'not_allowed' });
  assert.equal(api.posts.length, 0);
  await dial.sendText({ to: PATIENT, from: STEPH, body: 'ok' });
  assert.equal(api.posts.length, 1);
  assert.deepEqual(readConfig({ ...config, DIAL_MCP_TOKEN: config.DIAL_MCP_TOKEN, CAMERA_TOKEN: config.CAMERA_TOKEN,
    DIAL_ALLOWED_NUMBERS: `${PATIENT}, +15039290000` }).DIAL_ALLOWED_NUMBERS, [PATIENT, '+15039290000']);
  assert.throws(() => readConfig({ DIAL_MCP_TOKEN: config.DIAL_MCP_TOKEN, CAMERA_TOKEN: config.CAMERA_TOKEN,
    DIAL_ALLOWED_NUMBERS: '5039290000' }), /E\.164/);
});

test('an ambiguous POST /calls never produces a second call, whether or not Dial placed it', async t => {
  for (const mode of ['placed-then-timeout', 'timeout', 'placed-then-error']) {
    const { api, clock, client, dispatch } = await fixture(t);
    await client.callTool({ name: 'set_reminder', arguments: { text: 'Doctor at 3', in_minutes: 1 } });
    api.onCall = mode;
    clock.now += 60_000;
    const first = await dispatch();
    // Every later run, through the settle window and beyond: never another POST /calls.
    for (let minute = 0; minute < 20; minute++) {
      clock.now += 60_000;
      await dispatch();
    }
    assert.equal(callPosts(api).length, 1, mode);
    if (mode !== 'timeout') {
      // The call Dial did place was found by listing calls and adopted.
      assert.equal(first.called, 1);
      assert.ok(api.gets.includes('/calls'));
      assert.equal(api.posts.filter(post => post.path === '/messages').length, 0);
    } else {
      // Unconfirmed: parked, re-checked, then given up with one fallback text (a text is not a second call).
      assert.equal(first.unconfirmed, 1);
      assert.equal(api.posts.filter(post => post.path === '/messages').length, 1);
    }
  }
});

test('409 calling_disabled and 400 are surfaced once and never retried', async t => {
  for (const mode of ['calling_disabled', 'bad_request']) {
    const { api, clock, client, dispatch } = await fixture(t);
    await client.callTool({ name: 'set_reminder', arguments: { text: 'Pay rent', in_minutes: 1 } });
    api.onCall = mode;
    clock.now += 60_000;
    assert.equal((await dispatch()).failed, 1);
    for (let i = 0; i < 5; i++) {
      clock.now += 5 * 60_000;
      await dispatch();
    }
    assert.equal(callPosts(api).length, 1, mode);
  }
});

test('restart reconciles reserved calls and legacy expired leases without another placement', async t => {
  for (const crash of ['before-request', 'accepted', 'legacy-accepted']) {
    const { api, clock, client, store } = await fixture(t);
    await client.callTool({ name: 'set_reminder', arguments: { text: 'Review reminder', in_minutes: 1 } });
    clock.now += 60_000;
    const stamp = new Date(clock.now).toISOString();
    const lease = new Date(clock.now + 120_000).toISOString();
    const [claimed] = await store.claimDueReminders(stamp, lease);
    if (crash === 'legacy-accepted') {
      await store.sql(store.adapter === 'sqlite'
        ? "UPDATE reminders SET status = 'sending', lease_until = ? WHERE id = ?"
        : "UPDATE reminders SET status = 'sending', lease_until = $1 WHERE id = $2", [lease, claimed.id]);
    }
    if (crash !== 'before-request') api.placed.push({ id: 'accepted-before-crash', to: PATIENT, from: STEPH,
      direction: 'outbound', instruction: '<reminder>Review reminder</reminder>', createdAt: stamp,
      status: { state: 'Queued' } });
    // No result was saved: recover through a fresh store connection and dispatcher.
    const reopened = store.reopen();
    t.after(() => reopened.close());
    const recovered = createReminders(config, reopened, { dial: createDial('sk_test', api.fetch), now: () => clock.now });
    clock.now += 121_000;
    await recovered.dispatch();
    assert.equal(callPosts(api).length, 0, crash);
    if (crash !== 'before-request') assert.equal((await reopened.reminderByCall('accepted-before-crash')).id, claimed.id);
    clock.now += 20 * 60_000;
    await recovered.dispatch();
    assert.equal(callPosts(api).length, 0, `${crash}: later dispatch cannot redial`);
    assert.equal(api.texts.length, crash === 'before-request' ? 1 : 0);
  }
});

// Texts follow DEC-020: reserved before the request, so a timeout leaves the delivery unknown, never a resend.
test('a text whose POST times out is recorded as unknown and never sent twice', async t => {
  for (const mode of ['timeout', 'sent-then-timeout']) {
    const { api, clock, client, dispatch } = await fixture(t);
    await client.callTool({ name: 'set_reminder', arguments: { text: 'Garden club', in_minutes: 1, channel: 'text' } });
    api.onText = mode;
    clock.now += 60_000;
    assert.equal((await dispatch()).failed, 1, mode);
    clock.now += 10 * 60_000;
    await dispatch();
    assert.equal(api.posts.filter(post => post.path === '/messages').length, 1, mode);
  }
});

test('reminder calls and texts respect DIAL_ALLOWED_NUMBERS end to end', async t => {
  const { api, clock, client, dispatch } = await fixture(t, { allowed: ['+15039290000'] });
  await client.callTool({ name: 'set_reminder', arguments: { text: 'Walk', in_minutes: 1 } });
  clock.now += 60_000;
  assert.equal((await dispatch()).failed, 1);
  assert.equal(api.posts.length, 0);
});
