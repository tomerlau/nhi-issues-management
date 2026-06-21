import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from 'express';
import type { DatabaseSync } from 'node:sqlite';
import { AuthService } from './auth/auth-service.js';
import { createAuthRouter } from './auth/auth-routes.js';
import { invalidRequestError } from './auth/errors.js';

export interface AppOptions {
  /**
   * Send the `Secure` attribute on the session cookie. Enabled in production,
   * disabled for local HTTP development. Defaults from NODE_ENV when omitted.
   */
  cookieSecure?: boolean;
}

interface BodyParseError extends Error {
  type?: string;
  status?: number;
}

function isBodyParseError(error: unknown): error is BodyParseError {
  return (
    error instanceof Error &&
    typeof (error as BodyParseError).type === 'string' &&
    typeof (error as BodyParseError).status === 'number'
  );
}

/**
 * Construct and configure the Express application. Process concerns (ports,
 * signals) live in server.ts; the database is injected so the full application
 * can be exercised in-process against an isolated database.
 */
export function createApp(db: DatabaseSync, options: AppOptions = {}): Express {
  const cookieSecure = options.cookieSecure ?? process.env.NODE_ENV === 'production';

  const app = express();
  app.disable('x-powered-by');

  // Unauthenticated and independent of the database, exactly as before.
  app.get('/api/health', (_request, response) => {
    response.status(200).json({ status: 'ok' });
  });

  app.use(express.json({ limit: '10kb' }));

  const authService = new AuthService(db);
  app.use('/api/auth', createAuthRouter(authService, { cookieSecure }));

  // Translate body-parser failures (malformed JSON, payload too large) into the
  // same structured 400 shape the routes use.
  app.use((error: unknown, request: Request, response: Response, next: NextFunction) => {
    if (isBodyParseError(error)) {
      if (request.path.startsWith('/api/auth')) {
        response.setHeader('Cache-Control', 'no-store');
      }
      response.status(400).json(invalidRequestError('Request body could not be parsed.'));
      return;
    }
    next(error);
  });

  return app;
}
