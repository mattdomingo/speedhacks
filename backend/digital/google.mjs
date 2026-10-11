import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { addDays, describeDate, describeTime, localDate, startOfDay } from '../time.mjs';

export const SCOPES = {
  calendar: 'https://www.googleapis.com/auth/calendar.readonly',
  gmail: 'https://www.googleapis.com/auth/gmail.readonly',
};
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const CALENDAR_API = 'https://www.googleapis.com/calendar/v3';
const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';

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

function clip(text, length) {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > length ? `${clean.slice(0, length - 1)}…` : clean;
}

function senderName(from = '') {
  const match = from.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  return (match ? match[1] || match[2] : from).trim() || 'an unknown sender';
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
  const when = allDay
    ? (endDate === date ? `all day on ${describeDate(date, timeZone)}`
      : `from ${describeDate(date, timeZone)} through ${describeDate(endDate, timeZone)}`)
    : `on ${describeDate(date, timeZone)} from ${describeTime(start, timeZone)} to ${describeTime(event.end?.dateTime ?? start, timeZone)}`;
  const self = event.attendees?.find(attendee => attendee.self);
  const declined = self?.responseStatus === 'declined';
  const location = event.location ? ` at ${clip(event.location, 200)}` : '';
  return {
    id: `gcal:${calendarId}:${event.id}`, source: 'calendar', origin: 'google-calendar',
    date, endDate, allDay, title, timeZone,
    start: start.toISOString(),
    end: allDay ? startOfDay(addDays(endDate, 1), timeZone).toISOString() : new Date(event.end?.dateTime ?? start).toISOString(),
    timestamp: start.toISOString(),
    ...(event.location ? { location: clip(event.location, 200) } : {}),
    ...(declined ? { declined: true } : {}),
    ref: event.htmlLink,
    text: `Calendar event "${title}" ${when}${location}${declined ? ' (the user declined this invitation)' : ''}.`,
    demo: false,
  };
}

export function messageRecord(message, timeZone) {
  const header = name => message.payload?.headers?.find(h => h.name.toLowerCase() === name)?.value ?? '';
  const timestamp = new Date(Number(message.internalDate)).toISOString();
  const from = senderName(header('from'));
  const subject = clip(header('subject') || '(no subject)', 200);
  const snippet = clip(decodeEntities(message.snippet ?? ''), SNIPPET_CHARS);
  return {
    id: `gmail:${message.id}`, source: 'email', origin: 'google-gmail',
    timestamp, from, subject, snippet,
    ref: `https://mail.google.com/mail/u/0/#all/${message.threadId ?? message.id}`,
    text: `Email from ${from} on ${describeDate(localDate(timestamp, timeZone), timeZone)}, subject "${subject}": ${snippet}`,
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
  const calendarIds = (config.GOOGLE_CALENDAR_IDS || 'primary').split(',').map(id => id.trim()).filter(Boolean);
  let accessToken;
  let calendarWindow;

  function connection() {
    const row = configured ? store.googleConnection() : undefined;
    return row && { ...row, scopes: row.scope.split(' ') };
  }

  function timeZone() {
    return config.TIMEZONE || connection()?.timezone || 'UTC';
  }

  function can(scope) {
    const row = connection();
    return row?.status === 'connected' && row.scopes.includes(SCOPES[scope]);
  }

  async function tokenRequest(params, signal = AbortSignal.timeout(10_000)) {
    const response = await fetch(TOKEN_URL, {
      method: 'POST', signal,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: config.GOOGLE_CLIENT_ID, client_secret: config.GOOGLE_CLIENT_SECRET, ...params,
      }),
    });
    const body = await response.json().catch(() => ({}));
    if (response.ok) return body;
    // invalid_grant: the refresh token was revoked, expired (7 days in Testing mode) or rotated.
    if (body.error === 'invalid_grant' && params.grant_type === 'refresh_token') {
      store.markGoogleReconnectRequired();
      accessToken = undefined;
      throw new GoogleError('Google access expired or was revoked; reconnect required', { status: 401, reconnect: true });
    }
    throw new GoogleError(`Google token request failed (${response.status} ${body.error ?? 'unknown_error'})`, { status: response.status });
  }

  async function token(force, signal) {
    if (!force && accessToken && accessToken.expiresAt > Date.now() + 60_000) return accessToken.value;
    const row = connection();
    if (!row || row.status !== 'connected') throw new GoogleError('Google account is not connected', { reconnect: true });
    const body = await tokenRequest({ grant_type: 'refresh_token', refresh_token: unseal(key, row.refresh_token) }, signal);
    accessToken = { value: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
    return accessToken.value;
  }

  // One deadline covers every request in an operation (list + per-item gets + token refresh).
  async function api(url, signal = AbortSignal.timeout(10_000)) {
    for (const force of [false, true]) {
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${await token(force, signal)}`, Accept: 'application/json' },
        signal,
      });
      if (response.status === 401 && !force) continue;
      const body = await response.json().catch(() => ({}));
      if (response.ok) return body;
      const reason = body.error?.errors?.[0]?.reason ?? body.error?.status ?? 'unknown_error';
      throw new GoogleError(`Google API request failed (${response.status} ${reason})`, { status: response.status });
    }
  }

  async function listEvents(timeMin, timeMax, timeout = 30_000) {
    const signal = AbortSignal.timeout(timeout);
    const zone = timeZone();
    const records = [];
    for (const calendarId of calendarIds) {
      let pageToken;
      for (let page = 0; page < MAX_PAGES; page++) {
        const query = new URLSearchParams({
          timeMin: timeMin.toISOString(), timeMax: timeMax.toISOString(), singleEvents: 'true',
          orderBy: 'startTime', maxResults: '250', timeZone: zone, ...(pageToken ? { pageToken } : {}),
        });
        const body = await api(`${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events?${query}`, signal);
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

  async function listMessages(q, maxResults, timeout = 60_000) {
    const signal = AbortSignal.timeout(timeout);
    const query = new URLSearchParams({ q, maxResults: String(maxResults) });
    const body = await api(`${GMAIL_API}/messages?${query}`, signal);
    const zone = timeZone();
    return mapLimit(body.messages ?? [], 8, async ({ id }) => {
      const params = new URLSearchParams({ format: 'metadata' });
      for (const name of ['From', 'Subject', 'Date']) params.append('metadataHeaders', name);
      return messageRecord(await api(`${GMAIL_API}/messages/${encodeURIComponent(id)}?${params}`, signal), zone);
    });
  }

  async function runSync(name, work) {
    try {
      const count = await work();
      store.recordSync(name, { count });
      return { name, ok: true, count };
    } catch (error) {
      store.recordSync(name, { error: error.message });
      log.error(`Google sync ${name} failed: ${error.message}`);
      return { name, ok: false, error: error.message };
    }
  }

  return {
    configured,
    timeZone,
    can,

    // Starts the OAuth web-server flow with PKCE; the caller visits the returned URL.
    beginConnect() {
      if (!configured) throw new GoogleError('Google integration is not configured', { status: 503 });
      const state = randomBytes(24).toString('base64url');
      const verifier = randomBytes(48).toString('base64url');
      store.saveOAuthState(state, verifier);
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
      const verifier = typeof state === 'string' ? store.takeOAuthState(state) : undefined;
      if (!verifier) throw new GoogleError('Connection link expired or was already used', { status: 400 });
      const body = await tokenRequest({
        grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: config.GOOGLE_REDIRECT_URI,
      });
      if (!body.refresh_token) throw new GoogleError('Google did not return offline access; try connecting again', { status: 400 });
      // Users can untick scopes on the consent screen; keep only what was granted.
      const granted = (body.scope ?? '').split(' ').filter(scope => Object.values(SCOPES).includes(scope));
      if (!granted.length) throw new GoogleError('Calendar or Gmail read access is required', { status: 400 });
      accessToken = { value: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
      store.saveGoogleConnection({ scope: granted.join(' '), refreshToken: seal(key, body.refresh_token) });
      calendarWindow = undefined;
      let email = null;
      let zone = null;
      if (granted.includes(SCOPES.calendar)) {
        const primary = await api(`${CALENDAR_API}/calendars/primary`).catch(() => ({}));
        email = primary.id ?? null;
        zone = primary.timeZone ?? null;
      }
      if (!email && granted.includes(SCOPES.gmail)) {
        email = (await api(`${GMAIL_API}/profile`).catch(() => ({}))).emailAddress ?? null;
      }
      store.saveGoogleConnection({ email, timezone: zone, scope: granted.join(' '), refreshToken: seal(key, body.refresh_token) });
      return { email, scopes: granted };
    },

    async disconnect() {
      const row = connection();
      if (row) {
        // Best effort: local deletion must not depend on Google being reachable.
        await fetch(REVOKE_URL, {
          method: 'POST', signal: AbortSignal.timeout(10_000),
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ token: unseal(key, row.refresh_token) }),
        }).catch(error => log.warn(`Google revoke failed: ${error.message}`));
      }
      store.deleteGoogleConnection();
      accessToken = undefined;
      calendarWindow = undefined;
    },

    status() {
      const row = connection();
      return {
        configured,
        timeZone: timeZone(),
        connection: row ? {
          email: row.email, status: row.status, connectedAt: row.connected_at,
          calendar: row.scopes.includes(SCOPES.calendar), gmail: row.scopes.includes(SCOPES.gmail),
        } : null,
        sync: store.syncState().filter(state => state.name.startsWith('google-')),
        records: store.countByOrigin(),
      };
    },

    async syncCalendar() {
      return runSync('google-calendar', async () => {
        const today = localDate(new Date(), timeZone());
        const from = addDays(today, -PAST_DAYS);
        const to = addDays(today, FUTURE_DAYS);
        const records = await listEvents(startOfDay(from, timeZone()), startOfDay(addDays(to, 1), timeZone()));
        store.replaceOrigin('google-calendar', records);
        calendarWindow = { from, to, syncedAt: Date.now() };
        return records.length;
      });
    },

    async syncEmail() {
      return runSync('google-gmail', async () => {
        const records = await listMessages(config.GMAIL_SYNC_QUERY, config.GMAIL_SYNC_LIMIT);
        store.replaceOrigin('google-gmail', records);
        return records.length;
      });
    },

    async syncAll() {
      const results = [];
      if (can('calendar')) results.push(await this.syncCalendar());
      if (can('gmail')) results.push(await this.syncEmail());
      if (results.length) onSync(results);
      return results;
    },

    // True when a recent full sync covered this date, so the store is authoritative.
    covers(date) {
      const maxAge = Math.max(config.GOOGLE_SYNC_MINUTES, 15) * 2 * 60_000;
      return Boolean(calendarWindow && Date.now() - calendarWindow.syncedAt < maxAge &&
        calendarWindow.from <= date && date <= calendarWindow.to);
    },

    // Live lookups run during a phone call, so they use a short timeout.
    async fetchDay(date) {
      const zone = timeZone();
      const records = await listEvents(startOfDay(date, zone), startOfDay(addDays(date, 1), zone), config.GOOGLE_LIVE_TIMEOUT_MS);
      store.upsertOrigin('google-calendar', records);
      return records;
    },

    async searchMail(query) {
      const records = await listMessages(query, 5, config.GOOGLE_LIVE_TIMEOUT_MS);
      store.upsertOrigin('google-gmail', records);
      return records;
    },

    start() {
      if (!configured || !config.GOOGLE_SYNC_MINUTES) return () => {};
      let running = false;
      const tick = async () => {
        if (running) return;
        running = true;
        try { await this.syncAll(); } finally { running = false; }
      };
      tick();
      const timer = setInterval(tick, config.GOOGLE_SYNC_MINUTES * 60_000);
      timer.unref();
      return () => clearInterval(timer);
    },
  };
}
