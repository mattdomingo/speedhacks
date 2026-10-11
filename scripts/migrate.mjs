// Applies pending schema migrations: npm run db:migrate (uses DATABASE_URL or POSTGRES_URL).
// The backend also migrates on first request, so this is optional before a deploy.
import { postgres } from '../backend/db.mjs';
import { createStore, SCHEMA_VERSION } from '../backend/store.mjs';

const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
if (!url) {
  console.error('Set DATABASE_URL to a postgres:// connection string.');
  process.exit(2);
}
const store = createStore(postgres(url));
try {
  await store.ready();
  console.log(`Database schema is at v${SCHEMA_VERSION}.`);
} finally {
  await store.close();
}
