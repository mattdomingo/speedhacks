import test from 'node:test';
import assert from 'node:assert/strict';
import { ADA, SAM, STEPH, START, fixture, mcpClient, postWebhook, reply, signIn, toolUse, turn } from './brain-helpers.mjs';

const iso = ms => new Date(ms).toISOString();
const sms = (id, from, body) => ({ id: `evt-${id}`, object: 'event', type: 'message.received',
  data: { messageId: id, from, to: STEPH, channel: 'sms', body } });

test('a text to Steph is answered once by StephBrain, from her number, and logged', async t => {
  const f = await fixture(t, { script: params => {
    assert.match(params.messages[0].content[0].text, /channel: sms/);
    assert.match(params.messages[0].content[0].text, /at most 320 characters/);
    return turn(reply('r1', 'Your flight leaves at 6:00 PM from SFO.'));
  } });
  const { token, user } = await signIn(f, { phone: ADA });
  const first = await postWebhook(f, sms('m1', ADA, "When's my flight?"));
  assert.equal(first.status, 200);
  const answers = f.dial.texts.filter(text => text.to === ADA && /flight/.test(text.body));
  assert.deepEqual(answers.map(text => [text.from, text.body]), [[STEPH, 'Your flight leaves at 6:00 PM from SFO.']]);
  await postWebhook(f, sms('m1', ADA, "When's my flight?"));
  await postWebhook(f, { ...sms('m1', ADA, "When's my flight?"), id: 'evt-redelivered-differently' });
  assert.equal(f.dial.texts.filter(text => /flight/.test(text.body)).length, 1, 'redeliveries never answer twice');
  await postWebhook(f, sms('m2', '+14155550999', 'hello?'));
  assert.equal(f.claude.requests.length, 1, 'unknown numbers are not answered');
  const timeline = (await f.api('/v1/timeline', { token })).body.entries;
  assert.deepEqual(timeline.map(entry => [entry.channel, entry.direction]), [['sms', 'out'], ['sms', 'in']]);
  assert.equal((await f.api('/v1/diagnostics', { token })).body.decisions[0].reason, 'texted back: you texted me');
  assert.ok(user);
});

test('after a call, the transcript joins the timeline and becomes memories', async t => {
  const f = await fixture(t, { script: params => {
    assert.ok(params.output_config?.format, 'fact extraction uses structured output');
    assert.match(params.messages[0].content, /<transcript>/);
    return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ facts: [
      { summary: 'Put the passport in the desk drawer', people: [], place: 'Desk drawer' }] }) }] };
  } });
  const { token, user } = await signIn(f, { phone: ADA });
  f.dial.callRecords['c-77'] = { id: 'c-77', direction: 'inbound', from: ADA, to: STEPH, callStartedAt: iso(START - 3_600_000),
    transcriptTurns: [
      { speaker: 'agent', text: 'Hi, this is Steph, an AI assistant.', startMs: 0 },
      { speaker: 'user', text: 'I put my passport in the desk drawer.', startMs: 4000 },
    ] };
  const event = { id: 'evt-tr-1', type: 'call.transcribed', data: { callId: 'c-77' } };
  await postWebhook(f, event);
  await postWebhook(f, event);
  const entries = (await f.api('/v1/timeline', { token })).body.entries.filter(entry => entry.channel === 'call');
  assert.deepEqual(entries.map(entry => [entry.direction, entry.text]), [
    ['in', 'I put my passport in the desk drawer.'], ['out', 'Hi, this is Steph, an AI assistant.']]);
  const memories = await f.store.memoryCandidates(user.id, {});
  assert.deepEqual(memories.map(memory => memory.source).sort(), ['call', 'call']);
  assert.ok(memories.some(memory => memory.summary === 'Put the passport in the desk drawer' && memory.place === 'Desk drawer'));
  assert.equal(f.claude.requests.length, 1, 'a re-delivered transcript is filed once');
});

test('Dial calls get the same tools: memories for the verified person in or out on Steph\'s line, actions only on her line', async t => {
  const f = await fixture(t);
  const { user } = await signIn(f, { phone: ADA });
  await f.store.upsertMemories(user.id, [{ source_ref: 'app:keys', type: 'note', summary: 'Keys are in the blue bowl', source: 'app',
    confidence: 0.9, time: iso(START) }], iso(START));
  const inbound = await mcpClient(t, f, { 'X-Dial-User-Number': ADA, 'X-Dial-Direction': 'inbound', 'X-Dial-Agent-Number': STEPH });
  const names = (await inbound.listTools()).tools.map(tool => tool.name);
  for (const name of ['search_memories', 'recent_conversation', 'set_reminder', 'log_medication', 'send_text']) assert.ok(names.includes(name), name);
  for (const name of ['forget', 'confirm_pending', 'disconnect_google', 'reply']) assert.ok(!names.includes(name), name);
  const found = await inbound.callTool({ name: 'search_memories', arguments: { query: 'keys' } });
  assert.equal(found.structuredContent.memories[0].summary, 'Keys are in the blue bowl');
  const outbound = await mcpClient(t, f, { 'X-Dial-User-Number': ADA, 'X-Dial-Direction': 'outbound', 'X-Dial-Agent-Number': STEPH });
  assert.equal((await outbound.callTool({ name: 'search_memories', arguments: { query: 'keys' } })).isError, undefined);
  const set = await outbound.callTool({ name: 'set_reminder', arguments: { text: 'Take the pill again', in_minutes: 10 } });
  assert.match(set.structuredContent.reminder.spoken_time, /Monday, October 12 at 10:10 AM/);
  const offLine = await mcpClient(t, f, { 'X-Dial-User-Number': ADA, 'X-Dial-Direction': 'outbound' });
  assert.equal((await offLine.callTool({ name: 'search_memories', arguments: { query: 'keys' } })).isError, true);
  assert.equal((await offLine.callTool({ name: 'set_reminder', arguments: { text: 'x', in_minutes: 5 } })).isError, true);
  const stranger = await mcpClient(t, f, { 'X-Dial-User-Number': SAM, 'X-Dial-Direction': 'inbound', 'X-Dial-Agent-Number': STEPH });
  assert.equal((await stranger.callTool({ name: 'search_memories', arguments: { query: 'keys' } })).isError, true);
  assert.equal((await f.store.users()).length, 1, 'an unknown caller creates nothing');
});

test('with a caller PIN, phone memories and actions need it but the clock does not', async t => {
  const f = await fixture(t, { overrides: { CALLER_PIN: '4821' } });
  await signIn(f, { phone: ADA });
  const client = await mcpClient(t, f, { 'X-Dial-User-Number': ADA, 'X-Dial-Direction': 'inbound', 'X-Dial-Agent-Number': STEPH });
  assert.match((await client.callTool({ name: 'search_memories', arguments: { query: 'keys' } })).content[0].text, /PIN is required/);
  assert.match((await client.callTool({ name: 'set_reminder', arguments: { text: 'x', in_minutes: 5 } })).content[0].text, /PIN is required/);
  assert.equal((await client.callTool({ name: 'whats_today', arguments: {} })).structuredContent.date, '2026-10-12');
  assert.equal((await client.callTool({ name: 'search_memories', arguments: { query: 'keys', pin: '4821' } })).isError, undefined);
});

test('"Remind me to call mom tomorrow" lands on Google Calendar when it is connected', async t => {
  const f = await fixture(t, { script: (params, index) => index === 0
    ? turn(toolUse('e1', 'add_calendar_event', { title: 'Call mom', at: '2026-10-13T10:00' }))
    : turn(reply('r1', "Done. I added 'Call mom' to your calendar for tomorrow at 10.")) });
  const { token } = await signIn(f, { phone: ADA });
  const answer = (await f.api('/v1/steph/message', { token, body: { text: 'Remind me to call mom tomorrow at 10' } })).body;
  assert.match(answer.reply.text, /added 'Call mom'/);
  assert.deepEqual(f.google.created, [{ title: 'Call mom', start: '2026-10-13T17:00:00.000Z', end: '2026-10-13T17:30:00.000Z', description: undefined }]);
});

test('a text the carrier rejects shows up in Diagnostics with the reason', async t => {
  const f = await fixture(t, { script: () => turn(reply('r1', 'Here you go.')) });
  const { token } = await signIn(f, { phone: ADA });
  await f.api('/v1/steph/message', { token, body: { text: 'Hello' } });
  await f.api('/v1/steph/text-me', { token, body: {} });
  const messageId = `msg-${f.dial.texts.length}`;
  await postWebhook(f, { id: 'evt-st-1', type: 'message.status_changed', data: { messageId, deliveryState: 'undelivered',
    deliveryError: "The carrier rejected the message because the sender isn't registered for A2P/10DLC messaging." } });
  const [latest] = (await f.api('/v1/diagnostics', { token })).body.decisions;
  assert.equal(latest.reason, "text not delivered: The carrier rejected the message because the sender isn't registered for A2P/10DLC messaging.");
});
