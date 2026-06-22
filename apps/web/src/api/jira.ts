/**
 * Frontend Jira connection API.
 *
 * Talks only to the relative `/api/jira/*` endpoints over the Vite dev proxy and
 * relies exclusively on the backend's HttpOnly session cookie. The Jira
 * connection is a tenant-wide integration: these functions read and replace the
 * single shared connection for the caller's tenant.
 *
 * Security: the API token exists only as a transient argument to
 * {@link saveJiraConnection} and in the outgoing request body. It is never stored
 * here, never returned by the backend, and never logged. Requests, responses,
 * credentials, and raw backend/Jira error text are deliberately never logged.
 */

/** Safe connection status the backend is allowed to expose. No credentials. */
export type JiraConnectionStatus =
  | { connected: false }
  | { connected: true; siteUrl: string; email: string };

/** The connected shape on its own, returned by a successful save. */
export interface JiraConnected {
  connected: true;
  siteUrl: string;
  email: string;
}

/** Fields the user submits to create or replace the shared connection. */
export interface JiraConnectionInput {
  siteUrl: string;
  email: string;
  apiToken: string;
}

/**
 * The distinct Jira API failures the UI reacts to differently. Each maps to safe,
 * generic frontend copy; raw backend or Jira messages are never surfaced.
 */
export type JiraErrorKind =
  | 'invalid_request'
  | 'credentials_rejected'
  | 'not_configured'
  | 'timeout'
  | 'unreachable'
  | 'network'
  | 'authentication'
  | 'server';

/** A typed Jira failure carrying only a UI-safe kind and generic message. */
export class JiraApiError extends Error {
  readonly kind: JiraErrorKind;

  constructor(kind: JiraErrorKind, message: string) {
    super(message);
    this.name = 'JiraApiError';
    this.kind = kind;
  }
}

const JSON_HEADERS = { 'Content-Type': 'application/json', Accept: 'application/json' };

/**
 * Read the structured `{ error: { code } }` envelope without trusting its shape.
 * Returns the backend error code when present, otherwise `undefined`. The backend
 * message is intentionally ignored so raw server text never reaches the user.
 */
async function readErrorCode(response: Response): Promise<string | undefined> {
  try {
    const body: unknown = await response.json();
    if (
      typeof body === 'object' &&
      body !== null &&
      'error' in body &&
      typeof (body as { error: unknown }).error === 'object' &&
      (body as { error: unknown }).error !== null
    ) {
      const code = (body as { error: { code?: unknown } }).error.code;
      if (typeof code === 'string') {
        return code;
      }
    }
  } catch {
    // A missing or non-JSON body is treated as an unknown error code.
  }
  return undefined;
}

/** Map a recognized structured backend error code to a UI error kind. */
function kindForCode(code: string | undefined): JiraErrorKind | undefined {
  switch (code) {
    case 'invalid_request':
      return 'invalid_request';
    case 'jira_credentials_rejected':
      return 'credentials_rejected';
    case 'jira_not_configured':
      return 'not_configured';
    case 'jira_timeout':
      return 'timeout';
    case 'jira_unreachable':
      return 'unreachable';
    case 'unauthenticated':
      return 'authentication';
    default:
      return undefined;
  }
}

/**
 * Translate a non-OK response into a typed {@link JiraApiError}. A recognized
 * structured code wins; otherwise the HTTP status is used, with 401 mapping to an
 * authentication failure and everything else to a generic server failure.
 */
async function errorForResponse(response: Response): Promise<JiraApiError> {
  const kind = kindForCode(await readErrorCode(response));
  if (kind) {
    return new JiraApiError(kind, messageForKind(kind));
  }
  if (response.status === 401) {
    return new JiraApiError('authentication', messageForKind('authentication'));
  }
  return new JiraApiError('server', messageForKind('server'));
}

/** Generic, UI-safe copy for each error kind. Never includes backend text. */
export function messageForKind(kind: JiraErrorKind): string {
  switch (kind) {
    case 'invalid_request':
      return 'Please check the Jira site URL, email, and API token and try again.';
    case 'credentials_rejected':
      return 'Jira rejected this email and API token. Check them and try again.';
    case 'not_configured':
      return 'Jira integration is not configured on the server. Contact an administrator.';
    case 'timeout':
      return 'Jira did not respond in time. Please try again.';
    case 'unreachable':
      return 'Jira could not be reached. Please try again.';
    case 'network':
      return 'Unable to reach the server. Check your connection and try again.';
    case 'authentication':
      return 'Your session is no longer valid. Please sign in again.';
    case 'server':
    default:
      return 'Something went wrong. Please try again.';
  }
}

/**
 * Parse a connection-status body, reading only the safe fields. A `connected:
 * true` body must carry string `siteUrl` and `email`; any other shape (including
 * one with unexpected credential-shaped fields) is reduced to those fields only,
 * and a malformed body throws a `server` {@link JiraApiError}. Extra fields are
 * defensively ignored, so an unexpected token-shaped field is never read.
 */
function parseStatus(body: unknown): JiraConnectionStatus {
  if (typeof body === 'object' && body !== null && 'connected' in body) {
    const connected = (body as { connected: unknown }).connected;
    if (connected === false) {
      return { connected: false };
    }
    if (connected === true) {
      const siteUrl = (body as { siteUrl?: unknown }).siteUrl;
      const email = (body as { email?: unknown }).email;
      if (typeof siteUrl === 'string' && typeof email === 'string') {
        return { connected: true, siteUrl, email };
      }
    }
  }
  throw new JiraApiError('server', messageForKind('server'));
}

/** Read and defensively parse a JSON success body. */
async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new JiraApiError('server', messageForKind('server'));
  }
}

/**
 * Load the tenant's current shared Jira connection status. Resolves to the safe
 * status on HTTP 200, and rejects with a typed {@link JiraApiError} on a network
 * failure, an authentication failure, a missing server configuration, or any
 * unexpected status or malformed body.
 */
export async function getJiraConnection(signal?: AbortSignal): Promise<JiraConnectionStatus> {
  let response: Response;
  try {
    response = await fetch('/api/jira/connection', {
      method: 'GET',
      headers: { Accept: 'application/json' },
      credentials: 'same-origin',
      signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw error;
    }
    throw new JiraApiError('network', messageForKind('network'));
  }

  if (!response.ok) {
    throw await errorForResponse(response);
  }
  return parseStatus(await readJson(response));
}

/**
 * Create or replace the tenant's shared Jira connection. The API token is used
 * only to build this single request body and is never retained. On success the
 * backend returns the safe connected status. Every failure rejects with a typed
 * {@link JiraApiError}; the request is never retried automatically, so a token is
 * never re-sent on the caller's behalf.
 */
export async function saveJiraConnection(input: JiraConnectionInput): Promise<JiraConnected> {
  let response: Response;
  try {
    response = await fetch('/api/jira/connection', {
      method: 'POST',
      headers: JSON_HEADERS,
      credentials: 'same-origin',
      body: JSON.stringify({
        siteUrl: input.siteUrl,
        email: input.email,
        apiToken: input.apiToken,
      }),
    });
  } catch {
    throw new JiraApiError('network', messageForKind('network'));
  }

  if (!response.ok) {
    throw await errorForResponse(response);
  }

  const status = parseStatus(await readJson(response));
  if (!status.connected) {
    // A successful save must report a connected status; anything else is unexpected.
    throw new JiraApiError('server', messageForKind('server'));
  }
  return status;
}
