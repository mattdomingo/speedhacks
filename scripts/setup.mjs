import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const secret = () => randomBytes(32).toString('hex');
const generated = {
  DIAL_MCP_TOKEN: secret, CAMERA_TOKEN: secret, ADMIN_TOKEN: secret, GOOGLE_TOKEN_KEY: secret, CRON_SECRET: secret,
};
const content = `PORT=3000\nDATA_DIR=./data\n${Object.entries(generated).map(([key, make]) => `${key}=${make()}`).join('\n')}\n` +
  'DEMO_CALLER_NUMBER=\nDEMO_MODE=true\n';
try {
  writeFileSync('.env', content, { flag: 'wx', mode: 0o600 });
  console.log('Created .env with separate secrets. Set DEMO_CALLER_NUMBER before testing phone tools.');
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
  // Existing values are never changed; only secrets added by newer versions are appended.
  const existing = readFileSync('.env', 'utf8');
  const missing = Object.keys(generated).filter(key => !new RegExp(`^${key}=.+`, 'm').test(existing));
  if (!missing.length) {
    console.log('.env already exists; left it unchanged.');
  } else {
    const prefix = existing.endsWith('\n') || !existing ? '' : '\n';
    appendFileSync('.env', prefix + missing.map(key => `${key}=${generated[key]()}`).join('\n') + '\n');
    console.log(`.env already exists; appended missing ${missing.join(', ')}.`);
  }
}
