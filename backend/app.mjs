import express from 'express';
import { timingSafeEqual } from 'node:crypto';
import { frameSchema, observationSchema } from '../contracts/index.mjs';
import { handleMcp } from './voice/mcp.mjs';

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

export function createApp(config, store) {
  const app = express();
  app.disable('x-powered-by');
  app.get('/health', (_req, res) => res.json({ ok: true, demo: config.DEMO_MODE === 'true' }));
  app.use('/mcp', bearer(config.DIAL_MCP_TOKEN));
  app.use('/camera', bearer(config.CAMERA_TOKEN));
  app.use(express.json({ limit: '1mb' }));

  app.all('/mcp', async (req, res) => {
    if (req.method !== 'POST') return res.status(405).set('Allow', 'POST').end();
    // shortcut: caller ID is only a demo allowlist, add verified identity before real personal data.
    const authorized = config.DEMO_CALLER_NUMBER !== '' &&
      req.get('x-dial-user-number') === config.DEMO_CALLER_NUMBER &&
      req.get('x-dial-direction') === 'inbound';
    await handleMcp(req, res, store, authorized);
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
    await store.saveFrame(frame.timestamp, jpeg);
    res.status(201).json({ status: 'stored', inference: 'not_configured', timestamp: frame.timestamp });
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
