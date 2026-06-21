import { createApp } from './app.js';

const port = 3001;

const app = createApp();

const server = app.listen(port, () => {
  console.log(`[api] listening on http://localhost:${port}`);
});

const shutdown = (signal: NodeJS.Signals): void => {
  console.log(`[api] received ${signal}, shutting down`);
  server.close(() => process.exit(0));
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
