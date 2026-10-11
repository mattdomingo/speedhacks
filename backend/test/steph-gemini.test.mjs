import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../app.mjs';
import { readConfig } from '../config.mjs';
import { createHealth } from '../health.mjs';
import { checkGeminiKey, createGemini } from '../steph/gemini.mjs';
import { cardFormat, STEPH_SYSTEM_PROMPT } from '../steph/prompt.mjs';
import { stephProvider } from '../steph/routes.mjs';
import { testStore, TEST_DATABASE_URL } from './helpers.mjs';

const TOKEN = 'r'.repeat(64);
const base = { DIAL_MCP_TOKEN: 'd'.repeat(64), CAMERA_TOKEN: 'c'.repeat(64), RECALL_APP_TOKEN: TOKEN, DATABASE_URL: TEST_DATABASE_URL };
const keys = { id: 'photo-keys', type: 'photo', summary: 'Keys on the kitchen counter next to the fruit bowl.', people: [],
  place: 'Kitchen', timestamp: '2026-10-11T08:12:00-07:00', source: 'photo', confidence: 0.9 };
const ask = { question: 'Where are my keys?', now: '2026-10-11T13:05:00-07:00', time_zone: 'America/Los_Angeles', memories: [keys] };
const card = { answer: 'On the kitchen counter, next to the fruit bowl.', card_type: 'photo', memory_ids: ['photo-keys', 'made-up'],
  buttons: ['Found them!', 'Not there', 'Extra'] };

const geminiReply = (text, { finishReason = 'STOP', blockReason, thought } = {}) => Response.json({
  candidates: blockReason ? [] : [{ finishReason, content: { role: 'model', parts: [
    ...(thought ? [{ text: thought, thought: true }] : []), { text },
  ] } }],
  ...(blockReason ? { promptFeedback: { blockReason } } : {}),
});

// Never answers; a ref'd placeholder keeps the event loop alive until the client's unref'd timeout fires.
function hang(signal) {
  return new Promise((_, reject) => {
    const keepAlive = setTimeout(() => {}, 10_000);
    signal.addEventListener('abort', () => { clearTimeout(keepAlive); reject(signal.reason); });
  });
}

async function fixture(t, env, { gemini, claude } = {}) {
  const store = await testStore(t);
  const server = createApp(readConfig({ ...base, ...env }), store, undefined, { steph: { gemini, claude } }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return async (body = ask, path = '/ask') => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method: 'POST', body: JSON.stringify(body), headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    });
    return { status: response.status, body: await response.json() };
  };
}

function fakeFetch(respond) {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, init, body: init.body ? JSON.parse(init.body) : undefined });
    return respond(init);
  };
  return { requests, fetchImpl };
}

test('Gemini gets the verbatim system prompt, the same user turn and the card schema; its card is hardened like Claude\'s', async t => {
  const api = fakeFetch(() => geminiReply(JSON.stringify(card), { thought: 'Thinking about keys…' }));
  const post = await fixture(t, { GEMINI_API_KEY: 'g-key' }, { gemini: createGemini('g-key', api.fetchImpl) });
  const reply = await post();
  assert.equal(reply.status, 200);
  assert.deepEqual(reply.body, { answer: card.answer, card_type: 'photo', memory_ids: ['photo-keys'], buttons: ['Found them!', 'Not there'] });
  const [{ url, init, body }] = api.requests;
  assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent');
  assert.equal(init.headers['x-goog-api-key'], 'g-key');
  assert.equal(body.systemInstruction.parts[0].text, STEPH_SYSTEM_PROMPT);
  assert.equal(body.contents[0].role, 'user');
  assert.match(body.contents[0].parts[0].text, /<memories>\n\{"id":"clock-now".*\n\{"id":"photo-keys"[\s\S]*Question: Where are my keys\?$/);
  assert.deepEqual(body.generationConfig, { responseMimeType: 'application/json', responseJsonSchema: cardFormat.schema,
    thinkingConfig: { thinkingLevel: 'minimal' } });
});

test('Gemini replies wrapped in prose are recovered; blocked, unsafe, truncated and broken replies give a calm 502', async t => {
  for (const [name, response, status] of [
    ['prose-wrapped JSON', () => geminiReply(`Sure! ${JSON.stringify(card)} Hope that helps.`), 200],
    ['SAFETY finish', () => geminiReply(JSON.stringify(card), { finishReason: 'SAFETY' }), 502],
    ['RECITATION finish', () => geminiReply(JSON.stringify(card), { finishReason: 'RECITATION' }), 502],
    ['MAX_TOKENS finish', () => geminiReply('{"answer": "On the', { finishReason: 'MAX_TOKENS' }), 502],
    ['blocked prompt', () => geminiReply('', { blockReason: 'SAFETY' }), 502],
    ['empty answer', () => geminiReply('{"answer": "", "card_type": "answer", "memory_ids": [], "buttons": []}'), 502],
    ['server error', () => new Response('{"error": {"message": "Where are my keys? echoed"}}', { status: 500 }), 502],
    ['not JSON', () => new Response('<html>oops</html>', { status: 200 }), 502],
  ]) {
    const post = await fixture(t, { GEMINI_API_KEY: 'g-key' }, { gemini: createGemini('g-key', fakeFetch(response).fetchImpl) });
    const reply = await post();
    assert.equal(reply.status, status, name);
    if (status === 502) assert.deepEqual(reply.body, { error: 'Steph could not answer' }, name);
  }
});

test('Gemini 429 answers 503 busy, a timeout answers 502, and nothing about the question is logged', async t => {
  const logged = [];
  const original = console.error;
  console.error = (...args) => logged.push(args.join(' '));
  t.after(() => { console.error = original; });
  const busy = await fixture(t, { GEMINI_API_KEY: 'g-key' },
    { gemini: createGemini('g-key', fakeFetch(() => new Response('{}', { status: 429 })).fetchImpl) });
  assert.deepEqual(await busy(), { status: 503, body: { error: 'Steph is busy right now' } });
  const reminders = { now: ask.now, candidates: [{ id: 'c1', kind: 'meeting', title: 'Coffee', memories: [keys] }] };
  assert.deepEqual(await busy(reminders, '/reminders'), { status: 503, body: { error: 'Steph is busy right now' } });
  const slow = await fixture(t, { GEMINI_API_KEY: 'g-key' },
    { gemini: createGemini('g-key', fakeFetch(init => hang(init.signal)).fetchImpl, { timeoutMs: 50 }) });
  assert.deepEqual(await slow(), { status: 502, body: { error: 'Steph could not answer' } });
  assert.ok(logged.some(line => /Gemini request failed: (429|TimeoutError)/.test(line)));
  assert.ok(logged.every(line => !/keys|kitchen|Where are/i.test(line)));
});

test('STEPH_PROVIDER auto prefers Claude, then Gemini; explicit choices are honoured', async t => {
  const pick = env => stephProvider(readConfig({ ...base, ...env }));
  assert.equal(pick({}), null);
  assert.deepEqual(pick({ GEMINI_API_KEY: 'g' }), { name: 'gemini', model: 'gemini-3.5-flash-lite' });
  assert.deepEqual(pick({ ANTHROPIC_API_KEY: 'a', GEMINI_API_KEY: 'g' }), { name: 'claude', model: 'claude-opus-5-5' });
  assert.equal(pick({ ANTHROPIC_API_KEY: 'a', GEMINI_API_KEY: 'g', STEPH_PROVIDER: 'gemini' }).name, 'gemini');
  assert.equal(pick({ GEMINI_API_KEY: 'g', STEPH_PROVIDER: 'claude' }), null);
  assert.deepEqual(pick({ GEMINI_API_KEY: 'g', STEPH_GEMINI_MODEL: 'gemini-3.8-flash' }).model, 'gemini-3.8-flash');
  assert.throws(() => readConfig({ ...base, STEPH_PROVIDER: 'openai' }));

  const api = fakeFetch(() => geminiReply(JSON.stringify(card)));
  const claudeCalls = [];
  const claude = { beta: { messages: { async create(params) {
    claudeCalls.push(params);
    return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(card) }] };
  } } } };
  const both = await fixture(t, { ANTHROPIC_API_KEY: 'a', GEMINI_API_KEY: 'g' }, { claude, gemini: createGemini('g', api.fetchImpl) });
  assert.equal((await both()).status, 200);
  assert.deepEqual([claudeCalls.length, api.requests.length], [1, 0]);
  const forced = await fixture(t, { ANTHROPIC_API_KEY: 'a', GEMINI_API_KEY: 'g', STEPH_PROVIDER: 'gemini' },
    { claude, gemini: createGemini('g', api.fetchImpl) });
  assert.equal((await forced()).status, 200);
  assert.deepEqual([claudeCalls.length, api.requests.length], [1, 1]);
  const none = await fixture(t, { GEMINI_API_KEY: 'g', STEPH_PROVIDER: 'claude' });
  assert.deepEqual(await none(), { status: 503, body: { error: 'Steph is not configured' } });
});

test('health validates the Gemini key with a cheap models read and names the active Steph provider', async t => {
  const api = fakeFetch(() => new Response('{"models": []}', { status: 200 }));
  await checkGeminiKey('g-key', api.fetchImpl);
  assert.equal(api.requests[0].url, 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1');
  assert.equal(api.requests[0].init.headers['x-goog-api-key'], 'g-key');
  const bad = fakeFetch(() => new Response('{"error": {"status": "INVALID_ARGUMENT"}}', { status: 400 }));
  const store = await testStore(t);
  const health = createHealth(readConfig({ ...base, GEMINI_API_KEY: 'g-key' }), store, {
    checks: { gemini: () => checkGeminiKey('g-key', bad.fetchImpl) } });
  const report = await health();
  assert.equal(report.checks.gemini, 'invalid');
  assert.deepEqual(report.steph, { provider: 'gemini', model: 'gemini-3.5-flash-lite' });
  const none = await createHealth(readConfig(base), store, { checks: {} })();
  assert.deepEqual([none.checks.gemini, none.steph], ['missing', null]);
});
