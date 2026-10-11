import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

const TOLERANCE_SECONDS = 300;
const MAX_BYTES = 1_000_000;
const eventSchema = z.object({ id: z.string().min(1).max(200), type: z.string().min(1).max(100) }).passthrough();

// Dial signs deliveries as `X-Dial-Signature: t=<unix seconds>,v1=<hex>`, where
// v1 = HMAC-SHA256(secret, `${t}.${rawBody}`) (per @getdial/sdk verifyDialSignature).
export function verifyDialSignature(secret, header, rawBody, now = Date.now()) {
  if (!secret || !header) return false;
  let timestamp;
  const signatures = [];
  for (const part of header.split(',')) {
    const index = part.indexOf('=');
    const [key, value] = [part.slice(0, index).trim(), part.slice(index + 1).trim()];
    if (key === 't') timestamp = value;
    if (key === 'v1') signatures.push(value);
  }
  if (!/^\d+$/.test(timestamp ?? '') || Math.abs(now / 1000 - Number(timestamp)) > TOLERANCE_SECONDS) return false;
  const expected = createHmac('sha256', secret).update(`${timestamp}.`).update(rawBody).digest();
  return signatures.some(signature => /^[0-9a-f]{64}$/i.test(signature) &&
    timingSafeEqual(Buffer.from(signature, 'hex'), expected));
}

// The signature covers the exact bytes, so the body is read from the stream here rather than
// through a body parser: on Vercel the runtime consumes the request first (body parsers then
// skip it) and replays the original bytes on the stream's data/end events.
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BYTES) reject(Object.assign(new Error('Payload too large'), { status: 413 }));
      else chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function dialWebhook(config, store, analytics) {
  return async (req, res) => {
    if (!config.DIAL_WEBHOOK_SECRET) return res.status(503).json({ error: 'Endpoint is not configured' });
    const body = await readRawBody(req);
    if (!verifyDialSignature(config.DIAL_WEBHOOK_SECRET, req.get('x-dial-signature'), body)) {
      return res.status(401).json({ error: 'Invalid signature' });
    }
    let event;
    try {
      event = eventSchema.parse(JSON.parse(body.toString('utf8')));
    } catch {
      return res.status(400).json({ error: 'Invalid event' });
    }
    // Stored as received, including transcripts; pruned after DIAL_EVENT_RETENTION_DAYS.
    const fresh = await store.recordDialEvent(event, config.DIAL_EVENT_RETENTION_DAYS ?? 30);
    if (fresh) analytics.dialEvent(event.type);
    res.json({ received: true, duplicate: !fresh });
  };
}

const PHONE = /^\+?\d{7,15}$/;

// Diagnostic for confirming Dial's Context MCP headers: names, plus enough of each Dial or
// MCP value to recognise it (phone numbers: last four digits; anything else: shape only).
export function describeHeaders(headers) {
  return Object.keys(headers).sort().map(name => {
    if (!name.startsWith('x-dial-') && !name.startsWith('mcp-')) return name;
    const value = String(headers[name]);
    if (PHONE.test(value)) return `${name}=…${value.slice(-4)}`;
    if (/^(inbound|outbound)$/i.test(value) || name === 'mcp-protocol-version') return `${name}=${value}`;
    return `${name}=<${value.length} chars>`;
  }).join(', ');
}
