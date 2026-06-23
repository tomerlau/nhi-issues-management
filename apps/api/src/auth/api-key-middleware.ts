import type { RequestHandler } from 'express';
import './express-request.js';
import type { ApiKeyService } from './api-key-service.js';
import { unauthenticatedError } from './errors.js';

const BEARER_PREFIX = 'Bearer ';

/**
 * Reusable middleware that authenticates a request from an API key in the
 * `Authorization: Bearer <api-key>` header. On success it attaches a typed
 * `req.auth` context whose userId and tenantId come exclusively from the
 * stored key record. On any failure it returns the same generic 401 with
 * Cache-Control: no-store, intentionally revealing nothing about whether the
 * key ID exists, whether the secret was wrong, or whether the record was
 * deleted.
 */
export function createRequireApiKeyAuth(apiKeyService: ApiKeyService): RequestHandler {
  return (request, response, next) => {
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith(BEARER_PREFIX)) {
      response.setHeader('Cache-Control', 'no-store');
      response.status(401).json(unauthenticatedError());
      return;
    }

    const rawKey = authHeader.slice(BEARER_PREFIX.length);
    const context = apiKeyService.authenticate(rawKey);
    if (!context) {
      response.setHeader('Cache-Control', 'no-store');
      response.status(401).json(unauthenticatedError());
      return;
    }

    // Ownership is derived entirely from the stored key record. No request
    // input (body, query, path, or additional headers) can override it.
    request.auth = { context };
    next();
  };
}
