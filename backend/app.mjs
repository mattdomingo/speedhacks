import express from 'express';
import { timingSafeEqual } from 'node:crypto';
import { frameSchema, observationSchema } from '../contracts/index.mjs';
import { handleMcp } from './voice/mcp.mjs';
import { createPhysicalMemory } from './physical/pipeline.mjs';
import { frameId } from './physical/state.mjs';
import { createGoogle } from './digital/google.mjs';
import { cronRoutes, googleRoutes } from './digital/routes.mjs';
import { describeHeaders, dialWebhook } from './voice/webhooks.mjs';
import { createAnalytics } from './analytics/index.mjs';
import { createDial } from './voice/dial.mjs';
import { createReminders } from './voice/reminders.mjs';
import { STEPH_PATHS, stephGate, stephRoutes } from './steph/routes.mjs';

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

export function createApp(config, store, physicalOptions, {
  google = createGoogle({ config, store }), analytics = createAnalytics({}), dial, now, steph,
} = {}) {
  const app = express();
  const physical = createPhysicalMemory(config, store, physicalOptions);
  const reminders = createReminders(config, store, {
    dial: config.DIAL_API_KEY ? dial ?? createDial(config.DIAL_API_KEY) : null, now, timeZone: () => google.timeZone(),
  });
  app.disable('x-powered-by');
  app.get('/health', (_req, res) => res.json({ ok: true, demo: config.DEMO_MODE === 'true' }));
  // Signed by Dial over the raw body, so it is mounted before the JSON parser.
  app.post('/webhooks/dial', dialWebhook(config, store, analytics, event => reminders.handleEvent(event)));
  app.use('/mcp', bearer(config.DIAL_MCP_TOKEN));
  app.use('/camera', bearer(config.CAMERA_TOKEN));
  app.use('/camera', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  app.use(STEPH_PATHS, stephGate(config), bearer(config.RECALL_APP_TOKEN));
  app.use(express.json({ limit: '1mb' }));
  app.use('/google', googleRoutes(google, bearer(config.ADMIN_TOKEN)));
  // Vercel Cron, every minute: deliver due reminders and settle calls whose webhook never arrived.
  app.get('/cron/dial-reminders', bearer(config.CRON_SECRET), async (_req, res) => {
    if (!reminders.ready) return res.status(503).json({ error: 'Reminder delivery is not configured' });
    res.set('Cache-Control', 'no-store').json(await reminders.dispatch());
  });
  app.use('/cron', cronRoutes(google, bearer(config.CRON_SECRET), { store, retentionDays: config.DIAL_EVENT_RETENTION_DAYS }));
  app.use(stephRoutes(config, steph));

  app.all('/mcp', async (req, res) => {
    if (req.method !== 'POST') return res.status(405).set('Allow', 'POST').end();
    // One message per request: batches would let one request run many tool calls (and PIN
    // guesses) at once. Dial sends single messages, and MCP 2025-06-18 removed batching.
    if (Array.isArray(req.body)) {
      return res.status(400).json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Batch requests are not supported' } });
    }
    if (config.DIAL_LOG_HEADERS === 'true') console.log(`MCP headers: ${describeHeaders(req.headers)}`);
    // shortcut: caller ID is only a demo allowlist; CALLER_PIN adds a second factor. Add verified
    // identity and user-scoped storage before multiple users' personal data.
    const number = req.get(config.DIAL_CALLER_HEADER ?? 'x-dial-user-number');
    const direction = req.get(config.DIAL_DIRECTION_HEADER ?? 'x-dial-direction');
    const known = !config.DEMO_CALLER_NUMBER ? 'no_demo_caller' : !number ? 'no_caller_header'
      : number !== config.DEMO_CALLER_NUMBER ? 'unknown_caller' : undefined;
    const reason = known ?? (direction !== 'inbound' ? 'not_inbound' : undefined);
    // Reminder calls ring the same person from Steph's line, and they may ask to be reminded again.
    const reminderReason = known ?? (!['inbound', 'outbound'].includes(direction) ? 'no_direction'
      : req.get('x-dial-agent-number') !== config.STEPH_NUMBER ? 'not_steph_line' : undefined);
    await handleMcp(req, res, store, {
      authorized: !reason, reason, number: known ? undefined : number, reminders: !reminderReason, reminderReason,
    }, {
      includeDemo: config.DEMO_MODE === 'true', cameraStatus: () => physical.status(),
      google, analytics, timeZone: await google.timeZone(), callerPin: config.CALLER_PIN, reminders,
    });
  });

  app.post('/camera/observations', async (req, res) => {
    const observation = observationSchema.parse(req.body);
    validateTimestamp(observation.timestamp);
    res.status(201).json(await store.observe(observation));
  });
  app.post('/camera/frame', async (req, res) => {
    const frame = frameSchema.parse(req.body);
    validateTimestamp(frame.timestamp);
    const jpeg = Buffer.from(frame.jpegBase64, 'base64');
    if (jpeg.length > 500_000 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8 ||
      jpeg.at(-2) !== 0xff || jpeg.at(-1) !== 0xd9) {
      return res.status(400).json({ error: 'Expected JPEG, at most 500 KB' });
    }
    const stored = await store.saveFrame(frame.timestamp, jpeg);
    // Await inference inside the request; Vercel may suspend work after a response.
    const result = stored ? await physical.processLatest()
      : { inference: config.GEMINI_API_KEY ? 'ignored' : 'not_configured' };
    res.status(201).json({ status: stored ? 'stored' : 'ignored', timestamp: frame.timestamp,
      frameId: frameId({ timestamp: frame.timestamp, jpeg }), ...result });
  });
  app.get('/camera/status', async (_req, res) => res.json(await physical.status()));
  app.get('/camera/evidence/:frameId', async (req, res) => {
    if (!/^[a-f0-9]{64}$/.test(req.params.frameId)) return res.status(404).json({ error: 'No retained evidence frame' });
    const frame = await store.cameraSnapshot(req.params.frameId);
    if (!frame) return res.status(404).json({ error: 'No retained evidence frame' });
    res.set('X-Captured-At', frame.timestamp).type('jpeg').send(Buffer.from(frame.jpeg));
  });
  app.get('/camera/frame', async (req, res) => {
    const frame = await store.latestFrame();
    if (!frame) return res.status(404).json({ error: 'No frame received' });
    res.set('X-Captured-At', frame.timestamp).type('jpeg').send(Buffer.from(frame.jpeg));
  });
  app.use((error, _req, res, _next) => {
    if (error.name === 'ZodError') return res.status(400).json({ error: 'Invalid request', issues: error.issues });
    // Vercel's request helpers report malformed bodies with statusCode instead of status.
    const status = error.status || error.statusCode || 500;
    if (status === 500) console.error('Request failed:', error.message);
    res.status(status).json({ error: status === 500 ? 'Internal server error' : error.message });
  });
  return app;
}
