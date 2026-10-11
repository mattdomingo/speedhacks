import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { addDays, describeDate, describeTime, localDate, startOfDay } from '../time.mjs';

export const SCOPES = {
  calendar: 'https://www.googleapis.com/auth/calendar.readonly',
  gmail: 'https://www.googleapis.com/auth/gmail.readonly',
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
  };
}

// Synced calendar window relative to today; dates outside it are fetched live.
const PAST_DAYS = 7;
const FUTURE_DAYS = 60;
const MAX_PAGES = 10;
const SNIPPET_CHARS = 300;

export class GoogleError extends Error {
  constructor(message, { status, reconnect = false } = {}) {
    super(message);
    this.name = 'GoogleError';
    this.status = status;
    this.reconnect = reconnect;
  }
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

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decodeEntities(text) {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, code) => {
    if (code[0] !== '#') return ENTITIES[code.toLowerCase()] ?? match;
    const point = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
    return Number.isInteger(point) && point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : match;
  });
}

// Also strips what Postgres jsonb rejects: NUL characters and unpaired UTF-16 surrogates (a
// cut emoji). One bad string would otherwise fail the whole batch write of a sync.
function clip(text, length) {
  const clean = text.replace(/\u0000/g, '').replace(/\s+/g, ' ').trim().toWellFormed();
  return clean.length > length ? `${clean.slice(0, length - 1).replace(/[\uD800-\uDBFF]$/, '')}…` : clean;
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
  return {
    id: `gcal:${calendarId}:${event.id}`, source: 'calendar', origin: 'google-calendar',
    date, endDate, allDay, title, timeZone,
    start: start.toISOString(),
    end: allDay ? startOfDay(addDays(endDate, 1), timeZone).toISOString() : new Date(event.end?.dateTime ?? start).toISOString(),
    timestamp: start.toISOString(),
    ...(event.location ? { location: clip(event.location, 200) } : {}),
    ...(note ? { response } : {}),
    ...(response === 'declined' ? { declined: true } : {}),
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

export function createGoogle({ config, store, fetch = globalThis.fetch, log = console, onSync = () => {} }) {
  const configured = Boolean(config.GOOGLE_CLIENT_ID);
  const key = configured ? Buffer.from(config.GOOGLE_TOKEN_KEY, 'hex') : undefined;
  const { auth: AUTH_URL, token: TOKEN_URL, revoke: REVOKE_URL, calendar: CALENDAR_API, gmail: GMAIL_API } = endpoints(config);
  // A connection belongs to the token endpoint it was made with (DEC-015): a real Google
  // connection is never used against a local mock, nor a mock connection against Google.
  const TOKEN_ORIGIN = new URL(TOKEN_URL).origin;
  const originOf = row => row.token_origin ?? REAL_TOKEN_ORIGIN;
  const foreign = row => Boolean(row) && originOf(row) !== TOKEN_ORIGIN;
  function foreignConnection(row) {
    const error = new GoogleError(`The stored Google connection was made against ${originOf(row)}, not ${TOKEN_ORIGIN}; ` +
      'disconnect it with matching Google endpoint settings first', { status: 409 });
    error.expose = true;
    return error;
  }
  const calendarIds = (config.GOOGLE_CALENDAR_IDS || 'primary').split(',').map(id => id.trim()).filter(Boolean);
  const syncMinutes = config.GOOGLE_SYNC_MINUTES ?? 10;
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

  async function timeZone() {
    return config.TIMEZONE || (await connection())?.timezone || 'UTC';
  }

  async function snapshot(scope) {
    const stored = configured ? await store.googleSnapshot() : { generation: null };
    const current = foreign(stored.connection) ? { ...stored, connection: undefined } : stored;
    const row = current.connection;
    return { ...current, scope,
      state: row?.scope.split(' ').includes(SCOPES[scope]) ? row.status : 'absent' };
  }

  function changedConnection() {
    const error = new GoogleError('Google connection changed; retry the lookup', { status: 409 });
    error.expose = true;
    return error;
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

  async function apiResponse(response) {
    const body = await response.json().catch(() => undefined);
    // A truncated or non-JSON 200 must not read as "no events" and wipe the synced copy.
    if (response.ok && body && typeof body === 'object') return body;
    if (response.ok) throw new GoogleError('Google API returned an unreadable response', { status: 502 });
    const reason = body?.error?.errors?.[0]?.reason ?? body?.error?.status ?? 'unknown_error';
    throw new GoogleError(`Google API request failed (${response.status} ${reason})`, { status: response.status });
  }

  // One deadline and one connection cover every request in an operation.
  async function api(url, context, signal = AbortSignal.timeout(10_000)) {
    for (const force of [false, true]) {
      const response = await fetch(url, {
        redirect: 'error',
        headers: { Authorization: `Bearer ${await token(context, force, signal)}`, Accept: 'application/json' },
        signal,
      });
      if (response.status === 401 && !force) continue;
      return apiResponse(response);
    }
  }

  async function listEvents(timeMin, timeMax, context, timeout = 30_000) {
    const signal = AbortSignal.timeout(timeout);
    const zone = config.TIMEZONE || context.connection.timezone || 'UTC';
    const records = [];
    for (const calendarId of calendarIds) {
      let pageToken;
      for (let page = 0; page < MAX_PAGES; page++) {
        const query = new URLSearchParams({
          timeMin: timeMin.toISOString(), timeMax: timeMax.toISOString(), singleEvents: 'true',
          orderBy: 'startTime', maxResults: '250', timeZone: zone, ...(pageToken ? { pageToken } : {}),
        });
        const body = await api(`${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events?${query}`, context, signal);
        for (const event of body.items ?? []) {
          if (event.status !== 'cancelled' && event.start) records.push(eventRecord(event, calendarId, zone));
        }
        pageToken = body.nextPageToken;
        if (!pageToken) break;
      }
      if (pageToken) log.warn(`Calendar ${calendarId}: stopped after ${MAX_PAGES} pages`);
    }
    return records;
  }

  async function listMessages(q, maxResults, context, timeout = 60_000) {
    const signal = AbortSignal.timeout(timeout);
    const query = new URLSearchParams({ q, maxResults: String(maxResults) });
    const body = await api(`${GMAIL_API}/messages?${query}`, context, signal);
    const zone = config.TIMEZONE || context.connection.timezone || 'UTC';
    return mapLimit(body.messages ?? [], 8, async ({ id }) => {
      const params = new URLSearchParams({ format: 'metadata' });
      for (const name of ['From', 'Subject', 'Date']) params.append('metadataHeaders', name);
      return messageRecord(await api(`${GMAIL_API}/messages/${encodeURIComponent(id)}?${params}`, context, signal), zone);
    });
  }

  async function runSync(scope, work) {
    const name = `google-${scope}`;
    let context;
    try {
      context = requireConnected(await snapshot(scope));
      const { records, window } = await work(context);
      const count = records.length;
      if (!(await store.replaceOrigin(name, records, context.generation)) ||
          !(await store.recordSync(name, { count, window }, context.generation))) throw changedConnection();
      await assertCurrent(context);
      return { name, ok: true, count };
    } catch (error) {
      log.error(`Google sync ${name} failed: ${error.message}`);
      try {
        if (context) await store.recordSync(name, { error: error.message }, context.generation);
      } catch { /* reported above */ }
      return { name, ok: false, error: error.message };
    }
  }

  const google = {
    configured,
    timeZone,
    can,
    state,
    snapshot,
    assertCurrent,

    // Starts the OAuth web-server flow with PKCE; the caller visits the returned URL.
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
        response_type: 'code', scope: Object.values(SCOPES).join(' '),
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
      // Users can untick scopes on the consent screen; keep only what was granted.
      const granted = (body.scope ?? '').split(' ').filter(scope => Object.values(SCOPES).includes(scope));
      if (!granted.length) throw new GoogleError('Calendar or Gmail read access is required', { status: 400 });
      // Resolve account metadata with the new token before committing anything. The
      // single final save is conditional on the generation claimed with OAuth state.
      const oauthApi = async url => apiResponse(await fetch(url, {
        redirect: 'error',
        headers: { Authorization: `Bearer ${body.access_token}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      }));
      let email = null;
      let zone = null;
      if (granted.includes(SCOPES.calendar)) {
        const primary = await oauthApi(`${CALENDAR_API}/calendars/primary`).catch(() => ({}));
        email = primary.id ?? null;
        zone = primary.timeZone ?? null;
      }
      if (!email && granted.includes(SCOPES.gmail)) {
        email = (await oauthApi(`${GMAIL_API}/profile`).catch(() => ({}))).emailAddress ?? null;
      }
      const row = await store.saveGoogleConnection({ email, timezone: zone, scope: granted.join(' '),
        refreshToken: seal(key, body.refresh_token), generation: handshake.generation, tokenOrigin: TOKEN_ORIGIN });
      if (!row) throw changedConnection();
      accessToken = { generation: row.generation, value: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
      return { email, scopes: granted };
    },

    async disconnect() {
      // Never revoke at, or delete for, an endpoint the connection was not made with.
      const existing = await store.googleConnection();
      if (foreign(existing)) throw foreignConnection(existing);
      // Invalidate local requests and pending callbacks before the best-effort network call.
      const row = await store.deleteGoogleConnection();
      accessToken = undefined;
      if (row) {
        // Best effort: local deletion must not depend on decrypting the token or reaching Google.
        try {
          await fetch(REVOKE_URL, {
            method: 'POST', signal: AbortSignal.timeout(10_000), redirect: 'error',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ token: unseal(key, row.refresh_token) }),
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
        } : null,
        sync: (await store.syncState()).filter(state => state.name.startsWith('google-'))
          .map(({ age_seconds: _age, ...state }) => state),
        records: await store.countByOrigin(),
      };
    },

    async syncCalendar() {
      return runSync('calendar', async context => {
        const zone = config.TIMEZONE || context.connection.timezone || 'UTC';
        const today = localDate(new Date(), zone);
        const window = { from: addDays(today, -PAST_DAYS), to: addDays(today, FUTURE_DAYS) };
        const records = await listEvents(startOfDay(window.from, zone), startOfDay(addDays(window.to, 1), zone), context);
        return { records, window };
      });
    },

    async syncEmail() {
      return runSync('gmail', async context => ({
        records: await listMessages(config.GMAIL_SYNC_QUERY, config.GMAIL_SYNC_LIMIT, context),
      }));
    },

    async syncAll() {
      const results = [];
      if (await can('calendar')) results.push(await google.syncCalendar());
      if (await can('gmail')) results.push(await google.syncEmail());
      if (results.length) onSync(results);
      return results;
    },

    // True when a recent successful sync covered this date, so the database is authoritative.
    async covers(date) {
      const [state] = await store.syncState('google-calendar');
      return Boolean(state?.window_from && fresh(state) && state.window_from <= date && date <= state.window_to);
    },

    // Whether the stored mail copy is recent enough to answer without asking Gmail first.
    async mailFresh() {
      const [state] = await store.syncState('google-gmail');
      return fresh(state);
    },

    // Live lookups run during a phone call, so they share one short deadline.
    async fetchRange(from, through, context) {
      context = requireConnected(context ?? await snapshot('calendar'));
      const zone = config.TIMEZONE || context.connection.timezone || 'UTC';
      const records = await listEvents(startOfDay(from, zone), startOfDay(addDays(through, 1), zone), context, config.GOOGLE_LIVE_TIMEOUT_MS ?? 1500);
      await assertCurrent(context);
      return records;
    },

    async fetchDay(date, context) {
      context = requireConnected(context ?? await snapshot('calendar'));
      const records = await google.fetchRange(date, date, context);
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
      if (!(await store.upsertOrigin('google-gmail', records, context.generation))) throw changedConnection();
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
