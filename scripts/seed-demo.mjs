// npm run seed:demo — loads the demo story (keys, Priya, Sam, Maya, parking, a caregiver note, and
// a separate demo patient B) into the configured database. Safe to re-run: same-day ids are reused.
import { readConfig } from '../backend/config.mjs';
import { openStore } from '../backend/store.mjs';
import { openPostgresStore } from '../backend/postgres.mjs';
import { seedDemo, DEMO_PATIENT_B } from '../backend/demo.mjs';

const config = readConfig();
const store = config.DATABASE_URL ? openPostgresStore(config.DATABASE_URL) : openStore(config.DATA_DIR);
const timeZone = config.TIMEZONE ?? 'UTC';
try {
  const count = await seedDemo(store, new Date(), timeZone);
  console.log(`Seeded ${count} demo records (${timeZone}) into ${config.DATABASE_URL ? 'Postgres' : `SQLite in ${config.DATA_DIR}`}.`);
  console.log(`Demo patient B is ${DEMO_PATIENT_B}. Set DEMO_MODE=true so phone lookups include demo object locations.`);
} finally {
  await store.close();
}
