import express from 'express';
import { z } from 'zod';

const callbackQuery = z.object({
  code: z.string().min(1).max(2048).optional(),
  state: z.string().min(1).max(256).optional(),
  error: z.string().max(256).optional(),
});

// Static pages only: nothing from the request is reflected back to the browser.
function page(res, status, message) {
  res.status(status).set({
    'Content-Security-Policy': "default-src 'none'", 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store',
  }).type('html').send(`<!doctype html><meta charset="utf-8"><title>Memory assistant</title><p>${message}</p>`);
}

export function googleRoutes(google, adminAuth) {
  const router = express.Router();
  router.use((_req, res, next) => google.configured ? next()
    : res.status(503).json({ error: 'Google integration is not configured' }));

  // Public: Google redirects the browser here. The single-use state proves an admin started it.
  router.get('/callback', async (req, res) => {
    const query = callbackQuery.safeParse(req.query);
    if (!query.success || query.data.error || !query.data.code || !query.data.state) {
      return page(res, 400, 'Google connection was not completed. Start again from the connect command.');
    }
    try {
      await google.completeConnect(query.data.code, query.data.state);
      // Sync before responding: work after the response is not durable on Vercel (DEC-004).
      const synced = (await google.syncAll()).every(result => result.ok);
      page(res, 200, synced ? 'Google account connected and synced. You can close this tab.'
        : 'Google account connected; the first sync failed and will be retried. You can close this tab.');
    } catch (error) {
      console.error(`Google connection failed: ${error.message}`);
      page(res, error.status === 400 ? 400 : 502, 'Google connection failed. Start again from the connect command.');
    }
  });

  router.use(adminAuth);
  router.post('/connect', async (_req, res) => {
    res.json({ authorizationUrl: await google.beginConnect(), expiresInSeconds: 600 });
  });
  router.get('/status', async (_req, res) => res.json(await google.status()));
  router.post('/sync', async (_req, res) => {
    if (!(await google.can('calendar')) && !(await google.can('gmail'))) {
      return res.status(409).json({ error: 'Google account is not connected', ...(await google.status()) });
    }
    res.json({ results: await google.syncAll(), ...(await google.status()) });
  });
  router.delete('/connection', async (_req, res) => {
    await google.disconnect();
    res.json(await google.status());
  });
  return router;
}

// Vercel Cron calls this with `Authorization: Bearer $CRON_SECRET` (Hobby plans: once a day).
// It also enforces Dial transcript retention, which otherwise only runs when a webhook arrives,
// and keeps doing so after webhooks are switched off. A database that has not yet run
// `npm run db:init` for the Dial table (Postgres 42P01) simply has nothing to prune.
export function cronRoutes(google, cronAuth, { store, retentionDays = 30 } = {}) {
  const router = express.Router();
  router.get('/google-sync', cronAuth, async (_req, res) => {
    let pruned = 0;
    try {
      pruned = store ? await store.pruneDialEvents(retentionDays) : 0;
    } catch (error) {
      if (error.code !== '42P01') throw error;
    }
    if (!google.configured) return res.json({ skipped: 'Google integration is not configured', prunedDialEvents: pruned });
    res.json({ results: await google.syncAll(), prunedDialEvents: pruned });
  });
  return router;
}
