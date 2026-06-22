import { Router } from 'express';
import type { DatabaseSync } from 'node:sqlite';
import '../auth/express-request.js';
import type { AuthService } from '../auth/auth-service.js';
import { createRequireAuth } from '../auth/auth-middleware.js';
import { normalizeEmail } from '../auth/auth-context.js';
import { invalidRequestError } from '../auth/errors.js';
import { JiraConnectionService } from './jira-connection-service.js';
import type { FetchLike } from './jira-verifier.js';
import { validateJiraSiteUrl } from './site-url.js';
import {
  jiraCredentialsRejectedError,
  jiraNotConfiguredError,
  jiraTimeoutError,
  jiraUnreachableError,
} from './jira-errors.js';

const MAX_EMAIL_LENGTH = 254;
const MAX_TOKEN_LENGTH = 1024;

interface ConnectionBody {
  /** Raw site URL; validated and normalized separately. */
  siteUrl: string;
  email: string;
  apiToken: string;
}

type Validated<T> = { ok: true; value: T } | { ok: false; message: string };

function validateConnectionBody(body: unknown): Validated<ConnectionBody> {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, message: 'Request body must be a JSON object.' };
  }
  const { siteUrl, email, apiToken } = body as Record<string, unknown>;

  if (typeof siteUrl !== 'string' || typeof email !== 'string' || typeof apiToken !== 'string') {
    return { ok: false, message: 'siteUrl, email and apiToken are required string fields.' };
  }
  if (siteUrl.trim().length === 0 || email.trim().length === 0 || apiToken.length === 0) {
    return { ok: false, message: 'siteUrl, email and apiToken must not be empty.' };
  }
  if (email.length > MAX_EMAIL_LENGTH || apiToken.length > MAX_TOKEN_LENGTH) {
    return { ok: false, message: 'email or apiToken exceeds the allowed length.' };
  }

  return { ok: true, value: { siteUrl, email, apiToken } };
}

export interface JiraRouterDependencies {
  db: DatabaseSync;
  authService: AuthService;
  /** Decoded 32-byte key, or null when Jira is not configured. */
  encryptionKey: Buffer | null;
  /** Injectable transport; defaults to the global fetch in app construction. */
  fetch: FetchLike;
  timeoutMs?: number;
}

export function createJiraRouter(deps: JiraRouterDependencies): Router {
  const router = Router();
  const requireAuth = createRequireAuth(deps.authService);

  // Jira connection responses must never be cached.
  router.use((_request, response, next) => {
    response.setHeader('Cache-Control', 'no-store');
    next();
  });

  // Every Jira endpoint requires an authenticated application session. tenantId
  // and userId come solely from the session, never from request input.
  router.use(requireAuth);

  // Built only when a key is present; otherwise endpoints report 503.
  const service = deps.encryptionKey
    ? new JiraConnectionService({
        db: deps.db,
        encryptionKey: deps.encryptionKey,
        fetch: deps.fetch,
        timeoutMs: deps.timeoutMs,
      })
    : null;

  router.get('/connection', (request, response) => {
    if (!service) {
      response.status(503).json(jiraNotConfiguredError());
      return;
    }
    response.status(200).json(service.getStatus(request.auth!.context));
  });

  router.post('/connection', (request, response, next) => {
    if (!service) {
      response.status(503).json(jiraNotConfiguredError());
      return;
    }

    const validated = validateConnectionBody(request.body);
    if (!validated.ok) {
      response.status(400).json(invalidRequestError(validated.message));
      return;
    }

    // SSRF boundary: validate the URL before any network request occurs.
    const site = validateJiraSiteUrl(validated.value.siteUrl);
    if (!site.ok) {
      response.status(400).json(invalidRequestError(site.message));
      return;
    }

    service
      .connect(request.auth!.context, {
        origin: site.origin,
        email: normalizeEmail(validated.value.email),
        apiToken: validated.value.apiToken,
      })
      .then((outcome) => {
        switch (outcome.status) {
          case 'connected':
            response
              .status(200)
              .json({ connected: true, siteUrl: outcome.siteUrl, email: outcome.email });
            return;
          case 'credentials_rejected':
            response.status(422).json(jiraCredentialsRejectedError());
            return;
          case 'timeout':
            response.status(504).json(jiraTimeoutError());
            return;
          case 'unavailable':
            response.status(502).json(jiraUnreachableError());
            return;
        }
      })
      .catch(next);
  });

  return router;
}
