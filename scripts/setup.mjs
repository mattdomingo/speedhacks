import { writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const content = `PORT=3000\nDATA_DIR=./data\nDIAL_MCP_TOKEN=${randomBytes(32).toString('hex')}\nCAMERA_TOKEN=${randomBytes(32).toString('hex')}\nDEMO_CALLER_NUMBER=\nDEMO_MODE=true\n`;
try {
  writeFileSync('.env', content, { flag: 'wx', mode: 0o600 });
  console.log('Created .env with separate secrets. Set DEMO_CALLER_NUMBER before testing phone tools.');
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
  console.log('.env already exists; left it unchanged.');
}
