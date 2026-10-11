// Online SQLite snapshot: npm run db:backup [-- path/to/file.sqlite]
import { join } from 'node:path';
import { openStore } from '../backend/store.mjs';

const dataDir = process.env.DATA_DIR || './data';
const target = process.argv[2] || join(dataDir, `backup-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`);
const store = openStore(dataDir);
try {
  store.backup(target);
  console.log(`Backed up ${join(dataDir, 'memory.sqlite')} to ${target}`);
} finally {
  store.close();
}
