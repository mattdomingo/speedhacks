// Long-running server: npm start, Docker. Syncs Google on a timer instead of Vercel Cron.
import { createRuntime } from './runtime.mjs';

const { config, store, google, analytics, app, boot } = createRuntime();
await boot();
const stopSync = google.start();
const server = app.listen(config.PORT, '0.0.0.0', async () => {
  const status = await google.status();
  console.log(`Memory backend listening on ${config.PORT}; demo=${config.DEMO_MODE}; ` +
    `google=${google.configured ? (status.connection?.status ?? 'disconnected') : 'not_configured'}; ` +
    `keewano=${analytics.enabled}`);
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stopSync();
    server.close(async () => {
      await analytics.shutdown();
      await store.close();
      process.exit(0);
    });
    server.closeIdleConnections();
  });
}
