import { readConfig } from './config.mjs';
import { openStore } from './store.mjs';
import { seedDemo } from './demo.mjs';
import { createApp } from './app.mjs';
import { createGoogle } from './digital/google.mjs';
import { createAnalytics } from './analytics/index.mjs';

const config = readConfig();
const store = openStore(config.DATA_DIR);
const analytics = createAnalytics(config);
const google = createGoogle({ config, store,
  onSync: results => analytics.sync({ caller: config.DEMO_CALLER_NUMBER, results }) });
if (config.DEMO_MODE === 'true') seedDemo(store, new Date(), google.timeZone());
const stopSync = google.start();
const server = createApp(config, store, google, analytics).listen(config.PORT, '0.0.0.0', () => {
  console.log(`Memory backend listening on ${config.PORT}; demo=${config.DEMO_MODE}; ` +
    `google=${google.configured ? (google.status().connection?.status ?? 'disconnected') : 'not_configured'}; ` +
    `keewano=${analytics.enabled}`);
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stopSync();
    server.close(async () => { await analytics.shutdown(); store.close(); process.exit(0); });
    server.closeIdleConnections();
  });
}
