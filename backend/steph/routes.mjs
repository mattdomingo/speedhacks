import { Router } from 'express';
import { askSchema, embedSchema, remindersSchema } from '../../contracts/index.mjs';
import { askClaude, createClaude, shapeCard } from './claude.mjs';
import { askGemini, createGemini, StephBusyError } from './gemini.mjs';
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

// Which model answers for Steph: STEPH_PROVIDER, where auto prefers Claude, then Gemini. Null when neither key is set.
export function stephProvider(config) {
  const choice = config.STEPH_PROVIDER ?? 'auto';
  if (choice !== 'gemini' && config.ANTHROPIC_API_KEY) return { name: 'claude', model: config.STEPH_MODEL || 'claude-opus-5-5' };
  if (choice !== 'claude' && config.GEMINI_API_KEY) return { name: 'gemini', model: config.STEPH_GEMINI_MODEL || 'gemini-3.5-flash-lite' };
  return null;
}

// Memories stay on the phone; each request carries only the snippets it needs and nothing is stored here.
export function stephRoutes(config, { claude, fetch: fetchImpl = fetch, gemini } = {}) {
  const router = Router();
  const provider = stephProvider(config);
  let ask = null;
  if (provider?.name === 'claude') {
    const client = claude ?? createClaude(config.ANTHROPIC_API_KEY);
    ask = content => askClaude(client, provider.model, content);
  } else if (provider?.name === 'gemini') {
    const client = gemini ?? createGemini(config.GEMINI_API_KEY, fetchImpl);
    ask = content => askGemini(client, provider.model, content);
  }
  const notConfigured = res => res.status(503).json({ error: 'Steph is not configured' });
  // Both providers share the same hardening: unknown memory ids dropped, buttons clamped, card_type checked.
  async function answer(content, memories) {
    try {
      return { card: shapeCard(await ask(content), memories) };
    } catch (error) {
      if (error instanceof StephBusyError) return { busy: true };
      throw error;
    }
  }

  router.post('/embed', async (req, res) => {
    if (!config.VOYAGE_API_KEY) return res.status(503).json({ error: 'Embeddings are not configured' });
    const { texts, input_type } = embedSchema.parse(req.body);
    res.json(await embedTexts(fetchImpl, config.VOYAGE_API_KEY, config.EMBED_MODEL || 'voyage-3.5-lite', texts, input_type));
  });

  router.post('/ask', async (req, res) => {
    if (!ask) return notConfigured(res);
    const body = askSchema.parse(req.body);
    const { card, busy } = await answer(askTurn(body), body.memories);
    if (busy) return res.status(503).json({ error: 'Steph is busy right now' });
    if (!card) return res.status(502).json({ error: 'Steph could not answer' });
    res.json(card);
  });

  router.post('/reminders', async (req, res) => {
    if (!ask) return notConfigured(res);
    const body = remindersSchema.parse(req.body);
    const results = await Promise.all(body.candidates.map(async candidate => {
      const { card, busy } = await answer(reminderTurn(body, candidate), candidate.memories);
      return busy ? { busy } : card && { candidate_id: candidate.id, ...card };
    }));
    const reminders = results.filter(result => result?.candidate_id);
    if (!reminders.length) {
      return results.some(result => result?.busy) ? res.status(503).json({ error: 'Steph is busy right now' })
        : res.status(502).json({ error: 'Steph could not answer' });
    }
    res.json({ reminders });
  });
  return router;
}
