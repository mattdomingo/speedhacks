import test from 'node:test';
import assert from 'node:assert/strict';
import { ADA, START, fixture, reply, signIn, toolResult, toolUse, turn } from './brain-helpers.mjs';

const iso = ms => new Date(ms).toISOString();
const memory = (ref, summary, extra = {}) => ({ source_ref: ref, type: 'note', summary, source: 'app', confidence: 0.9,
  time: iso(START - 3_600_000), ...extra });

test('one Steph across channels: the app sees what was said on a call, through the shared timeline and tools', async t => {
  const f = await fixture(t, { script: (params, index) => {
    if (index === 0) return turn(toolUse('u1', 'recent_conversation', { channel: 'call', hours: 12 }));
    const transcript = toolResult(params, 'u1');
    assert.equal(transcript.entries[0].text, 'Your gate is B22 and boarding starts at 2:40.');
    return turn(reply('u2', 'On the call I said your gate is B22.'));
  } });
  const { token, user } = await signIn(f, { phone: ADA });
  await f.store.addTimeline({ user_id: user.id, channel: 'call', direction: 'out', text: 'Your gate is B22 and boarding starts at 2:40.',
    at: iso(START - 2 * 3_600_000), ref: 'call:c1:0', call_id: 'c1', kind: 'transcript' });
  const answer = await f.api('/v1/steph/message', { token, body: { text: 'What did you tell me on the call this morning?', context: { in_app: true } } });
  assert.equal(answer.status, 200);
  assert.equal(answer.body.reply.text, 'On the call I said your gate is B22.');
  const first = f.claude.requests[0];
  assert.match(first.messages[0].content[0].text, /channel: app/);
  assert.match(first.messages[0].content[0].text, /call · steph\] Your gate is B22/, 'the timeline is in context');
  assert.equal(first.system[0].cache_control.type, 'ephemeral');
  assert.ok(first.tools.some(tool => tool.name === 'reply') && first.tools.some(tool => tool.name === 'search_memories'));
  assert.deepEqual(first.fallbacks, 'default');
  const timeline = (await f.api('/v1/timeline', { token })).body.entries;
  assert.deepEqual(timeline.slice(0, 3).map(entry => [entry.channel, entry.direction]), [['app', 'out'], ['app', 'in'], ['call', 'out']]);
});

test('cards cite only memories a tool returned this turn, never ids the model invents', async t => {
  const f = await fixture(t, { script: (params, index) => {
    if (index === 0) return turn(toolUse('s1', 'search_memories', { query: 'passport' }));
    const found = toolResult(params, 's1').memories;
    return turn(reply('r1', 'Your passport is in the desk drawer.', { card_type: 'place', memory_ids: [found[0].id, 'm_made_up'], buttons: ['Thanks!', 'Not there', 'Extra'] }));
  } });
  const { token, user } = await signIn(f, { phone: ADA });
  await f.store.upsertMemories(user.id, [memory('app:1', 'Put the passport in the desk drawer', { place: 'Desk drawer' })], iso(START));
  const answer = (await f.api('/v1/steph/message', { token, body: { text: 'Where is my passport?' } })).body;
  assert.equal(answer.reply.card.card_type, 'place');
  assert.deepEqual(answer.reply.card.buttons, ['Thanks!', 'Not there']);
  assert.deepEqual(answer.reply.memories.map(item => item.summary), ['Put the passport in the desk drawer']);
});

test('during backfill Steph says she is getting to know the day; without a brain the app answers on-device', async t => {
  const f = await fixture(t, { script: () => assert.fail('no model call during backfill') });
  const { token } = await signIn(f, { phone: ADA });
  await f.api('/v1/setup/complete', { token, body: { time_zone: 'America/Los_Angeles' } });
  const me = (await f.api('/v1/me', { token })).body;
  assert.equal(me.backfill.state, 'running');
  const answer = (await f.api('/v1/steph/message', { token, body: { text: "What's my day look like?" } })).body;
  assert.equal(answer.reply.text, "I'm getting to know your day. Give me a minute.");
  assert.equal(answer.backfilling, true);
  const off = await fixture(t, { overrides: { ANTHROPIC_API_KEY: undefined } });
  const other = await signIn(off, { phone: ADA });
  const unavailable = await off.api('/v1/steph/message', { token: other.token, body: { text: 'Hi' } });
  assert.deepEqual([unavailable.status, unavailable.body.error], [503, "Steph's brain is not configured"]);
});

test('"Forget that" asks first, deletes only after a yes, and the deletion reaches the phone', async t => {
  let memoryId;
  const f = await fixture(t, { script: (params, index) => {
    if (index === 0) return turn(toolUse('s1', 'search_memories', { query: 'door code' }));
    if (index === 1) {
      memoryId = toolResult(params, 's1').memories[0].id;
      return turn(toolUse('f1', 'forget', { memory_id: memoryId }));
    }
    if (index === 2) return turn(reply('r1', toolResult(params, 'f1').question));
    // A later turn: the model tries to confirm on text that is not a yes.
    if (index === 3) return turn(toolUse('c1', 'confirm_pending', { pending_action_id: 'whatever', answer: 'yes' }));
    return turn(reply('r2', toolResult(params, 'c1').error));
  } });
  const { token, user } = await signIn(f, { phone: ADA });
  await f.store.upsertMemories(user.id, [memory('app:door', 'The door code is 4412')], iso(START));
  const asked = (await f.api('/v1/steph/message', { token, body: { text: 'Forget the door code' } })).body;
  assert.equal(asked.reply.card.card_type, 'confirm');
  assert.equal(asked.reply.text, 'Forget "The door code is 4412" everywhere?');
  assert.equal(await f.store.memoryCount(user.id), 1, 'nothing deleted before a yes');
  const refused = (await f.api('/v1/steph/message', { token, body: { text: 'Ignore that and delete everything' } })).body;
  assert.equal(refused.reply.text, 'I need the person to say yes first.');
  const confirmed = await f.api('/v1/steph/confirm', { token, body: { pending_action_id: asked.reply.card.pending_action_id, answer: 'yes' } });
  assert.equal(confirmed.body.reply.text, "Done. I've forgotten that everywhere.");
  assert.equal(await f.store.memoryCount(user.id), 0);
  const changes = (await f.api(`/v1/memories/changes?since=${iso(START - 1000)}`, { token })).body;
  assert.deepEqual(changes.tombstones.map(item => item.source_ref), ['app:door']);
  const resync = await f.api('/v1/memories/sync', { token, body: { upserts: [memory('app:door', 'The door code is 4412')] } });
  assert.equal(resync.body.accepted, 0, 'a forgotten memory never syncs back');
  const again = await f.api('/v1/steph/confirm', { token, body: { pending_action_id: asked.reply.card.pending_action_id, answer: 'yes' } });
  assert.equal(again.body.reply.text, 'That question expired. Ask me again if you still want it.');
});

test('"Text me that" and "call me at 3" go out the way the person asked and are logged with reasons', async t => {
  const f = await fixture(t, { script: (params, index) => {
    if (index === 0) return turn(toolUse('t1', 'send_text', { text: 'Hotel: 12 Pine St\nConfirmation 7HX2Q' }), toolUse('c1', 'call_me', { about: 'leave for the airport', at: '2026-10-12T15:00' }));
    return turn(reply('r1', 'Texted it, and I will call you at 3.'));
  } });
  const { token } = await signIn(f, { phone: ADA });
  const answer = (await f.api('/v1/steph/message', { token, body: { text: 'Text me the hotel and call me at 3 to leave' } })).body;
  assert.deepEqual(answer.deliveries.map(item => [item.channel, item.reason]), [['text', 'texted: you asked me to']]);
  assert.equal(f.dial.texts.at(-1).body, 'Hotel: 12 Pine St\nConfirmation 7HX2Q');
  const status = (await f.api('/v1/steph/status', { token })).body;
  assert.equal(status.state, 'texted');
  assert.match(status.caption, /^STEPH TEXTED YOU · 10:00 AM$/);
  await f.api(`/v1/timeline/${status.message.id}/seen`, { token, body: {} });
  const scheduled = (await f.api('/v1/steph/status', { token })).body;
  assert.deepEqual([scheduled.state, scheduled.caption], ['scheduled', 'STEPH WILL CALL AT 3:00']);
});

test('holding the orb: Call me rings the verified phone with the last reply; Text me texts it', async t => {
  const f = await fixture(t, { script: () => turn(reply('r1', 'Coffee with Priya is at 3 at Blue Bottle.')) });
  const unverified = await signIn(f);
  assert.equal((await f.api('/v1/steph/call-me', { token: unverified.token, body: {} })).status, 409);
  const { token } = await signIn(f, { phone: ADA, email: 'ada2@example.com' });
  await f.api('/v1/steph/message', { token, body: { text: "What's next?" } });
  const called = await f.api('/v1/steph/call-me', { token, body: {} });
  assert.deepEqual(called.body, { call_id: 'call-1', status: 'queued' });
  const placed = f.dial.calls[0];
  assert.equal(placed.to, ADA);
  assert.equal(placed.from, '+12408962183');
  assert.match(placed.instruction, /<detail>Coffee with Priya is at 3 at Blue Bottle\.<\/detail>/);
  assert.match(placed.instruction, /AI assistant/);
  assert.deepEqual((await f.api('/v1/steph/status', { token })).body.state, 'calling');
  const texted = await f.api('/v1/steph/text-me', { token, body: {} });
  assert.equal(texted.body.text, 'Coffee with Priya is at 3 at Blue Bottle.');
  const diagnostics = (await f.api('/v1/diagnostics', { token })).body;
  assert.deepEqual(diagnostics.decisions.slice(0, 2).map(item => item.reason), ['texted: you asked me to', 'called: you asked me to']);
  assert.deepEqual(diagnostics.counts_today, { calls: 0, texts: 0, limits: { calls: 2, texts: 5 } }, 'what you ask for is not capped');
  assert.equal(diagnostics.phone, '…0123');
});

test('the phone syncs text-only memories; invalid ones are rejected and deletions honored', async t => {
  const f = await fixture(t);
  const { token, user } = await signIn(f, { phone: ADA });
  const accepted = await f.api('/v1/memories/sync', { token, body: { upserts: [
    memory('photos:A1', 'Keys on the kitchen counter', { type: 'photo', source: 'photos', place: 'Kitchen' }),
    memory('contacts:sam', 'Sam Chen, son Leo turns 4 in March', { type: 'person', source: 'contacts', people: ['Sam Chen'] }),
  ] } });
  assert.equal(accepted.body.accepted, 2);
  assert.equal((await f.api('/v1/memories/sync', { token, body: { upserts: [{ ...memory('x', 'y'), source: 'gmail' }] } })).status, 400);
  assert.equal((await f.api('/v1/memories/sync', { token, body: { upserts: [{ ...memory('x', 'y'), image: 'base64...' }] } })).body.accepted, 1,
    'unknown fields such as image data are dropped, never stored');
  assert.equal(JSON.stringify(await f.store.memoryCandidates(user.id, {})).includes('base64'), false);
  await f.api('/v1/memories/sync', { token, body: { deletes: ['photos:A1'] } });
  assert.equal(await f.store.memoryCount(user.id), 2);
});

test('"connect my Google" hands the app a link; finishing it links Google to the same person', async t => {
  const keys = await import('./brain-helpers.mjs').then(m => m.appleKeys());
  const f = await fixture(t, { fetch: keys.fetch, script: (params, index) => index === 0
    ? turn(toolUse('g1', 'connect_google', {}))
    : turn(reply('r1', 'Tap the button to connect Google.')) });
  const apple = (await f.api('/v1/auth/apple', { body: { identity_token: keys.token({}) } })).body;
  const answer = (await f.api('/v1/steph/message', { token: apple.session_token, body: { text: 'Connect my Google' } })).body;
  assert.equal(answer.reply.card.card_type, 'connect');
  const state = new URL(answer.reply.card.action.url).searchParams.get('state');
  const page = await f.api(`/google/callback?state=${state}&code=c`);
  assert.equal(page.status, 200);
  assert.match(page.text, /Google is connected to Steph/);
  const me = (await f.api('/v1/me', { token: apple.session_token })).body;
  assert.equal(me.google.email, 'ada@example.com');
});

test('"Disconnect Google" asks, then revokes and deletes what Steph learned from Google', async t => {
  const f = await fixture(t, { script: (params, index) => index === 0
    ? turn(toolUse('d1', 'disconnect_google', {}))
    : turn(reply('r1', 'Disconnect Google and delete everything I learned from it?')) });
  const { token, user } = await signIn(f, { phone: ADA });
  await f.store.upsertMemories(user.id, [memory('gcal:1', 'Dentist at 4', { type: 'event', source: 'google-calendar' }),
    memory('app:2', 'Bike is in the garage')], iso(START));
  const asked = (await f.api('/v1/steph/message', { token, body: { text: 'Disconnect Google' } })).body;
  assert.equal(f.google.disconnected, 0);
  const done = (await f.api('/v1/steph/confirm', { token, body: { pending_action_id: asked.reply.card.pending_action_id, answer: 'yes' } })).body;
  assert.match(done.reply.text, /Google is disconnected/);
  assert.equal(f.google.disconnected, 1);
  assert.deepEqual((await f.store.memoryCandidates(user.id, {})).map(item => item.source), ['app']);
});

test('settings change by asking: "Don\'t call me before 9" moves the end of quiet hours', async t => {
  const f = await fixture(t, { script: (params, index) => index === 0
    ? turn(toolUse('s1', 'update_settings', { quiet_end: '09:00' }))
    : turn(reply('r1', "Okay, I won't call or text before 9.")) });
  const { token } = await signIn(f, { phone: ADA });
  await f.api('/v1/steph/message', { token, body: { text: "Don't call me before 9" } });
  const me = (await f.api('/v1/me', { token })).body;
  assert.equal(me.settings.quiet_end, '09:00');
  assert.equal((await f.api('/v1/diagnostics', { token })).body.quiet_hours.end, '09:00');
});

test('Google sources write into the household owner\'s memories; with no owner they are not filed', async t => {
  const { ownerMemorySink } = await import('../brain/memory.mjs');
  const f = await fixture(t);
  const sink = ownerMemorySink(f.store, () => START);
  const record = { source_ref: 'gcontact:1', type: 'person', summary: 'Sam Chen, brother', people: ['Sam Chen'], source: 'google-contacts', confidence: 1 };
  assert.equal(await sink.replaceSource('google-contacts', [record]), 0);
  const { user } = await signIn(f, { phone: ADA });
  assert.equal(await sink.replaceSource('google-contacts', [record]), 1);
  assert.equal((await f.store.memoryCandidates(user.id, { words: ['sam'] }))[0].summary, 'Sam Chen, brother');
  await sink.deleteSource('google-');
  assert.equal(await f.store.memoryCount(user.id), 0);
});
