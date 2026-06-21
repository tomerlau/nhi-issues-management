import express, { type Express } from 'express';

/**
 * Construct and configure the Express application. Kept free of process
 * concerns (ports, signals) so it can be tested in-process without a socket.
 */
export function createApp(): Express {
  const app = express();
  app.disable('x-powered-by');

  app.get('/api/health', (_request, response) => {
    response.status(200).json({ status: 'ok' });
  });

  return app;
}
