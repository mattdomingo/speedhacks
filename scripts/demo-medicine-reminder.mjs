// Default: local simulation. Only --live call or --live text loads .env and schedules real delivery.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../backend/store.mjs';
import { createReminders } from '../backend/voice/reminders.mjs';

const args = process.argv.slice(2);
if (!args.length) {
  await mockDemo();
} else if (args.length === 2 && args[0] === '--live' && ['call', 'text'].includes(args[1])) {
  try {
    try { process.loadEnvFile(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const { scheduleMedicineReminder } = await import('./live-medicine-reminder.mjs');
    console.log(`LIVE — scheduling a real ${args[1]} to your configured number ending ${process.env.DEMO_CALLER_NUMBER?.slice(-4) || '(unset)'}.`);
    const reminder = await scheduleMedicineReminder(process.env, args[1]);
    console.log(`Scheduled ${reminder.channel} for ${reminder.spoken_time} (ID: ${reminder.id}).`);
    console.log('Allow 1–2 minutes for the hosted cron. Scheduled does not mean delivered.');
  } catch (error) {
    console.error(error.message);
    console.error('Not confirmed. If the request timed out, check existing reminders before retrying to avoid duplicates.');
    process.exitCode = 1;
  }
} else {
  console.error('Usage: npm run demo:medicine [-- --live call|text]');
  process.exitCode = 2;
}

async function mockDemo() {
  const directory = await mkdtemp(join(tmpdir(), 'recall-reminder-demo-'));
  const store = openStore(directory);
  let now = Date.parse('2026-10-11T20:00:00Z');
  const calls = [], texts = [];
  const dial = {
    async placeCall(call) {
      calls.push(call);
      return { id: `demo-call-${calls.length}` };
    },
    async sendText(text) {
      texts.push(text);
      return { id: `demo-text-${texts.length}`, status: 'pending' };
    },
  };
  const reminders = createReminders({ STEPH_NUMBER: '+12025550100' }, store, {
    dial, now: () => now, timeZone: async () => 'America/Los_Angeles',
  });
  const patient = '+12025550101';
  const text = 'This is your demo reminder to take your medicine.';
  try {
    console.log('DEMO — local simulation; no phone calls or texts are sent.');
    console.log('You: Remind me in one minute to take my medicine.');
    const scheduled = await reminders.set(patient, { text, in_minutes: 1, channel: 'call' });
    assert.equal(scheduled.status, 'scheduled');
    console.log(`Steph: Your reminder is set for ${scheduled.reminder.spoken_time}.`);
    assert.equal((await reminders.dispatch()).called, 0);
    now += 60_000;
    assert.equal((await reminders.dispatch()).called, 1);
    assert.ok(calls[0].instruction.includes(text));
    assert.match(calls[0].instruction, /Never ask or confirm whether they took medicine/);
    assert.equal((await reminders.dispatch()).called, 0);
    console.log('\n[Simulated incoming call — sample dialogue, not generated Dial audio]');
    console.log(`Steph: Hi, I’m Steph, your AI assistant. ${text}`);
    console.log('You: Thanks, Steph.');
    await reminders.handleEvent({ type: 'call.ended', data: { callId: 'demo-call-1', status: 'completed' } });
    const answered = await store.reminderByCall('demo-call-1');
    assert.equal(answered.status, 'delivered');
    assert.equal(answered.outcome, 'answered');
    assert.equal(texts.length, 0);
    console.log('[Call answered. Taking medicine is not tracked or confirmed.]');

    await reminders.set(patient, { text, in_minutes: 1, channel: 'call' });
    now += 60_000;
    assert.equal((await reminders.dispatch()).called, 1);
    const missed = { type: 'call.ended', data: { callId: 'demo-call-2', status: 'no-answer' } };
    await reminders.handleEvent(missed);
    await reminders.handleEvent(missed);
    assert.equal(texts.length, 1);
    assert.ok(texts[0].body.includes(text));
    console.log('\n[Alternate ending: call missed → one simulated fallback text]');
    console.log(texts[0].body);
    console.log('\nPASS — scheduled, dispatched once, answered, and missed-call fallback checked.');
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
}
