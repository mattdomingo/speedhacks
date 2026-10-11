import { createHmac, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { once } from 'node:events';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createApp } from '../app.mjs';
import { readConfig } from '../config.mjs';
import { testStore, TEST_DATABASE_URL } from './helpers.mjs';

export const STEPH = '+12408962183';
export const ADA = '+14155550123';
export const SAM = '+14155550199';
export const BUNDLE = 'com.speedhacks.recall';
// Monday 12 October 2026, 10:00 in Los Angeles.
export const START = Date.parse('2026-10-12T17:00:00Z');
export const config = readConfig({
  DIAL_MCP_TOKEN: 'd'.repeat(64), CAMERA_TOKEN: 'c'.repeat(64), CRON_SECRET: 'r'.repeat(64), DIAL_API_KEY: 'sk_test',
  DIAL_WEBHOOK_SECRET: 'w'.repeat(32), ANTHROPIC_API_KEY: 'sk-ant-test', TIMEZONE: 'America/Los_Angeles',
  APPLE_BUNDLE_IDS: BUNDLE, DEMO_MODE: 'false', DATABASE_URL: TEST_DATABASE_URL,
});
export const NO_ANALYTICS = { toolCall() {}, rejected() {}, sync() {}, dialEvent() {} };

export function fakeDial() {
  const dial = {
    calls: [], texts: [], callRecords: {}, failCall: null,
    async placeCall(args) {
      dial.calls.push(args);
      if (dial.failCall) throw dial.failCall;
      return { id: `call-${dial.calls.length}` };
    },
    async getCall(id) { return dial.callRecords[id] ?? { id, status: { state: 'In-Progress' } }; },
    async sendText(args) {
      dial.texts.push(args);
      return { id: `msg-${dial.texts.length}` };
    },
    codeFor(phone) {
      const text = [...dial.texts].reverse().find(entry => entry.to === phone)?.body ?? '';
      return text.match(/\b(\d{6})\b/)?.[1];
    },
  };
  return dial;
}

export function fakeApns() {
  const apns = { sent: [], async send(device, message) { apns.sent.push({ device, message }); return 'sent'; } };
  return apns;
}

export function fakeGoogle({ email = 'ada@example.com' } = {}) {
  const google = {
    configured: true, email, disconnected: 0, created: [],
    async timeZone() { return 'America/Los_Angeles'; },
    async beginConnect() { return `https://accounts.example/o/oauth2/v2/auth?state=${randomBytes(12).toString('hex')}`; },
    async completeConnect() { return { email: google.email, scopes: [] }; },
    async can() { return true; },
    async status() { return { connection: { email: google.email, calendar: true, gmail: true } }; },
    async syncAll() { return []; },
    async disconnect() { google.disconnected++; },
    async createEvent(event) { google.created.push(event); return { id: `ev-${google.created.length}` }; },
  };
  return google;
}

// A scripted Claude: script(params, index) returns the next response.
export function fakeClaude(script) {
  const claude = {
    requests: [],
    beta: { messages: { async create(params) {
      claude.requests.push(structuredClone(params));
      return script(params, claude.requests.length - 1);
    } } },
  };
  return claude;
}
export const toolUse = (id, name, input) => ({ type: 'tool_use', id, name, input });
export const reply = (id, text, extra = {}) => toolUse(id, 'reply', { text, ...extra });
export const turn = (...content) => ({ stop_reason: content.some(block => block.type === 'tool_use') ? 'tool_use' : 'end_turn', content });
// Finds what a tool returned to the model in the latest request.
export function toolResult(params, id) {
  for (const message of [...params.messages].reverse()) {
    if (!Array.isArray(message.content)) continue;
    const block = message.content.find(part => part.type === 'tool_result' && part.tool_use_id === id);
    if (block) return block.is_error ? { error: block.content } : JSON.parse(block.content);
  }
  return undefined;
}

export function appleKeys() {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-kid', alg: 'RS256', use: 'sig' };
  return {
    fetch: async () => new Response(JSON.stringify({ keys: [jwk] }), { status: 200 }),
    token(claims) {
      const part = value => Buffer.from(JSON.stringify(value)).toString('base64url');
      const body = `${part({ alg: 'RS256', kid: 'test-kid' })}.${part({ iss: 'https://appleid.apple.com', aud: BUNDLE,
        sub: 'apple-sub-1', exp: Math.floor(START / 1000) + 600, ...claims })}`;
      return `${body}.${sign('RSA-SHA256', Buffer.from(body), privateKey).toString('base64url')}`;
    },
  };
}

export async function fixture(t, { overrides = {}, script, google = fakeGoogle(), apns = fakeApns(), fetch } = {}) {
  const store = await testStore(t);
  const clock = { now: START };
  const dial = fakeDial();
  const claude = script ? fakeClaude(script) : undefined;
  const app = createApp({ ...config, ...overrides }, store, undefined, {
    google, dial, claude, apns, fetch, now: () => clock.now, analytics: NO_ANALYTICS,
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  const api = async (path, { token, method, body, headers = {} } = {}) => {
    const response = await fetch_(`${url}${path}`, {
      method: method ?? (body ? 'POST' : 'GET'), redirect: 'manual',
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    let json;
    try { json = JSON.parse(text); } catch { json = undefined; }
    return { status: response.status, body: json, text, headers: response.headers };
  };
  return { store, clock, dial, claude, google, apns, url, api };
}
const fetch_ = (...args) => globalThis.fetch(...args);

// Google sign-in through the real routes, then (optionally) phone verification with the texted code.
export async function signIn(f, { mode = 'self', phone, email } = {}) {
  if (email) f.google.email = email;
  const start = await f.api('/v1/auth/google/start', { body: { mode } });
  const state = new URL(start.body.authorization_url).searchParams.get('state');
  const callback = await f.api(`/google/callback?state=${state}&code=auth-code`);
  const code = new URL(callback.headers.get('location')).searchParams.get('code');
  const exchanged = await f.api('/v1/auth/exchange', { body: { code } });
  let user = exchanged.body.user;
  const token = exchanged.body.session_token;
  if (phone) {
    await f.api('/v1/auth/phone/start', { token, body: { phone } });
    user = (await f.api('/v1/auth/phone/verify', { token, body: { phone, code: f.dial.codeFor(phone) } })).body.user;
  }
  return { token, user };
}

export function signWebhook(event, secret = config.DIAL_WEBHOOK_SECRET) {
  const body = JSON.stringify(event);
  const at = Math.floor(Date.now() / 1000);
  return { body, signature: `t=${at},v1=${createHmac('sha256', secret).update(`${at}.${body}`).digest('hex')}` };
}

export async function postWebhook(f, event) {
  const { body, signature } = signWebhook(event);
  const response = await globalThis.fetch(`${f.url}/webhooks/dial`, { method: 'POST', body,
    headers: { 'Content-Type': 'application/json', 'X-Dial-Signature': signature, 'X-Dial-Event-ID': event.id } });
  return { status: response.status, body: await response.json() };
}

export async function mcpClient(t, f, headers) {
  const client = new Client({ name: 'steph-check', version: '0.1.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${f.url}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${config.DIAL_MCP_TOKEN}`, ...headers } },
  }));
  t.after(() => client.close());
  return client;
}

export const cron = f => f.api('/cron/steph', { headers: { Authorization: `Bearer ${config.CRON_SECRET}` } });
