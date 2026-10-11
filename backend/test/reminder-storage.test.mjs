import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { testStore } from './helpers.mjs';
import { sqliteVoiceStore } from '../voice/store-sqlite.mjs';

const NOW = '2026-10-11T20:00:00.000Z';
const LATER = '2026-10-11T20:10:00.000Z';
const END = '2026-10-11T20:20:00.000Z';
const PATIENT = '+14155550123';
const reminder = (id, channel = 'text') => ({
  id, patient_number: PATIENT, text: 'Synthetic reminder', channel, due_at: NOW, created_at: NOW,
});
const parameters = (store, sql) => store.adapter === 'sqlite' ? sql.replace(/\$\d+/g, '?') : sql;
const write = (store, sql, values = []) => store.sql(parameters(store, sql), values);
async function rows(store, sql, values = []) {
  return store.adapter === 'sqlite'
    ? store.db.prepare(parameters(store, sql)).all(...values)
    : (await store.sql(sql, values)).rows;
}
const allReminders = store => rows(store, 'SELECT * FROM reminders ORDER BY id');
async function migrate(store) {
  if (store.adapter === 'postgres') {
    await store.sql(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  } else {
    sqliteVoiceStore(store.db);
  }
}

test('legacy reminder migration preserves records and does not invent SMS delivery or retries', async t => {
  const store = await testStore(t);
  const legacy = `DROP TABLE reminders;
    CREATE TABLE reminders (
      id TEXT PRIMARY KEY, patient_number TEXT NOT NULL, text TEXT NOT NULL,
      channel TEXT NOT NULL CHECK (channel IN ('call', 'text')), due_at TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('scheduled', 'sending', 'calling', 'delivered', 'missed', 'canceled', 'failed')),
      attempts INTEGER NOT NULL DEFAULT 0, lease_until TEXT, call_id TEXT UNIQUE, outcome TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX reminders_by_status ON reminders (status, due_at);`;
  if (store.adapter === 'sqlite') store.db.exec(legacy);
  else await store.sql(legacy);
  for (const channel of ['call', 'text']) {
    for (const status of ['scheduled', 'sending', 'calling', 'delivered', 'missed', 'canceled', 'failed']) {
      const id = `${channel}-${status}`;
      await store.createReminder(reminder(id, channel));
      const outcome = status === 'missed' ? 'no-answer; texted'
        : channel === 'text' && status === 'delivered' ? 'texted' : `historical ${status}`;
      await write(store, `UPDATE reminders SET status = $1, attempts = 2, lease_until = $2,
        call_id = $3, outcome = $4 WHERE id = $5`, [status, LATER, `call-${id}`, outcome, id]);
    }
  }
  await store.createReminder(reminder('fallback-send-error', 'call'));
  await write(store, "UPDATE reminders SET status = 'missed', outcome = 'busy; text failed' WHERE id = $1",
    ['fallback-send-error']);
  const before = await allReminders(store);
  await migrate(store);
  const after = await allReminders(store);
  assert.equal(after.length, before.length);
  for (let i = 0; i < before.length; i++) {
    for (const field of ['id', 'patient_number', 'text', 'channel', 'due_at', 'attempts', 'call_id', 'created_at', 'updated_at']) {
      assert.equal(after[i][field], before[i][field], `${before[i].id}: ${field}`);
    }
    const old = before[i], current = after[i];
    const ambiguousText = old.channel === 'text' && ['sending', 'delivered', 'failed'].includes(old.status);
    assert.equal(current.status, ambiguousText ? 'texting' : old.status);
    assert.equal(current.message_status, ambiguousText || old.status === 'missed' ? 'unknown' : null);
    assert.equal(current.message_id, null);
    assert.equal(current.lease_until, ambiguousText ? null : old.lease_until);
    assert.equal(current.outcome, old.outcome === 'texted' ? 'text delivery unknown'
      : old.outcome.endsWith('; texted') ? old.outcome.slice(0, -8)
        : old.outcome.endsWith('; text failed') ? old.outcome.slice(0, -13) : old.outcome);
  }
  // Reapplying the migration preserves both its first result and a genuinely confirmed receipt.
  await store.createReminder(reminder('proven-delivery'));
  await write(store, "UPDATE reminders SET status = 'texting', message_status = 'unknown' WHERE id = $1", ['proven-delivery']);
  assert.equal(await store.updateReminderMessage('proven-delivery', {
    message_id: 'proven-message', message_status: 'delivered',
  }, LATER), true);
  const once = await allReminders(store);
  await migrate(store);
  assert.deepEqual(await allReminders(store), once);
  const reclaimed = await store.claimDueReminders(END, END, 100);
  assert.equal(reclaimed.some(row => ['text-sending', 'text-delivered', 'text-failed'].includes(row.id)), false);
});

test('overlapping claims reserve calls and texts once, including after a lease would expire', async t => {
  const store = await testStore(t);
  const second = store.reopen();
  t.after(() => second.close());
  await store.createReminder(reminder('text'));
  await store.createReminder(reminder('voice', 'call'));
  const claims = (await Promise.all([
    store.claimDueReminders(NOW, LATER), second.claimDueReminders(NOW, LATER),
  ])).flat();
  assert.deepEqual(claims.map(row => row.id).sort(), ['text', 'voice']);
  const text = claims.find(row => row.id === 'text');
  assert.equal(text.status, 'texting');
  assert.equal(text.message_status, 'unknown');
  assert.equal(text.lease_until, null);
  assert.equal(text.attempts, 1);
  const voice = claims.find(row => row.id === 'voice');
  assert.equal(voice.status, 'calling');
  assert.equal(voice.lease_until, null);
  const reclaimed = await second.claimDueReminders(END, END);
  assert.deepEqual(reclaimed, []);
  assert.deepEqual((await second.unconfirmedCalls()).map(row => row.id), ['voice']);
});

test('only one worker owns missed-call fallback and SMS receipts preserve the call outcome', async t => {
  const store = await testStore(t);
  const second = store.reopen();
  t.after(() => second.close());
  await store.createReminder(reminder('fallback', 'call'));
  await store.claimDueReminders(NOW, LATER);
  await store.updateReminder('fallback', 'calling', { status: 'calling', call_id: 'missed-call' }, NOW);
  const results = await Promise.all([
    store.claimReminderFallback('fallback', 'no-answer', LATER),
    second.claimReminderFallback('fallback', 'no-answer', LATER),
  ]);
  assert.deepEqual(results.sort(), [false, true]);
  const claimed = await store.reminderByCall('missed-call');
  assert.equal(claimed.status, 'missed');
  assert.equal(claimed.outcome, 'no-answer');
  assert.equal(claimed.message_status, 'unknown');
  assert.equal(claimed.lease_until, null);
  assert.equal(await store.updateReminder('fallback', 'calling', { status: 'delivered' }, END), false);
  await store.updateReminderMessage('fallback', { message_id: 'fallback-sms', message_status: 'delivered' }, END);
  const delivered = await store.reminderByMessage('fallback-sms');
  assert.equal(delivered.status, 'missed');
  assert.equal(delivered.outcome, 'no-answer');
  assert.equal(delivered.message_status, 'delivered');
});

test('message IDs bind once and receipt state only advances to immutable terminal states', async t => {
  const store = await testStore(t);
  for (const id of ['delivered', 'failed']) await store.createReminder(reminder(id));
  await store.claimDueReminders(NOW, LATER);
  for (const message_status of [null, undefined, 'sent']) {
    assert.equal(await store.updateReminderMessage('delivered', { message_status }, LATER), false);
  }
  assert.equal(await store.updateReminderMessage('delivered', { message_status: 'unknown' }, LATER), true);
  assert.equal(await store.updateReminderMessage('delivered', { message_id: 'sms-1', message_status: 'pending' }, LATER), true);
  assert.equal(await store.updateReminderMessage('delivered', { message_id: 'wrong-id', message_status: 'delivered' }, END), false);
  assert.equal(await store.updateReminderMessage('delivered', { message_status: 'unknown' }, END), false);
  assert.equal((await store.reminderByMessage('sms-1')).message_status, 'pending');
  assert.equal(await store.updateReminderMessage('delivered', { message_status: 'delivered' }, END), true);
  const delivered = await store.reminderByMessage('sms-1');
  assert.equal(delivered.status, 'delivered');
  assert.equal(delivered.outcome, 'text delivery delivered');
  for (const message_status of ['unknown', 'pending', 'failed', 'delivered']) {
    assert.equal(await store.updateReminderMessage('delivered', { message_id: 'sms-1', message_status }, END), false);
  }
  assert.equal(await store.updateReminderMessage('failed', { message_id: 'sms-2', message_status: 'failed' }, LATER), true);
  assert.equal(await store.updateReminderMessage('failed', { message_id: 'sms-2', message_status: 'delivered' }, END), false);
  assert.equal((await store.reminderByMessage('sms-2')).status, 'failed');
});

test('overlapping terminal receipts cannot regress or replace an already settled message', async t => {
  const store = await testStore(t);
  const second = store.reopen();
  t.after(() => second.close());
  await store.createReminder(reminder('race'));
  await store.claimDueReminders(NOW, LATER);
  await store.updateReminderMessage('race', { message_id: 'sms-race', message_status: 'pending' }, NOW);
  const results = await Promise.all([
    store.updateReminderMessage('race', { message_id: 'sms-race', message_status: 'delivered' }, LATER),
    second.updateReminderMessage('race', { message_id: 'sms-race', message_status: 'failed' }, LATER),
  ]);
  assert.deepEqual(results.sort(), [false, true]);
  const settled = await store.reminderByMessage('sms-race');
  assert.ok(['delivered', 'failed'].includes(settled.message_status));
  assert.equal(settled.status, settled.message_status);
});

test('message polling excludes unbound attempts and rotates unchanged pending or unknown results', async t => {
  const store = await testStore(t);
  for (const id of ['a', 'b', 'c', 'unbound']) await store.createReminder(reminder(id));
  await store.claimDueReminders(NOW, LATER);
  for (const [id, message_status] of [['a', 'pending'], ['b', 'unknown'], ['c', 'pending']]) {
    await store.updateReminderMessage(id, { message_id: `sms-${id}`, message_status }, NOW);
  }
  assert.deepEqual((await store.unsettledMessages(LATER, 2)).map(row => row.id), ['a', 'b']);
  await store.updateReminderMessage('a', { message_status: 'pending' }, LATER);
  await store.updateReminderMessage('b', { message_status: 'unknown' }, LATER);
  assert.deepEqual((await store.unsettledMessages(END, 2)).map(row => row.id), ['c', 'a']);
  assert.equal((await store.reminderByMessage('sms-b')).updated_at, LATER);
});

test('stored receipts recover early webhooks by exact message ID and prefer terminal evidence', async t => {
  const store = await testStore(t);
  const event = (id, messageId, deliveryState, type = 'message.status_changed') => ({
    id, type, data: { messageId, deliveryState, direction: 'outbound' },
  });
  const events = [
    [event('terminal', 'sms-target', 'delivered'), NOW],
    [event('late-pending', 'sms-target', 'pending'), LATER],
    [event('other-message', 'sms-other', 'failed'), END],
    [event('wrong-event-type', 'sms-target', 'failed', 'webhook.ping'), END],
    [{ ...event('wrong-direction', 'sms-target', 'failed'),
      data: { messageId: 'sms-target', deliveryState: 'failed', direction: 'inbound' } }, END],
    [{ ...event('legacy-status', 'sms-legacy', 'delivered'),
      data: { messageId: 'sms-legacy', status: 'delivered' } }, NOW],
    [event('legacy-late-pending', 'sms-legacy', 'pending'), LATER],
  ];
  for (const [value] of events) await store.recordDialEvent(value, 30);
  for (const [value, time] of events) {
    await write(store, 'UPDATE dial_event SET received_at = $1 WHERE id = $2', [time, value.id]);
  }
  assert.equal((await store.messageReceipt('sms-target')).id, 'terminal');
  assert.equal((await store.messageReceipt('sms-other')).id, 'other-message');
  assert.equal((await store.messageReceipt('sms-legacy')).id, 'legacy-status');
  assert.equal(await store.messageReceipt('sms-missing'), undefined);
});

test('schema rejects unknown SMS states and duplicate provider message IDs', async t => {
  const store = await testStore(t);
  await store.createReminder(reminder('first'));
  await store.createReminder(reminder('second'));
  await store.claimDueReminders(NOW, LATER);
  await assert.rejects(async () => write(store, 'UPDATE reminders SET message_status = $1 WHERE id = $2', ['sent', 'first']));
  await store.updateReminderMessage('first', { message_id: 'same-id', message_status: 'pending' }, NOW);
  await assert.rejects(async () => store.updateReminderMessage('second', { message_id: 'same-id', message_status: 'pending' }, NOW));
  assert.equal((await store.reminderByMessage('same-id')).id, 'first');
});
