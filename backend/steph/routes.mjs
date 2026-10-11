import { Router } from 'express';
import { askSchema, embedSchema, remindersSchema } from '../../contracts/index.mjs';
import { askClaude, createClaude, shapeCard } from './claude.mjs';
import { embedTexts } from './embed.mjs';
import { askTurn, reminderTurn } from './prompt.mjs';

export const STEPH_PATHS = ['/embed', '/ask', '/reminders'];

// Runs before authentication so an unconfigured deployment says so plainly.
export function stephGate(config) {
  return (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (!config.RECALL_APP_TOKEN) return res.status(503).json({ error: 'Steph is not configured' });
    next();
  };
}

// Memories stay on the phone; each request carries only the snippets it needs and nothing is stored here.
export function stephRoutes(config, { claude, fetch: fetchImpl = fetch } = {}) {
  const router = Router();
  const model = config.STEPH_MODEL || 'claude-opus-5-5';
  const client = config.ANTHROPIC_API_KEY ? claude ?? createClaude(config.ANTHROPIC_API_KEY) : null;
  const notConfigured = res => res.status(503).json({ error: 'Steph is not configured' });

  router.post('/embed', async (req, res) => {
    if (!config.VOYAGE_API_KEY) return res.status(503).json({ error: 'Embeddings are not configured' });
    const { texts, input_type } = embedSchema.parse(req.body);
    res.json(await embedTexts(fetchImpl, config.VOYAGE_API_KEY, config.EMBED_MODEL || 'voyage-3.5-lite', texts, input_type));
  });

  router.post('/ask', async (req, res) => {
    if (!client) return notConfigured(res);
    const body = askSchema.parse(req.body);
    const card = shapeCard(await askClaude(client, model, askTurn(body)), body.memories);
    if (!card) return res.status(502).json({ error: 'Steph could not answer' });
    res.json(card);
  });

  router.post('/reminders', async (req, res) => {
    if (!client) return notConfigured(res);
    const body = remindersSchema.parse(req.body);
    const results = await Promise.all(body.candidates.map(async candidate => {
      const card = shapeCard(await askClaude(client, model, reminderTurn(body, candidate)), candidate.memories);
      return card && { candidate_id: candidate.id, ...card };
    }));
    const reminders = results.filter(Boolean);
    if (!reminders.length) return res.status(502).json({ error: 'Steph could not answer' });
    res.json({ reminders });
  });
  return router;
}
