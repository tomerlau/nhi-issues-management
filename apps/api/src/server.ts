import { createApp } from './app.js';
import { resolveDatabasePath } from './config/database.js';
import { loadLocalEnv } from './config/env.js';
import { resolveJiraEncryptionKey } from './config/jira-crypto.js';
import { initializeDatabase } from './database/lifecycle.js';

const port = 3001;

loadLocalEnv();

const databasePath = resolveDatabasePath();
const db = initializeDatabase(databasePath);
console.log(`[api] database ready at ${databasePath}`);

// A malformed key fails startup here; a missing key leaves Jira unconfigured
// (its endpoints return 503) without preventing the rest of the app from running.
const jiraEncryptionKey = resolveJiraEncryptionKey();
console.log(
  `[api] jira credential encryption ${jiraEncryptionKey ? 'configured' : 'not configured (set JIRA_CREDENTIAL_ENCRYPTION_KEY to enable Jira connections)'}`,
);

const app = createApp(db, {
  cookieSecure: process.env.NODE_ENV === 'production',
  jira: { encryptionKey: jiraEncryptionKey },
});

const server = app.listen(port, () => {
  console.log(`[api] listening on http://localhost:${port}`);
});

const shutdown = (signal: NodeJS.Signals): void => {
  console.log(`[api] received ${signal}, shutting down`);
  server.close(() => {
    db.close();
    process.exit(0);
  });
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
