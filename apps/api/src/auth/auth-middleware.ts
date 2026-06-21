import type { RequestHandler } from 'express';
import './express-request.js';
import type { AuthService } from './auth-service.js';
import { readSessionToken } from './cookies.js';
import { unauthenticatedError } from './errors.js';

/**
 * Reusable middleware that authenticates a request from the session cookie. It
 * resolves the token, loads the session and user within their tenant scope, and
 * on success attaches a typed `req.auth` context. It rejects every missing,
 * invalid, expired, or revoked session with a generic 401. The authenticated
 * context is derived solely from the server-side session; request input can
 * never supply or override userId or tenantId.
 */
export function createRequireAuth(authService: AuthService): RequestHandler {
  return (request, response, next) => {
    const token = readSessionToken(request);
    const resolved = token ? authService.resolveSession(token) : null;
    if (!resolved) {
      response.status(401).json(unauthenticatedError());
      return;
    }
    request.auth = resolved;
    next();
  };
}
