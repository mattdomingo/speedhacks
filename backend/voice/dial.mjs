const API = 'https://api.getdial.ai/api/v1';

// Minimal REST client for the three Dial calls reminders need. Keep DIAL_API_KEY server-side.
export function createDial(apiKey, fetchImpl = fetch) {
  async function request(method, path, body, headers = {}) {
    const response = await fetchImpl(`${API}${path}`, {
      method,
      headers: { Authorization: `Bearer ${apiKey}`, ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(15_000),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(`Dial ${method} ${path.split('/')[1]} failed with ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return payload;
  }
  return {
    // The idempotency key makes a retried placement return the original call instead of dialing twice.
    async placeCall({ to, from, instruction, idempotencyKey, maxSeconds }) {
      return (await request('POST', '/calls', {
        to, fromNumber: from, outboundInstruction: instruction, language: 'en-US', maxCallDurationSeconds: maxSeconds,
      }, { 'Idempotency-Key': idempotencyKey })).call;
    },
    async getCall(id) {
      return (await request('GET', `/calls/${encodeURIComponent(id)}`)).call;
    },
    async sendText({ to, from, body }) {
      return (await request('POST', '/messages', { to, fromNumber: from, body })).message;
    },
  };
}
