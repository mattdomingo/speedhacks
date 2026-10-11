import { connect } from 'node:http2';
import { createPrivateKey, sign } from 'node:crypto';

const HOSTS = { production: 'https://api.push.apple.com', sandbox: 'https://api.sandbox.push.apple.com' };

// Minimal APNs client (token auth, HTTP/2). Without all four APNS_* settings push is unavailable
// and the router never chooses it.
export function createApns(config, { request: requestImpl } = {}) {
  if (!config.APNS_KEY_ID) return null;
  const key = createPrivateKey(config.APNS_KEY.replace(/\\n/g, '\n'));
  let jwt = { value: '', at: 0 };

  function token() {
    // Apple accepts a provider token for up to an hour and rejects refreshes more often than every 20 minutes.
    if (Date.now() - jwt.at < 40 * 60_000) return jwt.value;
    const part = value => Buffer.from(JSON.stringify(value)).toString('base64url');
    const body = `${part({ alg: 'ES256', kid: config.APNS_KEY_ID })}.${part({ iss: config.APNS_TEAM_ID, iat: Math.floor(Date.now() / 1000) })}`;
    const signature = sign('sha256', Buffer.from(body), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
    jwt = { value: `${body}.${signature}`, at: Date.now() };
    return jwt.value;
  }

  function http2Request(host, path, headers, payload) {
    return new Promise((resolve, reject) => {
      const session = connect(host);
      session.on('error', reject);
      const stream = session.request({ ':method': 'POST', ':path': path, ...headers });
      stream.setTimeout(10_000, () => { stream.close(); reject(new Error('APNs timed out')); });
      let status = 0;
      let body = '';
      stream.on('response', response => { status = response[':status']; });
      stream.on('data', chunk => { body += chunk; });
      stream.on('end', () => { session.close(); resolve({ status, body }); });
      stream.on('error', error => { session.close(); reject(error); });
      stream.end(payload);
    });
  }
  const request = requestImpl ?? http2Request;

  return {
    // Returns 'sent', 'gone' (token no longer valid: forget it) or 'failed'.
    async send(device, { title, body, data }) {
      const payload = JSON.stringify({ aps: { alert: { title, body }, sound: 'default' }, steph: data });
      const { status, body: response } = await request(HOSTS[device.environment] ?? HOSTS.production,
        `/3/device/${device.apns_token}`, {
          authorization: `bearer ${token()}`, 'apns-topic': config.APNS_TOPIC,
          'apns-push-type': 'alert', 'apns-priority': '10', 'content-type': 'application/json',
        }, payload);
      if (status === 200) return 'sent';
      const reason = (() => { try { return JSON.parse(response).reason; } catch { return ''; } })();
      if (status === 410 || reason === 'BadDeviceToken' || reason === 'Unregistered') return 'gone';
      throw new Error(`APNs rejected the notification (${status} ${reason || 'unknown'})`);
    },
  };
}
