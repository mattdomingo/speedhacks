import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createApp } from '../app.mjs';
import { readConfig } from '../config.mjs';
import { checkPin } from '../voice/pin.mjs';
import { createGemini } from '../steph/gemini.mjs';
import { APP_ANSWER_PROMPT, PLAN_PROMPT } from '../steph/app-plan.mjs';
import { testStore } from './helpers.mjs';

const PATIENT = '+12025550101';
const OTHER = '+12025550102';
const DEVICE = 'a'.repeat(64);
const OTHER_DEVICE = 'b'.repeat(64);
const SHARED_APP = 'r'.repeat(64);
const hash = value => createHash('sha256').update(value).digest('hex');
const CLOCK = Date.parse('2026-10-11T20:05:00Z');
const env = {
  DIAL_MCP_TOKEN: 'd'.repeat(64), CAMERA_TOKEN: 'c'.repeat(64), RECALL_APP_TOKEN: SHARED_APP,
  DEMO_CALLER_NUMBER: PATIENT,
  PATIENTS: JSON.stringify([{ number: PATIENT, timeZone: 'America/Los_Angeles' }, { number: OTHER, timeZone: 'America/New_York' }]),
  RECALL_PATIENT_TOKENS: JSON.stringify([{ tokenHash: hash(DEVICE), patient: PATIENT }, { tokenHash: hash(OTHER_DEVICE), patient: OTHER }]),
  ANTHROPIC_API_KEY: 'test-only',
  DEMO_MODE: 'true', // App shared retrieval must still exclude demo evidence.
};
const askBody = {
  question: 'Where did I leave my keys?', now: '1990-01-01T00:00:00Z', time_zone: 'Asia/Tokyo', memories: [],
};
const camera = (id, location, extra = {}) => ({
  id, source: 'camera', timestamp: '2026-10-11T19:00:00Z',
  object: 'keys', location, text: 'keys last seen ' + location, demo: false, ...extra,
});
const phoneMemory = {
  id: 'phone-note', type: 'note', summary: 'I left my passport in my desk.', people: [],
  timestamp: '2026-10-11T18:00:00Z', source: 'you', confidence: 0.9,
};
const keyPlan = [{ tool: 'find_object', object: 'keys' }];
const recentPlan = [{ tool: 'search_messages', query: null, date: null, end_date: null }];
const response = value => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(value) }] });
const memoriesIn = text => text.slice(text.indexOf('<memories>\n') + 11, text.indexOf('\n</memories>')).split('\n').filter(Boolean).map(JSON.parse);
function defaultAnswer(params) {
  const memories = memoriesIn(params.messages[0].content).filter(memory => memory.id !== 'clock-now');
  return {
    answer: memories[0]?.summary ?? 'No matching memory.',
    card_type: 'answer', memory_ids: memories.slice(0, 1).map(memory => memory.id), buttons: ['Thanks!'],
    supported: memories.length > 0,
  };
}
function fakeClaude(plan = keyPlan, answer = defaultAnswer, intent = plan.length ? 'shared_memory' : 'phone_memory') {
  const calls = [];
  return {
    calls,
    beta: { messages: { async create(params, options) {
      calls.push({ params, options });
      return response(params.system === PLAN_PROMPT ? { intent, calls: plan } : await answer(params));
    } } },
  };
}
async function fixture(t, { config = {}, claude = fakeClaude(), gemini, google, appMemory } = {}) {
  const store = await testStore(t);
  const parsed = readConfig({ ...env, ...config });
  const server = createApp(parsed, store, undefined, {
    ...(google ? { google } : {}), steph: { claude, gemini }, appMemory, now: () => CLOCK,
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return {
    store, claude, config: parsed,
    async post(body = askBody, token = DEVICE, path = '/app/ask', headers = {}) {
      const result = await fetch('http://127.0.0.1:' + server.address().port + path, {
        method: 'POST', body: JSON.stringify(body),
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', ...headers },
      });
      return { status: result.status, body: await result.json(), headers: result.headers };
    },
  };
}

test('device token configuration is optional, unique, patient-bound and separate from every service credential', () => {
  assert.equal(readConfig({ ...env, RECALL_PATIENT_TOKENS: '' }).RECALL_PATIENT_TOKENS, undefined);
  for (const bindings of [
    [{ tokenHash: hash(DEVICE), patient: '+12025550999' }],
    [{ tokenHash: hash(DEVICE), patient: PATIENT }, { tokenHash: hash(DEVICE), patient: OTHER }],
    [{ tokenHash: 'not-a-hash', patient: PATIENT }],
    [{ tokenHash: hash(SHARED_APP), patient: PATIENT }],
    [{ tokenHash: hash(env.DIAL_MCP_TOKEN), patient: PATIENT }],
    [{ tokenHash: hash(env.CAMERA_TOKEN), patient: PATIENT }],
    [{ tokenHash: hash(DEVICE), patient: PATIENT, token: DEVICE }],
  ]) assert.throws(() => readConfig({ ...env, RECALL_PATIENT_TOKENS: JSON.stringify(bindings) }));
});

test('session validates credentials and PIN without invoking a model or reading evidence', async t => {
  const f = await fixture(t, { config: { CALLER_PIN: '1234' } });
  let evidenceReads = 0;
  f.store.list = async () => { evidenceReads++; return []; };
  for (const token of [SHARED_APP, env.DIAL_MCP_TOKEN, env.CAMERA_TOKEN, 'wrong', '']) {
    const denied = await f.post({ pin: '1234' }, token, '/app/session');
    assert.deepEqual([denied.status, denied.body.code], [401, 'unauthorized']);
  }
  const missing = await f.post({}, DEVICE, '/app/session');
  assert.deepEqual([missing.status, missing.body.code], [401, 'pin_required']);
  const wrong = await f.post({ pin: '9999' }, DEVICE, '/app/session');
  assert.deepEqual([wrong.status, wrong.body.code], [401, 'pin_wrong']);
  const good = await f.post({ pin: '1234' }, DEVICE, '/app/session');
  assert.deepEqual(good.body, { connected: true });
  assert.equal(good.headers.get('cache-control'), 'no-store');
  assert.deepEqual([evidenceReads, f.claude.calls.length], [0, 0]);
  const off = await fixture(t, { config: { RECALL_PATIENT_TOKENS: '' } });
  assert.equal((await off.post({}, DEVICE, '/app/session')).body.code, 'app_not_configured');
});

test('wrong app PINs share the existing phone lockout and never start retrieval', async t => {
  const f = await fixture(t, { config: { CALLER_PIN: '1234' } });
  for (let i = 0; i < 5; i++) assert.equal((await f.post({ ...askBody, pin: '9999' })).body.code, 'pin_wrong');
  const locked = await f.post({ ...askBody, pin: '1234' });
  assert.deepEqual([locked.status, locked.body.code], [429, 'pin_locked']);
  assert.equal(await checkPin(f.store, '1234', PATIENT, '1234'), 'pin_locked');
  assert.equal(f.claude.calls.length, 0);
});

test('shared camera replies scope patient evidence, exclude demo data, and use trusted server date/zone', async t => {
  const f = await fixture(t);
  await f.store.put(camera('own', 'desk'));
  await f.store.put(camera('other', 'secret other room', { patient: OTHER, timestamp: '2026-10-11T20:00:00Z' }));
  await f.store.put(camera('demo', 'invented demo room', { demo: true, timestamp: '2026-10-11T21:00:00Z' }));
  const result = await f.post(askBody, DEVICE, '/app/ask', { 'x-dial-user-number': OTHER });
  assert.equal(result.status, 200);
  assert.equal(result.headers.get('cache-control'), 'no-store');
  assert.equal(result.body.evidence.length, 1);
  const [evidence] = result.body.evidence;
  assert.match(evidence.id, /^shared:[a-f0-9]{64}$/);
  assert.equal(evidence.summary, 'keys last seen desk.');
  assert.equal(evidence.demo, false);
  assert.deepEqual(evidence.provenance, { source: 'camera', timestamp: '2026-10-11T19:00:00Z' });
  assert.deepEqual(result.body.memory_ids, [evidence.id]);
  const plan = JSON.parse(f.claude.calls[0].params.messages[0].content);
  assert.deepEqual([plan.today, plan.time_zone, plan.server_now], ['2026-10-11', 'America/Los_Angeles', '2026-10-11T20:05:00.000Z']);
  assert.deepEqual(plan.last_week, { date: '2026-09-28', end_date: '2026-10-04' });
  const prompt = f.claude.calls[1].params.messages[0].content;
  assert.doesNotMatch(prompt, /secret other room|invented demo room|1990|Tokyo/);
  assert.ok(f.claude.calls.every(call => !JSON.stringify(call.params).includes(DEVICE)));
  const other = await f.post(askBody, OTHER_DEVICE);
  assert.equal(other.body.evidence[0].summary, 'keys last seen secret other room.');
  assert.notEqual(other.body.evidence[0].id, evidence.id);
});

test('local snippets remain usable, only cited server evidence is returned, and exclusions remove shared sightings', async t => {
  const f = await fixture(t, { claude: fakeClaude(keyPlan, params => {
    const all = memoriesIn(params.messages[0].content).filter(memory => memory.id !== 'clock-now');
    return { answer: 'Your saved note and last sighting.', card_type: 'answer', memory_ids: all.map(memory => memory.id),
      buttons: ['Thanks!'], supported: all.length > 0 };
  }) });
  await f.store.put(camera('own', 'desk'));
  const result = await f.post({ ...askBody, memories: [phoneMemory] });
  assert.equal(result.status, 200);
  assert.equal(result.body.evidence.length, 1);
  assert.equal(result.body.memory_ids[1], phoneMemory.id);
  const excluded = await f.post({ ...askBody, excluded_ids: [result.body.evidence[0].id] });
  assert.equal(excluded.status, 200);
  assert.deepEqual(excluded.body.evidence, []);
  assert.deepEqual(excluded.body.memory_ids, []);
  assert.match(excluded.body.answer, /not sure/);
  const localOnly = await fixture(t, { claude: fakeClaude([], defaultAnswer) });
  const local = await localOnly.post({ ...askBody, question: 'Where is my passport?', memories: [phoneMemory] });
  assert.deepEqual(local.body.evidence, []);
  assert.deepEqual(local.body.memory_ids, [phoneMemory.id]);
});

test('reserved or duplicate local IDs and malformed exclusion/session input fail before provider calls', async t => {
  const f = await fixture(t);
  for (const body of [
    { ...askBody, memories: [{ ...phoneMemory, id: 'shared:' + 'a'.repeat(64) }] },
    { ...askBody, memories: [{ ...phoneMemory, id: 'clock-now' }] },
    { ...askBody, memories: [phoneMemory, phoneMemory] },
    { ...askBody, patient: OTHER },
    { ...askBody, excluded_ids: ['phone-note'] },
    { ...askBody, excluded_ids: Array(25).fill('shared:' + 'a'.repeat(64)) },
  ]) assert.deepEqual((await f.post(body)).body.code, 'invalid_request');
  assert.equal((await f.post({ pin: 'not-digits' }, DEVICE, '/app/session')).body.code, 'invalid_request');
  assert.equal(f.claude.calls.length, 0);
});

test('planner permits only three validated read-only tools and never executes arbitrary model arguments', async t => {
  for (const plan of [
    [{ tool: 'set_reminder', text: 'Call me', in_minutes: 1 }],
    Array(4).fill({ tool: 'find_object', object: 'keys' }),
    [{ tool: 'get_schedule', date: '2026-10-01', end_date: '2026-12-01' }],
    [{ tool: 'get_schedule', date: 'not-a-date', end_date: null }],
    [{ tool: 'search_messages', query: null, date: null, end_date: '2026-10-11' }],
    [{ tool: 'find_object', object: 'keys', pin: '1234' }],
  ]) {
    const f = await fixture(t, { claude: fakeClaude(plan) });
    let reads = 0;
    f.store.list = async () => { reads++; return []; };
    const result = await f.post();
    assert.deepEqual([result.status, result.body.code], [502, 'provider_unavailable']);
    assert.deepEqual([reads, f.claude.calls.length], [0, 1]);
  }
});

test('empty shared plans fail closed and unsupported actions never reach answer inference', async t => {
  const missing = await fixture(t, { claude: fakeClaude([], defaultAnswer, 'shared_memory') });
  const empty = await missing.post({ ...askBody, question: 'Read my recent emails' });
  assert.deepEqual([empty.status, empty.body.code], [502, 'provider_unavailable']);
  assert.equal(missing.claude.calls.length, 1);
  const action = await fixture(t, { claude: fakeClaude([], () => {
    throw new Error('Action requests must never generate an answer');
  }, 'unsupported_action') });
  let reads = 0;
  action.store.list = async () => { reads++; return []; };
  const result = await action.post({ ...askBody, question: 'Remind me to water plants tomorrow' });
  assert.equal(result.status, 200);
  assert.equal(result.body.answer, 'This app cannot set reminders, send messages, or make calls.');
  assert.deepEqual(result.body.evidence, []);
  assert.deepEqual([reads, action.claude.calls.length], [0, 1]);
});

test('clock-only citations are valid only for an explicit clock intent', async t => {
  const f = await fixture(t, { claude: fakeClaude([], () => ({
    answer: 'It is 1:05 PM.', card_type: 'answer', memory_ids: ['clock-now'], buttons: ['Thanks!'], supported: true,
  }), 'clock') });
  const result = await f.post({ ...askBody, question: 'What time is it?' });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.memory_ids, ['clock-now']);
});

test('three planned tools reuse calendar, people and saved caregiver retrieval', async t => {
  const plan = [
    { tool: 'get_schedule', date: '2026-10-11', end_date: null },
    { tool: 'who_is', name: 'Sam' },
    { tool: 'care_instructions', topic: 'pills' },
  ];
  const f = await fixture(t, { claude: fakeClaude(plan, params => {
    const memories = memoriesIn(params.messages[0].content).filter(memory => memory.id !== 'clock-now');
    return { answer: 'Here are your saved records.', card_type: 'answer', memory_ids: memories.map(memory => memory.id),
      buttons: ['Thanks!'], supported: true };
  }) });
  for (const record of [
    { id: 'calendar-own', source: 'calendar', date: '2026-10-11', text: 'Coffee planned with Sam.' },
    { id: 'person-own', source: 'person', name: 'Sam', text: 'Sam is your brother.' },
    { id: 'care-own', source: 'caregiver', topic: 'pills', text: 'Ask your caregiver about your pills.' },
    { id: 'care-other', source: 'caregiver', topic: 'pills', text: 'Other instructions.', patient: OTHER },
  ]) await f.store.put({ timestamp: '2026-10-11T18:00:00Z', demo: false, ...record });
  const result = await f.post({ ...askBody, question: 'What is planned with Sam, who is he, and what did my caregiver say about pills?' });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.evidence.map(memory => memory.source), ['calendar', 'person', 'caregiver']);
  assert.doesNotMatch(JSON.stringify(result.body), /Other instructions/);
});

function fakeGoogle() {
  let generation = 1;
  let state = 'connected';
  const calls = [];
  return {
    calls, timeZone: async () => 'America/Los_Angeles',
    snapshot: async scope => ({ generation, scope, state }),
    assertCurrent: async context => { if (context.generation !== generation) throw new Error('private connection changed'); },
    covers: async () => true,
    mailFresh: async () => true,
    searchMail: async () => {
      calls.push('gmail');
      return [{ id: 'gmail-live', source: 'email', origin: 'google-gmail', timestamp: '2026-10-11T19:00:00Z',
        text: 'Fresh email about lunch.', ref: 'https://mail.google.com/mail/u/0/#all/test', demo: false }];
    },
    change: () => { generation++; },
    revoke: () => { state = 'reconnect_required'; },
  };
}

test('primary patient uses live Gmail and returns provenance; other patients never access Google', async t => {
  const google = fakeGoogle();
  const f = await fixture(t, { google, claude: fakeClaude(recentPlan) });
  await f.store.put({ id: 'other-email', source: 'email', timestamp: '2026-10-11T18:00:00Z',
    text: 'Own secondary email.', patient: OTHER, demo: false });
  const result = await f.post({ ...askBody, question: 'Read my recent emails' });
  assert.equal(result.status, 200);
  assert.deepEqual(google.calls, ['gmail']);
  assert.deepEqual(result.body.evidence[0].provenance, {
    source: 'email', timestamp: '2026-10-11T19:00:00Z', origin: 'google-gmail',
    ref: 'https://mail.google.com/mail/u/0/#all/test',
  });
  const other = await f.post({ ...askBody, question: 'Read my recent emails' }, OTHER_DEVICE);
  assert.equal(other.status, 200);
  assert.equal(other.body.evidence[0].summary, 'Own secondary email.');
  assert.deepEqual(google.calls, ['gmail']);
});

test('Google account replacement or revoked scope during answer generation blocks the entire reply', async t => {
  for (const change of ['change', 'revoke', 'during-final-check']) {
    const google = fakeGoogle();
    let answered = false;
    const assertCurrent = google.assertCurrent;
    google.assertCurrent = async context => {
      await assertCurrent(context);
      if (change === 'during-final-check' && answered) google.change();
    };
    const f = await fixture(t, { google, claude: fakeClaude(recentPlan, params => {
      answered = true;
      if (change !== 'during-final-check') google[change]();
      return defaultAnswer(params);
    }) });
    const result = await f.post();
    assert.deepEqual([result.status, result.body.code], [503, 'memory_unavailable']);
    assert.equal(result.body.evidence, undefined);
    assert.doesNotMatch(JSON.stringify(result.body), /Fresh email|private connection/);
  }
});

test('Google revocation during another lookup blocks records before answer-model inference', async t => {
  const google = fakeGoogle();
  const f = await fixture(t, { google, claude: fakeClaude([...recentPlan, ...keyPlan]) });
  const list = f.store.list.bind(f.store);
  f.store.list = async source => {
    if (source === 'camera') {
      await new Promise(resolve => setTimeout(resolve, 15));
      google.change();
    }
    return list(source);
  };
  const result = await f.post();
  assert.deepEqual([result.status, result.body.code], [503, 'memory_unavailable']);
  assert.equal(f.claude.calls.length, 1, 'Revoked email never reaches the answer model');
});

test('lookup/database errors and stale Google access stay explicit and never become no-memory answers', async t => {
  const failing = await fixture(t);
  failing.store.list = async () => { throw new Error('private database password or record'); };
  const failed = await failing.post();
  assert.deepEqual([failed.status, failed.body.code], [503, 'memory_unavailable']);
  assert.equal(failing.claude.calls.length, 1);
  assert.doesNotMatch(JSON.stringify(failed.body), /password|record|not sure/);
  const google = fakeGoogle();
  google.revoke();
  const stale = await fixture(t, { google, claude: fakeClaude(recentPlan) });
  assert.equal((await stale.post()).body.code, 'memory_unavailable');
  assert.deepEqual(google.calls, []);
});

test('fabricated citations and ungrounded supported answers fail; unsupported model prose is replaced', async t => {
  for (const bad of [
    { memory_ids: ['invented'], supported: true },
    { memory_ids: [], supported: true },
    { memory_ids: ['clock-now'], supported: true },
  ]) {
    const f = await fixture(t, { claude: fakeClaude(keyPlan, () => ({
      answer: 'Your keys are on Mars.', card_type: 'answer', buttons: ['Thanks!'], ...bad,
    })) });
    assert.equal((await f.post()).body.code, 'provider_unavailable');
  }
  const unsupported = await fixture(t, { claude: fakeClaude([], () => ({
    answer: 'Untrusted unsupported prose.', card_type: 'answer', memory_ids: [], buttons: ['Thanks!'], supported: false,
  })) });
  const result = await unsupported.post();
  assert.match(result.body.answer, /not sure/);
  assert.doesNotMatch(result.body.answer, /Untrusted/);
});

test('total deadline aborts pending model work and does not start later lookups', async t => {
  let aborted = false;
  const claude = { beta: { messages: { create(_params, { signal }) {
    return new Promise((_, reject) => signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); }, { once: true }));
  } } } };
  const f = await fixture(t, { claude, appMemory: { timeoutMs: 30 } });
  let reads = 0;
  f.store.list = async () => { reads++; return []; };
  const result = await f.post();
  assert.deepEqual([result.status, result.body.code], [503, 'memory_unavailable']);
  assert.equal(aborted, true);
  assert.equal(reads, 0);
});

test('Gemini uses structured planning and answer schemas on the same scoped retrieval route', async t => {
  const requests = [];
  const gemini = createGemini('test-gemini', async (_url, init) => {
    const body = JSON.parse(init.body);
    requests.push(body);
    const output = body.systemInstruction.parts[0].text === PLAN_PROMPT ? { intent: 'shared_memory', calls: keyPlan } : defaultAnswer({
      messages: [{ content: body.contents[0].parts[0].text }],
    });
    return Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(output) }] } }] });
  });
  const f = await fixture(t, { config: { STEPH_PROVIDER: 'gemini', GEMINI_API_KEY: 'test-gemini' }, gemini });
  await f.store.put(camera('own', 'desk'));
  const result = await f.post();
  assert.equal(result.status, 200);
  assert.equal(result.body.evidence.length, 1);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].generationConfig.responseJsonSchema.properties.calls.maxItems, 3);
  assert.ok(requests[1].generationConfig.responseJsonSchema.required.includes('supported'));
  assert.equal(requests[1].systemInstruction.parts[0].text, APP_ANSWER_PROMPT);
  assert.equal(f.claude.calls.length, 0);
});
