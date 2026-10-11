import express from 'express';
import { timingSafeEqual } from 'node:crypto';
import { frameSchema, observationSchema } from '../contracts/index.mjs';
import { handleMcp } from './voice/mcp.mjs';
import { describeHeaders, dialWebhook } from './voice/webhooks.mjs';
import { createGoogle } from './digital/google.mjs';
import { googleRoutes } from './digital/routes.mjs';
import { createAnalytics } from './analytics/index.mjs';

function bearer(token) {
  return (req, res, next) => {
    if (!token) return res.status(503).json({ error: 'Endpoint is not configured' });
    const supplied = Buffer.from(req.get('authorization') || '');
    const expected = Buffer.from(`Bearer ${token}`);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
  };
}

function validateTimestamp(timestamp) {
  if (Date.parse(timestamp) > Date.now() + 30_000) {
    const error = new Error('Timestamp is in the future');
    error.status = 400;
    throw error;
  }
}

export function createApp(config, store, google = createGoogle({ config, store }), analytics = createAnalytics({})) {
  const app = express();
  app.disable('x-powered-by');
  app.get('/health', (_req, res) => {
    const db = store.ping();
    res.status(db ? 200 : 503).json({ ok: db, demo: config.DEMO_MODE === 'true' });
  });
  // Signed by Dial over the raw body, so it is mounted before the JSON parser.
  app.post('/webhooks/dial', ...dialWebhook(config, store, analytics));
  app.use('/mcp', bearer(config.DIAL_MCP_TOKEN));
  app.use('/camera', bearer(config.CAMERA_TOKEN));
  app.use(express.json({ limit: '1mb' }));
  app.use('/google', googleRoutes(google, bearer(config.ADMIN_TOKEN)));

  app.all('/mcp', async (req, res) => {
    if (req.method !== 'POST') return res.status(405).set('Allow', 'POST').end();
    // shortcut: caller ID is only a demo allowlist, add verified identity before real personal data.
    if (config.DIAL_LOG_HEADERS === 'true') console.log(`MCP headers: ${describeHeaders(req.headers)}`);
    const number = req.get(config.DIAL_CALLER_HEADER ?? 'x-dial-user-number');
    const direction = req.get(config.DIAL_DIRECTION_HEADER ?? 'x-dial-direction');
    const reason = !config.DEMO_CALLER_NUMBER ? 'no_demo_caller' : !number ? 'no_caller_header'
      : number !== config.DEMO_CALLER_NUMBER ? 'unknown_caller' : direction !== 'inbound' ? 'not_inbound' : undefined;
    await handleMcp(req, res, { store, google, analytics, timeZone: google.timeZone() },
      { authorized: !reason, reason, number: reason ? undefined : number });
  });

  app.post('/camera/observations', (req, res) => {
    const observation = observationSchema.parse(req.body);
    validateTimestamp(observation.timestamp);
    res.status(201).json(store.observe(observation));
  });
  app.post('/camera/frame', (req, res) => {
    const frame = frameSchema.parse(req.body);
    validateTimestamp(frame.timestamp);
    const jpeg = Buffer.from(frame.jpegBase64, 'base64');
    if (jpeg.length > 500_000 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8 ||
      jpeg.at(-2) !== 0xff || jpeg.at(-1) !== 0xd9) {
      return res.status(400).json({ error: 'Expected JPEG, at most 500 KB' });
    }
    store.saveFrame(frame.timestamp, jpeg);
    res.status(201).json({ status: 'stored', inference: 'not_configured', timestamp: frame.timestamp });
  });
  app.get('/camera/frame', (req, res) => {
    const frame = store.latestFrame();
    if (!frame) return res.status(404).json({ error: 'No frame received' });
    res.set('X-Captured-At', frame.timestamp).type('jpeg').send(Buffer.from(frame.jpeg));
  });
  app.use((error, _req, res, _next) => {
    if (error.name === 'ZodError') return res.status(400).json({ error: 'Invalid request', issues: error.issues });
    const status = error.status || 500;
    if (status === 500) console.error('Request failed:', error.message);
    res.status(status).json({ error: status === 500 ? 'Internal server error' : error.message });
  });
  return app;
}
