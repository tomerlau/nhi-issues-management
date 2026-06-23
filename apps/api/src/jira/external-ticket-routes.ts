import { Router } from 'express';
import type { DatabaseSync } from 'node:sqlite';
import '../auth/express-request.js';
import { ApiKeyService } from '../auth/api-key-service.js';
import { createRequireApiKeyAuth } from '../auth/api-key-middleware.js';
import { invalidRequestError } from '../auth/errors.js';
import { TicketService } from './ticket-service.js';
import type { FetchLike } from './jira-client.js';
import { validateTicketBody } from './ticket-validation.js';
import { sendCreateTicketResponse } from './ticket-result-mapper.js';
import { jiraNotConfiguredError } from './jira-errors.js';

export interface ExternalTicketRouterDependencies {
  db: DatabaseSync;
  /** Decoded 32-byte key, or null when Jira is not configured. */
  encryptionKey: Buffer | null;
  /** Injectable transport; defaults to the global fetch in app construction. */
  fetch: FetchLike;
  timeoutMs?: number;
}

/**
 * External-facing ticket creation router mounted at /api/v1/tickets.
 *
 * Authentication: Authorization: Bearer <application-api-key> only.
 * Session cookies are not accepted. Ownership (tenantId, userId) comes
 * exclusively from the stored API-key record; no request input can override it.
 */
export function createExternalTicketRouter(deps: ExternalTicketRouterDependencies): Router {
  const router = Router();

  const apiKeyService = new ApiKeyService(deps.db);
  const requireApiKeyAuth = createRequireApiKeyAuth(apiKeyService);

  // All external ticket responses must never be cached.
  router.use((_request, response, next) => {
    response.setHeader('Cache-Control', 'no-store');
    next();
  });

  // API-key authentication must run before any Jira configuration or connection
  // state is exposed. Session cookies without a valid API key are rejected here.
  router.use(requireApiKeyAuth);

  // Built only when an encryption key is present; otherwise the endpoint reports 503.
  const service = deps.encryptionKey
    ? new TicketService({
        db: deps.db,
        encryptionKey: deps.encryptionKey,
        fetch: deps.fetch,
        timeoutMs: deps.timeoutMs,
      })
    : null;

  router.post('/', (request, response, next) => {
    if (!service) {
      response.status(503).json(jiraNotConfiguredError());
      return;
    }

    const validated = validateTicketBody(request.body);
    if (!validated.ok) {
      response.status(400).json(invalidRequestError(validated.message));
      return;
    }

    // context is guaranteed by requireApiKeyAuth; ownership comes exclusively
    // from the stored key record, never from the request body.
    service
      .createTicket(request.auth!.context, validated.value)
      .then((outcome) => sendCreateTicketResponse(response, outcome))
      .catch(next);
  });

  return router;
}
