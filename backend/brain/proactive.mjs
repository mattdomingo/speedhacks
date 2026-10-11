import { localDate, localInstant } from '../time.mjs';
import { settingsOf } from './router.mjs';
import { spokenTime } from './tools.mjs';

const LEASE_MS = 2 * 60_000;
const URGENT_GRACE_MIN = 10;
const SETTLE_AFTER_MS = 10 * 60_000;
const MAX_CALL_ATTEMPTS = 3;
const AIRPORT_BUFFER_MIN = 120;
const DEFAULT_TRAVEL_MIN = 45;
const APPOINTMENT = /\b(doctor|dr\.?|dentist|appointment|clinic|hospital|therapy|physio|checkup|check-up)\b/i;
const DISTRESS = /\b(help|hurt|pain|fell|fall|scared|afraid|lost|confused|emergency|can't breathe|dizzy)\b/i;
const iso = ms => new Date(ms).toISOString();
const clockOf = (ms, timeZone) => new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit' }).format(new Date(ms));
const list = items => items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;

/**
 * Proactive engine: the nudge queue (reminders, medication, briefings, leave-by texts, caregiver
 * summaries), escalation of ignored notifications, and call settlement. Vercel Cron calls tick()
 * every minute; every claim holds a database lease so overlapping runs never double-send.
 */
export function createProactive({ config, store, deliver, dial, now = Date.now, zoneOf, log = console }) {
  async function schedule(user, nudge) {
    return store.addNudge({ user_id: user.id, created_at: iso(now()), ...nudge });
  }

  function itemFor(nudge, extra = {}) {
    const medication = nudge.kind === 'medication';
    const base = {
      label: { reminder: `Reminder: ${nudge.text}`, medication: `Medication: ${nudge.text}`, briefing: 'Morning briefing',
        leave_by: nudge.text.split('.')[0], caregiver_summary: 'Daily summary', call_request: 'Call you asked for' }[nudge.kind] ?? nudge.text,
      kind: nudge.kind, text: nudge.text, urgent: nudge.urgent && !medication, info: nudge.info, wake_me: nudge.wake_me,
      user_asked: nudge.user_asked, medication, askedAt: nudge.created_at, idempotencyKey: `nudge-${nudge.id}`,
      purpose: medication ? 'it is time for their medication, and you need to hear that they took it'
        : nudge.kind === 'call_request' ? 'they asked you to call them' : 'a reminder they asked for',
    };
    if (nudge.channel !== 'auto') base.explicit = nudge.channel;
    return { ...base, ...extra };
  }

  async function compose(user, nudge) {
    const zone = await zoneOf(user);
    if (nudge.kind === 'briefing') return briefing(user, zone);
    if (nudge.kind === 'caregiver_summary') return caregiverSummary(nudge.dedupe_key.split(':')[1], zone);
    if (nudge.kind === 'reminder') return `Reminder: ${nudge.text}`;
    if (nudge.kind === 'medication') return `It's time for your ${nudge.text}. Tell me when you've taken it.`;
    return nudge.text;
  }

  async function briefing(user, zone) {
    const today = localDate(now(), zone);
    const start = localInstant(`${today}T00:00`, zone).toISOString();
    const end = iso(Date.parse(start) + 86_400_000);
    const events = (await store.memoryCandidates(user.id, { from: start, to: end, types: ['event'], limit: 20 }))
      .sort((a, b) => a.time.localeCompare(b.time)).slice(0, 4)
      .map(event => `${event.summary.replace(/\.$/, '')} at ${clockOf(Date.parse(event.time), zone)}`);
    const tasks = (await store.memoryCandidates(user.id, { types: ['task'], limit: 50 }))
      .filter(task => !task.details?.completed && (!task.details?.due || task.details.due.slice(0, 10) <= today)).slice(0, 3)
      .map(task => task.summary.replace(/\.$/, ''));
    const deliveries = (await store.memoryCandidates(user.id, { types: ['fact'], limit: 50 }))
      .filter(fact => fact.details?.kind === 'delivery' && fact.details?.status !== 'delivered').slice(0, 2)
      .map(fact => fact.summary.replace(/\.$/, ''));
    const parts = ['Good morning!'];
    parts.push(events.length ? `Today: ${list(events)}.` : 'Nothing is on your calendar today.');
    if (tasks.length) parts.push(`To do: ${list(tasks)}.`);
    if (deliveries.length) parts.push(`Deliveries: ${list(deliveries)}.`);
    return parts.join(' ');
  }

  // Facts for the caregiver, never transcripts: counts, repeated questions, distress words, medication.
  async function caregiverSummary(patientId, zone) {
    const patient = await store.user(patientId);
    if (!patient) return 'Steph had no updates today.';
    const since = localInstant(`${localDate(now(), zone)}T00:00`, zone).toISOString();
    const entries = await store.timeline(patient.id, { since, limit: 500 });
    const fromPatient = entries.filter(entry => entry.direction === 'in');
    const calls = new Set(entries.filter(entry => entry.channel === 'call').map(entry => entry.call_id)).size;
    const questions = fromPatient.map(entry => entry.text.trim().toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' '))
      .filter(text => text.split(' ').length > 2);
    const repeated = [...new Set(questions.filter((text, index) => questions.indexOf(text) !== index))];
    const distress = fromPatient.some(entry => DISTRESS.test(entry.text));
    const meds = await store.memoryCandidates(patient.id, { from: since, types: ['health'], limit: 20 });
    const taken = meds.filter(memory => memory.details?.kind === 'medication_taken').length;
    const missed = (await store.nudgesInStatus('missed', iso(now()), 50))
      .filter(nudge => nudge.user_id === patient.id && nudge.kind === 'medication' && nudge.due_at >= since).length;
    const name = patient.name || 'Your person';
    return [
      `Steph's day with ${name}: ${fromPatient.length} messages, ${calls} calls.`,
      taken || missed ? `Medication: ${taken} taken${missed ? `, ${missed} missed` : ''}.` : null,
      repeated.length ? `Asked more than once: "${repeated[0].slice(0, 80)}".` : null,
      distress ? 'They used words like "help" or "pain" today; please check in.' : null,
    ].filter(Boolean).join(' ');
  }

  // Creates today's scheduled items; dedupe keys make every run idempotent.
  async function plan() {
    const at = now();
    for (const user of await store.users()) {
      const zone = await zoneOf(user);
      const settings = settingsOf(user);
      const today = localDate(at, zone);
      const plannable = due => due && due.getTime() > at - 30 * 60_000;
      if (user.setup_completed_at && user.role !== 'caregiver') {
        const due = localInstant(`${today}T${settings.briefing_time}`, zone);
        if (plannable(due) && due.getTime() > Date.parse(user.setup_completed_at)) {
          await schedule(user, { kind: 'briefing', text: 'Morning briefing', due_at: due.toISOString(), info: true,
            dedupe_key: `briefing:${user.id}:${today}` });
        }
      }
      for (const medication of settings.medications ?? []) {
        for (const time of medication.times) {
          const due = localInstant(`${today}T${time}`, zone);
          if (plannable(due)) {
            await schedule(user, { kind: 'medication', text: medication.name, due_at: due.toISOString(), urgent: true,
              must_confirm: true, wake_me: medication.wake_me, grace_minutes: URGENT_GRACE_MIN,
              dedupe_key: `med:${user.id}:${medication.name.toLowerCase()}:${today}:${time}` });
          }
        }
      }
      if (user.role === 'patient' && user.caregiver_id) {
        const caregiver = await store.user(user.caregiver_id);
        const due = localInstant(`${today}T19:00`, zone);
        if (caregiver?.phone && plannable(due)) {
          await schedule(caregiver, { kind: 'caregiver_summary', text: 'Daily summary', due_at: due.toISOString(), info: true,
            user_asked: true, dedupe_key: `summary:${user.id}:${today}` });
        }
      }
      await planDepartures(user, zone, settings, at);
    }
  }

  async function planDepartures(user, zone, settings, at) {
    const horizon = iso(at + 30 * 3_600_000);
    const upcoming = await store.memoryCandidates(user.id, { from: iso(at), to: horizon, types: ['fact', 'event'], limit: 100 });
    for (const memory of upcoming) {
      const departs = Date.parse(memory.details?.departure_time ?? memory.time);
      if (memory.details?.kind === 'flight' && Number.isFinite(departs)) {
        const travel = settings.airport_travel_minutes ?? DEFAULT_TRAVEL_MIN;
        const leaveBy = departs - (AIRPORT_BUFFER_MIN + travel) * 60_000;
        const facts = [memory.details.flight_number && `Flight ${memory.details.flight_number}`,
          `leaves at ${clockOf(departs, zone)}`, memory.details.departure_airport && `from ${memory.details.departure_airport}`].filter(Boolean).join(' ');
        const lines = [`${facts}.`, memory.details.gate && `Gate ${memory.details.gate}.`,
          memory.details.confirmation && `Confirmation ${memory.details.confirmation}.`, `Leave by ${clockOf(leaveBy, zone)}.`].filter(Boolean);
        await schedule(user, { kind: 'leave_by', text: lines.join('\n'), due_at: iso(Math.max(at, leaveBy - 45 * 60_000)),
          info: true, dedupe_key: `leave:${memory.source_ref}` });
      } else if ((memory.details?.kind === 'appointment' || (memory.type === 'event' && APPOINTMENT.test(memory.summary))) &&
          memory.place && Number.isFinite(departs) && departs - at < 6 * 3_600_000) {
        await schedule(user, { kind: 'leave_by', urgent: true, due_at: iso(Math.max(at, departs - 45 * 60_000)),
          text: `${memory.summary.replace(/\.$/, '')} at ${clockOf(departs, zone)}, at ${memory.place}. Time to get ready to leave.`,
          dedupe_key: `appt:${memory.source_ref}` });
      }
    }
  }

  // Applies a delivery result to the nudge's state machine.
  async function applySent(nudge, fromStatus, sent, extra = {}) {
    const at = iso(now());
    const outcome = extra.push_ignored || extra.grace_elapsed ? 'escalated' : null;
    if (sent.channel === 'defer') return store.updateNudge(nudge.id, fromStatus, { status: 'scheduled', due_at: sent.defer_until }, at);
    if (sent.channel === 'call') return store.updateNudge(nudge.id, fromStatus, { status: 'calling', call_id: sent.call_id }, at);
    if (nudge.must_confirm) return store.updateNudge(nudge.id, fromStatus, { status: 'awaiting', push_id: sent.timeline_id, pushed_at: at, outcome }, at);
    if (sent.channel === 'push') return store.updateNudge(nudge.id, fromStatus, { status: 'pushed', push_id: sent.timeline_id, pushed_at: at, outcome }, at);
    return store.updateNudge(nudge.id, fromStatus, { status: 'delivered', outcome: sent.channel }, at);
  }

  async function sendFor(nudge, fromStatus, extra) {
    const user = await store.user(nudge.user_id);
    if (!user) return store.updateNudge(nudge.id, fromStatus, { status: 'failed', outcome: 'user gone' }, iso(now()));
    const text = await compose(user, nudge);
    try {
      const sent = await deliver(user, itemFor(nudge, { text, ...extra }));
      await applySent(nudge, fromStatus, sent, extra);
      return sent;
    } catch (error) {
      log.error(`Nudge delivery failed: ${error.message}`);
      // Calls reuse the nudge's idempotency key, so a retried claim never dials twice; 4xx will not fix itself.
      const permanent = error.status >= 400 && error.status < 500 && error.status !== 429;
      if (fromStatus !== 'sending' || permanent || nudge.attempts >= MAX_CALL_ATTEMPTS) {
        await store.updateNudge(nudge.id, fromStatus, { status: 'failed', outcome: error.message.slice(0, 200) }, iso(now()));
      }
      return undefined;
    }
  }

  async function settleCall(nudge, status) {
    const at = iso(now());
    if (status === 'completed') {
      // An answered medication call still needs their word that they took it.
      if (nudge.must_confirm && nudge.kind === 'medication') {
        const taken = await takenSince(nudge);
        return finishMedication(nudge, 'calling', taken);
      }
      return store.updateNudge(nudge.id, 'calling', { status: 'delivered', outcome: 'answered' }, at);
    }
    if (nudge.kind === 'medication') return finishMedication(nudge, 'calling', await takenSince(nudge));
    if (!await store.updateNudge(nudge.id, 'calling', { status: 'missed', outcome: status }, at)) return false;
    const user = await store.user(nudge.user_id);
    try {
      // The missed-call text goes through the router too, so quiet hours and caps still apply.
      await deliver(user, itemFor(nudge, { text: `I tried to call you. ${await compose(user, nudge)}`, grace_elapsed: true,
        urgent: false, explicit: undefined, label: `Missed call: ${nudge.text}` }));
    } catch (error) {
      log.error(`Missed-call text failed: ${error.message}`);
    }
    return true;
  }

  async function takenSince(nudge) {
    const logs = await store.memoryCandidates(nudge.user_id, { from: nudge.due_at, types: ['health'], limit: 10 });
    return logs.some(memory => memory.details?.kind === 'medication_taken');
  }

  async function finishMedication(nudge, fromStatus, taken) {
    const at = iso(now());
    if (taken) return store.updateNudge(nudge.id, fromStatus, { status: 'delivered', outcome: 'taken' }, at);
    if (!await store.updateNudge(nudge.id, fromStatus, { status: 'missed', outcome: 'no confirmation' }, at)) return false;
    const user = await store.user(nudge.user_id);
    const contact = settingsOf(user).missed_medication_contact;
    if (contact && dial) {
      try {
        await dial.sendText({ to: contact.phone, from: config.STEPH_NUMBER,
          body: `Steph here: ${user.name || 'they'} didn't confirm taking their ${nudge.text} (due ${clockOf(Date.parse(nudge.due_at), await zoneOf(user))}). You asked me to let you know.` });
        await store.addDecision({ user_id: user.id, at, item: `Medication missed: ${nudge.text}`, channel: 'text', rule: 'caregiver',
          reason: `texted ${contact.name}: you asked me to tell them if you miss your medicine`, counted: false });
      } catch (error) {
        log.error(`Missed-medication text failed: ${error.message}`);
      }
    }
    return true;
  }

  return {
    schedule,
    briefing,
    caregiverSummary,
    plan,
    settleCall,

    async medicationTaken(user) {
      const nudge = await store.openNudge(user.id, 'medication', iso(now()));
      if (nudge && ['awaiting', 'calling'].includes(nudge.status)) await finishMedication(nudge, nudge.status, true);
    },

    // One cron tick: plan today's items, deliver what is due, escalate ignored ones, settle calls.
    async tick() {
      const result = { planned: true, sent: 0, escalated: 0, settled: 0 };
      await plan();
      for (const nudge of await store.claimDueNudges(iso(now()), iso(now() + LEASE_MS))) {
        if (await sendFor(nudge, 'sending')) result.sent++;
      }
      // Notifications nobody opened: urgent ones become calls after 10 minutes, others texts after their grace period.
      for (const status of ['pushed', 'awaiting']) {
        for (const nudge of await store.nudgesInStatus(status, iso(now() - URGENT_GRACE_MIN * 60_000 / 2))) {
          const entry = nudge.push_id && await store.timelineEntry(nudge.user_id, nudge.push_id);
          if (status === 'pushed' && entry?.opened_at) {
            await store.updateNudge(nudge.id, status, { status: 'delivered', outcome: 'opened' }, iso(now()));
            continue;
          }
          if (status === 'awaiting' && await takenSince(nudge)) {
            await finishMedication(nudge, status, true);
            continue;
          }
          const grace0 = (nudge.urgent || nudge.must_confirm ? URGENT_GRACE_MIN : nudge.grace_minutes) * 60_000;
          // One escalation only: after that an unconfirmed item is missed (and the caregiver told, if asked).
          if (nudge.outcome === 'escalated') {
            if (now() - Date.parse(nudge.pushed_at) >= grace0) {
              if (status === 'awaiting') await finishMedication(nudge, status, false);
              else await store.updateNudge(nudge.id, status, { status: 'delivered', outcome: 'not opened' }, iso(now()));
            }
            continue;
          }
          const grace = (nudge.urgent || nudge.must_confirm ? URGENT_GRACE_MIN : nudge.grace_minutes) * 60_000;
          if (now() - Date.parse(nudge.pushed_at) < grace) continue;
          const escalate = nudge.urgent || nudge.must_confirm ? { push_ignored: true } : { grace_elapsed: true };
          if (await sendFor({ ...nudge, must_confirm: nudge.must_confirm }, status, { ...escalate, explicit: undefined })) result.escalated++;
        }
      }
      // A lost call.ended webhook must not strand a nudge: check Dial's call status before acting.
      if (dial) {
        for (const nudge of await store.nudgesInStatus('calling', iso(now() - SETTLE_AFTER_MS))) {
          try {
            const call = await dial.getCall(nudge.call_id);
            if (call?.status?.state === 'Terminated' && await settleCall(nudge, call.status.terminationType)) result.settled++;
          } catch (error) {
            log.error(`Call status check failed: ${error.message}`);
          }
        }
      }
      return result;
    },

    async handleCallEnded(event) {
      const nudge = event.data?.callId && await store.nudgeByCall(event.data.callId);
      if (!nudge || nudge.status !== 'calling') return false;
      return settleCall(nudge, event.data.status);
    },
  };
}
