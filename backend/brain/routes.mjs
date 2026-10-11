import { Router } from 'express';
import { z } from 'zod';
import { isTimeZone } from '../time.mjs';
import { memorySync, normalizeTime } from './memory.mjs';
import { quietHours, settingsOf, dayStart } from './router.mjs';
import { maskPhone } from './auth.mjs';
import { BrainUnavailable } from './brain.mjs';

const phone = z.string().regex(/^\+[1-9]\d{7,14}$/, 'Use international format, like +14155550123');
const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const iso = ms => new Date(ms).toISOString();
const HALF_DAY = 12 * 3_600_000;

function page(res, status, message) {
  res.status(status).set({ 'Content-Security-Policy': "default-src 'none'", 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' })
    .type('html').send(`<!doctype html><meta charset="utf-8"><title>Steph</title><p>${message}</p>`);
}

/** /v1 endpoints for the Recall app (docs/steph-api.md). Every route but sign-in needs a session. */
export function stephRoutes(steph, { now = Date.now } = {}) {
  const { auth, brain, store, deliver, config, google } = steph;
  const router = Router();
  const session = auth.requireSession();
  router.use('/v1', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

  async function view(user) {
    const caregiver = user.caregiver_id ? await store.user(user.caregiver_id) : undefined;
    const patients = user.role === 'caregiver' ? (await store.users()).filter(other => other.caregiver_id === user.id) : [];
    const status = user.owner && google?.configured ? await google.status().catch(() => undefined) : undefined;
    const memories = await store.memoryCount(user.id);
    const recentSetup = user.setup_completed_at && now() - Date.parse(user.setup_completed_at) < 30 * 60_000;
    return {
      id: user.id, name: user.name, role: user.role, phone: user.phone, phone_verified: Boolean(user.phone),
      steph_number: config.STEPH_NUMBER, time_zone: await steph.zoneOf(user),
      google: user.google_email ? { connected: Boolean(status?.connection), email: user.google_email,
        sources: status?.connection?.sources ?? ['calendar', 'gmail'].filter(source => status?.connection?.[source]) } : null,
      caregiver: caregiver ? { name: caregiver.name, phone_last4: caregiver.phone?.slice(-4) ?? null } : null,
      patient: patients[0] ? { id: patients[0].id, name: patients[0].name } : null,
      settings: settingsOf(user),
      backfill: { state: recentSetup && memories === 0 ? 'running' : memories ? 'done' : 'idle', memories },
      setup_completed_at: user.setup_completed_at,
    };
  }

  const handle = fn => async (req, res, next) => {
    try { await fn(req, res, next); } catch (error) { next(error); }
  };

  // Sign-in.
  router.post('/v1/auth/google/start', handle(async (req, res) => {
    const { mode } = z.object({ mode: z.enum(['self', 'caregiver']).default('self') }).parse(req.body ?? {});
    res.json({ authorization_url: await auth.startGoogle(mode) });
  }));
  // Google sends every OAuth callback here; app sign-ins are handled, admin connects fall through.
  router.get('/google/callback', handle(async (req, res, next) => {
    const state = typeof req.query.state === 'string' ? req.query.state : undefined;
    if (!(await auth.isLoginState(state))) return next();
    const fail = reason => {
      const target = new URL(config.APP_CALLBACK_URL);
      target.searchParams.set('error', reason);
      res.redirect(302, target.toString());
    };
    if (typeof req.query.code !== 'string' || req.query.error) {
      await store.takeLoginIntent(state);
      return fail(typeof req.query.error === 'string' ? req.query.error.slice(0, 60) : 'cancelled');
    }
    try {
      const result = await auth.completeGoogle(req.query.code, state);
      if (result.linked) return page(res, 200, 'Google is connected to Steph. You can close this tab.');
      res.redirect(302, result.redirect);
    } catch (error) {
      console.error(`Google sign-in failed: ${error.message}`);
      fail(error.status === 409 ? 'account_in_use' : 'google_failed');
    }
  }));
  router.post('/v1/auth/exchange', handle(async (req, res) => {
    const { code } = z.object({ code: z.string().min(10).max(200) }).parse(req.body);
    const result = await auth.exchange(code);
    res.json({ session_token: result.session_token, user: await view(result.user) });
  }));
  router.post('/v1/auth/apple', handle(async (req, res) => {
    const body = z.object({ identity_token: z.string().min(20).max(5000), full_name: z.string().max(100).optional() }).parse(req.body);
    const result = await auth.apple(body.identity_token, body.full_name);
    res.json({ session_token: result.session_token, user: await view(result.user) });
  }));
  router.post('/v1/auth/phone/start', session, handle(async (req, res) => {
    res.json(await auth.startPhone(req.user, phone.parse(req.body?.phone)));
  }));
  router.post('/v1/auth/phone/verify', session, handle(async (req, res) => {
    const body = z.object({ phone, code: z.string().regex(/^\d{6}$/) }).parse(req.body);
    const { user } = await auth.verifyPhone(req.user, body.phone, body.code);
    res.json({ user: await view(user) });
  }));
  router.post('/v1/caregiver/patient/start', session, handle(async (req, res) => {
    const body = z.object({ phone, name: z.string().trim().min(1).max(60).optional() }).parse(req.body);
    res.json(await auth.startPhone(req.user, body.phone, 'patient', body.name));
  }));
  router.post('/v1/caregiver/patient/verify', session, handle(async (req, res) => {
    const body = z.object({ phone, code: z.string().regex(/^\d{6}$/), name: z.string().trim().min(1).max(60).optional() }).parse(req.body);
    const result = await auth.verifyPhone(req.user, body.phone, body.code, 'patient', body.name);
    res.json({ session_token: result.session_token, user: await view(result.user) });
  }));

  router.get('/v1/me', session, handle(async (req, res) => res.json(await view(req.user))));
  router.post('/v1/setup/complete', session, handle(async (req, res) => {
    const body = z.object({ time_zone: z.string().refine(isTimeZone, 'Unknown time zone').optional(),
      briefing_time: clock.optional() }).parse(req.body ?? {});
    const at = iso(now());
    const settings = body.briefing_time ? { ...req.user.settings, briefing_time: body.briefing_time } : req.user.settings;
    let user = await store.updateUser(req.user.id, { time_zone: body.time_zone ?? req.user.time_zone, settings,
      setup_completed_at: req.user.setup_completed_at ?? at }, at);
    // Backfill now, inside the request (DEC-004); the scheduled cron keeps it fresh afterwards.
    if (user.owner && google?.configured && await google.can?.('calendar').catch(() => false)) {
      await google.syncAll().catch(error => console.error(`Backfill failed: ${error.message}`));
    }
    await steph.proactive.plan();
    user = await store.user(user.id);
    res.json({ user: await view(user) });
  }));

  // Talking to Steph.
  router.post('/v1/steph/message', session, handle(async (req, res) => {
    const body = z.object({ text: z.string().trim().min(1).max(2000), context: z.object({
      in_app: z.boolean().default(true), foreground: z.boolean().optional(), locale: z.string().max(20).optional(),
      location: z.object({ lat: z.number(), lon: z.number(), place: z.string().max(120).optional() }).optional(),
    }).default({}) }).parse(req.body);
    res.json(await brain.handle({ user: req.user, channel: 'app', text: body.text, context: body.context }));
  }));
  // A tapped Yes/No: an explicit answer, so no model is needed to act on it.
  router.post('/v1/steph/confirm', session, handle(async (req, res) => {
    const body = z.object({ pending_action_id: z.string().min(1).max(100), answer: z.enum(['yes', 'no']) }).parse(req.body);
    const at = iso(now());
    await store.addTimeline({ user_id: req.user.id, channel: 'app', direction: 'in', text: body.answer === 'yes' ? 'Yes' : 'No', at, kind: 'confirm' });
    const result = await steph.resolvePending({ user: req.user }, body.pending_action_id, body.answer);
    const text = { forgotten: "Done. I've forgotten that everywhere.", already_gone: "That's already gone.",
      disconnected: "Done. Google is disconnected and I've deleted what I learned from it.", dropped: "Okay, I won't.",
      expired: 'That question expired. Ask me again if you still want it.' }[result.status] ?? "Okay.";
    const out = await store.addTimeline({ user_id: req.user.id, channel: 'app', direction: 'out', text, at: iso(now()), kind: 'reply' });
    res.json({ reply: { id: out.id, text, card: { card_type: 'answer', buttons: [] }, memories: [] }, deliveries: [], backfilling: false });
  }));

  // Hold the orb: Call me / Text me.
  async function lastAppReply(user) {
    return (await store.latestEntry(user.id, { channel: 'app', direction: 'out' }))?.text;
  }
  router.post('/v1/steph/call-me', session, handle(async (req, res) => {
    if (!req.user.phone) return res.status(409).json({ error: 'Verify your phone number first' });
    if (!steph.dial) return res.status(503).json({ error: 'Calling is not configured' });
    const said = await lastAppReply(req.user);
    const sent = await deliver(req.user, { label: 'Call me (from the orb)', kind: 'call_request', explicit: 'call', immediate: true,
      user_asked: true, text: said ?? 'They tapped Call me in the app.',
      purpose: said ? 'they tapped Call me in the app; pick up from what you last told them there' : 'they tapped Call me in the app' });
    if (sent.channel !== 'call') return res.status(409).json({ error: sent.reason });
    res.json({ call_id: sent.call_id, status: 'queued' });
  }));
  router.post('/v1/steph/text-me', session, handle(async (req, res) => {
    if (!req.user.phone) return res.status(409).json({ error: 'Verify your phone number first' });
    if (!steph.dial) return res.status(503).json({ error: 'Texting is not configured' });
    const body = z.object({ text: z.string().trim().min(1).max(1200).optional() }).parse(req.body ?? {});
    const text = body.text ?? await lastAppReply(req.user);
    if (!text) return res.status(409).json({ error: "I haven't said anything to text yet" });
    const sent = await deliver(req.user, { label: 'Text me (from the orb)', kind: 'message', explicit: 'text', immediate: true,
      user_asked: true, text });
    if (sent.channel !== 'text') return res.status(409).json({ error: sent.reason });
    res.json({ message_id: sent.message_id, sent_at: sent.at, text });
  }));

  // Orb status; polling it also tells the router the app is open (rule 2).
  router.get('/v1/steph/status', session, handle(async (req, res) => {
    const at = now();
    const user = await store.updateUser(req.user.id, { app_seen_at: iso(at) }, iso(at));
    const zone = await steph.zoneOf(user);
    const clockOf = ms => new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: 'numeric', minute: '2-digit' }).format(new Date(ms));
    const active = await store.activeCall(user.id);
    const placed = await store.latestEntry(user.id, { kind: 'call_placed', since: iso(at - 2 * 60_000) });
    const texted = await store.latestEntry(user.id, { channel: 'sms', direction: 'out', since: iso(at - HALF_DAY) });
    const next = await store.nextCall(user.id, iso(at), iso(at + HALF_DAY));
    const say = await store.latestEntry(user.id, { channel: 'app', direction: 'out', kind: 'say', since: iso(at - 30 * 60_000) });
    const body = { state: 'idle', caption: null };
    if (active || placed) {
      Object.assign(body, { state: 'calling', caption: 'STEPH IS CALLING', call: { id: active?.call_id ?? placed.call_id, status: 'ringing' } });
    } else if (texted && !texted.seen_at) {
      Object.assign(body, { state: 'texted', caption: `STEPH TEXTED YOU · ${clockOf(Date.parse(texted.at))}`,
        message: { id: texted.id, text: texted.text, at: texted.at } });
    } else if (next) {
      Object.assign(body, { state: 'scheduled', caption: `STEPH WILL CALL AT ${clockOf(Date.parse(next.due_at)).replace(/ [AP]M$/, '')}` });
    }
    if (next) body.next_call = { at: next.due_at, reason: next.text };
    if (say && !say.seen_at) body.say = { id: say.id, text: say.text, kind: say.meta?.kind ?? 'message' };
    res.json(body);
  }));

  router.get('/v1/timeline', session, handle(async (req, res) => {
    const query = z.object({ before: z.iso.datetime({ offset: true }).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) })
      .parse(req.query);
    const entries = await store.timeline(req.user.id, { before: query.before && normalizeTime(query.before), limit: query.limit });
    res.json({ entries: entries.map(entry => ({ id: entry.id, channel: entry.channel, direction: entry.direction, text: entry.text,
      at: entry.at, kind: entry.kind, ...(entry.call_id ? { call_id: entry.call_id } : {}), seen: Boolean(entry.seen_at) })) });
  }));
  router.post('/v1/timeline/:id/seen', session, handle(async (req, res) => {
    await store.markSeen(req.user.id, String(req.params.id), iso(now()));
    res.json({ seen: true });
  }));

  router.get('/v1/diagnostics', session, handle(async (req, res) => {
    const zone = await steph.zoneOf(req.user);
    const settings = settingsOf(req.user);
    const since = iso(dayStart(now(), zone));
    const quiet = quietHours(settings, now(), zone);
    const googleStatus = req.user.owner && google?.configured ? await google.status().catch(() => undefined) : undefined;
    const counts = await store.sourceCounts(req.user.id);
    res.json({
      decisions: (await store.decisions(req.user.id, 50)).map(({ at, item, channel, reason }) => ({ at, item, channel, reason })),
      counts_today: { calls: await store.countedSince(req.user.id, 'call', since), texts: await store.countedSince(req.user.id, 'text', since),
        limits: { calls: settings.max_calls, texts: settings.max_texts } },
      quiet_hours: { start: quiet.start, end: quiet.end, active: quiet.active },
      sources: [
        ...counts.map(row => ({ name: row.source, state: 'ok', count: Number(row.n), last_sync: row.last })),
        ...(googleStatus?.sync ?? []).filter(state => state.last_error).map(state => ({ name: state.name, state: 'error', error: state.last_error })),
      ],
      push: { registered: Boolean(steph.apns) && (await store.devices(req.user.id)).length > 0, configured: Boolean(steph.apns) },
      phone: maskPhone(req.user.phone),
    });
  }));

  // Text-only memories from the phone; "Forget that" tombstones flow back down.
  router.post('/v1/memories/sync', session, handle(async (req, res) => {
    const body = memorySync.parse(req.body);
    const at = iso(now());
    const accepted = await store.upsertMemories(req.user.id, body.upserts.map(memory => ({ ...memory,
      time: normalizeTime(memory.time), place: memory.place ?? null })), at);
    if (body.deletes.length) await store.deleteSourceRefs(req.user.id, body.deletes);
    res.json({ accepted });
  }));
  router.get('/v1/memories/changes', session, handle(async (req, res) => {
    const since = normalizeTime(typeof req.query.since === 'string' ? req.query.since : null) ?? iso(0);
    res.json({ tombstones: await store.tombstonesSince(req.user.id, since), server_time: iso(now()) });
  }));

  // Push.
  router.post('/v1/devices', session, handle(async (req, res) => {
    const body = z.object({ apns_token: z.string().regex(/^[0-9a-f]{64,200}$/i), environment: z.enum(['sandbox', 'production']) }).parse(req.body);
    await store.saveDevice(body.apns_token.toLowerCase(), req.user.id, body.environment, iso(now()));
    res.json({ registered: true, push_configured: Boolean(steph.apns) });
  }));
  router.post('/v1/push/:id/opened', session, handle(async (req, res) => {
    await store.markOpened(req.user.id, String(req.params.id), iso(now()));
    res.json({ opened: true });
  }));

  // Google Photos Picker: the person picks what to share; Steph never reads the whole library.
  router.post('/v1/google/photos/session', session, handle(async (req, res) => {
    if (!req.user.owner || !google?.createPhotoPickerSession) return res.status(503).json({ error: 'Google Photos is not connected' });
    res.json(await google.createPhotoPickerSession());
  }));
  router.get('/v1/google/photos/session/:id', session, handle(async (req, res) => {
    if (!req.user.owner || !google?.pollPhotoPickerSession) return res.status(503).json({ error: 'Google Photos is not connected' });
    res.json(await google.pollPhotoPickerSession(String(req.params.id)));
  }));

  router.use('/v1', (error, _req, res, next) => {
    if (error instanceof BrainUnavailable) return res.status(503).json({ error: error.message });
    next(error);
  });
  return router;
}
