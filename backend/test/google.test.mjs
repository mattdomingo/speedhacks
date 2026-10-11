import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createApp } from '../app.mjs';
import { readConfig } from '../config.mjs';
import { openStore, SCHEMA_VERSION } from '../store.mjs';
import { createGoogle, SCOPES } from '../digital/google.mjs';
import { addDays, localDate, startOfDay } from '../time.mjs';

const ZONE = 'America/Los_Angeles';
const config = readConfig({
  DIAL_MCP_TOKEN: 'd'.repeat(64), CAMERA_TOKEN: 'c'.repeat(64), ADMIN_TOKEN: 'a'.repeat(64),
  DEMO_CALLER_NUMBER: '+14155550123', DEMO_MODE: 'false',
  GOOGLE_CLIENT_ID: 'client-id.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'client-secret',
  GOOGLE_REDIRECT_URI: 'http://127.0.0.1:3000/google/callback', GOOGLE_TOKEN_KEY: 'f'.repeat(64),
});
const admin = { Authorization: `Bearer ${config.ADMIN_TOKEN}` };
const today = localDate(new Date(), ZONE);
const quietLog = { warn() {}, error() {} };

// In-process stand-in for Google's OAuth, Calendar and Gmail endpoints.
function fakeGoogle() {
  const google = {
    calls: [], events: [], messages: [], failCalendar: false, revoked: [],
    grantedScope: Object.values(SCOPES).join(' '), refreshValid: true,
  };
  const json = (body, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json' },
  });
  google.fetch = async (input, init = {}) => {
    const url = new URL(input);
    google.calls.push(`${init.method ?? 'GET'} ${url.host}${url.pathname}`);
    if (url.href === 'https://oauth2.googleapis.com/token') {
      const params = new URLSearchParams(init.body);
      google.lastTokenRequest = params;
      if (params.get('grant_type') === 'refresh_token' && !google.refreshValid) {
        return json({ error: 'invalid_grant' }, 400);
      }
      return json({
        access_token: `access-${google.calls.length}`, expires_in: 3600, token_type: 'Bearer',
        scope: google.grantedScope,
        ...(params.get('grant_type') === 'authorization_code' ? { refresh_token: 'refresh-secret-value' } : {}),
      });
    }
    if (url.href.startsWith('https://oauth2.googleapis.com/revoke')) {
      google.revoked.push(new URLSearchParams(init.body).get('token'));
      return json({});
    }
    assert.match(init.headers.Authorization, /^Bearer access-/);
    if (url.pathname === '/calendar/v3/calendars/primary') return json({ id: 'me@example.com', timeZone: ZONE });
    if (url.pathname === '/calendar/v3/calendars/primary/events') {
      if (google.failCalendar) return json({ error: { errors: [{ reason: 'backendError' }] } }, 503);
      const min = Date.parse(url.searchParams.get('timeMin'));
      const max = Date.parse(url.searchParams.get('timeMax'));
      return json({ items: google.events.filter(event => {
        const start = Date.parse(event.start.dateTime ?? `${event.start.date}T12:00:00-07:00`);
        return start >= min && start < max;
      }) });
    }
    if (url.pathname === '/gmail/v1/users/me/messages') {
      const q = url.searchParams.get('q');
      const hits = google.messages.filter(message => q.startsWith('newer_than') ||
        q.split(' ').every(word => message.body.toLowerCase().includes(word)));
      return json({ messages: hits.slice(0, +url.searchParams.get('maxResults')).map(({ id }) => ({ id, threadId: `t${id}` })) });
    }
    const message = url.pathname.match(/^\/gmail\/v1\/users\/me\/messages\/(\w+)$/);
    if (message) {
      assert.deepEqual(url.searchParams.getAll('metadataHeaders'), ['From', 'Subject', 'Date']);
      const found = google.messages.find(({ id }) => id === message[1]);
      return json({ ...found, threadId: `t${found.id}` });
    }
    return json({ error: { status: 'NOT_FOUND' } }, 404);
  };
  return google;
}

async function fixture(t, overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'speedhacks-google-'));
  const store = openStore(dir);
  const remote = fakeGoogle();
  const google = createGoogle({ config: { ...config, ...overrides }, store, fetch: remote.fetch, log: quietLog });
  const server = createApp({ ...config, ...overrides }, store, google).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, store, remote, google, url: `http://127.0.0.1:${server.address().port}` };
}

async function connectGoogle(url) {
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
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
});

test('Google configuration is all-or-nothing and redirect URIs are safe', () => {
  const base = { DIAL_MCP_TOKEN: 'd'.repeat(64), CAMERA_TOKEN: 'c'.repeat(64) };
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

test('pre-versioned scaffold databases migrate in place without losing evidence', () => {
  const dir = mkdtempSync(join(tmpdir(), 'speedhacks-migrate-'));
  try {
    const legacy = new DatabaseSync(join(dir, 'memory.sqlite'));
    legacy.exec(`CREATE TABLE evidence (id TEXT PRIMARY KEY, source TEXT NOT NULL, timestamp TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE latest_frame (slot INTEGER PRIMARY KEY CHECK (slot = 1), timestamp TEXT NOT NULL, jpeg BLOB NOT NULL);`);
    legacy.prepare('INSERT INTO evidence VALUES (?, ?, ?, ?)').run('old', 'camera', '2026-01-01T00:00:00Z',
      JSON.stringify({ id: 'old', source: 'camera', object: 'keys', location: 'desk', timestamp: '2026-01-01T00:00:00Z' }));
    legacy.close();
    const store = openStore(dir);
    assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
    assert.equal(store.list('camera')[0].location, 'desk');
    assert.deepEqual(store.countByOrigin(), { local: 1 });
    store.backup(join(dir, 'copy.sqlite'));
    store.close();
    const reopened = new DatabaseSync(join(dir, 'copy.sqlite'));
    assert.equal(reopened.prepare('SELECT COUNT(*) AS n FROM evidence').get().n, 1);
    reopened.close();
    const future = new DatabaseSync(join(dir, 'memory.sqlite'));
    future.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    future.close();
    assert.throws(() => openStore(dir), /newer than this build/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
  const { authorizationUrl, state, callback } = await connectGoogle(url);
  assert.equal(callback.status, 200);
  assert.equal(authorizationUrl.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(authorizationUrl.searchParams.get('access_type'), 'offline');
  assert.equal(authorizationUrl.searchParams.get('scope'), Object.values(SCOPES).join(' '));
  assert.ok(remote.lastTokenRequest.get('code_verifier')?.length >= 43);
  const row = store.googleConnection();
  assert.equal(row.email, 'me@example.com');
  assert.equal(row.timezone, ZONE);
  assert.ok(!row.refresh_token.includes('refresh-secret-value'));
  assert.equal((await fetch(`${url}/google/callback?code=auth-code&state=${state}`)).status, 400);
  assert.equal((await fetch(`${url}/google/callback?error=access_denied`)).status, 400);
});

test('calendar sync stores zone-correct events with provenance and drops cancelled ones', async t => {
  const { url, google, remote } = await fixture(t);
  await connectGoogle(url);
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
  assert.match(todayPlans.evidence[0].text, /Dinner with Sarah" on \w+day, .* from \d{1,2}:30 PM to .* at Home\./);
  assert.deepEqual((await schedule(addDays(today, 4))).evidence.map(item => item.title), ['Trip']);
  assert.equal((await schedule(addDays(today, 5))).status, 'unknown');
  const tools = await client.listTools();
  assert.match(tools.tools.find(tool => tool.name === 'get_schedule').description, new RegExp(`Today is ${today}`));

  remote.events = remote.events.filter(event => event.id !== 'late');
  await google.syncAll();
  assert.equal((await schedule(today)).status, 'unknown');
});

test('dates outside the synced window are fetched live, and failures are errors not "no plans"', async t => {
  const { url, google, remote } = await fixture(t);
  await connectGoogle(url);
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
  assert.match(google.status().sync[0].last_error, /503 backendError/);
});

test('email search ranks synced mail and falls back to live Gmail search', async t => {
  const { url, google, remote } = await fixture(t);
  await connectGoogle(url);
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

  remote.messages.push({ id: 'm2', internalDate: String(Date.parse('2025-01-01T00:00:00Z')), snippet: 'See attached',
    body: 'passport renewal form', payload: { headers: [{ name: 'From', value: 'records@example.gov' }, { name: 'Subject', value: 'Forms' }] } });
  const live = await search('passport renewal');
  assert.equal(live.evidence[0].id, 'gmail:m2');
  assert.equal((await search('the')).status, 'unknown');
});

test('revoked refresh tokens flag reconnection; disconnect revokes and purges Google evidence', async t => {
  const { url, google, remote, store } = await fixture(t);
  await connectGoogle(url);
  remote.events = [{ id: 'e', status: 'confirmed', summary: 'Walk',
    start: { dateTime: `${today}T10:00:00-07:00` }, end: { dateTime: `${today}T11:00:00-07:00` } }];
  await google.syncAll();
  assert.equal(store.countByOrigin()['google-calendar'], 1);

  const fresh = createGoogle({ config, store, fetch: remote.fetch, log: quietLog });
  remote.refreshValid = false;
  const [failed] = await fresh.syncAll();
  assert.equal(failed.ok, false);
  assert.equal(fresh.status().connection.status, 'reconnect_required');
  assert.equal(fresh.can('calendar'), false);

  const response = await fetch(`${url}/google/connection`, { method: 'DELETE', headers: admin });
  assert.equal(response.status, 200);
  assert.deepEqual(remote.revoked, ['refresh-secret-value']);
  assert.equal(store.googleConnection(), undefined);
  assert.equal(store.countByOrigin()['google-calendar'], undefined);
});

test('consent with only calendar access keeps Gmail tools on local evidence', async t => {
  const { url, google, remote } = await fixture(t);
  remote.grantedScope = SCOPES.calendar;
  await connectGoogle(url);
  assert.equal(google.can('calendar'), true);
  assert.equal(google.can('gmail'), false);
  const results = await google.syncAll();
  assert.deepEqual(results.map(result => result.name), ['google-calendar']);
});

test('setup appends only missing secrets to an existing .env', () => {
  const dir = mkdtempSync(join(tmpdir(), 'speedhacks-setup-'));
  try {
    writeFileSync(join(dir, '.env'), 'DIAL_MCP_TOKEN=keep\nCAMERA_TOKEN=keep2');
    execFileSync(process.execPath, [join(import.meta.dirname, '../../scripts/setup.mjs')], { cwd: dir });
    const env = readFileSync(join(dir, '.env'), 'utf8');
    assert.match(env, /^DIAL_MCP_TOKEN=keep\nCAMERA_TOKEN=keep2\nADMIN_TOKEN=[0-9a-f]{64}\nGOOGLE_TOKEN_KEY=[0-9a-f]{64}\n$/);
    execFileSync(process.execPath, [join(import.meta.dirname, '../../scripts/setup.mjs')], { cwd: dir });
    assert.equal(readFileSync(join(dir, '.env'), 'utf8'), env);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
