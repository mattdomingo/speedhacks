import express from 'express';
import { readConfig } from './config.mjs';
import { postgres } from './db.mjs';
import { createStore } from './store.mjs';
import { seedDemo } from './demo.mjs';
import { createApp } from './app.mjs';
import { createGoogle } from './digital/google.mjs';
import { createAnalytics } from './analytics/index.mjs';

// Wires the backend once per process or serverless instance. Both entry points share it:
// server.js (Vercel function) and backend/index.mjs (long-running server, Docker).
export function createRuntime(config = readConfig(), { db = postgres(config.DATABASE_URL) } = {}) {
  const store = createStore(db);
  const analytics = createAnalytics(config);
  const google = createGoogle({ config, store,
    onSync: results => analytics.sync({ caller: config.DEMO_CALLER_NUMBER, results }) });

  // Migrations and demo seeding run before the first request; a failure (e.g. a database
  // still waking from scale-to-zero) is retried by the next request.
  let booted;
  const boot = () => (booted ??= (async () => {
    await store.ready();
    if (config.DEMO_MODE === 'true') await seedDemo(store, new Date(), await google.timeZone());
  })().catch(error => { booted = undefined; throw error; }));

  const app = express();
  app.disable('x-powered-by');
  app.use((_req, res, next) => boot().then(() => next(), error => {
    console.error(`Startup failed: ${error.message}`);
    res.status(503).json({ ok: false, error: 'Database unavailable' });
  }));
  app.use(createApp(config, store, google, analytics));
  return { config, store, google, analytics, app, boot };
}
