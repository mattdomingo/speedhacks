import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createApp } from '../app.mjs';
import { readConfig } from '../config.mjs';
import { seedDemo, DEMO_PATIENT_B } from '../demo.mjs';
import { identifyCaller, patientsFrom } from '../voice/patients.mjs';
import { testStore, TEST_DATABASE_URL } from './helpers.mjs';

const A = '+14155550123';
const B = DEMO_PATIENT_B;
const STEPH = '+12408962183';
const CAREGIVER = '+14155550100';
const config = readConfig({
  DIAL_MCP_TOKEN: 'd'.repeat(64), CAMERA_TOKEN: 'c'.repeat(64), DIAL_API_KEY: 'sk_test', DEMO_MODE: 'true',
  DEMO_CALLER_NUMBER: A, CAREGIVER_NUMBER: CAREGIVER, TIMEZONE: 'America/Los_Angeles', DATABASE_URL: TEST_DATABASE_URL,
  PATIENTS: JSON.stringify([{ number: B, name: 'Rosa', caregiver: '+14155550101', timeZone: 'America/Chicago' }]),
});
const NO_ANALYTICS = { toolCall() {}, rejected() {}, sync() {}, dialEvent() {} };

function fakeDial() {
  const dial = {
    texts: [],
    async sendText(args) { dial.texts.push(args); return { id: `m${dial.texts.length}` }; },
    async placeCall() { throw new Error('not used'); },
    async getCall() { return null; },
    async listCalls() { return []; },
    async listMessages() { return []; },
  };
  return dial;
}

async function fixture(t, overrides = {}) {
  const store = await testStore(t);
  await seedDemo(store, new Date(), 'America/Los_Angeles');
  const dial = fakeDial();
  const server = createApp({ ...config, ...overrides }, store, undefined, { dial, analytics: NO_ANALYTICS }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  const connect = async (headers = {}) => {
    const client = new Client({ name: 'isolation', version: '0.1.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: {
      Authorization: `Bearer ${config.DIAL_MCP_TOKEN}`, ...headers } } }));
    t.after(() => client.close());
    return client;
  };
  return { store, dial, connect };
}

const as = (number, direction = 'inbound') => ({ 'X-Dial-User-Number': number, 'X-Dial-Direction': direction, 'X-Dial-Agent-Number': STEPH });
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new Date());
const text = result => JSON.stringify(result.structuredContent ?? result.content);

test('PATIENTS config adds patients next to the primary caller and rejects bad entries', () => {
  const patients = patientsFrom(config);
  assert.deepEqual(patients.map(patient => [patient.number, patient.primary, patient.caregiver]),
    [[A, true, CAREGIVER], [B, false, '+14155550101']]);
  const base = { DIAL_MCP_TOKEN: config.DIAL_MCP_TOKEN, CAMERA_TOKEN: config.CAMERA_TOKEN };
  assert.throws(() => readConfig({ ...base, PATIENTS: 'not json' }), /PATIENTS/);
  assert.throws(() => readConfig({ ...base, PATIENTS: JSON.stringify([{ number: '555-0199' }]) }), /PATIENTS/);
  assert.throws(() => readConfig({ ...base, PATIENTS: JSON.stringify([{ number: B }, { number: B }]) }), /PATIENTS/);
  assert.throws(() => readConfig({ ...base, CAREGIVER_NUMBER: '4155550100' }));
  for (const [value, reason] of [[undefined, 'no_caller_header'], ['', 'no_caller_header'], ['   ', 'no_caller_header'],
    ['{{user_number}}', 'unfilled_caller_header'], ['{{ caller }}', 'unfilled_caller_header'], ['4155550123', 'malformed_caller'],
    ['+1 415 555 0123', 'malformed_caller'], [`${A},${B}`, 'malformed_caller'], ['+14155550999', 'unknown_caller']]) {
    assert.equal(identifyCaller(patients, value).reason, reason, String(value));
  }
  assert.equal(identifyCaller([], A).reason, 'no_demo_caller');
  assert.equal(identifyCaller(patients, ` ${B} `).patient.number, B);
});

test('each patient sees only their own records through every memory tool', async t => {
  const { connect } = await fixture(t);
  const a = await connect(as(A));
  const b = await connect(as(B));
  const schedule = async client => (await client.callTool({ name: 'get_schedule', arguments: { date: today() } })).structuredContent;
  assert.deepEqual((await schedule(a)).evidence.map(item => item.title).sort(), ['Coffee with Priya', 'Maya visits']);
  assert.deepEqual((await schedule(b)).evidence.map(item => item.title), ['Diego visits']);
  const keys = await a.callTool({ name: 'find_object', arguments: { object: 'my keys' } });
  assert.match(keys.structuredContent.evidence[0].text, /kitchen counter, next to the fruit bowl/);
  assert.equal((await b.callTool({ name: 'find_object', arguments: { object: 'keys' } })).structuredContent.status, 'unknown');
  assert.equal((await a.callTool({ name: 'find_object', arguments: { object: 'glasses' } })).structuredContent.status, 'unknown');
  assert.equal((await b.callTool({ name: 'find_object', arguments: { object: 'glasses' } })).structuredContent.status, 'supported');
  assert.equal((await b.callTool({ name: 'search_messages', arguments: { query: 'Maya dinner' } })).structuredContent.status, 'unknown');
  const sam = await a.callTool({ name: 'who_is', arguments: { name: 'Sam' } });
  assert.match(sam.structuredContent.evidence[0].text, /Tokyo ramen/);
  // Asking about patient B's family while calling as A returns nothing from B, and vice versa.
  // ("my son" may match A's own note about Sam's son Leo, never B's son.)
  for (const name of ['Diego', 'my son', 'Rosa', 'Austin']) {
    const reply = await a.callTool({ name: 'who_is', arguments: { name } });
    if (name !== 'my son') assert.equal(reply.structuredContent.status, 'unknown', name);
    assert.doesNotMatch(text(reply), /Diego|Austin|glasses/);
  }
  assert.equal((await b.callTool({ name: 'who_is', arguments: { name: 'Sam Chen' } })).structuredContent.status, 'unknown');
  assert.match(text(await b.callTool({ name: 'who_is', arguments: { name: 'my son' } })), /Diego/);
});

test('missing, empty, template, malformed and unknown caller headers get a polite refusal and no data', async t => {
  const { connect } = await fixture(t);
  for (const headers of [
    { 'X-Dial-Direction': 'inbound' },
    { ...as(A), 'X-Dial-User-Number': '' },
    { ...as(A), 'X-Dial-User-Number': '{{user_number}}' },
    { ...as(A), 'X-Dial-User-Number': '415-555-0123' },
    { ...as(A), 'X-Dial-User-Number': '+14155550999' },
  ]) {
    const client = await connect(headers);
    for (const [name, args] of [['find_object', { object: 'keys' }], ['who_is', { name: 'Sam' }],
      ['get_schedule', { date: today() }], ['care_instructions', { topic: 'pills' }]]) {
      const reply = await client.callTool({ name, arguments: args });
      assert.equal(reply.isError, true, `${name} ${JSON.stringify(headers)}`);
      assert.match(reply.content[0].text, /not authorized\. No personal records were retrieved/);
      assert.doesNotMatch(text(reply), /kitchen|Priya|Sam|pill|Maya/);
    }
  }
});

test('care_instructions only repeats what the caregiver saved', async t => {
  const { connect } = await fixture(t);
  const a = await connect(as(A));
  const pills = await a.callTool({ name: 'care_instructions', arguments: { topic: 'Should I take two pills?' } });
  assert.deepEqual(pills.structuredContent.evidence.map(item => item.text), ['DEMO: Your caregiver saved this: Take one blue pill with breakfast.']);
  assert.equal((await a.callTool({ name: 'care_instructions', arguments: { topic: 'insulin dose' } })).structuredContent.status, 'unknown');
  const b = await connect(as(B));
  assert.equal((await b.callTool({ name: 'care_instructions', arguments: { topic: 'pills' } })).structuredContent.status, 'unknown');
});

test('notify_caregiver texts only the caller\'s own caregiver, at most three times an hour, without a PIN', async t => {
  const { connect, dial } = await fixture(t, { CALLER_PIN: '4821' });
  const a = await connect(as(A));
  const reason = 'I fell and I can\'t get up';
  const first = await a.callTool({ name: 'notify_caregiver', arguments: { reason } });
  assert.equal(first.isError, undefined);
  assert.deepEqual(dial.texts.map(message => [message.to, message.from]), [[CAREGIVER, STEPH]]);
  assert.match(dial.texts[0].body, /AI assistant.*I fell and I can't get up/);
  for (let i = 0; i < 3; i++) await a.callTool({ name: 'notify_caregiver', arguments: { reason: `again ${i}` } });
  assert.equal(dial.texts.length, 3);
  const limited = await a.callTool({ name: 'notify_caregiver', arguments: { reason: 'one more' } });
  assert.equal(limited.isError, true);
  assert.match(limited.content[0].text, /call 911/);
  const b = await connect(as(B));
  await b.callTool({ name: 'notify_caregiver', arguments: { reason: 'help' } });
  assert.equal(dial.texts.at(-1).to, '+14155550101');
  const stranger = await connect(as('+14155550999'));
  assert.equal((await stranger.callTool({ name: 'notify_caregiver', arguments: { reason: 'help' } })).isError, true);
  assert.equal(dial.texts.length, 4);
});

test('20 concurrent MCP tool calls split across patients never mix their data', async t => {
  const { connect } = await fixture(t);
  const clients = { [A]: await connect(as(A)), [B]: await connect(as(B)) };
  const started = performance.now();
  const results = await Promise.all(Array.from({ length: 20 }, async (_, index) => {
    const number = index % 2 ? B : A;
    const reply = await clients[number].callTool({ name: index % 4 < 2 ? 'get_schedule' : 'who_is',
      arguments: index % 4 < 2 ? { date: today() } : { name: number === A ? 'Sam' : 'Diego' } });
    return { number, reply };
  }));
  t.diagnostic(`20 concurrent MCP calls in ${(performance.now() - started).toFixed(0)} ms`);
  for (const { number, reply } of results) {
    assert.equal(reply.isError, undefined);
    const body = text(reply);
    if (number === A) assert.doesNotMatch(body, /Diego/); else assert.doesNotMatch(body, /Priya|Maya|Sam/);
  }
});

test('when Dial is down, notify_caregiver says to call 911 and works again once Dial is back', async t => {
  const { connect, dial } = await fixture(t);
  const send = dial.sendText;
  dial.sendText = async () => { throw Object.assign(new Error('Dial POST messages did not complete (TypeError)'), { ambiguous: true }); };
  const a = await connect(as(A));
  const down = await a.callTool({ name: 'notify_caregiver', arguments: { reason: 'I feel dizzy' } });
  assert.equal(down.isError, true);
  assert.match(down.content[0].text, /could not reach your caregiver just now\. If this is an emergency, hang up and call 911/);
  dial.sendText = send;
  assert.equal((await a.callTool({ name: 'notify_caregiver', arguments: { reason: 'I feel dizzy' } })).isError, undefined);
  assert.equal(dial.texts.length, 1);
});
