import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createApp } from '../app.mjs';
import { readConfig } from '../config.mjs';
import { testStore, TEST_DATABASE_URL } from './helpers.mjs';
import { CONSENT_SCOPES, createGoogle, endpoints, eventRecord, SCOPES } from '../digital/google.mjs';
import { addDays, localDate, startOfDay } from '../time.mjs';
import { getSchedule, searchMessages } from '../digital/index.mjs';

const ZONE = 'America/Los_Angeles';
const config = readConfig({
  DIAL_MCP_TOKEN: 'd'.repeat(64), CAMERA_TOKEN: 'c'.repeat(64), ADMIN_TOKEN: 'a'.repeat(64),
  DEMO_CALLER_NUMBER: '+14155550123', DEMO_MODE: 'false', DATABASE_URL: TEST_DATABASE_URL,
  GOOGLE_CLIENT_ID: 'client-id.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'client-secret',
  GOOGLE_REDIRECT_URI: 'http://127.0.0.1:3000/google/callback', GOOGLE_TOKEN_KEY: 'f'.repeat(64),
});
const admin = { Authorization: `Bearer ${config.ADMIN_TOKEN}` };
const today = localDate(new Date(), ZONE);
const quietLog = { warn() {}, error() {} };

// In-process stand-in for Google's OAuth, Calendar, Gmail, People, Tasks and Photos Picker endpoints.
function fakeGoogle() {
  const google = {
    calls: [], events: [], messages: [], failCalendar: false, revoked: [],
    grantedScope: Object.values(SCOPES).join(' '), refreshValid: true, account: 'me@example.com',
    accessAccounts: new Map(), refreshAccounts: new Map(),
    // id_token claims; idTokenEmail null leaves the email out, idTokens false omits the token.
    idTokens: true, idTokenEmail: undefined, idTokenAud: config.GOOGLE_CLIENT_ID,
    eventQueries: [], changes: [], syncTokens: new Map(), goneTokens: new Set(), inserted: [], watches: [], stopped: [],
    contacts: [], contactsPageSize: undefined, taskLists: [], fullFetches: [], picked: undefined, pickerSessions: 0,
  };
  const json = (body, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json' },
  });
  const jwt = claims => ['{"alg":"RS256"}', JSON.stringify(claims), 'signature']
    .map(part => Buffer.from(part).toString('base64url')).join('.');
  google.fetch = async (input, init = {}) => {
    const url = new URL(input);
    const method = init.method ?? 'GET';
    google.calls.push(`${method} ${url.host}${url.pathname}`);
    if (url.href === 'https://oauth2.googleapis.com/token') {
      const params = new URLSearchParams(init.body);
      google.lastTokenRequest = params;
      if (params.get('grant_type') === 'refresh_token' && !google.refreshValid) {
        return json({ error: 'invalid_grant' }, 400);
      }
      const authorization = params.get('grant_type') === 'authorization_code';
      const account = authorization ? google.account : google.refreshAccounts.get(params.get('refresh_token'));
      const access = `access-${google.calls.length}`;
      google.accessAccounts.set(access, account);
      const refresh = account === 'me@example.com' ? 'refresh-secret-value' : `refresh-${google.calls.length}`;
      if (authorization) google.refreshAccounts.set(refresh, account);
      const email = google.idTokenEmail === undefined ? account : google.idTokenEmail;
      return json({
        access_token: access, expires_in: 3600, token_type: 'Bearer',
        scope: google.grantedScope,
        ...(authorization ? { refresh_token: refresh } : {}),
        ...(authorization && google.idTokens ? { id_token: jwt({ iss: 'https://accounts.google.com', aud: google.idTokenAud,
          sub: '1', ...(email ? { email, email_verified: true } : {}) }) } : {}),
      });
    }
    if (url.href.startsWith('https://oauth2.googleapis.com/revoke')) {
      google.revoked.push(new URLSearchParams(init.body).get('token'));
      return json({});
    }
    assert.match(init.headers.Authorization, /^Bearer access-/);
    const account = google.accessAccounts.get(init.headers.Authorization.slice(7));
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    if (url.pathname === '/calendar/v3/calendars/primary') return json({ id: account, timeZone: ZONE });
    if (url.pathname === '/gmail/v1/users/me/profile') return json({ emailAddress: account });
    if (url.pathname === '/calendar/v3/calendars/primary/events' && method === 'POST') {
      const event = { ...body, id: `steph${google.inserted.length + 1}`, status: 'confirmed',
        htmlLink: `https://calendar.google.com/e/steph${google.inserted.length + 1}` };
      google.inserted.push(body);
      google.events.push(event);
      return json(event);
    }
    if (url.pathname === '/calendar/v3/calendars/primary/events/watch' && method === 'POST') {
      google.watches.push(body);
      return json({ kind: 'api#channel', id: body.id, resourceId: `resource-${google.watches.length}`,
        resourceUri: 'https://www.googleapis.com/calendar/v3/calendars/primary/events', token: body.token,
        expiration: String(Date.now() + Number(body.params.ttl) * 1000) });
    }
    if (url.pathname === '/calendar/v3/channels/stop' && method === 'POST') {
      google.stopped.push(body);
      return new Response(null, { status: 204 });
    }
    if (url.pathname === '/calendar/v3/calendars/primary/events') {
      if (google.failCalendar) return json({ error: { errors: [{ reason: 'backendError' }] } }, 503);
      const params = Object.fromEntries(url.searchParams);
      google.eventQueries.push(params);
      const visible = google.events.filter(event => !event.account || event.account === account);
      // A sync token remembers the whole calendar as it was; the next incremental list reports
      // what changed since, with deletions as cancelled entries (plus any scripted `changes`).
      const nextSyncToken = () => {
        const token = `sync-${google.syncTokens.size + 1}`;
        google.syncTokens.set(token, new Map(visible.map(event => [event.id, JSON.stringify(event)])));
        return token;
      };
      if (params.syncToken) {
        // As Google: these parameters cannot be combined with a sync token.
        if (['timeMin', 'timeMax', 'orderBy', 'q', 'iCalUID', 'updatedMin'].some(name => name in params)) {
          return json({ error: { errors: [{ reason: 'invalid' }] } }, 400);
        }
        const before = google.syncTokens.get(params.syncToken);
        if (!before || google.goneTokens.has(params.syncToken)) {
          return json({ error: { errors: [{ reason: 'fullSyncRequired' }] } }, 410);
        }
        const ids = new Set(visible.map(event => event.id));
        // Google reports a deleted recurring series once, by its own id, not per instance.
        const deleted = [...before.keys()].filter(id => !ids.has(id) && !id.includes('_')).map(id => ({ id, status: 'cancelled' }));
        const items = [...visible.filter(event => before.get(event.id) !== JSON.stringify(event)), ...deleted, ...google.changes.splice(0)];
        return json({ items, nextSyncToken: nextSyncToken() });
      }
      const min = Date.parse(params.timeMin);
      const max = Date.parse(params.timeMax);
      return json({ items: visible.filter(event => {
        const start = Date.parse(event.start.dateTime ?? `${event.start.date}T12:00:00-07:00`);
        return start >= min && start < max;
      }), nextSyncToken: nextSyncToken() });
    }
    if (url.pathname === '/v1/people/me/connections') {
      assert.match(url.searchParams.get('personFields'), /names.*phoneNumbers.*birthdays.*relations/);
      const size = google.contactsPageSize ?? +url.searchParams.get('pageSize');
      const offset = Number(url.searchParams.get('pageToken') ?? 0);
      const next = offset + size < google.contacts.length ? String(offset + size) : undefined;
      return json({ connections: google.contacts.slice(offset, offset + size), ...(next ? { nextPageToken: next } : {}) });
    }
    if (url.pathname === '/tasks/v1/users/@me/lists') {
      return json({ items: google.taskLists.map(({ tasks: _tasks, ...list }) => list) });
    }
    const taskList = url.pathname.match(/^\/tasks\/v1\/lists\/([^/]+)\/tasks$/);
    if (taskList) return json({ items: google.taskLists.find(list => list.id === decodeURIComponent(taskList[1]))?.tasks ?? [] });
    if (url.pathname === '/v1/sessions' && method === 'POST') {
      google.pickerSessions++;
      return json({ id: `session-${google.pickerSessions}`, pickerUri: `https://photos.google.com/picker/session-${google.pickerSessions}`,
        pollingConfig: { pollInterval: '5s', timeoutIn: '1800s' }, expireTime: new Date(Date.now() + 3600_000).toISOString(), mediaItemsSet: false });
    }
    const pickerSession = url.pathname.match(/^\/v1\/sessions\/([\w-]+)$/);
    if (pickerSession && method === 'DELETE') return json({});
    if (pickerSession) {
      return json({ id: pickerSession[1], mediaItemsSet: Boolean(google.picked),
        ...(google.picked ? {} : { pollingConfig: { pollInterval: '5s', timeoutIn: '1800s' } }) });
    }
    if (url.pathname === '/v1/mediaItems') return json({ mediaItems: google.picked ?? [] });
    if (url.pathname === '/gmail/v1/users/me/messages') {
      const q = url.searchParams.get('q');
      // Search operators (newer_than:30d, -category:social) scope by date; words must appear.
      // OR groups in braces narrow by category or keyword, which this fake does not model.
      const words = q.replace(/\{[^}]*\}/g, ' ').split(' ').filter(word => word && !word.includes(':'));
      const days = Number(q.match(/newer_than:(\d+)d/)?.[1] ?? Infinity);
      const hits = google.messages.filter(message => Date.now() - Number(message.internalDate) <= days * 86_400_000 &&
        words.every(word => message.body.toLowerCase().split(' ').includes(word)));
      google.lastQuery = q;
      return json({ messages: hits.slice(0, +url.searchParams.get('maxResults')).map(({ id }) => ({ id, threadId: `t${id}` })) });
    }
    const message = url.pathname.match(/^\/gmail\/v1\/users\/me\/messages\/(\w+)$/);
    if (message) {
      if (url.searchParams.get('format') === 'full') google.fullFetches.push(message[1]);
      else assert.deepEqual(url.searchParams.getAll('metadataHeaders'), ['From', 'Subject', 'Date']);
      const found = google.messages.find(({ id }) => id === message[1]);
      return json({ ...found, threadId: `t${found.id}` });
    }
    return json({ error: { status: 'NOT_FOUND' } }, 404);
  };
  return google;
}

async function fixture(t, overrides = {}, options = {}) {
  const store = await testStore(t);
  const remote = fakeGoogle();
  const google = createGoogle({ config: { ...config, ...overrides }, store, fetch: remote.fetch, log: quietLog, ...options });
  const server = createApp({ ...config, ...overrides }, store, undefined, { google }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  return { store, remote, google, url: `http://127.0.0.1:${server.address().port}` };
}

async function connectGoogle(url, store, remote) {
  const begin = await fetch(`${url}/google/connect`, { method: 'POST', headers: admin });
  assert.equal(begin.status, 200);
  const authorizationUrl = new URL((await begin.json()).authorizationUrl);
  const state = authorizationUrl.searchParams.get('state');
  const callback = await fetch(`${url}/google/callback?code=auth-code&state=${state}`);
  return { authorizationUrl, state, callback };
}

async function mcp(t, url) {
  const client = new Client({ name: 'google-check', version: '0.1.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
    requestInit: { headers: {
      Authorization: `Bearer ${config.DIAL_MCP_TOKEN}`,
      'X-Dial-User-Number': config.DEMO_CALLER_NUMBER, 'X-Dial-Direction': 'inbound',
    } },
  }));
  t.after(() => client.close());
  return client;
}

test('time helpers honour the user zone across daylight-saving changes', () => {
  assert.equal(startOfDay('2026-03-08', ZONE).toISOString(), '2026-03-08T08:00:00.000Z');
  assert.equal(startOfDay('2026-03-09', ZONE).toISOString(), '2026-03-09T07:00:00.000Z');
  assert.equal(startOfDay('2026-11-01', ZONE).toISOString(), '2026-11-01T07:00:00.000Z');
  assert.equal(localDate('2026-10-12T06:30:00Z', ZONE), '2026-10-11');
  // Chile springs forward at midnight: the day starts at 01:00 local.
  const santiago = startOfDay('2026-09-06', 'America/Santiago');
  assert.equal(localDate(santiago, 'America/Santiago'), '2026-09-06');
  assert.equal(localDate(santiago.getTime() - 1, 'America/Santiago'), '2026-09-05');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
});

test('Google configuration is all-or-nothing and redirect URIs are safe', () => {
  const base = { DIAL_MCP_TOKEN: 'd'.repeat(64), CAMERA_TOKEN: 'c'.repeat(64), DATABASE_URL: TEST_DATABASE_URL };
  assert.equal(readConfig(base).GOOGLE_CLIENT_ID, undefined);
  assert.equal(readConfig({ ...base, ADMIN_TOKEN: '', TIMEZONE: '' }).TIMEZONE, undefined);
  assert.throws(() => readConfig({ ...base, GOOGLE_CLIENT_ID: 'x' }), /GOOGLE_CLIENT_SECRET/);
  const full = {
    ...base, ADMIN_TOKEN: 'a'.repeat(64), GOOGLE_CLIENT_ID: 'x', GOOGLE_CLIENT_SECRET: 'y',
    GOOGLE_TOKEN_KEY: 'f'.repeat(64), GOOGLE_REDIRECT_URI: 'https://memory.example.com/google/callback',
  };
  assert.equal(readConfig(full).GOOGLE_SYNC_MINUTES, 10);
  assert.throws(() => readConfig({ ...full, GOOGLE_REDIRECT_URI: 'http://memory.example.com/google/callback' }), /HTTPS/);
  assert.throws(() => readConfig({ ...full, GOOGLE_REDIRECT_URI: 'https://memory.example.com/oauth' }), /\/google\/callback/);
  assert.throws(() => readConfig({ ...full, ADMIN_TOKEN: full.DIAL_MCP_TOKEN }), /separate/);
  assert.throws(() => readConfig({ ...base, TIMEZONE: 'Mars/Olympus' }));
});

test('Google tables initialize idempotently and keep the connection across reopening', async t => {
  const store = await testStore(t);
  await store.put({ id: 'kept', source: 'camera', object: 'keys', location: 'desk', timestamp: '2026-01-01T00:00:00Z', text: 'x' });
  const remote = fakeGoogle();
  const google = createGoogle({ config, store, fetch: remote.fetch, log: quietLog });
  await store.saveGoogleConnection({ scope: SCOPES.calendar, refreshToken: 'sealed', email: 'me@example.com',
    generation: (await store.googleSnapshot()).generation });
  const reopened = store.reopen();
  t.after(() => reopened.close());
  assert.equal((await reopened.googleConnection()).email, 'me@example.com');
  assert.equal((await reopened.list('camera'))[0].location, 'desk');
  assert.deepEqual(await reopened.countByOrigin(), { local: 1 });
  assert.equal(await google.can('calendar'), true);
});

test('Google routes require the admin secret and report when unconfigured', async t => {
  const { url } = await fixture(t);
  assert.equal((await fetch(`${url}/google/status`)).status, 401);
  assert.equal((await fetch(`${url}/google/connect`, { method: 'POST',
    headers: { Authorization: `Bearer ${config.DIAL_MCP_TOKEN}` } })).status, 401);
  assert.equal((await fetch(`${url}/google/status`, { headers: admin })).status, 200);
  const off = await fixture(t, { GOOGLE_CLIENT_ID: undefined });
  assert.equal((await fetch(`${off.url}/google/status`, { headers: admin })).status, 503);
});

test('OAuth connect uses PKCE and single-use state, and encrypts the refresh token', async t => {
  const { url, store, remote } = await fixture(t);
  const forged = await fetch(`${url}/google/callback?code=x&state=forged`);
  assert.equal(forged.status, 400);
  assert.equal(forged.headers.get('content-security-policy'), "default-src 'none'");
  const { authorizationUrl, state, callback } = await connectGoogle(url, store, remote);
  assert.equal(callback.status, 200);
  assert.equal(authorizationUrl.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(authorizationUrl.searchParams.get('access_type'), 'offline');
  assert.equal(authorizationUrl.searchParams.get('scope'), CONSENT_SCOPES);
  assert.ok(remote.lastTokenRequest.get('code_verifier')?.length >= 43);
  const row = await store.googleConnection();
  assert.equal(row.email, 'me@example.com');
  assert.equal(row.timezone, ZONE);
  assert.ok(!row.refresh_token.includes('refresh-secret-value'));
  assert.equal((await fetch(`${url}/google/callback?code=auth-code&state=${state}`)).status, 400);
  assert.equal((await fetch(`${url}/google/callback?error=access_denied`)).status, 400);
});

test('calendar sync stores zone-correct events with provenance and drops cancelled ones', async t => {
  const { url, google, remote, store } = await fixture(t);
  await connectGoogle(url, store, remote);
  remote.events = [
    { id: 'late', status: 'confirmed', summary: 'Dinner with Sarah', location: 'Home', htmlLink: 'https://calendar.google.com/e/late',
      start: { dateTime: `${today}T23:30:00-07:00` }, end: { dateTime: `${addDays(today, 1)}T00:30:00-07:00` } },
    { id: 'trip', status: 'confirmed', summary: 'Trip', start: { date: addDays(today, 2) }, end: { date: addDays(today, 5) } },
    { id: 'gone', status: 'cancelled', summary: 'Cancelled', start: { dateTime: `${today}T09:00:00-07:00` }, end: { dateTime: `${today}T10:00:00-07:00` } },
  ];
  const [result] = await google.syncAll();
  assert.equal(result.ok, true);
  const client = await mcp(t, url);
  const schedule = async date => (await client.callTool({ name: 'get_schedule', arguments: { date } })).structuredContent;
  const todayPlans = await schedule(today);
  assert.equal(todayPlans.status, 'supported');
  assert.deepEqual(todayPlans.evidence.map(item => item.title), ['Dinner with Sarah']);
  assert.equal(todayPlans.evidence[0].ref, 'https://calendar.google.com/e/late');
  assert.equal(todayPlans.evidence[0].demo, false);
  assert.match(todayPlans.evidence[0].text, /Dinner with Sarah" from \w+day, .* at \d{1,2}:30 PM to \w+day, .* at \d{1,2}:30 AM at Home\./);
  assert.deepEqual((await schedule(addDays(today, 4))).evidence.map(item => item.title), ['Trip']);
  assert.equal((await schedule(addDays(today, 5))).status, 'unknown');
  const tools = await client.listTools();
  assert.match(tools.tools.find(tool => tool.name === 'get_schedule').description, new RegExp(`Today is ${today}`));

  remote.events = remote.events.filter(event => event.id !== 'late');
  await google.syncAll();
  assert.equal((await schedule(today)).status, 'unknown');
});

test('dates outside the synced window are fetched live, and failures are errors not "no plans"', async t => {
  const { url, google, remote, store } = await fixture(t);
  await connectGoogle(url, store, remote);
  await google.syncAll();
  const far = addDays(today, 120);
  remote.events = [{ id: 'far', status: 'confirmed', summary: 'Dentist',
    start: { dateTime: `${far}T10:00:00-07:00` }, end: { dateTime: `${far}T11:00:00-07:00` } }];
  const client = await mcp(t, url);
  const found = await client.callTool({ name: 'get_schedule', arguments: { date: far } });
  assert.equal(found.structuredContent.evidence[0].title, 'Dentist');
  remote.failCalendar = true;
  const failed = await client.callTool({ name: 'get_schedule', arguments: { date: addDays(today, 200) } });
  assert.equal(failed.isError, true);
  assert.match(failed.content[0].text, /Calendar is unavailable.*not evidence that nothing happened/);
  const sync = await google.syncCalendar();
  assert.equal(sync.ok, false);
  assert.match((await google.status()).sync.find(state => state.name === 'google-calendar').last_error, /503 backendError/);
});

test('email search ranks synced mail and falls back to live Gmail search', async t => {
  const { url, google, remote, store } = await fixture(t);
  await connectGoogle(url, store, remote);
  remote.messages = [
    { id: 'm1', internalDate: String(Date.parse(`${today}T15:00:00Z`)), snippet: 'I&#39;ll bring lasagna &amp; salad',
      body: 'dinner lasagna salad', payload: { headers: [{ name: 'From', value: '"Sarah Lee" <sarah@example.com>' }, { name: 'Subject', value: 'Dinner' }] } },
  ];
  await google.syncAll();
  const client = await mcp(t, url);
  const search = async query => (await client.callTool({ name: 'search_messages', arguments: { query } })).structuredContent;
  const local = await search("What did Sarah's email say about dinner?");
  assert.equal(local.evidence[0].from, 'Sarah Lee');
  assert.match(local.evidence[0].text, /I'll bring lasagna & salad/);
  assert.equal(local.evidence[0].ref, 'https://mail.google.com/mail/u/0/#all/tm1');

  remote.messages.push({ id: 'm2', internalDate: String(Date.now() - 20 * 86_400_000), snippet: 'See attached',
    body: 'passport renewal form', payload: { headers: [{ name: 'From', value: 'records@example.gov' }, { name: 'Subject', value: 'Forms' }] } });
  const live = await search('passport renewal');
  assert.equal(live.evidence[0].id, 'gmail:m2');
  assert.equal(remote.lastQuery, `passport renewal ${config.GMAIL_SYNC_QUERY}`);
  remote.messages.push({ id: 'm3', internalDate: String(Date.parse('2024-01-01T00:00:00Z')), snippet: 'Old tax return',
    body: 'tax return 2023', payload: { headers: [{ name: 'From', value: 'irs@example.gov' }] } });
  assert.equal((await search('tax return')).status, 'unknown', 'mail outside the configured window stays out of reach');
  assert.equal((await search('the')).status, 'unknown');
});

test('revoked refresh tokens flag reconnection; disconnect revokes and purges Google evidence', async t => {
  const { url, google, remote, store } = await fixture(t);
  await connectGoogle(url, store, remote);
  remote.events = [{ id: 'e', status: 'confirmed', summary: 'Walk',
    start: { dateTime: `${today}T10:00:00-07:00` }, end: { dateTime: `${today}T11:00:00-07:00` } }];
  await google.syncAll();
  assert.equal((await store.countByOrigin())['google-calendar'], 1);

  const fresh = createGoogle({ config, store, fetch: remote.fetch, log: quietLog });
  remote.refreshValid = false;
  const [failed] = await fresh.syncAll();
  assert.equal(failed.ok, false);
  assert.equal((await fresh.status()).connection.status, 'reconnect_required');
  assert.equal(await fresh.can('calendar'), false);

  const response = await fetch(`${url}/google/connection`, { method: 'DELETE', headers: admin });
  assert.equal(response.status, 200);
  assert.deepEqual(remote.revoked, ['refresh-secret-value']);
  assert.equal(await store.googleConnection(), undefined);
  assert.equal((await store.countByOrigin())['google-calendar'], undefined);
});

test('evidence carries sender addresses and unanswered invitations, and search ignores boilerplate', async t => {
  const { url, google, remote, store } = await fixture(t);
  await connectGoogle(url, store, remote);
  remote.events = [{ id: 'inv', status: 'confirmed', summary: 'Team lunch',
    attendees: [{ email: 'me@example.com', self: true, responseStatus: 'needsAction' }],
    start: { dateTime: `${today}T12:00:00-07:00` }, end: { dateTime: `${today}T13:00:00-07:00` } }];
  remote.messages = [{ id: 'm1', internalDate: String(Date.parse(`${today}T15:00:00Z`)), snippet: 'Your account is locked',
    body: 'account locked', payload: { headers: [{ name: 'From', value: '"Your Bank" <alerts@phish.example>' }, { name: 'Subject', value: 'Urgent' }] } }];
  await google.syncAll();
  const client = await mcp(t, url);
  const [lunch] = (await client.callTool({ name: 'get_schedule', arguments: { date: today } })).structuredContent.evidence;
  assert.match(lunch.text, /has not answered/);
  const search = async query => (await client.callTool({ name: 'search_messages', arguments: { query } })).structuredContent;
  const [bank] = (await search('bank account')).evidence;
  assert.match(bank.text, /Your Bank <alerts@phish\.example>/);
  assert.equal(bank.fromAddress, 'alerts@phish.example');
  // Words that only appear in generated text (weekday, month) or as substrings do not match.
  const month = new Intl.DateTimeFormat('en-US', { month: 'long', timeZone: ZONE }).format(new Date()).toLowerCase();
  assert.equal((await search(month)).status, 'unknown');
  assert.equal((await search('count')).status, 'unknown');
  assert.equal((await search('lock')).status, 'supported', 'four-letter prefixes still match ("locked")');
});

test('unreadable Google responses, expired access and narrower consent never fake an answer', async t => {
  const { url, google, remote, store } = await fixture(t);
  await connectGoogle(url, store, remote);
  remote.events = [{ id: 'walk', status: 'confirmed', summary: 'Walk',
    start: { dateTime: `${today}T10:00:00-07:00` }, end: { dateTime: `${today}T11:00:00-07:00` } }];
  await google.syncAll();
  const realFetch = remote.fetch;
  const broken = async (input, init) => new URL(input).pathname.endsWith('/events')
    ? new Response('<html>proxy error</html>', { status: 200 }) : realFetch(input, init);
  const flaky = createGoogle({ config, store, fetch: broken, log: quietLog });
  assert.equal((await flaky.syncCalendar()).ok, false);
  assert.equal((await store.countByOrigin())['google-calendar'], 1, 'a garbled 200 must not wipe the synced copy');

  await store.markGoogleReconnectRequired((await store.googleSnapshot()).generation);
  const client = await mcp(t, url);
  const far = await client.callTool({ name: 'get_schedule', arguments: { date: addDays(today, 3) } });
  assert.equal(far.isError, true);
  const known = await client.callTool({ name: 'get_schedule', arguments: { date: today } });
  assert.equal(known.structuredContent.evidence[0].title, 'Walk');
  assert.equal((await client.callTool({ name: 'search_messages', arguments: { query: 'passport' } })).isError, true);

  remote.grantedScope = SCOPES.calendar;
  await store.upsertOrigin('google-gmail', [{ id: 'gmail:old', source: 'email', origin: 'google-gmail', timestamp: new Date().toISOString(), text: 'old', snippet: 'old', demo: false }], (await store.googleSnapshot()).generation);
  await connectGoogle(url, store, remote);
  assert.equal((await store.countByOrigin())['google-gmail'], undefined);
});

test('a changed token key or an in-flight sync cannot block or undo a disconnect', async t => {
  const { url, remote, store } = await fixture(t);
  await connectGoogle(url, store, remote);
  const oldGeneration = (await store.googleSnapshot()).generation;
  const rekeyed = createGoogle({ config: { ...config, GOOGLE_TOKEN_KEY: 'e'.repeat(64) }, store, fetch: remote.fetch, log: quietLog });
  assert.equal((await rekeyed.syncCalendar()).ok, false);
  assert.equal((await rekeyed.status()).connection.status, 'reconnect_required');
  await rekeyed.disconnect();
  assert.equal(await store.googleConnection(), undefined);
  // A sync that finishes after the disconnect writes nothing.
  await store.replaceOrigin('google-calendar', [{ id: 'gcal:late', source: 'calendar', timestamp: new Date().toISOString(), date: today, text: 'late' }], oldGeneration);
  assert.equal((await store.countByOrigin())['google-calendar'], undefined);
});

test('a live single-day lookup drops events cancelled upstream', async t => {
  const { url, google, remote, store } = await fixture(t);
  await connectGoogle(url, store, remote);
  const far = addDays(today, 120);
  remote.events = [{ id: 'far', status: 'confirmed', summary: 'Dentist',
    start: { dateTime: `${far}T10:00:00-07:00` }, end: { dateTime: `${far}T11:00:00-07:00` } }];
  await google.fetchDay(far);
  remote.events = [];
  await google.fetchDay(far);
  assert.equal((await store.list('calendar')).length, 0);
});

test('a stale mail copy asks Gmail first, within the request', async t => {
  const { url, google, remote, store } = await fixture(t);
  await connectGoogle(url, store, remote);
  remote.messages = [{ id: 'old', internalDate: String(Date.now() - 86_400_000), snippet: 'Dinner at six',
    body: 'dinner six', payload: { headers: [{ name: 'From', value: 'Sarah <s@example.com>' }] } }];
  await google.syncAll();
  remote.messages.push({ id: 'new', internalDate: String(Date.now()), snippet: 'Dinner moved to seven',
    body: 'dinner seven', payload: { headers: [{ name: 'From', value: 'Sarah <s@example.com>' }] } });
  const client = await mcp(t, url);
  const search = async () => (await client.callTool({ name: 'search_messages', arguments: { query: 'dinner' } })).structuredContent;
  assert.deepEqual((await search()).evidence.map(item => item.id), ['gmail:old'], 'a fresh copy answers locally');
  const age = store.adapter === 'sqlite'
    ? ["UPDATE sync_state SET last_success = ? WHERE name = 'google-gmail'", [new Date(Date.now() - 3_600_000).toISOString()]]
    : ["UPDATE sync_state SET last_success = now() - interval '1 hour' WHERE name = 'google-gmail'", []];
  await store.sql(...age);
  assert.equal(await google.mailFresh(), false);
  assert.ok((await search()).evidence.some(item => item.id === 'gmail:new'), 'a stale copy asks Gmail');
});

test('consent with only calendar access keeps Gmail tools on local evidence', async t => {
  const { url, google, remote, store } = await fixture(t);
  remote.grantedScope = SCOPES.calendar;
  await connectGoogle(url, store, remote);
  assert.equal(await google.can('calendar'), true);
  assert.equal(await google.can('gmail'), false);
  const results = await google.syncAll();
  assert.deepEqual(results.map(result => result.name), ['google-calendar']);
});

test('setup appends only missing secrets to an existing .env', () => {
  const dir = mkdtempSync(join(tmpdir(), 'speedhacks-setup-'));
  try {
    writeFileSync(join(dir, '.env'), 'DIAL_MCP_TOKEN=keep\nCAMERA_TOKEN=keep2');
    execFileSync(process.execPath, [join(import.meta.dirname, '../../scripts/setup.mjs')], { cwd: dir });
    const env = readFileSync(join(dir, '.env'), 'utf8');
    assert.match(env, /^DIAL_MCP_TOKEN=keep\nCAMERA_TOKEN=keep2\nADMIN_TOKEN=[0-9a-f]{64}\nGOOGLE_TOKEN_KEY=[0-9a-f]{64}\nCRON_SECRET=[0-9a-f]{64}\nRECALL_APP_TOKEN=[0-9a-f]{64}\n$/);
    execFileSync(process.execPath, [join(import.meta.dirname, '../../scripts/setup.mjs')], { cwd: dir });
    assert.equal(readFileSync(join(dir, '.env'), 'utf8'), env);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a database without the new tables keeps serving while Google, PIN and webhooks are off', {
  skip: !process.env.TEST_DATABASE_URL,
}, async t => {
  const store = await testStore(t);
  // As on an environment that has not run `npm run db:init` since these tables were added.
  await store.sql('DROP TABLE google_connection, google_generation, oauth_state, sync_state, dial_event, caller_pin_failure');
  const off = { ...config, GOOGLE_CLIENT_ID: undefined, CRON_SECRET: 'r'.repeat(64), DEMO_MODE: 'true' };
  await store.put({ id: 'demo-calendar', source: 'calendar', date: today, text: 'DEMO plan', timestamp: new Date().toISOString(), demo: true });
  const server = createApp(off, store, undefined, { google: createGoogle({ config: off, store }) }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const client = await mcp(t, url);
  const plans = await client.callTool({ name: 'get_schedule', arguments: { date: today } });
  assert.equal(plans.structuredContent.status, 'supported');
  assert.equal((await client.callTool({ name: 'search_messages', arguments: { query: 'dinner' } })).isError, undefined);
  const cron = await fetch(`${url}/cron/google-sync`, { headers: { Authorization: `Bearer ${off.CRON_SECRET}` } });
  assert.equal(cron.status, 200);
});


// Pause a real adapter response at a deterministic boundary; no clocks or network sleeps.
function heldFetch(fetch, matches) {
  let arrive;
  let release;
  let enabled = false;
  const reached = new Promise(resolve => { arrive = resolve; });
  const resumed = new Promise(resolve => { release = resolve; });
  return {
    reached, release, enable() { enabled = true; },
    async fetch(input, init) {
      const response = await fetch(input, init);
      if (enabled && matches(new URL(input), init)) {
        enabled = false;
        arrive();
        await resumed;
      }
      return response;
    },
  };
}

async function authorize(google) {
  const url = new URL(await google.beginConnect());
  return google.completeConnect('auth-code', url.searchParams.get('state'));
}

function calendarEvent(id, date = today, account) {
  return { id, account, summary: id, status: 'confirmed',
    start: { dateTime: `${date}T10:00:00-07:00` }, end: { dateTime: `${date}T11:00:00-07:00` } };
}

function passportMessage() {
  return { id: 'passport', internalDate: String(Date.now()), snippet: 'passport renewal', body: 'passport renewal',
    payload: { headers: [{ name: 'From', value: 'records@example.com' }] } };
}

test('midnight end descriptions use the next date while day coverage stays exclusive', () => {
  const record = eventRecord({ id: 'trip', summary: 'Trip',
    start: { dateTime: '2026-10-11T10:00:00-07:00' }, end: { dateTime: '2026-10-13T00:00:00-07:00' } }, 'primary', ZONE);
  assert.equal(record.endDate, '2026-10-12');
  assert.equal(record.end, '2026-10-13T07:00:00.000Z');
  assert.match(record.text, /to Tuesday, October 13, 2026 at 12:00 AM/);
});

test('generation migration preserves legacy connections and evidence and is idempotent', async t => {
  const store = await testStore(t);
  await store.saveGoogleConnection({ scope: SCOPES.calendar, refreshToken: 'legacy-sealed', email: 'legacy@example.com',
    generation: (await store.googleSnapshot()).generation });
  await store.upsertOrigin('google-calendar', [eventRecord(calendarEvent('kept'), 'primary', ZONE)],
    (await store.googleSnapshot()).generation);
  await store.sql('DROP TABLE google_generation');
  if (store.adapter === 'postgres') await store.sql(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  const reopened = store.reopen();
  t.after(() => reopened.close());
  assert.equal((await reopened.googleConnection()).email, 'legacy@example.com');
  assert.equal((await reopened.list('calendar'))[0].title, 'kept');
  assert.equal((await reopened.googleSnapshot()).generation, '0');
  if (store.adapter === 'postgres') await store.sql(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  const twice = store.reopen();
  t.after(() => twice.close());
  assert.equal((await twice.googleSnapshot()).generation, '0');
});

test('reconnect clears the old copy and warm workers refresh credentials for the new account', async t => {
  const { google, remote, store } = await fixture(t);
  await authorize(google);
  remote.events = [calendarEvent('first-account', today, 'me@example.com'), calendarEvent('second-account', today, 'second@example.com')];
  await google.syncCalendar();
  const other = createGoogle({ config, store, fetch: remote.fetch, log: quietLog });
  remote.account = 'second@example.com';
  await authorize(other);
  assert.deepEqual(await store.list('calendar'), []);
  assert.equal(await other.covers(today), false);
  assert.equal(await other.mailFresh(), false);
  assert.equal((await google.syncCalendar()).ok, true);
  assert.equal((await store.googleConnection()).email, 'second@example.com');
  assert.deepEqual((await store.list('calendar')).map(item => item.title), ['second-account']);
});

test('narrower consent fences an in-flight sync and both success and error metadata', async t => {
  const { google, remote, store } = await fixture(t);
  await authorize(google);
  remote.events = [calendarEvent('withdrawn-calendar')];
  const held = heldFetch(remote.fetch, url => url.pathname.endsWith('/events'));
  const oldWorker = createGoogle({ config, store, fetch: held.fetch, log: quietLog });
  held.enable();
  const pending = oldWorker.syncCalendar();
  await held.reached;
  remote.grantedScope = SCOPES.gmail;
  await authorize(google);
  const currentGeneration = (await store.googleSnapshot()).generation;
  held.release();
  assert.equal((await pending).ok, false);
  assert.equal(await google.can('calendar'), false);
  assert.deepEqual(await store.list('calendar'), []);
  assert.deepEqual(await store.syncState('google-calendar'), []);
  assert.equal((await getSchedule(store, today, google)).status, 'unknown');
  assert.equal(await store.replaceOrigin('google-calendar', [], currentGeneration), false, 'generation alone cannot grant a withdrawn scope');
  assert.equal(await store.recordSync('google-calendar', { error: 'late' }, currentGeneration), false);
});

test('disconnect fences live responses and cached fallbacks, then reconnect cannot revive them', async t => {
  for (const source of ['calendar', 'gmail']) await t.test(source, async t => {
    const { google, remote, store } = await fixture(t);
    await authorize(google);
    remote.events = [calendarEvent('private-calendar')];
    remote.messages = [passportMessage()];
    if (source === 'gmail') await google.syncEmail();
    const held = heldFetch(remote.fetch, url => source === 'calendar' ? url.pathname.endsWith('/events') : url.pathname.endsWith('/messages/passport'));
    const oldWorker = createGoogle({ config, store, fetch: held.fetch, log: quietLog });
    // Force live mail lookup while retaining a local match, exercising the error fallback too.
    oldWorker.mailFresh = async () => false;
    held.enable();
    const pending = source === 'calendar' ? getSchedule(store, today, oldWorker) : searchMessages(store, 'passport', oldWorker);
    const rejected = assert.rejects(pending, /Google connection changed/);
    await held.reached;
    await google.disconnect();
    await authorize(google);
    held.release();
    await rejected;
    assert.deepEqual(await store.list(source === 'calendar' ? 'calendar' : 'email'), []);
    assert.deepEqual(await store.syncState(), []);
  });
});

test('a cached answer read before disconnect is not returned after disconnect', async t => {
  const { google, remote, store } = await fixture(t);
  await authorize(google);
  remote.messages = [passportMessage()];
  await google.syncEmail();
  let arrive, release;
  const reached = new Promise(resolve => { arrive = resolve; });
  const resumed = new Promise(resolve => { release = resolve; });
  const readingStore = { ...store, async list(source) {
    const rows = await store.list(source);
    arrive();
    await resumed;
    return rows;
  } };
  const pending = searchMessages(readingStore, 'passport', google);
  const rejected = assert.rejects(pending, /Google connection changed/);
  await reached;
  await google.disconnect();
  release();
  await rejected;
});

test('an old invalid refresh response cannot mark the new connection expired or write sync errors', async t => {
  const { google, remote, store } = await fixture(t);
  await authorize(google);
  const held = heldFetch(remote.fetch, url => url.pathname === '/token');
  const oldWorker = createGoogle({ config, store, fetch: held.fetch, log: quietLog });
  remote.refreshValid = false;
  held.enable();
  const pending = oldWorker.syncCalendar();
  await held.reached;
  remote.refreshValid = true;
  await authorize(google);
  held.release();
  assert.equal((await pending).ok, false);
  assert.equal((await store.googleConnection()).status, 'connected');
  assert.deepEqual(await store.syncState(), []);
});

test('a pending OAuth callback cannot undo a disconnect or overwrite a newer connection', async t => {
  for (const change of ['disconnect', 'reconnect']) await t.test(change, async t => {
    const { google, remote, store } = await fixture(t);
    const held = heldFetch(remote.fetch, url => url.pathname.endsWith('/primary'));
    const oldWorker = createGoogle({ config, store, fetch: held.fetch, log: quietLog });
    held.enable();
    const pending = authorize(oldWorker);
    const rejected = assert.rejects(pending, /Google connection changed/);
    await held.reached;
    if (change === 'disconnect') await google.disconnect();
    else {
      remote.account = 'newer@example.com';
      await authorize(google);
    }
    held.release();
    await rejected;
    assert.equal((await store.googleConnection())?.email, change === 'disconnect' ? undefined : 'newer@example.com');
    assert.deepEqual(await store.syncState(), []);
  });
});

test('a cut emoji or NUL in Google text cannot fail the sync batch', async t => {
  const { url, google, remote, store } = await fixture(t);
  await connectGoogle(url, store, remote);
  const nasty = `${'a'.repeat(198)}😀 and more`;
  remote.events = [{ id: 'e1', status: 'confirmed', summary: nasty, location: 'Room\u00001',
    start: { dateTime: `${today}T10:00:00-07:00` }, end: { dateTime: `${today}T11:00:00-07:00` } }];
  remote.messages = [
    { id: 'm1', internalDate: String(Date.now()), snippet: 'ok', body: 'ok',
      payload: { headers: [{ name: 'From', value: 'a@example.com' }, { name: 'Subject', value: nasty }] } },
    { id: 'm2', internalDate: String(Date.now()), snippet: 'nul\u0000here', body: 'nul',
      payload: { headers: [{ name: 'From', value: 'b@example.com' }, { name: 'Subject', value: 'fine' }] } },
  ];
  const results = await google.syncAll();
  assert.deepEqual(results.map(result => result.ok), [true, true, true, true]);
  const counts = await store.countByOrigin();
  assert.equal(counts['google-calendar'], 1);
  assert.equal(counts['google-gmail'], 2);
  const [event] = await store.list('calendar');
  assert.ok(event.title.isWellFormed() && event.title.endsWith('…'));
  assert.ok(!JSON.stringify(await store.list('email')).includes('\\u0000'));
});

test('a cached access token is dropped when another instance reconnects the account', async t => {
  const { url, store, remote } = await fixture(t);
  await connectGoogle(url, store, remote);
  const other = createGoogle({ config, store, fetch: remote.fetch, log: quietLog });
  await other.fetchDay(addDays(today, 120));
  const refreshes = () => remote.calls.filter(call => call === 'POST oauth2.googleapis.com/token').length;
  const before = refreshes();
  await other.fetchDay(addDays(today, 121));
  assert.equal(refreshes(), before, 'the cached token is reused while the connection is unchanged');
  await connectGoogle(url, store, remote);
  const afterReconnect = refreshes();
  await other.fetchDay(addDays(today, 122));
  assert.equal(refreshes(), afterReconnect + 1, 'a new stored refresh token invalidates the old cache');
  await store.deleteGoogleConnection();
  await assert.rejects(other.fetchDay(addDays(today, 123)), /not connected/);
});

test('on Vercel, Google or Dial webhooks require CRON_SECRET', () => {
  const base = { DIAL_MCP_TOKEN: 'd'.repeat(64), CAMERA_TOKEN: 'c'.repeat(64), VERCEL: '1', DATABASE_URL: TEST_DATABASE_URL };
  assert.throws(() => readConfig({ ...base, DIAL_WEBHOOK_SECRET: 'w'.repeat(32) }), /CRON_SECRET/);
  const google = { ADMIN_TOKEN: 'a'.repeat(64), GOOGLE_CLIENT_ID: 'x', GOOGLE_CLIENT_SECRET: 'y',
    GOOGLE_TOKEN_KEY: 'f'.repeat(64), GOOGLE_REDIRECT_URI: 'https://memory.example.com/google/callback' };
  assert.throws(() => readConfig({ ...base, ...google }), /CRON_SECRET/);
  assert.equal(readConfig({ ...base, ...google, CRON_SECRET: 'r'.repeat(64) }).CRON_SECRET, 'r'.repeat(64));
  assert.equal(readConfig({ ...base, VERCEL: undefined, DIAL_WEBHOOK_SECRET: 'w'.repeat(32) }).CRON_SECRET, undefined);
});

test('Google endpoints can point at a local same-URL mock such as a Sparta World, and only locally', async t => {
  const base = { DIAL_MCP_TOKEN: 'd'.repeat(64), CAMERA_TOKEN: 'c'.repeat(64) };
  assert.throws(() => readConfig({ ...base, GOOGLE_API_BASE_URL: 'https://evil.example.com' }), /localhost/);
  assert.throws(() => readConfig({ ...base, GOOGLE_OAUTH_BASE_URL: 'http://10.0.0.5:8080' }), /localhost/);
  assert.throws(() => readConfig({ ...base, VERCEL: '1', DATABASE_URL: TEST_DATABASE_URL,
    GOOGLE_API_BASE_URL: 'http://127.0.0.1:8080' }), /not allowed on Vercel/);
  assert.equal(readConfig({ ...base, GOOGLE_API_BASE_URL: 'http://[::1]:8080' }).GOOGLE_API_BASE_URL, 'http://[::1]:8080');

  const store = await testStore(t);
  const seen = [];
  const world = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://world');
    seen.push(`${req.method} ${url.pathname}`);
    for await (const _chunk of req);
    const json = (body, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (url.pathname === '/token') {
      return json({ access_token: 'world-access', expires_in: 3600, refresh_token: 'world-refresh', scope: Object.values(SCOPES).join(' ') });
    }
    if (url.pathname === '/calendar/v3/calendars/primary') return json({ id: 'world@example.com', timeZone: ZONE });
    if (url.pathname === '/calendar/v3/calendars/primary/events') {
      return json({ items: [{ id: 'w1', status: 'confirmed', summary: 'World lunch',
        start: { dateTime: `${today}T12:00:00-07:00` }, end: { dateTime: `${today}T13:00:00-07:00` } }] });
    }
    if (url.pathname === '/gmail/v1/users/me/messages') return json({ messages: [{ id: 'g1', threadId: 't1' }] });
    if (url.pathname === '/v1/people/me/connections') return json({ connections: [] });
    if (url.pathname === '/tasks/v1/users/@me/lists') return json({ items: [] });
    if (url.pathname === '/gmail/v1/users/me/messages/g1') {
      return json({ id: 'g1', threadId: 't1', internalDate: String(Date.now()), snippet: 'Hello from the world',
        payload: { headers: [{ name: 'From', value: 'World <w@example.com>' }, { name: 'Subject', value: 'Hi' }] } });
    }
    json({ error: { status: 'NOT_FOUND' } }, 404);
  }).listen(0, '127.0.0.1');
  await once(world, 'listening');
  t.after(() => new Promise(resolve => world.close(resolve)));
  const origin = `http://127.0.0.1:${world.address().port}`;
  const local = { ...config, GOOGLE_API_BASE_URL: origin, GOOGLE_OAUTH_BASE_URL: origin };
  // Real network calls through global fetch, as against a running Sparta World.
  const google = createGoogle({ config: local, store, log: quietLog });
  const consent = new URL(await google.beginConnect());
  assert.equal(consent.origin, origin);
  assert.deepEqual(await google.completeConnect('code', consent.searchParams.get('state')),
    { email: 'world@example.com', scopes: Object.values(SCOPES) });
  assert.deepEqual((await google.syncAll()).map(result => result.ok), [true, true, true, true]);
  assert.deepEqual(await store.countByOrigin(), { 'google-calendar': 1, 'google-gmail': 1 });
  assert.ok(['POST /token', 'GET /calendar/v3/calendars/primary/events', 'GET /gmail/v1/users/me/messages/g1']
    .every(call => seen.includes(call)));
});


test('loopback Google endpoints cannot redirect credentials or authenticated requests', async t => {
  const store = await testStore(t);
  let forwarded = 0;
  const receiver = createServer(async (req, res) => {
    forwarded++;
    for await (const _chunk of req);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{}');
  }).listen(0, '127.0.0.1');
  await once(receiver, 'listening');
  const destination = `http://127.0.0.1:${receiver.address().port}/forwarded`;
  let redirectPath = '/token';
  let scope = Object.values(SCOPES).join(' ');
  const world = createServer(async (req, res) => {
    const path = new URL(req.url, 'http://world').pathname;
    for await (const _chunk of req);
    if (path === redirectPath) {
      // 307 preserves POST bodies, including the OAuth client secret and refresh token.
      res.writeHead(307, { Location: destination });
      return res.end();
    }
    const json = body => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (path === '/token') return json({ access_token: 'local-access', refresh_token: 'local-refresh', expires_in: 3600, scope });
    if (path === '/calendar/v3/calendars/primary') return json({ id: 'local@example.com', timeZone: ZONE });
    if (path === '/gmail/v1/users/me/profile') return json({ emailAddress: 'local@example.com' });
    if (path.endsWith('/events')) return json({ items: [] });
    if (path.endsWith('/messages')) return json({ messages: [] });
    json({});
  }).listen(0, '127.0.0.1');
  await once(world, 'listening');
  t.after(async () => {
    world.closeAllConnections();
    receiver.closeAllConnections();
    await Promise.all([new Promise(resolve => world.close(resolve)), new Promise(resolve => receiver.close(resolve))]);
  });
  const origin = `http://127.0.0.1:${world.address().port}`;
  const local = readConfig({ ...config, GOOGLE_API_BASE_URL: origin, GOOGLE_OAUTH_BASE_URL: origin });
  const google = createGoogle({ config: local, store, log: quietLog });
  await assert.rejects(authorize(google), /fetch failed/);
  assert.equal(await store.googleConnection(), undefined);
  assert.equal(forwarded, 0, 'authorization-code POST must not follow a 307');

  // Each metadata request uses the same redirect policy even though optional metadata errors
  // are tolerated by the connection flow. Gmail-only consent exercises its profile fallback.
  for (const path of ['/calendar/v3/calendars/primary', '/gmail/v1/users/me/profile']) {
    redirectPath = path;
    scope = path.includes('/gmail/') ? SCOPES.gmail : SCOPES.calendar;
    assert.equal((await authorize(google)).email, null);
    assert.equal(forwarded, 0, `${path} must not forward its bearer token`);
  }
  redirectPath = null;
  scope = Object.values(SCOPES).join(' ');
  await authorize(google);
  for (const path of ['/calendar/v3/calendars/primary/events', '/gmail/v1/users/me/messages']) {
    redirectPath = path;
    await assert.rejects(path.includes('/gmail/') ? google.searchMail('passport') : google.fetchDay(today), /fetch failed/);
    assert.equal(forwarded, 0, `${path} must not follow redirects`);
  }
  // A cold worker must also refuse to forward the saved refresh token.
  redirectPath = '/token';
  const other = createGoogle({ config: local, store, log: quietLog });
  await assert.rejects(other.fetchDay(today), /fetch failed/);
  assert.equal(forwarded, 0, 'refresh-token POST must not follow a 307');
  redirectPath = '/revoke';
  await google.disconnect();
  assert.equal(forwarded, 0, 'revocation POST must not follow a 307');
  assert.equal(await store.googleConnection(), undefined);
});

test('a stored Google connection is never used, replaced or revoked through endpoints it was not made with', async t => {
  const { url, google, remote, store } = await fixture(t);
  await connectGoogle(url, store, remote);
  remote.events = [{ id: 'real', status: 'confirmed', summary: 'Real appointment',
    start: { dateTime: `${today}T10:00:00-07:00` }, end: { dateTime: `${today}T11:00:00-07:00` } }];
  await google.syncAll();
  const before = await store.countByOrigin();

  const seen = [];
  const world = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ access_token: 'mock', expires_in: 3600, refresh_token: 'mock-refresh',
      scope: Object.values(SCOPES).join(' '), items: [], messages: [] }));
  }).listen(0, '127.0.0.1');
  await once(world, 'listening');
  t.after(() => new Promise(resolve => world.close(resolve)));
  const origin = `http://127.0.0.1:${world.address().port}`;
  const mock = createGoogle({ config: { ...config, GOOGLE_API_BASE_URL: origin, GOOGLE_OAUTH_BASE_URL: origin },
    store, log: quietLog });

  // The real connection is invisible to the mock configuration: no refresh, no sync, no overwrite.
  assert.equal(await mock.can('calendar'), false);
  assert.deepEqual(await mock.syncAll(), []);
  await assert.rejects(mock.fetchDay(today), /not connected/);
  await assert.rejects(mock.beginConnect(), /made against https:\/\/oauth2\.googleapis\.com/);
  await assert.rejects(mock.disconnect(), /disconnect it with matching Google endpoint settings/);
  assert.equal((await mock.status()).foreignConnection.tokenEndpoint, 'https://oauth2.googleapis.com');
  assert.deepEqual(seen, [], 'nothing, least of all the real refresh token, reached the mock');
  assert.deepEqual(await store.countByOrigin(), before);
  assert.equal(await google.can('calendar'), true, 'the real configuration still uses its connection');

  // Rows saved before origins were recorded count as real Google connections.
  await store.sql('UPDATE google_connection SET token_origin = NULL');
  assert.equal(await google.can('calendar'), true);
  assert.equal(await mock.can('calendar'), false);

  // And the reverse: a mock connection is never sent to real Google.
  await google.disconnect();
  const consent = new URL(await mock.beginConnect());
  await mock.completeConnect('code', consent.searchParams.get('state'));
  assert.equal(await mock.can('calendar'), true);
  const tokenCalls = remote.calls.filter(call => call === 'POST oauth2.googleapis.com/token').length;
  assert.equal(await google.can('calendar'), false);
  assert.deepEqual(await google.syncAll(), []);
  assert.equal(remote.calls.filter(call => call === 'POST oauth2.googleapis.com/token').length, tokenCalls);
});

test('mock Google endpoints need a clean base URL and a local database', () => {
  const base = { DIAL_MCP_TOKEN: 'd'.repeat(64), CAMERA_TOKEN: 'c'.repeat(64) };
  for (const value of ['http://127.0.0.1:8080?x', 'http://127.0.0.1:8080#x', 'http://u:p@127.0.0.1:8080']) {
    assert.throws(() => readConfig({ ...base, GOOGLE_API_BASE_URL: value }), /plain origin and path/, value);
  }
  assert.throws(() => readConfig({ ...base, GOOGLE_OAUTH_BASE_URL: 'http://127.0.0.1:8080',
    DATABASE_URL: 'postgres://u:p@ep-recall.example.com/neondb' }), /local database/);
  assert.equal(readConfig({ ...base, GOOGLE_OAUTH_BASE_URL: 'http://127.0.0.1:8080',
    DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/test' }).GOOGLE_OAUTH_BASE_URL, 'http://127.0.0.1:8080');
  assert.equal(endpoints({ GOOGLE_API_BASE_URL: 'http://127.0.0.1:8080/base/#' }).gmail,
    'http://127.0.0.1:8080/base/gmail/v1/users/me');
});
