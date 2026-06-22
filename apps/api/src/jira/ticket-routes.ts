import { Router } from 'express';
import type { DatabaseSync } from 'node:sqlite';
import '../auth/express-request.js';
import type { AuthService } from '../auth/auth-service.js';
import { createRequireAuth } from '../auth/auth-middleware.js';
import { internalError, invalidRequestError } from '../auth/errors.js';
import { TicketService } from './ticket-service.js';
import { RecentTicketsService } from './recent-tickets-service.js';
import type { TicketCreationInput } from './jira-integration-service.js';
import type { FetchLike } from './jira-client.js';
import {
  jiraNotConfiguredError,
  jiraNotConnectedError,
  jiraProjectInaccessibleError,
  jiraStoredCredentialsRejectedError,
  jiraTaskUnsupportedError,
  jiraTimeoutError,
  jiraUnreachableError,
} from './jira-errors.js';

const MAX_PROJECT_KEY_LENGTH = 10;
const MAX_TITLE_LENGTH = 255;
const MAX_DESCRIPTION_LENGTH = 5000;

// Conservative Jira project-key syntax: an uppercase letter followed by one or
// more uppercase letters or digits (2-10 characters after normalization).
const PROJECT_KEY_PATTERN = /^[A-Z][A-Z0-9]+$/;

type Validated<T> = { ok: true; value: T } | { ok: false; message: string };

/**
 * Validate the ticket request body fully before any Jira network request. Only
 * the three domain inputs are read; any client-supplied tenantId, userId,
 * connectionId, siteUrl, issueType, or ownership field is ignored.
 */
function validateTicketBody(body: unknown): Validated<TicketCreationInput> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, message: 'Request body must be a JSON object.' };
  }
  const { projectKey, title, description } = body as Record<string, unknown>;

  if (typeof projectKey !== 'string' || typeof title !== 'string' || typeof description !== 'string') {
    return { ok: false, message: 'projectKey, title and description are required string fields.' };
  }

  const normalizedProjectKey = projectKey.trim().toUpperCase();
  if (normalizedProjectKey.length === 0) {
    return { ok: false, message: 'projectKey must not be empty.' };
  }
  if (normalizedProjectKey.length > MAX_PROJECT_KEY_LENGTH || !PROJECT_KEY_PATTERN.test(normalizedProjectKey)) {
    return { ok: false, message: 'projectKey is not a valid Jira project key.' };
  }

  const trimmedTitle = title.trim();
  if (trimmedTitle.length === 0) {
    return { ok: false, message: 'title must not be empty.' };
  }
  if (trimmedTitle.length > MAX_TITLE_LENGTH) {
    return { ok: false, message: 'title exceeds the allowed length.' };
  }

  // trim() removes surrounding whitespace (including leading/trailing newlines)
  // while preserving meaningful internal line breaks.
  const trimmedDescription = description.trim();
  if (trimmedDescription.length === 0) {
    return { ok: false, message: 'description must not be empty.' };
  }
  if (trimmedDescription.length > MAX_DESCRIPTION_LENGTH) {
    return { ok: false, message: 'description exceeds the allowed length.' };
  }

  return {
    ok: true,
    value: {
      projectKey: normalizedProjectKey,
      title: trimmedTitle,
      description: trimmedDescription,
    },
  };
}

/**
 * Validate and normalize the `projectKey` query parameter for the recent-tickets
 * read. It must be present exactly once as a non-empty string and match the same
 * conservative Jira project-key syntax and length used for ticket creation. A
 * repeated `projectKey` is parsed by Express as an array and is rejected, so no
 * ambiguous or duplicated value can reach the query. No tenant, site, connection,
 * credential, limit, cursor, or ownership value is ever read from the request.
 */
function validateProjectKeyQuery(raw: unknown): Validated<string> {
  if (typeof raw !== 'string') {
    // Missing (undefined), repeated (array), or otherwise non-string.
    return { ok: false, message: 'projectKey is required and must be a single value.' };
  }
  const normalizedProjectKey = raw.trim().toUpperCase();
  if (normalizedProjectKey.length === 0) {
    return { ok: false, message: 'projectKey must not be empty.' };
  }
  if (normalizedProjectKey.length > MAX_PROJECT_KEY_LENGTH || !PROJECT_KEY_PATTERN.test(normalizedProjectKey)) {
    return { ok: false, message: 'projectKey is not a valid Jira project key.' };
  }
  return { ok: true, value: normalizedProjectKey };
}

export interface TicketRouterDependencies {
  db: DatabaseSync;
  authService: AuthService;
  /** Decoded 32-byte key, or null when Jira is not configured. */
  encryptionKey: Buffer | null;
  /** Injectable transport; defaults to the global fetch in app construction. */
  fetch: FetchLike;
  timeoutMs?: number;
}

export function createTicketRouter(deps: TicketRouterDependencies): Router {
  const router = Router();
  const requireAuth = createRequireAuth(deps.authService);

  // Ticket responses must never be cached.
  router.use((_request, response, next) => {
    response.setHeader('Cache-Control', 'no-store');
    next();
  });

  // Every ticket endpoint requires an authenticated application session.
  // tenantId and userId come solely from the session; the body validator reads
  // only projectKey, title, and description, so no client-supplied ownership
  // field can influence the result.
  router.use(requireAuth);

  // Built only when a key is present; otherwise the endpoints report 503.
  const service = deps.encryptionKey
    ? new TicketService({
        db: deps.db,
        encryptionKey: deps.encryptionKey,
        fetch: deps.fetch,
        timeoutMs: deps.timeoutMs,
      })
    : null;

  const recentTicketsService = deps.encryptionKey
    ? new RecentTicketsService({
        db: deps.db,
        encryptionKey: deps.encryptionKey,
        fetch: deps.fetch,
        timeoutMs: deps.timeoutMs,
      })
    : null;

  router.get('/', (request, response, next) => {
    if (!recentTicketsService) {
      response.status(503).json(jiraNotConfiguredError());
      return;
    }

    const validated = validateProjectKeyQuery(request.query.projectKey);
    if (!validated.ok) {
      response.status(400).json(invalidRequestError(validated.message));
      return;
    }

    recentTicketsService
      .listRecentTickets(request.auth!.context, { projectKey: validated.value })
      .then((outcome) => {
        switch (outcome.status) {
          case 'ok':
            response.status(200).json({ tickets: outcome.tickets });
            return;
          case 'not_connected':
            response.status(409).json(jiraNotConnectedError());
            return;
          case 'credentials_rejected':
            response.status(502).json(jiraStoredCredentialsRejectedError());
            return;
          case 'unavailable':
            response.status(502).json(jiraUnreachableError());
            return;
          case 'timeout':
            response.status(504).json(jiraTimeoutError());
            return;
          case 'configuration_error':
            response.status(503).json(jiraNotConfiguredError());
            return;
        }
      })
      .catch(next);
  });

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

    service
      .createTicket(request.auth!.context, validated.value)
      .then((outcome) => {
        switch (outcome.status) {
          case 'created':
            response.status(201).json({ issueId: outcome.issueId, issueKey: outcome.issueKey });
            return;
          case 'not_connected':
            response.status(409).json(jiraNotConnectedError());
            return;
          case 'project_inaccessible':
            response.status(422).json(jiraProjectInaccessibleError());
            return;
          case 'task_unsupported':
            response.status(422).json(jiraTaskUnsupportedError());
            return;
          case 'credentials_rejected':
            response.status(502).json(jiraStoredCredentialsRejectedError());
            return;
          case 'unavailable':
            response.status(502).json(jiraUnreachableError());
            return;
          case 'timeout':
            response.status(504).json(jiraTimeoutError());
            return;
          case 'configuration_error':
            response.status(503).json(jiraNotConfiguredError());
            return;
          case 'persistence_failed':
            response.status(500).json(internalError());
            return;
        }
      })
      .catch(next);
  });

  return router;
}
