import Anthropic from '@anthropic-ai/sdk';
import { createDial } from './voice/dial.mjs';
import { embedTexts } from './steph/embed.mjs';
import { checkGeminiKey } from './steph/gemini.mjs';
import { stephProvider } from './steph/routes.mjs';

const TTL_MS = 60_000;
const PROBE_TIMEOUT_MS = 5_000;

// Cheap authenticated reads that prove a key works without spending tokens or placing anything.
function defaultChecks(config) {
  return {
    claude: config.ANTHROPIC_API_KEY
      ? () => new Anthropic({ apiKey: config.ANTHROPIC_API_KEY, timeout: PROBE_TIMEOUT_MS, maxRetries: 0 }).models.list({ limit: 1 })
      : null,
    // GEMINI_API_KEY serves Steph (when it is the provider) and camera vision.
    gemini: config.GEMINI_API_KEY ? () => checkGeminiKey(config.GEMINI_API_KEY, fetch, PROBE_TIMEOUT_MS) : null,
    dial: config.DIAL_API_KEY ? () => createDial(config.DIAL_API_KEY, fetch, { timeoutMs: PROBE_TIMEOUT_MS }).account() : null,
    // Search itself runs on the phone; the server only turns text into vectors when Voyage is configured.
    embeddings: config.VOYAGE_API_KEY
      ? () => embedTexts(fetch, config.VOYAGE_API_KEY, config.EMBED_MODEL || 'voyage-3.5-lite', ['ping'], 'query')
      : null,
  };
}

// Google answers a bad key with 400, the others with 401/403.
function statusOf(error) {
  return [400, 401, 403].includes(error?.status) ? 'invalid' : 'error';
}

// Each check reports ok | missing | invalid | error and never echoes a key or provider message.
// Provider results are cached (and an in-flight probe shared), so the public endpoint can make at
// most one paid-API read per provider per minute.
export function createHealth(config, store, { checks, now = Date.now, ttlMs = TTL_MS } = {}) {
  const probes = { ...defaultChecks(config), ...checks };
  const cache = new Map();

  function probe(name) {
    const run = probes[name];
    if (!run) return Promise.resolve('missing');
    const hit = cache.get(name);
    if (hit && (hit.pending || now() - hit.at < ttlMs)) return hit.pending ?? Promise.resolve(hit.status);
    const pending = Promise.race([
      Promise.resolve().then(run).then(() => 'ok', statusOf),
      new Promise(resolve => setTimeout(resolve, PROBE_TIMEOUT_MS + 500, 'error').unref?.()),
    ]).then(status => {
      cache.set(name, { status, at: now() });
      return status;
    });
    cache.set(name, { pending, at: now() });
    return pending;
  }

  return async function report() {
    let db = 'ok';
    try {
      await store.ping();
    } catch {
      db = 'error';
    }
    const [claude, gemini, dial, embeddings] = await Promise.all(['claude', 'gemini', 'dial', 'embeddings'].map(probe));
    // Which provider answers /ask and /reminders right now (null when neither key is set).
    const provider = stephProvider(config);
    return {
      ok: db === 'ok', checks: { db, claude, gemini, dial, embeddings },
      steph: provider ? { provider: provider.name, model: provider.model } : null, search: 'on-device',
    };
  };
}
