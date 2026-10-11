import express from 'express';
import { timingSafeEqual } from 'node:crypto';
import { frameSchema, observationSchema } from '../contracts/index.mjs';
import { handleMcp } from './voice/mcp.mjs';
import { createDial, verifyDialSignature } from './voice/dial.mjs';
import { createReminders } from './voice/reminders.mjs';
import { createPhysicalMemory } from './physical/pipeline.mjs';
import { frameId } from './physical/state.mjs';

function bearer(token) {
  return (req, res, next) => {
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

export function createApp(config, store, physicalOptions, voiceOptions = {}) {
  const app = express();
  const physical = createPhysicalMemory(config, store, physicalOptions);
  const dial = config.DIAL_API_KEY ? voiceOptions.dial ?? createDial(config.DIAL_API_KEY) : null;
  const reminders = createReminders(config, store, { dial, now: voiceOptions.now });
  app.disable('x-powered-by');
  app.get('/health', (_req, res) => res.json({ ok: true, demo: config.DEMO_MODE === 'true' }));
  app.use('/mcp', bearer(config.DIAL_MCP_TOKEN));
  app.use('/camera', bearer(config.CAMERA_TOKEN));
  app.use('/camera', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  app.use('/dial', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

  // Registered before the JSON parser: the signature covers the exact bytes Dial sent.
  app.post('/dial/webhook', express.raw({ type: () => true, limit: '256kb' }), async (req, res) => {
    if (!config.DIAL_WEBHOOK_SECRET) return res.status(503).json({ error: 'Dial webhooks are not configured' });
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!verifyDialSignature(config.DIAL_WEBHOOK_SECRET, req.get('x-dial-signature'), raw)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    let event;
    try { event = JSON.parse(raw.toString('utf8')); } catch { return res.status(400).json({ error: 'Invalid JSON' }); }
    const id = req.get('x-dial-event-id') || event.id;
    if (typeof id !== 'string' || !id) return res.status(400).json({ error: 'Missing event ID' });
    // Deliveries repeat; handling is idempotent, and the event is recorded only after it succeeds.
    if (await store.seenDialEvent(id)) return res.json({ ok: true, duplicate: true });
    await reminders.handleEvent(event);
    await store.recordDialEvent(id, String(event.type || 'unknown'), new Date().toISOString());
    res.json({ ok: true });
  });
  app.get('/dial/dispatch', (_req, res, next) => {
    if (!config.CRON_SECRET || !reminders.ready) return res.status(503).json({ error: 'Reminder delivery is not configured' });
    next();
  }, bearer(config.CRON_SECRET), async (_req, res) => res.json(await reminders.dispatch()));
  app.use(express.json({ limit: '1mb' }));

  app.all('/mcp', async (req, res) => {
    if (req.method !== 'POST') return res.status(405).set('Allow', 'POST').end();
    // shortcut: caller ID is only a demo allowlist, add verified identity before real personal data.
    const caller = req.get('x-dial-user-number');
    const direction = req.get('x-dial-direction');
    const known = config.DEMO_CALLER_NUMBER !== '' && caller === config.DEMO_CALLER_NUMBER;
    const access = {
      caller,
      memory: known && direction === 'inbound',
      // Reminder calls ring the same person from Steph's line; they may ask to be reminded again.
      reminders: known && ['inbound', 'outbound'].includes(direction) &&
        req.get('x-dial-agent-number') === config.STEPH_NUMBER,
    };
    await handleMcp(req, res, store, access, {
      includeDemo: config.DEMO_MODE === 'true', cameraStatus: () => physical.status(),
    }, reminders);
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
    const status = error.status || 500;
    if (status === 500) console.error('Request failed:', error.message);
    res.status(status).json({ error: status === 500 ? 'Internal server error' : error.message });
  });
  return app;
}
