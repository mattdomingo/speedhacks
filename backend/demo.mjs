import { localDate } from './time.mjs';

export function seedDemo(store, now = new Date(), timeZone = 'UTC') {
  const date = localDate(now, timeZone);
  const timestamp = now.toISOString();
  for (const item of [
    { id: `demo-calendar-${date}`, source: 'calendar', date,
      text: `DEMO: Sarah is scheduled to visit on ${date} at 4 PM.` },
    { id: `demo-email-${date}`, source: 'email',
      text: 'DEMO: Sarah wrote that she will bring dinner when she visits.' },
    { id: `demo-keys-${date}`, source: 'camera', object: 'keys',
      location: 'beside the blue mug on the desk',
      text: 'DEMO: Keys last seen beside the blue mug on the desk.' },
  ]) store.put({ ...item, timestamp, demo: true });
}
