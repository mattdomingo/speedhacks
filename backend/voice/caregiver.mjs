import { randomUUID } from 'node:crypto';
import { localDate, describeTime } from '../time.mjs';
import { maskPhones, safeMessage } from '../log.mjs';
import { ownerOf } from './patients.mjs';
import { ReminderError } from './reminders.mjs';

const ALERTS_PER_HOUR = 3;
const SUMMARY_CHARS = 600;
const QUIET_FROM_HOUR = 21;
const QUIET_UNTIL_HOUR = 8;

// 9pm–8am in the patient's own time zone: no summaries, nothing that can wait.
export function isQuietHour(ms, timeZone) {
  const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', hourCycle: 'h23' }).format(new Date(ms)));
  return hour >= QUIET_FROM_HOUR || hour < QUIET_UNTIL_HOUR;
}

const clip = (text, length) => {
  const clean = maskPhones(String(text ?? '').replace(/\s+/g, ' ').trim());
  return clean.length > length ? `${clean.slice(0, length - 1)}…` : clean;
};

// The caregiver's end-of-day text, built only from what was recorded that local day:
// calls with Steph, missed calls, alerts and texts. Returns null when there is nothing to report.
// Quoted words are the patient's own (masked, clipped); they are data, never instructions.
export function buildDailySummary({ patient, date, records, alerts = [], timeZone }) {
  const onDay = record => localDate(Date.parse(record.timestamp), timeZone) === date;
  const calls = records.filter(record => record.source === 'call_log' && onDay(record));
  const said = records.filter(record => record.source === 'call' && onDay(record));
  const missed = records.filter(record => record.source === 'caregiver_flag' && onDay(record));
  const texts = records.filter(record => record.source === 'text' && onDay(record));
  if (!calls.length && !missed.length && !alerts.length && !texts.length) return null;
  const name = patient.name ?? 'your person';
  const parts = [`Steph (AI assistant) daily summary for ${name}, ${date}:`];
  if (calls.length) parts.push(`${calls.length} call${calls.length === 1 ? '' : 's'} with Steph.`);
  if (said.length) {
    parts.push(`They said: ${said.slice(0, 3).map(record => `"${clip(record.text, 70)}"`).join(', ')}.`);
  }
  for (const flag of missed.slice(0, 3)) {
    parts.push(`Missed call at ${describeTime(Date.parse(flag.timestamp), timeZone)} (${flag.status}).`);
  }
  for (const alert of alerts.slice(0, 3)) {
    parts.push(`Alert at ${describeTime(Date.parse(alert.created_at), timeZone)}: "${clip(alert.outcome?.replace(/^sent: /, '') ?? '', 70)}".`);
  }
  if (texts.length) parts.push(`${texts.length} text${texts.length === 1 ? '' : 's'} from them.`);
  return clip(parts.join(' '), SUMMARY_CHARS);
}

// Caregiver texts. Every send is a single attempt (a retried POST /messages would send twice);
// the database admits at most ALERTS_PER_HOUR alerts and one summary per patient per local day.
export function createCaregiver(config, store, { dial = null, patients = [], now = Date.now, timeZone = async () => 'UTC' } = {}) {
  const from = config.STEPH_NUMBER;
  const zoneFor = async patient => patient.timeZone ?? await timeZone();

  return {
    ready: Boolean(dial),

    // From the notify_caregiver tool. The reason is the patient's own words, clipped and masked.
    async notify(patient, reason) {
      if (!dial || !patient?.caregiver) {
        throw new ReminderError('I cannot reach your caregiver right now. If this is an emergency, hang up and call 911.');
      }
      const ms = now();
      const zone = await zoneFor(patient);
      const id = `alert:${randomUUID()}`;
      const text = clip(reason, 160);
      if (!await store.claimCaregiverAlert(id, patient.number, localDate(ms, zone), new Date(ms).toISOString(),
        new Date(ms - 3_600_000).toISOString(), ALERTS_PER_HOUR)) {
        throw new ReminderError('I already let your caregiver know a few times this hour. If this is an emergency, hang up and call 911.');
      }
      try {
        await dial.sendText({ to: patient.caregiver, from,
          body: `Steph (AI assistant): ${patient.name ?? 'Your person'} asked me to tell you: "${text}"` });
        await store.finishCaregiverMessage(id, 'sent', `sent: ${text}`);
      } catch (error) {
        console.error('Caregiver alert failed:', safeMessage(error));
        await store.finishCaregiverMessage(id, 'failed', `failed: ${text}`);
        throw new ReminderError('I could not reach your caregiver just now. If this is an emergency, hang up and call 911.');
      }
      return { status: 'sent', to: 'caregiver' };
    },

    // Daily cron: one summary per patient per local day, never in quiet hours, nothing when empty.
    async sendDailySummaries() {
      const ms = now();
      const results = [];
      const records = (await Promise.all(['call', 'call_log', 'caregiver_flag', 'text'].map(source => store.list(source)))).flat();
      for (const patient of patients) {
        const zone = await zoneFor(patient);
        const date = localDate(ms, zone);
        const result = { patient: `…${patient.number.slice(-4)}`, date };
        results.push(result);
        if (!patient.caregiver) { result.skipped = 'no_caregiver'; continue; }
        if (!dial) { result.skipped = 'dial_not_configured'; continue; }
        if (isQuietHour(ms, zone)) { result.skipped = 'quiet_hours'; continue; }
        const own = records.filter(record => ownerOf(record, patients) === patient.number);
        const alerts = (await store.caregiverMessages(patient.number, date)).filter(row => row.kind === 'alert' && row.status === 'sent');
        const body = buildDailySummary({ patient, date, records: own, alerts, timeZone: zone });
        if (!body) { result.skipped = 'nothing_to_report'; continue; }
        if (!await store.claimCaregiverSummary(patient.number, date, new Date(ms).toISOString())) {
          result.skipped = 'already_sent';
          continue;
        }
        const id = `summary:${patient.number}:${date}`;
        try {
          await dial.sendText({ to: patient.caregiver, from, body });
          await store.finishCaregiverMessage(id, 'sent', null);
          result.sent = true;
        } catch (error) {
          // Not retried today: the claim stays, so a timeout can never turn into two texts.
          console.error('Caregiver summary failed:', safeMessage(error));
          await store.finishCaregiverMessage(id, 'failed', safeMessage(error));
          result.failed = true;
        }
      }
      return { results };
    },
  };
}
