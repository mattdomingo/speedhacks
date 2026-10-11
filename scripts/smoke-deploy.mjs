// Read-only checks against a deployed backend: liveness, authentication on every protected
// route, and 404 for unknown paths. Sends no credentials and writes nothing.
// Usage: node scripts/smoke-deploy.mjs https://recall-kappa-nine.vercel.app
const CHECKS = [
  ['GET', '/health', [200], 'public liveness'],
  ['POST', '/mcp', [401], 'MCP needs DIAL_MCP_TOKEN'],
  ['GET', '/camera/status', [401], 'camera needs CAMERA_TOKEN'],
  ['GET', '/camera/frame', [401], 'raw frames need CAMERA_TOKEN'],
  ['POST', '/camera/observations', [401], 'observations need CAMERA_TOKEN'],
  // 503 while a feature is not configured, 401 once it is; never 200 without credentials.
  ['POST', '/app/session', [401, 503], 'pairing needs a device credential'],
  ['POST', '/app/ask', [401, 503], 'shared memory needs a device credential'],
  ['GET', '/google/status', [401, 503], 'Google admin needs ADMIN_TOKEN'],
  ['GET', '/cron/google-sync', [401, 503], 'cron needs CRON_SECRET'],
  ['POST', '/webhooks/dial', [401, 503], 'webhooks need a Dial signature'],
  ['GET', '/', [404], 'no frontend at /'],
];

export async function smokeDeploy(origin, { attempts = 5, delayMs = 5000, log = console.log } = {}) {
  const base = new URL(origin);
  if (base.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(base.hostname)) {
    throw new Error('Use an HTTPS origin');
  }
  const failures = [];
  for (const [method, path, expected, purpose] of CHECKS) {
    let status, body = '';
    // Retries cover the moment a new deployment is being promoted to the domain.
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const response = await fetch(new URL(path, base), {
          method, signal: AbortSignal.timeout(15_000),
          ...(method === 'POST' ? { headers: { 'Content-Type': 'application/json' }, body: '{}' } : {}),
        });
        status = response.status;
        body = await response.text();
      } catch (error) {
        status = `error: ${error.message}`;
      }
      if (expected.includes(status)) break;
      if (attempt < attempts) await new Promise(resolve => setTimeout(resolve, delayMs));
    }
    let ok = expected.includes(status);
    if (ok && path === '/health') {
      try { ok = JSON.parse(body).ok === true; } catch { ok = false; }
    }
    log(`${ok ? 'ok  ' : 'FAIL'} ${method} ${path} -> ${status} (${purpose}; expected ${expected.join(' or ')})`);
    if (!ok) failures.push(`${method} ${path}`);
  }
  return failures;
}

if (import.meta.main ?? process.argv[1]?.endsWith('smoke-deploy.mjs')) {
  const origin = process.argv[2] || process.env.SMOKE_URL;
  if (!origin) {
    console.error('Usage: node scripts/smoke-deploy.mjs https://YOUR_BACKEND');
    process.exit(2);
  }
  const failures = await smokeDeploy(origin);
  if (failures.length) {
    console.error(`Smoke check failed: ${failures.join(', ')}`);
    process.exit(1);
  }
  console.log('Smoke check passed.');
}
