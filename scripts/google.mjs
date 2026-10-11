// Admin client for the backend's Google routes: npm run google -- connect|status|sync|disconnect
const commands = {
  connect: ['POST', '/google/connect'],
  status: ['GET', '/google/status'],
  sync: ['POST', '/google/sync'],
  disconnect: ['DELETE', '/google/connection'],
};
const command = process.argv[2];
if (!commands[command]) {
  console.error(`Usage: npm run google -- ${Object.keys(commands).join('|')}`);
  process.exit(2);
}
const backend = new URL(process.env.BACKEND_URL || `http://127.0.0.1:${process.env.PORT || 3000}`);
if (backend.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(backend.hostname)) {
  console.error('Use HTTPS for a remote BACKEND_URL; the admin token must not travel in plain text.');
  process.exit(2);
}
if (!process.env.ADMIN_TOKEN) {
  console.error('Set ADMIN_TOKEN (npm run setup adds one to .env).');
  process.exit(2);
}
const [method, path] = commands[command];
const response = await fetch(new URL(path, backend), {
  method, headers: { Authorization: `Bearer ${process.env.ADMIN_TOKEN}` },
});
const body = await response.json().catch(() => ({}));
if (command === 'connect' && response.ok) {
  console.log(`Open this link within 10 minutes and approve Calendar and Gmail read access:\n\n${body.authorizationUrl}\n`);
} else {
  console.log(JSON.stringify(body, null, 2));
}
process.exitCode = response.ok ? 0 : 1;
