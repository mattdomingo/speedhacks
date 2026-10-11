export async function seedDemo(store, now = new Date()) {
  const date = now.toISOString().slice(0, 10);
  const timestamp = now.toISOString();
  for (const item of [
    { id: `demo-calendar-${date}`, source: 'calendar', date,
      text: `DEMO: Sarah is scheduled to visit on ${date} at 4 PM.` },
    { id: `demo-email-${date}`, source: 'email',
      text: 'DEMO: Sarah wrote that she will bring dinner when she visits.' },
    { id: `demo-keys-${date}`, source: 'camera', object: 'keys',
      location: 'beside the blue mug on the desk',
      text: 'DEMO: Keys last seen beside the blue mug on the desk.' },
  ]) await store.put({ ...item, timestamp, demo: true });
}
