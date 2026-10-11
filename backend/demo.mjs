import { addDays, localDate, localInstant } from './time.mjs';

// Patient B exists only in demo data, so isolation can be shown: calls from patient A never see it.
export const DEMO_PATIENT_B = '+15555550199';

// The demo story, matching the iPhone app's demo mode, dated in the person's time zone so it
// stays true every day. Records belong to the primary patient unless they name `patient`.
// Ids are keyed by date (or fixed for timeless facts), so re-running the same day changes nothing.
export function demoRecords(now = new Date(), timeZone = 'UTC') {
  const date = localDate(now, timeZone);
  const at = (day, time) => localInstant(`${day}T${time}`, timeZone).toISOString();
  const today = time => at(date, time);
  const seeded = now.toISOString();
  return [
    { id: `demo-keys-${date}`, source: 'camera', object: 'keys', location: 'on the kitchen counter, next to the fruit bowl',
      timestamp: today('08:12'), text: 'DEMO: Keys last seen on the kitchen counter, next to the fruit bowl.' },
    { id: `demo-car-${date}`, source: 'camera', object: 'car', location: 'on Level 3, spot 42 of the parking garage',
      timestamp: today('07:58'), text: 'DEMO: You parked on Level 3, spot 42.' },
    { id: `demo-calendar-priya-${date}`, source: 'calendar', date, title: 'Coffee with Priya', timestamp: today('15:00'),
      text: `DEMO: Coffee with Priya on ${date} at 3:00 PM.` },
    { id: `demo-calendar-maya-${date}`, source: 'calendar', date, title: 'Maya visits', timestamp: today('16:00'),
      text: `DEMO: Your daughter Maya is visiting on ${date} at 4 PM.` },
    { id: `demo-email-${date}`, source: 'email', from: 'Maya', subject: 'Dinner', timestamp: seeded,
      text: 'DEMO: Maya wrote that she will bring dinner when she visits.' },
    { id: `demo-note-priya-${date}`, source: 'note', name: 'Priya', timestamp: at(addDays(date, -14), '18:40'),
      text: "DEMO: Priya's mom had surgery. Ask how her mom is doing." },
    { id: 'demo-person-priya', source: 'person', name: 'Priya', relation: 'friend', timestamp: seeded,
      text: 'DEMO: Priya is your friend. You see her for coffee.' },
    { id: 'demo-person-sam', source: 'person', name: 'Sam Chen', relation: 'friend', timestamp: seeded,
      text: 'DEMO: Sam Chen is your friend. He started a new design job in September, and his son Leo just turned 4. ' +
        'You promised to send him the Tokyo ramen place.' },
    { id: `demo-calendar-sam-${date}`, source: 'calendar', date: addDays(date, -21), title: 'Lunch with Sam Chen',
      timestamp: at(addDays(date, -21), '12:30'), text: `DEMO: Lunch with Sam Chen on ${addDays(date, -21)} at 12:30 PM.` },
    { id: 'demo-person-maya', source: 'person', name: 'Maya', relation: 'daughter', timestamp: seeded,
      text: 'DEMO: Maya is your daughter.' },
    { id: 'demo-care-pills', source: 'caregiver', topic: 'pills medication medicine', timestamp: seeded,
      text: 'DEMO: Your caregiver saved this: Take one blue pill with breakfast.' },
    // Patient B: a different family that patient A must never hear about.
    { id: 'demo-b-person-diego', source: 'person', patient: DEMO_PATIENT_B, name: 'Diego', relation: 'son', timestamp: seeded,
      text: 'DEMO: Diego is your son. He lives in Austin.' },
    { id: `demo-b-glasses-${date}`, source: 'camera', patient: DEMO_PATIENT_B, object: 'glasses', location: 'on the bedside table',
      timestamp: today('07:30'), text: 'DEMO: Glasses last seen on the bedside table.' },
    { id: `demo-b-calendar-${date}`, source: 'calendar', patient: DEMO_PATIENT_B, date, title: 'Diego visits', timestamp: today('11:00'),
      text: `DEMO: Your son Diego is visiting on ${date} at 11 AM.` },
  ].map(record => ({ ...record, demo: true }));
}

export async function seedDemo(store, now = new Date(), timeZone = 'UTC') {
  const records = demoRecords(now, timeZone);
  for (const record of records) await store.put(record);
  return records.length;
}
