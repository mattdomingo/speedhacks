import { createHash, timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import { appAskSchema, appSessionSchema, memorySchema } from '../../contracts/index.mjs';
import { getSchedule, searchMessages } from '../digital/index.mjs';
import { findObject } from '../physical/index.mjs';
import { scopedStore } from '../voice/patients.mjs';
import { careInstructions, whoIs } from '../voice/people.mjs';
import { checkPin } from '../voice/pin.mjs';
import { askClaude, createClaude, shapeCard } from './claude.mjs';
import { askGemini, createGemini, StephBusyError } from './gemini.mjs';
import { askTurn, clockMemory } from './prompt.mjs';
import { stephProvider } from './routes.mjs';
import { APP_ANSWER_PROMPT, PLAN_PROMPT, appCardFormat, parseAppCard, parsePlan, planFormat, planTurn } from './app-plan.mjs';

export const APP_MEMORY_PATHS = ['/app/ask', '/app/session'];
const hash = value => createHash('sha256').update(value).digest('hex');
const fail = (status, code, message) => Object.assign(new Error(message), { status, code });
const unavailable = () => fail(503, 'memory_unavailable', 'Shared memory is unavailable. Please try again.');

// Each provisioned device credential maps to exactly one configured patient. The shared
// demo app token and Dial/camera credentials never grant access to this route.
export function appMemoryAuth(config, patients) {
  const bindings = config.RECALL_PATIENT_TOKENS ?? [];
  return (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (!bindings.length) return res.status(503).json({ code: 'app_not_configured', error: 'Shared app memory is not configured.' });
    const token = /^Bearer ([A-Za-z0-9_-]{32,256})$/.exec(req.get('authorization') ?? '')?.[1];
    const digest = Buffer.from(hash(token ?? ''), 'hex');
    let binding;
    for (const entry of bindings) {
      if (timingSafeEqual(digest, Buffer.from(entry.tokenHash, 'hex'))) binding = entry;
    }
    const patient = token && binding && patients.find(candidate => candidate.number === binding.patient);
    if (!patient) return res.status(401).json({ code: 'unauthorized', error: 'Reconnect this device to shared memory.' });
    res.locals.appPatient = patient;
    next();
  };
}

async function admitPin(store, config, patient, pin) {
  let problem;
  try { problem = await checkPin(store, config.CALLER_PIN, patient.number, pin); }
  catch { throw unavailable(); }
  if (problem === 'pin_missing') throw fail(401, 'pin_required', 'Enter your memory PIN to connect.');
  if (problem === 'pin_wrong') throw fail(401, 'pin_wrong', 'That memory PIN is not correct.');
  if (problem === 'pin_locked') throw fail(429, 'pin_locked', 'Too many wrong PIN attempts. Try again in 15 minutes.');
}

// Bounds every awaited stage and cancels provider requests. No later stage starts after
// expiry; existing Google retrieval owns its own bounded, generation-fenced cache writes.
async function bounded(operation, signal) {
  signal.throwIfAborted();
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try { return await Promise.race([Promise.resolve().then(operation), aborted]); }
  finally { signal.removeEventListener('abort', onAbort); }
}

function normalize(record, patient) {
  if (record.demo) return null;
  const type = record.source === 'calendar' ? 'event' : record.source === 'person' ? 'person' : 'note';
  const summary = record.source === 'camera'
    ? String(record.object ?? '') + ' last seen ' + String(record.location ?? '') + '.'
    : record.text;
  const parsed = memorySchema.safeParse({
    id: 'shared:' + hash(JSON.stringify([patient.number, record.source, record.id])),
    type, summary: typeof summary === 'string' ? summary.slice(0, 600) : '',
    people: record.source === 'person' && record.name ? [String(record.name).slice(0, 100)] : [],
    ...(record.location ? { place: String(record.location).slice(0, 200) } : {}),
    timestamp: record.timestamp, source: record.source,
    confidence: typeof record.confidence === 'number' ? record.confidence : 1,
  });
  // Malformed evidence is an unavailable lookup, not a silently empty successful one.
  if (!parsed.success || typeof record.id !== 'string' || !record.id) throw unavailable();
  const provenance = { source: parsed.data.source, timestamp: parsed.data.timestamp };
  if (typeof record.origin === 'string') provenance.origin = record.origin.slice(0, 100);
  if (typeof record.ref === 'string') {
    try { if (new URL(record.ref).protocol === 'https:') provenance.ref = record.ref.slice(0, 2000); } catch {}
  }
  return { ...parsed.data, demo: false, provenance };
}

function provider(config, { claude, gemini, fetch: fetchImpl = fetch }) {
  const selected = stephProvider(config);
  if (!selected) return null;
  if (selected.name === 'claude') {
    const client = claude ?? createClaude(config.ANTHROPIC_API_KEY, { timeout: 20_000, maxRetries: 0 });
    return (content, options) => askClaude(client, selected.model, content, options);
  }
  const client = gemini ?? createGemini(config.GEMINI_API_KEY, fetchImpl, { timeoutMs: 20_000 });
  return (content, options) => askGemini(client, selected.model, content, options);
}

export function appMemoryRoutes(config, store, {
  google, patients, now = Date.now, timeoutMs = 45_000, ...providerOptions
}) {
  const router = Router();
  const generate = provider(config, providerOptions);

  function route(work) {
    return async (req, res) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(unavailable()), timeoutMs);
      const closed = () => { if (!res.writableEnded) controller.abort(unavailable()); };
      res.on('close', closed);
      try { await work(req, res, controller.signal); }
      catch (error) {
        const problem = error instanceof StephBusyError
          ? fail(503, 'provider_unavailable', 'Steph is busy. Please try again.')
          : error?.code && ['memory_unavailable', 'pin_required', 'pin_wrong', 'pin_locked', 'provider_unavailable'].includes(error.code)
            ? error : error?.name === 'ZodError'
              ? fail(400, 'invalid_request', 'The app memory request is invalid.') : unavailable();
        if (!res.headersSent && !res.destroyed) res.status(problem.status).json({ code: problem.code, error: problem.message });
      } finally {
        clearTimeout(timer);
        res.removeListener('close', closed);
      }
    };
  }

  router.post('/app/session', route(async (req, res, signal) => {
    const { pin } = appSessionSchema.parse(req.body);
    await bounded(() => admitPin(store, config, res.locals.appPatient, pin), signal);
    res.json({ connected: true });
  }));

  router.post('/app/ask', route(async (req, res, signal) => {
    const body = appAskSchema.parse(req.body);
    const patient = res.locals.appPatient;
    await bounded(() => admitPin(store, config, patient, body.pin), signal);
    if (!generate) throw fail(503, 'provider_unavailable', 'Steph is not configured.');
    const ownStore = scopedStore(store, patient, patients);
    const ownGoogle = patient.primary ? google : undefined;
    const clock = new Date(now());
    const timeZone = patient.timeZone ?? config.TIMEZONE
      ?? (ownGoogle ? await bounded(() => ownGoogle.timeZone(), signal) : 'UTC');
    // The phone's clock and zone cannot alter shared date selection or evidence rendering.
    const turn = { ...body, now: clock.toISOString(), time_zone: timeZone };
    const plan = await bounded(() => generate(planTurn(body.question, clock, timeZone), {
      system: PLAN_PROMPT, format: planFormat, parse: parsePlan, signal, maxTokens: 1200,
    }), signal);
    if (!plan) throw fail(502, 'provider_unavailable', 'Steph could not plan a memory lookup. Please try again.');
    const { calls, intent } = plan;
    if (intent === 'unsupported_action') {
      return res.json({ answer: 'This app cannot set reminders, send messages, or make calls.',
        card_type: 'answer', memory_ids: [], buttons: ['Okay'], evidence: [] });
    }

    const scopes = [...new Set(calls.flatMap(call => call.tool === 'get_schedule' ? ['calendar']
      : call.tool === 'search_messages' ? ['gmail'] : []))];
    const contexts = ownGoogle ? await bounded(() => Promise.all(scopes.map(scope => ownGoogle.snapshot(scope))), signal) : [];
    if (contexts.some(context => context.state === 'reconnect_required')) throw unavailable();
    const assertContexts = () => bounded(() => Promise.all(contexts.map(async context => {
      await ownGoogle.assertCurrent(context);
      const current = await ownGoogle.snapshot(context.scope);
      if (current.generation !== context.generation || current.state !== context.state) throw unavailable();
    })), signal);
    const options = { includeDemo: false };
    const lookups = {
      get_schedule: ({ date, end_date }) => getSchedule(ownStore, date, ownGoogle, { ...options, endDate: end_date ?? date }),
      search_messages: ({ query, date, end_date }) => searchMessages(ownStore, query, ownGoogle, { ...options, date, endDate: end_date ?? date, timeZone }),
      find_object: ({ object }) => findObject(ownStore, object, options),
      who_is: ({ name }) => whoIs(ownStore, name, options),
      care_instructions: ({ topic }) => careInstructions(ownStore, topic, options),
    };
    // Bound prompt size even when a month's calendar contains many entries.
    const results = await bounded(() => Promise.all(calls.map(call => lookups[call.tool](call.args))), signal);
    const excluded = new Set(body.excluded_ids);
    const shared = new Map();
    for (const result of results) {
      if (!Array.isArray(result.evidence)) throw unavailable();
      for (const record of result.evidence) {
        const memory = normalize(record, patient);
        if (memory && !excluded.has(memory.id)) shared.set(memory.id, memory);
      }
    }
    const evidence = [...shared.values()].slice(0, 24);
    const memories = [...evidence, ...body.memories].slice(0, 48);
    // A faster Google lookup can become stale while another lookup is still running.
    await assertContexts();
    const rawCard = await bounded(() => generate(askTurn({ ...turn, memories }), {
      system: APP_ANSWER_PROMPT, format: appCardFormat, parse: parseAppCard, signal, maxTokens: 1500,
    }), signal);
    if (!rawCard) throw fail(502, 'provider_unavailable', 'Steph could not answer. Please try again.');

    // Account/scope replacement during model generation must invalidate the finished answer.
    await assertContexts();
    signal.throwIfAborted();
    const allowed = [clockMemory(turn.now, timeZone), ...memories];
    const allowedIDs = new Set(allowed.map(memory => memory.id));
    const clockOnlyLookup = intent !== 'clock' && rawCard.memory_ids.every(id => id === 'clock-now');
    if (rawCard.memory_ids.some(id => !allowedIDs.has(id)) || (rawCard.supported && (!rawCard.memory_ids.length || clockOnlyLookup))) {
      throw fail(502, 'provider_unavailable', 'Steph could not verify that answer. Please try again.');
    }
    const card = rawCard.supported ? shapeCard(rawCard, allowed) : {
      answer: "I'm not sure; I don't have a matching memory for that.",
      card_type: 'answer', memory_ids: [], buttons: ['Okay'],
    };
    res.json({ ...card, evidence: evidence.filter(memory => card.memory_ids.includes(memory.id)) });
  }));
  return router;
}
