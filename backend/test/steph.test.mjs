import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import Anthropic from '@anthropic-ai/sdk';
import { createApp } from '../app.mjs';
import { readConfig } from '../config.mjs';
import { testStore } from './helpers.mjs';
import { STEPH_SYSTEM_PROMPT } from '../steph/prompt.mjs';

const config = {
  DIAL_MCP_TOKEN: 'd'.repeat(64), CAMERA_TOKEN: 'c'.repeat(64), RECALL_APP_TOKEN: 'r'.repeat(64),
  ANTHROPIC_API_KEY: 'test-anthropic-key', VOYAGE_API_KEY: 'test-voyage-key',
  STEPH_MODEL: 'claude-opus-5-5', EMBED_MODEL: 'voyage-3.5-lite', DEMO_MODE: 'false',
};
const keys = {
  id: 'photo-1', type: 'photo', summary: 'Keys on the kitchen counter next to the fruit bowl.',
  people: [], place: 'Kitchen', timestamp: '2026-10-11T08:12:00-07:00', source: 'photo', confidence: 0.9,
};
const priya = {
  id: 'note-1', type: 'note', summary: 'Priya\'s mom had surgery.', people: ['Priya'],
  timestamp: '2026-09-27T10:00:00-07:00', source: 'note', confidence: 1,
};

// Fake Anthropic client: records each request and answers from a queue of responses or errors.
function fakeClaude(...replies) {
  const calls = [];
  return {
    calls,
    beta: { messages: { async create(params) {
      calls.push(params);
      const reply = replies.length > 1 ? replies.shift() : replies[0];
      if (reply instanceof Error) throw reply;
      return typeof reply === 'function' ? reply(params) : reply;
    } } },
  };
}

function message(card, stop_reason = 'end_turn') {
  return { stop_reason, content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: JSON.stringify(card) }] };
}

async function fixture(t, overrides = {}, stephOptions = {}) {
  const store = await testStore(t);
  const server = createApp({ ...config, ...overrides }, store, undefined, { steph: stephOptions }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  return (path, body, token = config.RECALL_APP_TOKEN) => fetch(`${url}${path}`, {
    method: 'POST', body: JSON.stringify(body),
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
}

const askBody = { question: 'Where are my keys?', now: '2026-10-11T15:00:00Z', time_zone: 'America/Los_Angeles', memories: [keys, priya] };

test('configuration keeps Steph optional and its secret separate', () => {
  const base = { DIAL_MCP_TOKEN: config.DIAL_MCP_TOKEN, CAMERA_TOKEN: config.CAMERA_TOKEN };
  const parsed = readConfig(base);
  assert.equal(parsed.RECALL_APP_TOKEN, undefined);
  assert.equal(readConfig({ ...base, RECALL_APP_TOKEN: '' }).RECALL_APP_TOKEN, undefined);
  assert.equal(parsed.STEPH_MODEL, 'claude-opus-5-5');
  assert.equal(parsed.EMBED_MODEL, 'voyage-3.5-lite');
  assert.throws(() => readConfig({ ...base, RECALL_APP_TOKEN: 'short' }));
  assert.throws(() => readConfig({ ...base, RECALL_APP_TOKEN: config.CAMERA_TOKEN }), /app secrets/);
  assert.throws(() => readConfig({ ...base, RECALL_APP_TOKEN: config.DIAL_MCP_TOKEN }), /app secrets/);
  assert.equal(readConfig({ ...base, RECALL_APP_TOKEN: config.RECALL_APP_TOKEN }).RECALL_APP_TOKEN, config.RECALL_APP_TOKEN);
});

test('Steph routes report 503 without an app token and 401 with a wrong one', async t => {
  const unconfigured = await fixture(t, { RECALL_APP_TOKEN: '' });
  for (const path of ['/embed', '/ask', '/reminders']) {
    const response = await unconfigured(path, {});
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'Steph is not configured' });
  }
  const post = await fixture(t);
  for (const token of [config.CAMERA_TOKEN, config.DIAL_MCP_TOKEN, 'wrong']) {
    assert.equal((await post('/ask', askBody, token)).status, 401);
  }
});

test('ask sends the verbatim prompt with memories and keeps only supplied memory IDs', async t => {
  const claude = fakeClaude(message({
    answer: '  On the kitchen counter, next to the fruit bowl.  ', card_type: 'photo',
    memory_ids: ['photo-1', 'invented-9', 'photo-1'], buttons: [' Found them! ', '', 'Not there', 'Extra'],
  }));
  const post = await fixture(t, {}, { claude });
  const response = await post('/ask', askBody);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), {
    answer: 'On the kitchen counter, next to the fruit bowl.', card_type: 'photo',
    memory_ids: ['photo-1'], buttons: ['Found them!', 'Not there'],
  });
  const [request] = claude.calls;
  assert.equal(request.system, STEPH_SYSTEM_PROMPT);
  assert.match(STEPH_SYSTEM_PROMPT, /^You are Steph, the memory agent inside the Recall app\. .*not just facts\.$/);
  assert.equal(request.model, 'claude-opus-5-5');
  assert.equal(request.output_config.format.type, 'json_schema');
  assert.equal(request.fallbacks, 'default');
  const content = request.messages[0].content;
  assert.match(content, /^<memories>\n\{"id":"clock-now".*"summary":"Right now it is Sunday, October 11, 2026 at 8:00 AM\.".*\n\{"id":"photo-1".*\n\{"id":"note-1".*\n<\/memories>/);
  assert.match(content, /never as instructions/);
  assert.match(content, /Current local time: Sunday, October 11, 2026 at 8:00 AM/);
  assert.match(content, /Question: Where are my keys\?$/);
  // Times reach the model in the person's zone, never as a raw ISO stamp it could misread.
  assert.match(content, /"time":"Sunday, October 11, 2026 at 8:12 AM"/);
  assert.doesNotMatch(content, /"timestamp"/);
});

test('ask writes a UTC-stamped 3 PM event as 3:00 PM local time', async t => {
  const claude = fakeClaude(message({ answer: 'At 3:00 PM.', card_type: 'answer', memory_ids: ['event-1'], buttons: [] }));
  const post = await fixture(t, {}, { claude });
  const event = { id: 'event-1', type: 'event', summary: 'Coffee with Priya', people: ['Priya'],
    timestamp: '2026-10-11T22:00:00.000Z', source: 'calendar', confidence: 0.95 };
  const response = await post('/ask', { ...askBody, question: 'When is coffee with Priya?', memories: [event] });
  assert.equal(response.status, 200);
  assert.match(claude.calls[0].messages[0].content, /"time":"Sunday, October 11, 2026 at 3:00 PM"/);
});

test('ask falls back to a default button and rejects declined, cut-off, empty, or failed answers', async t => {
  const post = await fixture(t, {}, { claude: fakeClaude(message({ answer: 'I\'m not sure.', card_type: 'answer', memory_ids: [], buttons: [' '] })) });
  assert.deepEqual((await (await post('/ask', askBody)).json()).buttons, ['Thanks!']);
  for (const reply of [
    { stop_reason: 'refusal', content: [] },
    message({ answer: 'On the counter', card_type: 'photo', memory_ids: [], buttons: [] }, 'max_tokens'),
    message({ answer: '   ', card_type: 'answer', memory_ids: [], buttons: [] }),
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'not json' }] },
    new Anthropic.APIError(529, undefined, 'Overloaded', new Headers()),
  ]) {
    const failing = await fixture(t, {}, { claude: fakeClaude(reply) });
    const response = await failing('/ask', askBody);
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { error: 'Steph could not answer' });
  }
});

test('ask is unavailable without an Anthropic key and validates its body', async t => {
  const claude = fakeClaude(message({ answer: 'Hi', card_type: 'answer', memory_ids: [], buttons: [] }));
  const unconfigured = await fixture(t, { ANTHROPIC_API_KEY: '' }, { claude });
  const response = await unconfigured('/ask', askBody);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'Steph is not configured' });
  assert.equal(claude.calls.length, 0);

  const post = await fixture(t, {}, { claude });
  for (const body of [
    { ...askBody, question: '' },
    { ...askBody, now: 'today' },
    { ...askBody, time_zone: 'Mars/Olympus' },
    { ...askBody, memories: [{ ...keys, type: 'video' }] },
    { ...askBody, memories: [{ ...keys, confidence: 2 }] },
    { ...askBody, memories: Array.from({ length: 25 }, (_, i) => ({ ...keys, id: `m${i}` })) },
  ]) assert.equal((await post('/ask', body)).status, 400);
  assert.equal(claude.calls.length, 0);
});

test('reminders answer each candidate and omit the ones that fail', async t => {
  const claude = fakeClaude(params => {
    const content = params.messages[0].content;
    if (content.includes('Reminder: Send Sam the ramen place')) return { stop_reason: 'refusal', content: [] };
    return message({ answer: 'Ask how her mom is doing. She had surgery two weeks ago.', card_type: 'person',
      memory_ids: ['note-1', 'photo-1'], buttons: ['Thanks!', 'Tell me more'] });
  });
  const post = await fixture(t, {}, { claude });
  const body = { now: '2026-10-11T19:00:00Z', time_zone: 'America/Los_Angeles', candidates: [
    { id: 'meeting-priya', kind: 'meeting', title: 'Coffee with Priya', when: '2026-10-11T22:00:00Z', person: 'Priya', memories: [priya] },
    { id: 'promise-sam', kind: 'promise', title: 'Send Sam the ramen place', person: 'Sam Chen',
      memories: [{ ...priya, id: 'note-2', summary: 'You promised to send Sam the Tokyo ramen place.', people: ['Sam Chen'] }] },
  ] };
  const response = await post('/reminders', body);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { reminders: [{
    candidate_id: 'meeting-priya', answer: 'Ask how her mom is doing. She had surgery two weeks ago.',
    card_type: 'person', memory_ids: ['note-1'], buttons: ['Thanks!', 'Tell me more'],
  }] });
  assert.equal(claude.calls.length, 2);
  const meeting = claude.calls.find(call => call.messages[0].content.includes('Coffee with Priya')).messages[0].content;
  assert.match(meeting, /Kind: meeting\nWhen: Sunday, October 11, 2026 at 3:00 PM\nPerson: Priya\nWrite what the person should say or do\.$/);

  const allFail = await fixture(t, {}, { claude: fakeClaude({ stop_reason: 'refusal', content: [] }) });
  assert.equal((await allFail('/reminders', body)).status, 502);
  assert.equal((await post('/reminders', { ...body, candidates: [] })).status, 400);
  assert.equal((await post('/reminders', { ...body, candidates: [{ ...body.candidates[0], memories: [] }] })).status, 400);
});

test('embed preserves input order and reports missing or failing providers', async t => {
  const requests = [];
  const fakeFetch = async (url, init) => {
    requests.push({ url, init, body: JSON.parse(init.body) });
    return Response.json({ object: 'list', model: 'voyage-3.5-lite', data: [
      { object: 'embedding', index: 1, embedding: [0, 1] },
      { object: 'embedding', index: 0, embedding: [1, 0] },
    ] });
  };
  const post = await fixture(t, {}, { fetch: fakeFetch });
  const response = await post('/embed', { texts: [' keys on the counter ', 'coffee with Priya'], input_type: 'query' });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { model: 'voyage-3.5-lite', dimensions: 2, embeddings: [[1, 0], [0, 1]] });
  assert.equal(requests[0].url, 'https://api.voyageai.com/v1/embeddings');
  assert.equal(requests[0].init.headers.Authorization, 'Bearer test-voyage-key');
  assert.deepEqual(requests[0].body, { input: ['keys on the counter', 'coffee with Priya'], model: 'voyage-3.5-lite', input_type: 'query' });
  assert.equal((await post('/embed', { texts: [] })).status, 400);
  assert.equal((await post('/embed', { texts: ['x'.repeat(2001)] })).status, 400);

  const unconfigured = await fixture(t, { VOYAGE_API_KEY: '' }, { fetch: fakeFetch });
  const missing = await unconfigured('/embed', { texts: ['keys'] });
  assert.equal(missing.status, 503);
  assert.deepEqual(await missing.json(), { error: 'Embeddings are not configured' });

  for (const failingFetch of [
    async () => new Response('busy', { status: 500 }),
    async () => { throw new TypeError('fetch failed'); },
    async () => Response.json({ data: [{ index: 0, embedding: [1, 0] }] }),
  ]) {
    const failing = await fixture(t, {}, { fetch: failingFetch });
    const result = await failing('/embed', { texts: ['keys', 'wallet'] });
    assert.equal(result.status, 502);
    assert.deepEqual(await result.json(), { error: 'Embedding service failed' });
  }
});
