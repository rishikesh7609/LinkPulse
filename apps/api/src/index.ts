import './config/load-env.js';
import { createApp, closeAppResources } from './app.js';
import { closeDb } from './db/client.js';
import { resolveApiPort } from './config/runtime.js';
import { PostgresSessionStore } from './auth/session-store.js';

const port = resolveApiPort();
const sessionStore = new PostgresSessionStore();
const app = createApp(undefined, undefined, { sessionStore });
const sessionCleanup = setInterval(
  () => {
    void sessionStore.removeExpired().catch(() => undefined);
  },
  60 * 60 * 1000,
);
sessionCleanup.unref();

const server = app.listen(port, '0.0.0.0', () => {
  console.log(`LinkPulse API listening on port ${port}`);
});

async function shutdown() {
  clearInterval(sessionCleanup);
  server.close(async () => {
    await Promise.all([closeAppResources(), closeDb()]);
    process.exit(0);
  });
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
