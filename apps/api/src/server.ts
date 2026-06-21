import { createApp } from './app.js';
import { resolveDatabasePath } from './config/database.js';
import { initializeDatabase } from './database/lifecycle.js';

const port = 3001;

const databasePath = resolveDatabasePath();
const db = initializeDatabase(databasePath);
console.log(`[api] database ready at ${databasePath}`);

const app = createApp(db, { cookieSecure: process.env.NODE_ENV === 'production' });

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
