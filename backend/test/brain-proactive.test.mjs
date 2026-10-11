import test from 'node:test';
import assert from 'node:assert/strict';
import { ADA, SAM, START, cron, fixture, postWebhook, signIn } from './brain-helpers.mjs';

const iso = ms => new Date(ms).toISOString();
const local = (hhmm, date = '2026-10-12') => Date.parse(`${date}T${hhmm}:00-07:00`);
const minutes = n => n * 60_000;

async function person(f, settings = {}, { device = false, email } = {}) {
  const signed = await signIn(f, { phone: ADA, email });
  if (Object.keys(settings).length) {
    await f.store.updateUser(signed.user.id, { settings: { ...(await f.store.user(signed.user.id)).settings, ...settings } }, iso(START));
  }
  if (device) await f.api('/v1/devices', { token: signed.token, body: { apns_token: 'ab'.repeat(32), environment: 'sandbox' } });
  return signed;
}

test('cron needs its secret and Dial', async t => {
  const f = await fixture(t);
  assert.equal((await f.api('/cron/steph')).status, 401);
  assert.equal((await cron(f)).status, 200);
  const off = await fixture(t, { overrides: { DIAL_API_KEY: undefined } });
  assert.equal((await cron(off)).status, 503);
});

test('medication: a notification first, a call after 10 ignored minutes, then the caregiver contact is told', async t => {
  const f = await fixture(t);
  const { user, token } = await person(f, { medications: [{ name: 'blood pressure pill', times: ['10:05'] }],
    missed_medication_contact: { name: 'Sam', phone: SAM } }, { device: true });
  await cron(f);
  assert.equal(f.apns.sent.length, 0, 'nothing before 10:05');
  f.clock.now = local('10:06');
  await cron(f);
  assert.equal(f.apns.sent.length, 1);
  assert.match(f.apns.sent[0].message.body, /time for your blood pressure pill/);
  f.clock.now = local('10:12');
  await cron(f);
  assert.equal(f.dial.calls.length, 0, 'still inside the 10-minute window');
  f.clock.now = local('10:17');
  await cron(f);
  assert.equal(f.dial.calls.length, 1);
  assert.match(f.dial.calls[0].instruction, /time for their medication/);
  assert.equal((await f.api('/v1/steph/status', { token })).body.state, 'calling');
  await postWebhook(f, { id: 'evt-end-1', type: 'call.ended', data: { callId: 'call-1', status: 'no-answer' } });
  const alert = f.dial.texts.at(-1);
  assert.equal(alert.to, SAM);
  assert.match(alert.body, /didn't confirm taking their blood pressure pill \(due 10:05 AM\)/);
  const reasons = (await f.api('/v1/diagnostics', { token })).body.decisions.map(item => item.reason);
  assert.deepEqual(reasons.slice(0, 3), ['texted Sam: you asked me to tell them if you miss your medicine',
    'called: the notification went unopened for 10 minutes', 'sent a notification: a quick nudge while the app was closed']);
  assert.ok(user);
});

test('medication: saying "I took it" stops the escalation', async t => {
  const f = await fixture(t, { script: () => ({ stop_reason: 'tool_use', content: [
    { type: 'tool_use', id: 'l1', name: 'log_medication', input: { name: 'blood pressure pill' } },
    { type: 'tool_use', id: 'r1', name: 'reply', input: { text: 'Got it, I noted that.' } }] }) });
  const { token, user } = await person(f, { medications: [{ name: 'blood pressure pill', times: ['10:05'] }] }, { device: true });
  f.clock.now = local('10:06');
  await cron(f);
  f.clock.now = local('10:08');
  await f.api('/v1/steph/message', { token, body: { text: 'I took my medicine' } });
  f.clock.now = local('10:30');
  await cron(f);
  assert.equal(f.dial.calls.length, 0);
  const taken = await f.store.memoryCandidates(user.id, { types: ['health'] });
  assert.match(taken[0].summary, /Said they took their blood pressure pill/);
});

test('quiet hours hold a text-only reminder until morning; "wake me" goes through', async t => {
  const f = await fixture(t);
  const { user, token } = await person(f);
  const nudges = f.store;
  await nudges.addNudge({ user_id: user.id, kind: 'reminder', text: 'Put the bins out', due_at: iso(local('22:30')), user_asked: true, created_at: iso(START) });
  await nudges.addNudge({ user_id: user.id, kind: 'reminder', text: 'Check the oven', due_at: iso(local('22:30')), user_asked: true, wake_me: true, created_at: iso(START) });
  f.clock.now = local('22:31');
  await cron(f);
  assert.deepEqual(f.dial.texts.filter(text => text.to === ADA && /Reminder/.test(text.body)).map(text => text.body), ['Reminder: Check the oven']);
  const held = (await f.store.upcomingNudges(user.id))[0];
  assert.equal(held.due_at, iso(local('08:00', '2026-10-13')));
  assert.equal((await f.api('/v1/diagnostics', { token })).body.decisions.find(item => item.item === 'Reminder: Put the bins out').reason,
    'waited: quiet hours until 8:00 AM');
  f.clock.now = local('08:01', '2026-10-13');
  await cron(f);
  assert.equal(f.dial.texts.at(-1).body, 'Reminder: Put the bins out');
});

test('Steph starts at most two calls a day; the third urgent item is texted with the reason', async t => {
  const f = await fixture(t);
  const { user, token } = await person(f);
  for (const [index, place] of ['Dr. Lee', 'Dentist', 'Clinic'].entries()) {
    await f.store.addNudge({ user_id: user.id, kind: 'leave_by', urgent: true, text: `${place} appointment soon`,
      due_at: iso(local('10:00')), created_at: iso(START), dedupe_key: `appt:${index}` });
  }
  f.clock.now = local('10:01');
  await cron(f);
  assert.equal(f.dial.calls.length, 2);
  const reasons = (await f.api('/v1/diagnostics', { token })).body.decisions.map(item => item.reason);
  assert.ok(reasons.includes('texted instead of calling: already called 2 times today'));
  assert.deepEqual((await f.api('/v1/diagnostics', { token })).body.counts_today, { calls: 2, texts: 1, limits: { calls: 2, texts: 5 } });
});

test('a flight from Gmail becomes a text 45 minutes before leave-by, with gate and confirmation', async t => {
  const f = await fixture(t);
  const { user } = await person(f);
  await f.store.upsertMemories(user.id, [{ source_ref: 'gmail:fact:1', type: 'fact', source: 'google-gmail', confidence: 1,
    summary: 'United flight UA 123 SFO to JFK', time: iso(local('18:00')),
    details: { kind: 'flight', flight_number: 'UA 123', departure_time: iso(local('18:00')), departure_airport: 'SFO', gate: 'B22', confirmation: 'ABC123' } }], iso(START));
  await cron(f);
  f.clock.now = local('14:31');
  await cron(f);
  assert.equal(f.dial.texts.at(-1).body, 'Flight UA 123 leaves at 6:00 PM from SFO.\nGate B22.\nConfirmation ABC123.\nLeave by 3:15 PM.');
});

test('the morning briefing is spoken in the app when it is open, otherwise one text', async t => {
  const f = await fixture(t);
  const inApp = await person(f, {}, { email: 'ada@example.com' });
  f.clock.now = local('07:00');
  await f.api('/v1/setup/complete', { token: inApp.token, body: { time_zone: 'America/Los_Angeles' } });
  await f.store.upsertMemories(inApp.user.id, [{ source_ref: 'gcal:1', type: 'event', source: 'google-calendar', confidence: 1,
    summary: 'Coffee with Priya', time: iso(local('15:00')) }], iso(START));
  f.clock.now = local('08:16');
  await f.api('/v1/steph/status', { token: inApp.token });
  await cron(f);
  const status = (await f.api('/v1/steph/status', { token: inApp.token })).body;
  assert.deepEqual(status.say, { id: status.say.id, text: 'Good morning! Today: Coffee with Priya at 3:00 PM.', kind: 'briefing' });
  await f.api(`/v1/timeline/${status.say.id}/seen`, { token: inApp.token, body: {} });
  assert.equal((await f.api('/v1/steph/status', { token: inApp.token })).body.say, undefined);
  assert.equal(f.dial.texts.filter(text => /Good morning/.test(text.body)).length, 0);

  const g = await fixture(t);
  const closed = await person(g);
  g.clock.now = local('07:00');
  await g.api('/v1/setup/complete', { token: closed.token, body: {} });
  g.clock.now = local('08:16');
  await cron(g);
  assert.equal(g.dial.texts.at(-1).body, 'Good morning! Nothing is on your calendar today.');
});

test('a caregiver gets one daily text summary of the patient\'s day', async t => {
  const f = await fixture(t);
  const caregiver = await signIn(f, { mode: 'caregiver', phone: SAM, email: 'sam@example.com' });
  await f.api('/v1/caregiver/patient/start', { token: caregiver.token, body: { phone: ADA, name: 'Mom' } });
  const patient = (await f.api('/v1/caregiver/patient/verify', { token: caregiver.token, body: { phone: ADA, code: f.dial.codeFor(ADA), name: 'Mom' } })).body;
  for (const text of ['Where are my keys', 'where are my keys?', 'I fell in the kitchen']) {
    await f.store.addTimeline({ user_id: patient.user.id, channel: 'sms', direction: 'in', text, at: iso(local('11:00')) });
  }
  f.clock.now = local('19:01');
  await cron(f);
  const summary = f.dial.texts.at(-1);
  assert.equal(summary.to, SAM);
  assert.match(summary.body, /^Steph's day with Mom: 3 messages, 0 calls\./);
  assert.match(summary.body, /Asked more than once: "where are my keys"/);
  assert.match(summary.body, /words like "help" or "pain"/);
  await cron(f);
  assert.equal(f.dial.texts.filter(text => text.to === SAM && /day with Mom/.test(text.body)).length, 1, 'once a day');
});

test('an opened notification counts as delivered and is not texted again', async t => {
  const f = await fixture(t);
  const { user, token } = await person(f, {}, { device: true });
  await f.store.addNudge({ user_id: user.id, kind: 'reminder', text: 'Call the plumber', due_at: iso(local('10:00')), created_at: iso(START) });
  f.clock.now = local('10:01');
  await cron(f);
  const pushed = f.apns.sent[0].message.data.timeline_id;
  await f.api(`/v1/push/${pushed}/opened`, { token, body: {} });
  f.clock.now = local('11:00');
  await cron(f);
  assert.equal(f.dial.texts.filter(text => /plumber/.test(text.body)).length, 0);
  assert.equal((await f.store.nudgesInStatus('delivered', iso(f.clock.now + 1)))[0].outcome, 'opened');
});
