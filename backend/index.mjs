import { readConfig } from './config.mjs';
import { openStore } from './store.mjs';
import { openPostgresStore } from './postgres.mjs';
import { seedDemo } from './demo.mjs';
import { createApp } from './app.mjs';

const config = readConfig();
const store = config.DATABASE_URL ? openPostgresStore(config.DATABASE_URL) : openStore(config.DATA_DIR);
if (config.DEMO_MODE === 'true') await seedDemo(store);
const server = createApp(config, store).listen(config.PORT, '0.0.0.0', () => {
  console.log(`Memory backend listening on ${config.PORT}; demo=${config.DEMO_MODE}`);
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => server.close(async () => { await store.close(); process.exit(0); }));
}
