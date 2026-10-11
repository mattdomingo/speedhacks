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
      google.syncAll().catch(() => {});
      page(res, 200, 'Google account connected. You can close this tab.');
    } catch (error) {
      console.error(`Google connection failed: ${error.message}`);
      page(res, error.status === 400 ? 400 : 502, 'Google connection failed. Start again from the connect command.');
    }
  });

  router.use(adminAuth);
  router.post('/connect', (_req, res) => {
    res.json({ authorizationUrl: google.beginConnect(), expiresInSeconds: 600 });
  });
  router.get('/status', (_req, res) => res.json(google.status()));
  router.post('/sync', async (_req, res) => {
    if (!google.can('calendar') && !google.can('gmail')) {
      return res.status(409).json({ error: 'Google account is not connected', ...google.status() });
    }
    res.json({ results: await google.syncAll(), ...google.status() });
  });
  router.delete('/connection', async (_req, res) => {
    await google.disconnect();
    res.json(google.status());
  });
  return router;
}
