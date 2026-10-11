import { readConfig } from './config.mjs';
import { openStore } from './store.mjs';
import { seedDemo } from './demo.mjs';
import { createApp } from './app.mjs';

const config = readConfig();
const store = openStore(config.DATA_DIR);
if (config.DEMO_MODE === 'true') seedDemo(store);
const server = createApp(config, store).listen(config.PORT, '0.0.0.0', () => {
  console.log(`Memory backend listening on ${config.PORT}; demo=${config.DEMO_MODE}`);
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => { store.close(); process.exit(0); }));
}
