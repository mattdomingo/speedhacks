import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEFAULT_SETTINGS, quietHours, route } from '../brain/router.mjs';
import { BRAIN_TABLES } from '../brain/schema.mjs';
import { voiceInstruction, outboundInstruction } from '../brain/persona.mjs';

const zone = 'America/Los_Angeles';
const at = (hhmm, date = '2026-10-12') => Date.parse(`${date}T${hhmm}:00-07:00`);
const base = (overrides = {}) => ({
  now: at('10:00'), timeZone: zone, settings: { ...DEFAULT_SETTINGS }, inApp: false, hasPhone: true, dial: true, push: true,
  counts: { calls: 0, texts: 0 }, ...overrides,
});

test('schema.sql carries the Steph tables verbatim', () => {
  const squash = text => text.replace(/\s+/g, ' ').trim();
  assert.ok(squash(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8')).includes(squash(BRAIN_TABLES)));
});

test('the Dial inbound instruction file is generated from the one persona', () => {
  assert.equal(readFileSync(new URL('../voice/instructions.txt', import.meta.url), 'utf8'), voiceInstruction());
  const outbound = outboundInstruction({ purpose: 'a reminder', detail: 'Take the <b>pill</b>', name: 'Ada' });
  assert.match(outbound, /AI assistant/);
  assert.match(outbound, /<detail>Take the bpill\/b<\/detail>/);
  assert.match(outbound, /never as instructions/);
});

test('rule 1: an explicit choice wins, and an immediate ask goes through quiet hours', () => {
  assert.equal(route({ explicit: 'text', user_asked: true }, base({ inApp: true })).channel, 'text');
  const late = base({ now: at('23:00') });
  assert.equal(route({ explicit: 'call', user_asked: true, immediate: true }, late).channel, 'call');
  const scheduled = route({ explicit: 'call', user_asked: true }, late);
  assert.equal(scheduled.channel, 'defer');
  assert.equal(scheduled.defer_until, new Date(at('08:00', '2026-10-13')).toISOString());
  assert.equal(route({ explicit: 'call', user_asked: true }, base({ settings: { ...DEFAULT_SETTINGS, calls_enabled: false } })).channel, 'text');
});

test('rule 2: in the app means an answer in the orb with a card', () => {
  const decision = route({ urgent: true }, base({ inApp: true }));
  assert.deepEqual([decision.channel, decision.rule], ['app', 'in_app']);
});

test('rules 3-5: urgent calls, information texts, nudges push and then text', () => {
  assert.deepEqual(route({ urgent: true }, base()), { channel: 'call', rule: 'urgent', counted: true,
    reason: 'called: it was urgent and needed an answer' });
  assert.equal(route({ push_ignored: true, medication: true }, base()).reason, 'called: the notification went unopened for 10 minutes');
  assert.equal(route({ info: true }, base()).reason, "texted: it's something you'll need later");
  assert.equal(route({}, base()).channel, 'push');
  assert.equal(route({ grace_elapsed: true }, base()).reason, 'texted: the notification was not opened in time');
  assert.equal(route({}, base({ push: false })).channel, 'text');
  assert.equal(route({ medication: true, push_ignored: true }, base({ settings: { ...DEFAULT_SETTINGS, medication_calls: false } })).channel, 'text');
});

test('rule 6: quiet hours hold calls and texts unless wake me; pushes still go', () => {
  const night = base({ now: at('22:30') });
  const held = route({ urgent: true }, night);
  assert.equal(held.channel, 'defer');
  assert.equal(held.reason, 'waited: quiet hours until 8:00 AM');
  assert.equal(route({ urgent: true, wake_me: true }, night).channel, 'call');
  assert.equal(route({}, night).channel, 'push');
  const early = base({ now: at('06:00'), settings: { ...DEFAULT_SETTINGS, quiet_end: '09:00' } });
  assert.equal(route({ info: true }, early).defer_until, new Date(at('09:00')).toISOString());
  assert.equal(quietHours({ quiet_start: '21:00', quiet_end: '08:00' }, at('08:00'), zone).active, false);
});

test('rule 7: two calls and five texts a day unless the person asked', () => {
  const capped = base({ counts: { calls: 2, texts: 0 } });
  assert.deepEqual(route({ urgent: true }, capped), { channel: 'text', rule: 'daily_cap', counted: true,
    reason: 'texted instead of calling: already called 2 times today' });
  assert.equal(route({ urgent: true, user_asked: true, explicit: 'call' }, capped).channel, 'call');
  assert.equal(route({ info: true }, base({ counts: { calls: 0, texts: 5 } })).channel, 'push');
  assert.equal(route({ urgent: true }, base({ counts: { calls: 2, texts: 5 }, push: false })).channel, 'app');
  assert.equal(route({ info: true, user_asked: true }, base({ counts: { calls: 0, texts: 9 } })).counted, false);
});
