import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { addDays, describeDate, describeTime, localDate, startOfDay } from '../time.mjs';
import { createClaude } from '../steph/claude.mjs';
import { EMAIL_CHARS, extractWithClaude, heuristicFacts, htmlText, messageBody, schemaFacts } from './facts.mjs';
import {
  NO_MEMORIES, clip, contactMemory, decodeEntities, eventMemory, factMemory, photoMemory, taskMemory,
} from './memories.mjs';

// Data scopes, all requested on one consent screen. Every one but calendarEvents is read-only;
// calendarEvents only creates events Steph is asked to add (createEvent) and nothing edits or
// deletes other events.
export const SCOPES = {
  calendar: 'https://www.googleapis.com/auth/calendar.readonly',
  gmail: 'https://www.googleapis.com/auth/gmail.readonly',
  contacts: 'https://www.googleapis.com/auth/contacts.readonly',
  tasks: 'https://www.googleapis.com/auth/tasks.readonly',
  photos: 'https://www.googleapis.com/auth/photospicker.mediaitems.readonly',
  calendarEvents: 'https://www.googleapis.com/auth/calendar.events',
};
// Identity scopes make the token endpoint return an id_token naming the account.
export const CONSENT_SCOPES = ['openid', 'email', 'profile', ...Object.values(SCOPES)].join(' ');
// Readable sources: their memory source, sync_state name and evidence origin.
export const SOURCES = {
  calendar: 'google-calendar', gmail: 'google-gmail', contacts: 'google-contacts', tasks: 'google-tasks', photos: 'google-photos',
};

// Real Google unless GOOGLE_API_BASE_URL / GOOGLE_OAUTH_BASE_URL name a local same-URL mock such
// as a Sparta World (DEC-015). config.mjs only accepts loopback hosts and refuses them on Vercel,
// because tokens are sent wherever these point. Credentialed fetches reject redirects so
// a mock cannot forward an OAuth form body or authenticated API request to another host.
const REAL_TOKEN_ORIGIN = 'https://oauth2.googleapis.com';

// Origin and path only: a stray '?' or '#' must not swallow the paths appended below.
const base = value => value && (({ origin, pathname }) => `${origin}${pathname}`.replace(/\/+$/, ''))(new URL(value));

export function endpoints(config = {}) {
  const api = base(config.GOOGLE_API_BASE_URL);
  const oauth = base(config.GOOGLE_OAUTH_BASE_URL);
  return {
    auth: oauth ? `${oauth}/o/oauth2/v2/auth` : 'https://accounts.google.com/o/oauth2/v2/auth',
    token: oauth ? `${oauth}/token` : 'https://oauth2.googleapis.com/token',
    revoke: oauth ? `${oauth}/revoke` : 'https://oauth2.googleapis.com/revoke',
    calendar: `${api ?? 'https://www.googleapis.com'}/calendar/v3`,
    gmail: `${api ?? 'https://gmail.googleapis.com'}/gmail/v1/users/me`,
    people: `${api ?? 'https://people.googleapis.com'}/v1`,
    tasks: `${api ?? 'https://tasks.googleapis.com'}/tasks/v1`,
    photos: `${api ?? 'https://photospicker.googleapis.com'}/v1`,
  };
}

// Synced calendar window relative to today; dates outside it are fetched live.
const PAST_DAYS = 30;
const FUTURE_DAYS = 60;
const MAX_PAGES = 10;
const SNIPPET_CHARS = 300;
// Calendar push channels (events.watch): Google's default lifetime, renewed by the sync cron
// once less than a day is left.
const WATCH_TTL_SECONDS = 7 * 24 * 3600;
const WATCH_RENEW_MS = 24 * 3600_000;
// shortcut: at most this many new messages get facts extracted per sync (bounds Claude cost and
// request time); later syncs work through the rest. Upgrade to a queue if mail volume needs it.
const FACT_BATCH = 20;
// Completed tasks stay memories this long after completion.
const DONE_TASK_DAYS = 30;

export class GoogleError extends Error {
  constructor(message, { status, reconnect = false } = {}) {
    super(message);
    this.name = 'GoogleError';
    this.status = status;
    this.reconnect = reconnect;
  }
}

function exposed(message, status) {
  const error = new GoogleError(message, { status });
  error.expose = true;
  return error;
}

// Refresh tokens are encrypted at rest with AES-256-GCM so a copied database
// file alone does not grant mailbox access.
function seal(key, plaintext) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return ['v1', iv, cipher.getAuthTag(), body].map(part => typeof part === 'string' ? part : part.toString('base64url')).join('.');
}

function unseal(key, sealed) {
  const [version, iv, tag, body] = sealed.split('.');
  if (version !== 'v1') throw new GoogleError('Unsupported token encoding');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8');
}

// Display names are chosen by the sender and easy to fake ("Mom", "Your bank"), so the
// address always travels with the name.
function sender(from = '') {
  const match = from.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  const name = clip(match ? match[1] : '', 100);
  const address = clip(match ? match[2] : from, 200);
  if (!address) return { from: 'an unknown sender', fromAddress: null, label: 'an unknown sender' };
  return { from: name || address, fromAddress: address, label: name ? `${name} <${address}>` : address };
}

const RESPONSE_NOTES = {
  declined: ' (the user declined this invitation)',
  needsAction: ' (an invitation the user has not answered)',
  tentative: ' (the user answered maybe)',
};

function attendeesOf(event) {
  return (event.attendees ?? []).slice(0, 50).map(person => Object.fromEntries(Object.entries({
    name: person.displayName && clip(person.displayName, 100), email: person.email && clip(person.email, 200),
    response: person.responseStatus && clip(person.responseStatus, 20),
    self: person.self || undefined, organizer: person.organizer || undefined, resource: person.resource || undefined,
  }).filter(([, value]) => value)));
}

function videoLink(event) {
  const link = event.hangoutLink ?? event.conferenceData?.entryPoints?.find(point => point.entryPointType === 'video')?.uri;
  return typeof link === 'string' && /^https:\/\//.test(link) ? clip(link, 500) : undefined;
}

export function eventRecord(event, calendarId, timeZone) {
  const allDay = Boolean(event.start?.date);
  const start = allDay ? startOfDay(event.start.date, timeZone) : new Date(event.start.dateTime);
  const date = allDay ? event.start.date : localDate(start, timeZone);
  // All-day end dates are exclusive; a timed event ending at midnight ends the previous day.
  let endDate = allDay
    ? addDays(event.end?.date ?? addDays(date, 1), -1)
    : localDate(new Date(new Date(event.end?.dateTime ?? start).getTime() - 1), timeZone);
  if (endDate < date) endDate = date;
  const title = clip(event.summary || 'Untitled event', 200);
  const end = event.end?.dateTime ?? start;
  const displayEndDate = allDay ? endDate : localDate(end, timeZone);
  const when = allDay
    ? (endDate === date ? `all day on ${describeDate(date, timeZone)}`
      : `from ${describeDate(date, timeZone)} through ${describeDate(endDate, timeZone)}`)
    : displayEndDate === date
      ? `on ${describeDate(date, timeZone)} from ${describeTime(start, timeZone)} to ${describeTime(end, timeZone)}`
      : `from ${describeDate(date, timeZone)} at ${describeTime(start, timeZone)} to ${describeDate(displayEndDate, timeZone)} at ${describeTime(end, timeZone)}`;
  const response = event.attendees?.find(attendee => attendee.self)?.responseStatus;
  const note = RESPONSE_NOTES[response] ?? '';
  const location = event.location ? ` at ${clip(event.location, 200)}` : '';
  const attendees = attendeesOf(event);
  const video = videoLink(event);
  return {
    id: `gcal:${calendarId}:${event.id}`, source: 'calendar', origin: 'google-calendar',
    calendarId, eventId: event.id,
    date, endDate, allDay, title, timeZone,
    start: start.toISOString(),
    end: allDay ? startOfDay(addDays(endDate, 1), timeZone).toISOString() : new Date(event.end?.dateTime ?? start).toISOString(),
    timestamp: start.toISOString(),
    ...(event.location ? { location: clip(event.location, 200) } : {}),
    ...(note ? { response } : {}),
    ...(response === 'declined' ? { declined: true } : {}),
    ...(attendees.length ? { attendees } : {}),
    ...(video ? { video } : {}),
    ...(event.extendedProperties?.private?.stephCreated === 'true' ? { stephCreated: true } : {}),
    ref: event.htmlLink,
    text: `Calendar event "${title}" ${when}${location}${note}.`,
    demo: false,
  };
}

export function messageRecord(message, timeZone) {
  const header = name => message.payload?.headers?.find(h => h.name.toLowerCase() === name)?.value ?? '';
  const timestamp = new Date(Number(message.internalDate)).toISOString();
  const { from, fromAddress, label } = sender(header('from'));
  const subject = clip(header('subject') || '(no subject)', 200);
  const snippet = clip(decodeEntities(message.snippet ?? ''), SNIPPET_CHARS);
  return {
    id: `gmail:${message.id}`, source: 'email', origin: 'google-gmail',
    timestamp, from, fromAddress, subject, snippet,
    ref: `https://mail.google.com/mail/u/0/#all/${message.threadId ?? message.id}`,
    text: `Email from ${label} on ${describeDate(localDate(timestamp, timeZone), timeZone)}, subject "${subject}": ${snippet}`,
    demo: false,
  };
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  }));
  return results;
}

const eventTime = z.union([z.iso.date(), z.iso.datetime({ offset: true })]);
const eventInput = z.object({
  title: z.string().trim().min(1).max(200),
  start: eventTime,
  end: eventTime.optional(),
  description: z.string().trim().max(2000).optional(),
}).refine(({ start, end }) => !end || ((end.length === 10) === (start.length === 10) && Date.parse(end) > Date.parse(start)),
  { message: 'end must be after start and of the same kind (date or date-time)' });

export function createGoogle({
  config, store, fetch = globalThis.fetch, log = console, onSync = () => {}, memories = NO_MEMORIES,
  claude = config.ANTHROPIC_API_KEY ? createClaude(config.ANTHROPIC_API_KEY) : null,
}) {
  const configured = Boolean(config.GOOGLE_CLIENT_ID);
  const key = configured ? Buffer.from(config.GOOGLE_TOKEN_KEY, 'hex') : undefined;
  const {
    auth: AUTH_URL, token: TOKEN_URL, revoke: REVOKE_URL, calendar: CALENDAR_API, gmail: GMAIL_API,
    people: PEOPLE_API, tasks: TASKS_API, photos: PHOTOS_API,
  } = endpoints(config);
  // A connection belongs to the token endpoint it was made with (DEC-015): a real Google
  // connection is never used against a local mock, nor a mock connection against Google.
  const TOKEN_ORIGIN = new URL(TOKEN_URL).origin;
  const originOf = row => row.token_origin ?? REAL_TOKEN_ORIGIN;
  const foreign = row => Boolean(row) && originOf(row) !== TOKEN_ORIGIN;
  function foreignConnection(row) {
    return exposed(`The stored Google connection was made against ${originOf(row)}, not ${TOKEN_ORIGIN}; ` +
      'disconnect it with matching Google endpoint settings first', 409);
  }
  const calendarIds = (config.GOOGLE_CALENDAR_IDS || 'primary').split(',').map(id => id.trim()).filter(Boolean);
  const syncMinutes = config.GOOGLE_SYNC_MINUTES ?? 10;
  const model = config.STEPH_MODEL || 'claude-opus-5-5';
  // Calendar push channels carry a token only this backend can produce: an HMAC of the channel id
  // under a key derived from GOOGLE_TOKEN_KEY (nothing secret is stored with the channel).
  const channelKey = configured ? createHmac('sha256', key).update('recall/calendar-watch-token/v1').digest() : undefined;
  const channelToken = id => createHmac('sha256', channelKey).update(id).digest('base64url');
  // Per-instance cache only; serverless instances each refresh their own access token.
  let accessToken;

  // On Vercel the scheduled cron is the only scheduled sync, so freshness decides when a call
  // asks Google live instead (inside the request; nothing runs after the response).
  function fresh(state) {
    return Boolean(state && state.age_seconds !== null && state.age_seconds < Math.max(syncMinutes, 15) * 2 * 60);
  }

  async function connection() {
    const row = configured ? await store.googleConnection() : undefined;
    return row && !foreign(row) ? { ...row, scopes: row.scope.split(' ') } : undefined;
  }

  const zoneOf = context => config.TIMEZONE || context.connection.timezone || 'UTC';

  async function timeZone() {
    return config.TIMEZONE || (await connection())?.timezone || 'UTC';
  }

  // A per-user setting may switch Gmail off; it outlives connections (google_state 'setting:').
  async function gmailEnabled() {
    if (!configured) return true;
    return (await store.googleState('setting:gmail_enabled')).find(row => row.key === 'setting:gmail_enabled')?.value !== false;
  }

  async function snapshot(scope) {
    const stored = configured ? await store.googleSnapshot() : { generation: null };
    const current = foreign(stored.connection) ? { ...stored, connection: undefined } : stored;
    const row = current.connection;
    const granted = Boolean(row?.scope.split(' ').includes(SCOPES[scope]));
    const off = granted && scope === 'gmail' && !(await gmailEnabled());
    return { ...current, scope, state: granted && !off ? row.status : 'absent' };
  }

  function changedConnection() {
    return exposed('Google connection changed; retry the lookup', 409);
  }

  async function assertCurrent(context) {
    if (context.generation !== null && (await store.googleSnapshot()).generation !== context.generation) {
      throw changedConnection();
    }
  }

  function requireConnected(context) {
    if (context.state !== 'connected') throw new GoogleError('Google account is not connected', { reconnect: true });
    return context;
  }

  async function can(scope) {
    return (await state(scope)) === 'connected';
  }

  // 'connected', 'reconnect_required' (expired, revoked or undecryptable) or 'absent'.
  async function state(scope) {
    return (await snapshot(scope)).state;
  }

  // Memories go to a separate sink, outside the store's fenced transactions. So the generation is
  // checked before and after each write: when a disconnect or reconnect raced it, that source's
  // memories are dropped again (the next sync rebuilds them for the current connection).
  async function remember(context, source, write) {
    await assertCurrent(context);
    await write();
    const stale = (await store.googleSnapshot()).generation !== context.generation;
    if (stale || (source === SOURCES.gmail && !(await gmailEnabled()))) {
      await memories.deleteSource(source);
      throw changedConnection();
    }
  }

  async function tokenRequest(params, signal = AbortSignal.timeout(10_000), generation) {
    const response = await fetch(TOKEN_URL, {
      method: 'POST', signal, redirect: 'error',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: config.GOOGLE_CLIENT_ID, client_secret: config.GOOGLE_CLIENT_SECRET, ...params,
      }),
    });
    const body = await response.json().catch(() => ({}));
    if (response.ok) return body;
    // invalid_grant: the refresh token was revoked, expired (7 days in Testing mode) or rotated.
    if (body.error === 'invalid_grant' && params.grant_type === 'refresh_token') {
      await store.markGoogleReconnectRequired(generation);
      if (accessToken?.generation === generation) accessToken = undefined;
      throw new GoogleError('Google access expired or was revoked; reconnect required', { status: 401, reconnect: true });
    }
    throw new GoogleError(`Google token request failed (${response.status} ${body.error ?? 'unknown_error'})`, { status: response.status });
  }

  async function token(context, force, signal) {
    // A warm serverless worker must never reuse a token from an earlier connection.
    if (!force && accessToken?.generation === context.generation && accessToken.expiresAt > Date.now() + 60_000) {
      return accessToken.value;
    }
    let refreshToken;
    try {
      refreshToken = unseal(key, context.connection.refresh_token);
    } catch {
      await store.markGoogleReconnectRequired(context.generation);
      throw new GoogleError('Stored Google token cannot be decrypted (GOOGLE_TOKEN_KEY changed?); reconnect required', { reconnect: true });
    }
    const body = await tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken }, signal, context.generation);
    accessToken = { generation: context.generation, value: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
    return accessToken.value;
  }

  // Writes (POST/DELETE) may answer with an empty body.
  async function apiResponse(response, emptyOk = false) {
    const body = await response.json().catch(() => undefined);
    // A truncated or non-JSON 200 must not read as "no events" and wipe the synced copy.
    if (response.ok && body && typeof body === 'object') return body;
    if (response.ok && emptyOk) return {};
    if (response.ok) throw new GoogleError('Google API returned an unreadable response', { status: 502 });
    const reason = body?.error?.errors?.[0]?.reason ?? body?.error?.status ?? 'unknown_error';
    throw new GoogleError(`Google API request failed (${response.status} ${reason})`, { status: response.status });
  }

  // One deadline and one connection cover every request in an operation.
  async function api(url, context, signal = AbortSignal.timeout(10_000), { method = 'GET', body } = {}) {
    for (const force of [false, true]) {
      const response = await fetch(url, {
        method, redirect: 'error', signal,
        headers: {
          Authorization: `Bearer ${await token(context, force, signal)}`, Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (response.status === 401 && !force) continue;
      return apiResponse(response, method !== 'GET');
    }
  }

  // Follows nextPageToken; `last` is the final page (which carries a Calendar nextSyncToken), or
  // undefined when the page cap cut the listing short.
  async function paged(url, params, field, context, signal, pages = MAX_PAGES) {
    const items = [];
    let pageToken;
    for (let page = 0; page < pages; page++) {
      const body = await api(`${url}?${new URLSearchParams({ ...params, ...(pageToken ? { pageToken } : {}) })}`, context, signal);
      items.push(...(body[field] ?? []));
      pageToken = body.nextPageToken;
      if (!pageToken) return { items, last: body };
    }
    log.warn(`${new URL(url).pathname}: stopped after ${pages} pages`);
    return { items, last: undefined };
  }

  // Calendar events.list. A sync token cannot be combined with timeMin, timeMax, orderBy, q,
  // iCalUID, updatedMin or extended-property filters, and every other parameter must match the
  // full sync that issued it; so no request uses orderBy (the store sorts) and both kinds send
  // singleEvents, maxResults and timeZone alike.
  function listCalendar(calendarId, params, context, signal) {
    return paged(`${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events`,
      { singleEvents: 'true', maxResults: '250', timeZone: zoneOf(context), ...params }, 'items', context, signal);
  }

  async function listEvents(timeMin, timeMax, context, timeout = 30_000) {
    const signal = AbortSignal.timeout(timeout);
    const zone = zoneOf(context);
    const records = [];
    for (const calendarId of calendarIds) {
      const { items } = await listCalendar(calendarId, { timeMin: timeMin.toISOString(), timeMax: timeMax.toISOString() }, context, signal);
      for (const event of items) {
        if (event.status !== 'cancelled' && event.start) records.push(eventRecord(event, calendarId, zone));
      }
    }
    return records;
  }

  async function listMessages(q, maxResults, context, timeout = 60_000) {
    const signal = AbortSignal.timeout(timeout);
    const query = new URLSearchParams({ q, maxResults: String(maxResults) });
    const body = await api(`${GMAIL_API}/messages?${query}`, context, signal);
    const zone = zoneOf(context);
    return mapLimit(body.messages ?? [], 8, async ({ id }) => {
      const params = new URLSearchParams({ format: 'metadata' });
      for (const name of ['From', 'Subject', 'Date']) params.append('metadataHeaders', name);
      return messageRecord(await api(`${GMAIL_API}/messages/${encodeURIComponent(id)}?${params}`, context, signal), zone);
    });
  }

  async function saveState(context, scope, changes) {
    if (!(await store.saveGoogleState(context.generation, SCOPES[scope], changes))) throw changedConnection();
  }

  async function calendarCopy() {
    return (await store.list('calendar')).filter(record => record.origin === SOURCES.calendar);
  }

  // Full sync: the window's events replace the stored copy, and each calendar's nextSyncToken is
  // kept for that exact window, zone and calendar.
  async function fullCalendar(context, window, signal) {
    const zone = zoneOf(context);
    const records = [];
    const cursors = [];
    for (const calendarId of calendarIds) {
      const { items, last } = await listCalendar(calendarId, {
        timeMin: startOfDay(window.from, zone).toISOString(), timeMax: startOfDay(addDays(window.to, 1), zone).toISOString(),
      }, context, signal);
      for (const event of items) {
        if (event.status !== 'cancelled' && event.start) records.push(eventRecord(event, calendarId, zone));
      }
      cursors.push({ key: `calendar:${calendarId}`, syncToken: last?.nextSyncToken });
    }
    if (!(await store.replaceOrigin(SOURCES.calendar, records, context.generation))) throw changedConnection();
    await saveState(context, 'calendar', {
      put: cursors.filter(cursor => cursor.syncToken).map(({ key, syncToken }) => ({ key, value: { syncToken, ...window, zone } })),
      remove: cursors.filter(cursor => !cursor.syncToken).map(cursor => cursor.key),
    });
  }

  // Incremental sync from stored tokens. Changes arrive for the whole calendar (deletions always
  // included, as status "cancelled"), so anything cancelled or now outside the window is removed,
  // including stored instances of a cancelled recurring event. A 410 propagates to the caller.
  async function incrementalCalendar(context, cursors, window, signal) {
    const zone = zoneOf(context);
    const upserts = new Map();
    const removed = new Set();
    const next = [];
    for (const calendarId of calendarIds) {
      const { items, last } = await listCalendar(calendarId, { syncToken: cursors.get(calendarId).syncToken }, context, signal);
      for (const event of items) {
        const record = event.status !== 'cancelled' && event.start ? eventRecord(event, calendarId, zone) : null;
        if (record && record.date <= window.to && record.endDate >= window.from) upserts.set(record.id, record);
        else removed.add(`gcal:${calendarId}:${event.id}`);
      }
      next.push({ key: `calendar:${calendarId}`, syncToken: last?.nextSyncToken });
    }
    const remove = (await calendarCopy()).map(record => record.id).filter(id => !upserts.has(id) &&
      (removed.has(id) || [...removed].some(series => id.startsWith(`${series}_`))));
    if (!(await store.patchOrigin(SOURCES.calendar, [...upserts.values()], remove, context.generation))) throw changedConnection();
    await saveState(context, 'calendar', {
      put: next.filter(cursor => cursor.syncToken).map(({ key, syncToken }) => ({ key, value: { syncToken, ...window, zone } })),
      remove: next.filter(cursor => !cursor.syncToken).map(cursor => cursor.key),
    });
  }

  async function syncCalendarCopy(context) {
    const zone = zoneOf(context);
    const today = localDate(new Date(), zone);
    const window = { from: addDays(today, -PAST_DAYS), to: addDays(today, FUTURE_DAYS) };
    const signal = AbortSignal.timeout(30_000);
    const cursors = new Map((await store.googleState('calendar:')).map(({ key, value }) => [key.slice('calendar:'.length), value]));
    // A token is only reused for the window it was issued with: the window moves daily, and that
    // daily full sync also bounds any drift from incremental updates.
    const reusable = calendarIds.every(id => {
      const cursor = cursors.get(id);
      return cursor?.syncToken && cursor.from === window.from && cursor.to === window.to && cursor.zone === zone;
    });
    let mode = 'full';
    if (reusable) {
      try {
        await incrementalCalendar(context, cursors, window, signal);
        mode = 'incremental';
      } catch (error) {
        if (error.status !== 410) throw error;
        // 410 Gone: the token expired or was invalidated; wipe and resync the window.
        log.warn('Calendar sync token expired; running a full sync');
      }
    }
    if (mode === 'full') await fullCalendar(context, window, signal);
    return { window, mode };
  }

  async function runSync(source, work) {
    const name = SOURCES[source];
    let context;
    try {
      context = requireConnected(await snapshot(source));
      const { count, window, mode, memories: records } = await work(context);
      await remember(context, name, () => memories.replaceSource(name, records));
      if (!(await store.recordSync(name, { count, window }, context.generation))) throw changedConnection();
      await assertCurrent(context);
      return { name, ok: true, count, ...(mode ? { mode } : {}) };
    } catch (error) {
      log.error(`Google sync ${name} failed: ${error.message}`);
      try {
        if (context) await store.recordSync(name, { error: error.message }, context.generation);
      } catch { /* reported above */ }
      return { name, ok: false, error: error.message };
    }
  }

  // Facts from one message. Its body exists only inside this call; the facts are what is kept.
  async function messageFacts(record, context, signal) {
    const id = record.id.slice('gmail:'.length);
    const message = await api(`${GMAIL_API}/messages/${encodeURIComponent(id)}?format=full`, context, signal);
    const { html, text } = messageBody(message.payload);
    const structured = schemaFacts(html);
    if (structured.length) return structured;
    const email = {
      from: record.fromAddress, subject: record.subject, date: record.timestamp,
      text: (text || htmlText(html) || record.snippet || '').slice(0, EMAIL_CHARS),
    };
    return claude ? extractWithClaude(claude, model, email, log) : heuristicFacts(email);
  }

  // Facts are cached per message id (google_state 'gmail:<id>'), so each message is read and
  // extracted once; facts of mail that left the query (deleted, older than its window) go.
  async function gmailFacts(records, context) {
    const zone = zoneOf(context);
    const idOf = record => record.id.slice('gmail:'.length);
    const cached = new Map((await store.googleState('gmail:')).map(({ key, value }) => [key.slice('gmail:'.length), value.facts]));
    const listed = new Set(records.map(idOf));
    const pending = records.filter(record => !cached.has(idOf(record))).slice(0, FACT_BATCH);
    const signal = AbortSignal.timeout(60_000);
    const extracted = (await mapLimit(pending, 4, async record => {
      try {
        return [idOf(record), await messageFacts(record, context, signal)];
      } catch (error) {
        log.warn(`Gmail fact extraction failed: ${error.message}`);
        return [idOf(record), undefined];
      }
    })).filter(([, facts]) => Array.isArray(facts));
    await saveState(context, 'gmail', {
      put: extracted.map(([id, facts]) => ({ key: `gmail:${id}`, value: { facts } })),
      remove: [...cached.keys()].filter(id => !listed.has(id)).map(id => `gmail:${id}`),
    });
    for (const [id, facts] of extracted) cached.set(id, facts);
    return records.flatMap(record => (cached.get(idOf(record)) ?? []).map((fact, index) => factMemory(fact, record, index, zone)));
  }

  function watchAddress() {
    const origin = config.PUBLIC_BASE_URL ? base(config.PUBLIC_BASE_URL)
      : config.GOOGLE_REDIRECT_URI && new URL(config.GOOGLE_REDIRECT_URI).origin;
    // Google delivers push notifications only to HTTPS addresses with a valid certificate.
    return origin?.startsWith('https://') ? `${origin}/webhooks/google/calendar` : null;
  }

  async function stopChannel(bearer, channel, signal = AbortSignal.timeout(10_000)) {
    const response = await fetch(`${CALENDAR_API}/channels/stop`, {
      method: 'POST', redirect: 'error', signal,
      headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: channel.id, resourceId: channel.resourceId }),
    });
    if (!response.ok && response.status !== 404) log.warn(`Calendar channel stop failed (${response.status})`);
  }

  // Creates a push channel per calendar, or renews one that expires within a day (or whose
  // address changed); the replaced channel is stopped.
  async function ensureWatch(context) {
    const address = watchAddress();
    if (!address) return;
    const signal = AbortSignal.timeout(15_000);
    const channels = new Map((await store.googleState('channel:')).map(({ key, value }) => [key.slice('channel:'.length), value]));
    for (const calendarId of calendarIds) {
      const current = channels.get(calendarId);
      if (current?.address === address && current.expiration - Date.now() > WATCH_RENEW_MS) continue;
      const id = randomUUID();
      const body = await api(`${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events/watch`, context, signal, {
        method: 'POST', body: { id, type: 'web_hook', address, token: channelToken(id), params: { ttl: String(WATCH_TTL_SECONDS) } },
      });
      const channel = { id, resourceId: body.resourceId, address,
        expiration: Number(body.expiration) || Date.now() + WATCH_TTL_SECONDS * 1000 };
      const saved = await store.saveGoogleState(context.generation, SCOPES.calendar, { put: [{ key: `channel:${calendarId}`, value: channel }] });
      // Stop the superseded channel, or the new one when the connection changed meanwhile.
      const stale = saved ? current : channel;
      if (stale) await stopChannel(await token(context, false, signal), stale, signal).catch(error => log.warn(`Calendar channel stop failed: ${error.message}`));
      if (!saved) throw changedConnection();
    }
  }

  async function sources() {
    const row = await connection();
    if (!row) return [];
    const enabled = await gmailEnabled();
    return Object.keys(SOURCES).filter(source => row.scopes.includes(SCOPES[source]) && (source !== 'gmail' || enabled));
  }

  // The id_token comes straight from Google's token endpoint over TLS, so OpenID Connect allows
  // using its claims without checking the signature; it must still be issued to this client.
  function idTokenEmail(idToken) {
    try {
      const claims = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString('utf8'));
      return claims.aud === config.GOOGLE_CLIENT_ID && typeof claims.email === 'string' && claims.email_verified !== false
        ? clip(claims.email, 320) || null : null;
    } catch {
      return null;
    }
  }

  const google = {
    configured,
    timeZone,
    can,
    state,
    snapshot,
    assertCurrent,
    sources,

    // Starts the OAuth web-server flow with PKCE; the caller visits the returned URL. Every
    // scope is requested on one consent screen.
    async beginConnect() {
      if (!configured) throw new GoogleError('Google integration is not configured', { status: 503 });
      const existing = await store.googleConnection();
      if (foreign(existing)) throw foreignConnection(existing);
      const state = randomBytes(24).toString('base64url');
      const verifier = randomBytes(48).toString('base64url');
      await store.saveOAuthState(state, verifier);
      const url = new URL(AUTH_URL);
      url.search = new URLSearchParams({
        client_id: config.GOOGLE_CLIENT_ID, redirect_uri: config.GOOGLE_REDIRECT_URI,
        response_type: 'code', scope: CONSENT_SCOPES,
        access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true',
        state, code_challenge: createHash('sha256').update(verifier).digest('base64url'),
        code_challenge_method: 'S256',
      });
      return url.toString();
    },

    async completeConnect(code, state) {
      if (!configured) throw new GoogleError('Google integration is not configured', { status: 503 });
      const handshake = typeof state === 'string' ? await store.takeOAuthState(state) : undefined;
      if (!handshake) throw new GoogleError('Connection link expired or was already used', { status: 400 });
      const existing = await store.googleConnection();
      if (foreign(existing)) throw foreignConnection(existing);
      const body = await tokenRequest({
        grant_type: 'authorization_code', code, code_verifier: handshake.verifier, redirect_uri: config.GOOGLE_REDIRECT_URI,
      });
      if (!body.refresh_token) throw new GoogleError('Google did not return offline access; try connecting again', { status: 400 });
      // Users can untick scopes on the consent screen; keep only what was granted. Any one data
      // source is enough to connect.
      const granted = (body.scope ?? '').split(' ').filter(scope => Object.values(SCOPES).includes(scope));
      if (!granted.length) throw new GoogleError('Google did not grant access to any data source', { status: 400 });
      // Resolve account metadata with the new token before committing anything. The
      // single final save is conditional on the generation claimed with OAuth state.
      const oauthApi = async url => apiResponse(await fetch(url, {
        redirect: 'error',
        headers: { Authorization: `Bearer ${body.access_token}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      }));
      let email = typeof body.id_token === 'string' ? idTokenEmail(body.id_token) : null;
      let zone = null;
      if (granted.includes(SCOPES.calendar)) {
        const primary = await oauthApi(`${CALENDAR_API}/calendars/primary`).catch(() => ({}));
        email ??= primary.id ?? null;
        zone = primary.timeZone ?? null;
      }
      if (!email && granted.includes(SCOPES.gmail)) {
        email = (await oauthApi(`${GMAIL_API}/profile`).catch(() => ({}))).emailAddress ?? null;
      }
      const row = await store.saveGoogleConnection({ email, timezone: zone, scope: granted.join(' '),
        refreshToken: seal(key, body.refresh_token), generation: handshake.generation, tokenOrigin: TOKEN_ORIGIN });
      if (!row) throw changedConnection();
      accessToken = { generation: row.generation, value: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
      // Like the evidence copy, memories start over with each consent (DEC-016).
      await memories.deleteSource('google-');
      return { email, scopes: granted };
    },

    async disconnect() {
      // Never revoke at, or delete for, an endpoint the connection was not made with.
      const existing = await store.googleConnection();
      if (foreign(existing)) throw foreignConnection(existing);
      const channels = existing ? await store.googleState('channel:') : [];
      // Invalidate local requests and pending callbacks before the best-effort network calls.
      const row = await store.deleteGoogleConnection();
      accessToken = undefined;
      await memories.deleteSource('google-');
      if (row) {
        // Best effort: local deletion must not depend on decrypting the token or reaching Google.
        try {
          const refreshToken = unseal(key, row.refresh_token);
          if (channels.length) {
            try {
              const { access_token: bearer } = await tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken });
              for (const { value } of channels) await stopChannel(bearer, value);
            } catch (error) {
              log.warn(`Calendar channel stop failed: ${error.message}`);
            }
          }
          await fetch(REVOKE_URL, {
            method: 'POST', signal: AbortSignal.timeout(10_000), redirect: 'error',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ token: refreshToken }),
          });
        } catch (error) {
          log.warn(`Google revoke failed: ${error.message}`);
        }
      }
    },

    async status() {
      const row = await connection();
      const stored = configured ? await store.googleConnection() : undefined;
      return {
        configured,
        tokenEndpoint: TOKEN_ORIGIN,
        ...(foreign(stored) ? { foreignConnection: { tokenEndpoint: originOf(stored), email: stored.email } } : {}),
        timeZone: await timeZone(),
        connection: row ? {
          email: row.email, status: row.status, connectedAt: row.connected_at,
          calendar: row.scopes.includes(SCOPES.calendar), gmail: row.scopes.includes(SCOPES.gmail),
          // Granted read sources, and whether Steph may add events.
          sources: Object.keys(SOURCES).filter(source => row.scopes.includes(SCOPES[source])),
          calendarWrite: row.scopes.includes(SCOPES.calendarEvents),
        } : null,
        gmailEnabled: await gmailEnabled(),
        watch: {
          address: watchAddress(),
          channels: row ? (await store.googleState('channel:')).map(({ key, value }) => ({
            calendarId: key.slice('channel:'.length), expiresAt: new Date(value.expiration).toISOString(),
          })) : [],
        },
        sync: (await store.syncState()).filter(state => state.name.startsWith('google-'))
          .map(({ age_seconds: _age, ...state }) => state),
        records: await store.countByOrigin(),
      };
    },

    async syncCalendar() {
      return runSync('calendar', async context => {
        const { window, mode } = await syncCalendarCopy(context);
        const copy = await calendarCopy();
        return { count: copy.length, window, mode, memories: copy.map(eventMemory) };
      });
    },

    // Only fact-bearing mail (GMAIL_SYNC_QUERY): snippet evidence for search_messages, and fact
    // memories extracted from bodies that are read and dropped.
    async syncEmail() {
      return runSync('gmail', async context => {
        const records = await listMessages(config.GMAIL_SYNC_QUERY, config.GMAIL_SYNC_LIMIT, context);
        if (!(await store.replaceOrigin(SOURCES.gmail, records, context.generation))) throw changedConnection();
        return { count: records.length, memories: await gmailFacts(records, context) };
      });
    },

    // People API: every contact (paged), with names, relations, birthdays and phone numbers.
    async syncContacts() {
      return runSync('contacts', async context => {
        const { items } = await paged(`${PEOPLE_API}/people/me/connections`, {
          personFields: 'names,phoneNumbers,birthdays,relations,emailAddresses', pageSize: '1000',
        }, 'connections', context, AbortSignal.timeout(30_000), 20);
        const records = items.map(contactMemory).filter(Boolean);
        return { count: records.length, memories: records };
      });
    },

    // Tasks API: open tasks of every list, plus tasks completed in the last DONE_TASK_DAYS.
    async syncTasks() {
      return runSync('tasks', async context => {
        const signal = AbortSignal.timeout(30_000);
        const zone = zoneOf(context);
        const since = Date.now() - DONE_TASK_DAYS * 86_400_000;
        const records = [];
        const { items: lists } = await paged(`${TASKS_API}/users/@me/lists`, { maxResults: '100' }, 'items', context, signal);
        for (const list of lists) {
          const { items } = await paged(`${TASKS_API}/lists/${encodeURIComponent(list.id)}/tasks`,
            { maxResults: '100', showCompleted: 'true', showHidden: 'true' }, 'items', context, signal);
          for (const task of items) {
            if (task.deleted || !task.title?.trim()) continue;
            if (task.status === 'completed' && !(Date.parse(task.completed) >= since)) continue;
            records.push(taskMemory(task, list, zone));
          }
        }
        return { count: records.length, memories: records };
      });
    },

    async syncAll() {
      const results = [];
      if (await can('calendar')) results.push(await google.syncCalendar());
      if (await can('gmail')) results.push(await google.syncEmail());
      if (await can('contacts')) results.push(await google.syncContacts());
      if (await can('tasks')) results.push(await google.syncTasks());
      // Connect and the sync cron both land here, so push channels are created and renewed here.
      if (await can('calendar')) {
        try {
          await ensureWatch(requireConnected(await snapshot('calendar')));
        } catch (error) {
          log.warn(`Calendar push channel setup failed: ${error.message}`);
        }
      }
      if (results.length) onSync(results);
      return results;
    },

    // POST /webhooks/google/calendar. The channel token proves the channel is ours; the channel id
    // must be one the current connection holds. The sync runs inside the request (DEC-004).
    async calendarNotification({ channelId, token: supplied, resourceId, state: resourceState }) {
      if (!configured || typeof channelId !== 'string' || typeof supplied !== 'string' || channelId.length > 64) return { status: 401 };
      const expected = Buffer.from(channelToken(channelId));
      const given = Buffer.from(supplied);
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { status: 401 };
      // Google confirms a new channel with a "sync" message, possibly before watch() has returned.
      if (resourceState === 'sync') return { status: 200 };
      const known = (await store.googleState('channel:')).some(({ value }) => value.id === channelId && value.resourceId === resourceId);
      if (!known) return { status: 404 };
      const result = await google.syncCalendar();
      return { status: result.ok ? 200 : 503, result };
    },

    // Adds one event to the primary calendar, marked as Steph's in a private extended property
    // and recorded locally. There is deliberately no way to edit or delete events.
    async createEvent(input) {
      const { title, start, end, description } = eventInput.parse(input ?? {});
      const context = requireConnected(await snapshot('calendarEvents'));
      const allDay = start.length === 10;
      const field = value => value.length === 10 ? { date: value } : { dateTime: value };
      const finish = end ?? (allDay ? addDays(start, 1) : new Date(Date.parse(start) + 3600_000).toISOString());
      const event = await api(`${CALENDAR_API}/calendars/primary/events`, context, AbortSignal.timeout(10_000), {
        method: 'POST',
        body: {
          summary: title, ...(description ? { description } : {}), start: field(start), end: field(finish),
          extendedProperties: { private: { stephCreated: 'true' } },
        },
      });
      if (!event.id || !event.start) throw new GoogleError('Google Calendar returned an unreadable event', { status: 502 });
      await saveState(context, 'calendarEvents', {
        put: [{ key: `created:primary:${event.id}`, value: { title: clip(title, 200), createdAt: new Date().toISOString() } }],
      });
      const record = eventRecord(event, 'primary', zoneOf(context));
      // Into the calendar copy too when calendar reads are granted (a no-op otherwise).
      await store.upsertOrigin(SOURCES.calendar, [record], context.generation);
      const memory = eventMemory(record);
      await remember(context, SOURCES.calendar, () => memories.upsert([memory]));
      return { id: event.id, htmlLink: event.htmlLink ?? null, memory };
    },

    // Google Photos Picker (no library access): the person picks items in Google Photos.
    async createPhotoPickerSession() {
      const context = requireConnected(await snapshot('photos'));
      const session = await api(`${PHOTOS_API}/sessions`, context, AbortSignal.timeout(10_000), { method: 'POST', body: {} });
      if (!session.id || !session.pickerUri) throw new GoogleError('Google Photos returned an unreadable session', { status: 502 });
      const expired = (await store.googleState('picker:')).filter(({ value }) => !(Date.parse(value.expireTime) > Date.now()));
      // Only sessions this connection created can be polled and imported.
      await saveState(context, 'photos', {
        put: [{ key: `picker:${session.id}`, value: { expireTime: session.expireTime ?? new Date(Date.now() + 3600_000).toISOString() } }],
        remove: expired.map(row => row.key),
      });
      return {
        session_id: session.id, picker_uri: session.pickerUri,
        poll_interval: session.pollingConfig?.pollInterval ?? null, expire_time: session.expireTime ?? null,
      };
    },

    // 'pending' until the person finishes picking; then the picked items' metadata become photo
    // memories (no image is downloaded) and the session is deleted.
    async pollPhotoPickerSession(sessionId) {
      const context = requireConnected(await snapshot('photos'));
      if (typeof sessionId !== 'string' || !/^[\w-]{1,200}$/.test(sessionId) ||
          !(await store.googleState(`picker:${sessionId}`)).some(row => row.key === `picker:${sessionId}`)) {
        throw exposed('Unknown photo picker session', 404);
      }
      const signal = AbortSignal.timeout(30_000);
      const path = `${PHOTOS_API}/sessions/${encodeURIComponent(sessionId)}`;
      const session = await api(path, context, signal);
      if (!session.mediaItemsSet) {
        return { state: 'pending', poll_interval: session.pollingConfig?.pollInterval ?? null, timeout_in: session.pollingConfig?.timeoutIn ?? null };
      }
      const { items } = await paged(`${PHOTOS_API}/mediaItems`, { sessionId, pageSize: '100' }, 'mediaItems', context, signal, 20);
      const zone = zoneOf(context);
      const records = items.map(item => photoMemory(item, zone)).filter(Boolean);
      await remember(context, SOURCES.photos, () => memories.upsert(records));
      await saveState(context, 'photos', { remove: [`picker:${sessionId}`] });
      await api(path, context, signal, { method: 'DELETE' }).catch(error => log.warn(`Photo picker session delete failed: ${error.message}`));
      return { state: 'done', count: records.length, memories: records };
    },

    // Per-user setting (wired by the caller). Off stops Gmail sync and live search, and forgets
    // what was read from Gmail: evidence, cached facts and memories.
    async setGmailEnabled(enabled) {
      if (!configured) throw new GoogleError('Google integration is not configured', { status: 503 });
      await store.saveGoogleSetting('gmail_enabled', Boolean(enabled));
      if (enabled) return;
      const { generation, connection: row } = await store.googleSnapshot();
      if (row && !foreign(row)) {
        // Both are fenced writes and no-ops without the Gmail scope.
        await store.replaceOrigin(SOURCES.gmail, [], generation);
        await store.saveGoogleState(generation, SCOPES.gmail, { remove: (await store.googleState('gmail:')).map(entry => entry.key) });
      }
      await memories.deleteSource(SOURCES.gmail);
    },

    gmailEnabled,

    // True when a recent successful sync covered this date, so the database is authoritative.
    async covers(date) {
      const [state] = await store.syncState(SOURCES.calendar);
      return Boolean(state?.window_from && fresh(state) && state.window_from <= date && date <= state.window_to);
    },

    // Whether the stored mail copy is recent enough to answer without asking Gmail first.
    async mailFresh() {
      const [state] = await store.syncState(SOURCES.gmail);
      return fresh(state);
    },

    // Live lookups run during a phone call, so they share one short deadline.
    async fetchDay(date, context) {
      context = requireConnected(context ?? await snapshot('calendar'));
      const zone = zoneOf(context);
      const records = await listEvents(startOfDay(date, zone), startOfDay(addDays(date, 1), zone), context, config.GOOGLE_LIVE_TIMEOUT_MS ?? 1500);
      if (!(await store.replaceCalendarDay(date, records, context.generation))) throw changedConnection();
      await assertCurrent(context);
      return records;
    },

    // Live search stays inside the mail the owner chose to expose (GMAIL_SYNC_QUERY), so it
    // reaches message bodies and mail beyond the sync cap, not the whole mailbox.
    async searchMail(query, context) {
      context = requireConnected(context ?? await snapshot('gmail'));
      const scoped = [query, config.GMAIL_SYNC_QUERY].filter(Boolean).join(' ');
      const records = await listMessages(scoped, 5, context, config.GOOGLE_LIVE_TIMEOUT_MS ?? 1500);
      if (!(await store.upsertOrigin(SOURCES.gmail, records, context.generation))) throw changedConnection();
      await assertCurrent(context);
      return records;
    },

    // Long-running servers (npm start, Docker) sync on a timer. On Vercel, process timers are
    // not durable (DEC-004): Vercel Cron, the post-connect sync and live lookups cover it.
    start() {
      if (!configured || !syncMinutes || config.VERCEL === '1') return () => {};
      let running = false;
      const tick = async () => {
        if (running) return;
        running = true;
        try { await google.syncAll(); } catch (error) { log.error(`Google sync failed: ${error.message}`); } finally { running = false; }
      };
      tick();
      const timer = setInterval(tick, syncMinutes * 60_000);
      timer.unref();
      return () => clearInterval(timer);
    },
  };
  return google;
}
