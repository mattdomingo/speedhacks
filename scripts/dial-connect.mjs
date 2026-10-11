// Points Dial at this backend's public URL: a signed webhook (call.ended, call.transcribed,
// message.received), the Context MCP with its static bearer header, and Steph's inbound
// instruction. Tunnel URLs change on every restart, so earlier registrations that point at a
// tunnel host are replaced; anything pointing elsewhere (production) is left alone.
//   npm run dial:connect -- https://example.trycloudflare.com
import { readFileSync, writeFileSync } from 'node:fs';

const API = 'https://api.getdial.ai/api/v1';
const TUNNEL = /\.(trycloudflare\.com|ngrok-free\.app|ngrok\.app|ngrok\.io)$/;
const EVENTS = ['call.ended', 'call.transcribed', 'message.received'];

function fail(message) {
  console.error(message);
  process.exit(1);
}

const base = process.argv[2]?.replace(/\/+$/, '');
if (!/^https:\/\/[^/]+$/.test(base ?? '')) fail('Pass the public https origin of this backend, e.g. https://abc.trycloudflare.com');
const { DIAL_API_KEY, DIAL_MCP_TOKEN, STEPH_NUMBER = '+12408962183' } = process.env;
if (!DIAL_API_KEY || !DIAL_MCP_TOKEN) fail('Set DIAL_API_KEY and DIAL_MCP_TOKEN in .env first (npm run setup creates the token).');

async function dial(method, path, body) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${DIAL_API_KEY}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(30_000),
  });
  const payload = response.status === 204 ? {} : await response.json().catch(() => ({}));
  if (!response.ok) fail(`Dial ${method} ${path} failed with ${response.status}: ${JSON.stringify(payload.error ?? payload)}`);
  return payload;
}

const isTunnel = url => TUNNEL.test(new URL(url).hostname);

for (const hook of (await dial('GET', '/webhooks')).webhooks ?? []) {
  if (isTunnel(hook.targetUrl)) await dial('DELETE', `/webhooks/${hook.id}`);
}
const { webhook } = await dial('POST', '/webhooks', { targetUrl: `${base}/webhooks/dial`, eventTypes: EVENTS });
const { secret } = await dial('GET', `/webhooks/${webhook.id}/secret`);
// The signing secret goes only into the gitignored .env; it is never printed.
const env = readFileSync('.env', 'utf8');
const line = `DIAL_WEBHOOK_SECRET=${secret}`;
writeFileSync('.env', /^DIAL_WEBHOOK_SECRET=.*$/m.test(env) ? env.replace(/^DIAL_WEBHOOK_SECRET=.*$/m, line) : `${env.trimEnd()}\n${line}\n`);

for (const mcp of (await dial('GET', '/context-mcps')).contextMcps ?? []) {
  if (isTunnel(mcp.url)) await dial('DELETE', `/context-mcps/${mcp.id}`);
}
const { contextMcp } = await dial('POST', '/context-mcps', {
  name: 'Recall memory', url: `${base}/mcp`, headers: { Authorization: `Bearer ${DIAL_MCP_TOKEN}` }, timeoutMs: 20_000,
});

const numbers = (await dial('GET', '/numbers')).numbers ?? [];
const steph = numbers.find(number => number.number === STEPH_NUMBER);
if (!steph) fail(`Steph's number ${STEPH_NUMBER} is not on this Dial account.`);
const instruction = readFileSync(new URL('../backend/voice/instructions.txt', import.meta.url), 'utf8').trim();
await dial('PATCH', `/numbers/${steph.id}`, { inboundInstruction: instruction });

const ping = await dial('POST', `/webhooks/${webhook.id}/ping`, {});
console.log(`Webhook ${webhook.id} → ${base}/webhooks/dial (secret saved to .env; restart the server to load it)`);
console.log(`Context MCP ${contextMcp.id}: ${contextMcp.status}, ${contextMcp.toolCount} tools`);
console.log(`Inbound instruction set on ${STEPH_NUMBER} (${instruction.length} characters)`);
console.log(`Ping ${ping.eventId} sent; it verifies only after the server restarts with the new secret.`);
