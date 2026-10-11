const API = 'https://api.getdial.ai/api/v1';

function dialError(message, props) {
  return Object.assign(new Error(message), props);
}

// Minimal REST client for Steph's calls, texts and reads. Keep DIAL_API_KEY server-side.
//
// Dial writes are not reliably idempotent (its call guide says a retried POST /calls places a
// second call), so a failed write is classified rather than retried here:
// - `ambiguous`: no definite answer (timeout, dropped connection, 5xx, or an
//   idempotency 409). The call or text may exist; callers must look it up before acting again.
// - `permanent`: 4xx other than 429 (e.g. 409 calling_disabled, 400, 402). Retrying will not help.
// - otherwise a definite transient refusal (429): nothing was placed.
// allowedNumbers (DIAL_ALLOWED_NUMBERS) refuses any other destination before a request is made.
export function createDial(apiKey, fetchImpl = fetch, { allowedNumbers, timeoutMs = 15_000 } = {}) {
  const allowed = allowedNumbers?.length ? new Set(allowedNumbers) : null;

  function guard(to) {
    if (allowed && !allowed.has(to)) {
      throw dialError('Dial destination is not on DIAL_ALLOWED_NUMBERS', { status: 403, code: 'not_allowed', permanent: true });
    }
  }

  async function request(method, path, { body, headers = {}, query } = {}) {
    const resource = path.split('/')[1];
    const search = query ? `?${new URLSearchParams(Object.entries(query).filter(([, value]) => value != null))}` : '';
    let response;
    try {
      response = await fetchImpl(`${API}${path}${search}`, {
        method,
        headers: { Authorization: `Bearer ${apiKey}`, ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (cause) {
      throw dialError(`Dial ${method} ${resource} did not complete (${cause.name})`, { ambiguous: method !== 'GET' });
    }
    const payload = await response.json().catch(() => undefined);
    if (!response.ok) {
      const detail = payload?.error;
      const code = typeof detail === 'object' ? detail?.code : payload?.code ??
        (typeof detail === 'string' && /^[a-z_]+$/.test(detail) ? detail : undefined);
      const status = response.status;
      const stillProcessing = status === 409 && !/calling_disabled|tendlc/.test(`${code} ${detail}`);
      throw dialError(`Dial ${method} ${resource} failed with ${status}${code ? ` (${code})` : ''}`, {
        status, code,
        ambiguous: method !== 'GET' && (stillProcessing || status >= 500),
        permanent: status >= 400 && status < 500 && status !== 429 && !stillProcessing,
      });
    }
    return payload ?? {};
  }

  return {
    // Dial documents an Idempotency-Key for calls in one place and denies it in another, so the
    // key is sent as a bonus and never relied on: callers look a call up before any retry.
    async placeCall({ to, from, instruction, idempotencyKey, maxSeconds }) {
      guard(to);
      return (await request('POST', '/calls', {
        body: { to, fromNumber: from, outboundInstruction: instruction, language: 'en-US', maxCallDurationSeconds: maxSeconds },
        headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {},
      })).call;
    },
    async getCall(id) {
      return (await request('GET', `/calls/${encodeURIComponent(id)}`)).call;
    },
    // Newest first; `since` is an ISO timestamp.
    async listCalls({ contact, since, direction } = {}) {
      return (await request('GET', '/calls', { query: { contact, since, direction } })).calls ?? [];
    },
    async sendText({ to, from, body }) {
      guard(to);
      return (await request('POST', '/messages', { body: { to, fromNumber: from, body } })).message;
    },
    async listMessages({ contact, since, direction } = {}) {
      return (await request('GET', '/messages', { query: { contact, since, direction } })).messages ?? [];
    },
    // Cheapest authenticated read, for /health.
    async account() {
      return request('GET', '/account');
    },
    async getMessage(id, { to, since }) {
      // Dial has no get-by-ID or cursor: search its newest 100 matching outbound
      // messages, then require the exact ID. A missing row is inconclusive.
      const payload = await request('GET', '/messages', { query: { direction: 'outbound', contact: to, since } });
      if (!Array.isArray(payload.messages)) throw new Error('Dial message list is unavailable');
      return payload.messages.find(message => message?.id === id &&
        (message.direction === undefined || message.direction === 'outbound'));
    },
  };
}

// After an ambiguous POST /calls: the call Steph placed to `to` since `since`, if Dial has it.
export async function findPlacedCall(dial, { to, from, since, marker }) {
  const calls = await dial.listCalls({ contact: to, since, direction: 'outbound' });
  return calls.find(call => call.to === to && (!from || call.from === from) &&
    (!since || Date.parse(call.createdAt) >= Date.parse(since)) &&
    (!marker || !call.instruction || call.instruction.includes(marker))) ?? null;
}
