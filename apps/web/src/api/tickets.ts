/**
 * Frontend ticket API: creation and recent-ticket listing.
 *
 * Talks only to the relative `/api/tickets` endpoint over the Vite dev proxy and
 * relies exclusively on the backend's HttpOnly session cookie. The tenant and the
 * creating user are derived entirely from that server-side session: this module
 * sends only the three domain fields (projectKey, title, description) and never an
 * ownership, tenant, user, connection, site, or issue-type field.
 *
 * Security: requests, responses, and errors are never logged, and raw backend or
 * Jira error text is never surfaced. The creation request is never retried
 * automatically, because an unconfirmed creation could be duplicated by a retry.
 */

// ---------------------------------------------------------------------------
// Ticket creation
// ---------------------------------------------------------------------------

/** The exact fields the user submits to create a ticket. Nothing else is sent. */
export interface TicketCreationRequest {
  projectKey: string;
  title: string;
  description: string;
}

/** The safe success shape the backend returns for a created Jira issue. */
export interface CreatedTicket {
  issueId: string;
  issueKey: string;
}

/**
 * The distinct ticket-creation failures the UI reacts to differently. Each maps to
 * safe, generic frontend copy; raw backend or Jira messages are never surfaced.
 *
 * Several kinds are *uncertain* outcomes: because ticket creation is not
 * idempotent, the failure may have happened after Jira already created the issue,
 * so the UI must warn the user to check Jira before retrying rather than encourage
 * a blind retry. See {@link isUncertainTicketOutcome}.
 */
export type TicketErrorKind =
  | 'invalid_request'
  | 'authentication'
  | 'not_connected'
  | 'project_inaccessible'
  | 'task_unsupported'
  | 'credentials_rejected'
  | 'timeout'
  | 'unreachable'
  | 'not_configured'
  | 'network'
  | 'server';

/** A typed ticket failure carrying only a UI-safe kind and generic message. */
export class TicketApiError extends Error {
  readonly kind: TicketErrorKind;

  constructor(kind: TicketErrorKind, message: string) {
    super(message);
    this.name = 'TicketApiError';
    this.kind = kind;
  }
}

const JSON_HEADERS = { 'Content-Type': 'application/json', Accept: 'application/json' };

/**
 * Whether the outcome leaves it genuinely unknown whether Jira created the issue.
 * Because ticket creation is not idempotent, this covers every failure that can
 * occur after the request leaves the browser: an upstream timeout or unreachable
 * Jira, a browser/network failure where the response was never seen, and any
 * unexpected server outcome (including a server-side persistence failure that
 * happens *after* Jira created the issue). The UI uses this to show the
 * "check Jira before retrying" duplicate-risk warning instead of a blind retry.
 */
export function isUncertainTicketOutcome(kind: TicketErrorKind): boolean {
  return (
    kind === 'timeout' || kind === 'unreachable' || kind === 'network' || kind === 'server'
  );
}

/** Generic, UI-safe copy for each error kind. Never includes backend text. */
export function messageForTicketError(kind: TicketErrorKind): string {
  switch (kind) {
    case 'invalid_request':
      return 'Please check the project key, title, and description and try again.';
    case 'authentication':
      return 'Your session is no longer valid. Please sign in again.';
    case 'not_connected':
      return 'Your tenant is no longer connected to Jira. Connect Jira and try again.';
    case 'project_inaccessible':
      return 'That Jira project could not be found or is not accessible. Check the project key and try again.';
    case 'task_unsupported':
      return 'That Jira project does not support the Task issue type, so a ticket could not be created.';
    case 'credentials_rejected':
      return 'The stored Jira credentials were rejected. Reconnect Jira and try again.';
    case 'timeout':
      return 'Jira did not respond in time, so we could not confirm whether the ticket was created. Check Jira before trying again, because retrying may create a duplicate.';
    case 'unreachable':
      return 'We could not confirm whether Jira created the ticket. Check Jira before trying again, because retrying may create a duplicate.';
    case 'not_configured':
      return 'Jira integration is not configured on the server. Contact an administrator.';
    case 'network':
      return 'We could not reach the server to confirm whether the ticket was created. The ticket may already exist in Jira, so check Jira before trying again, because retrying may create a duplicate.';
    case 'server':
    default:
      return 'Something went wrong, so we could not confirm whether the ticket was created. The ticket may already exist in Jira, so check Jira before trying again, because retrying may create a duplicate.';
  }
}

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
function kindForCode(code: string | undefined): TicketErrorKind | undefined {
  switch (code) {
    case 'invalid_request':
      return 'invalid_request';
    case 'unauthenticated':
      return 'authentication';
    case 'jira_not_connected':
      return 'not_connected';
    case 'jira_project_inaccessible':
      return 'project_inaccessible';
    case 'jira_task_unsupported':
      return 'task_unsupported';
    case 'jira_credentials_rejected':
      return 'credentials_rejected';
    case 'jira_timeout':
      return 'timeout';
    case 'jira_unreachable':
      return 'unreachable';
    case 'jira_not_configured':
      return 'not_configured';
    case 'internal_error':
      return 'server';
    default:
      return undefined;
  }
}

/**
 * Translate a non-OK response into a typed {@link TicketApiError}. A recognized
 * structured code wins; otherwise the HTTP status is used, with 401 mapping to an
 * authentication failure and everything else to a generic server failure.
 */
async function errorForResponse(response: Response): Promise<TicketApiError> {
  const kind = kindForCode(await readErrorCode(response));
  if (kind) {
    return new TicketApiError(kind, messageForTicketError(kind));
  }
  if (response.status === 401) {
    return new TicketApiError('authentication', messageForTicketError('authentication'));
  }
  return new TicketApiError('server', messageForTicketError('server'));
}

/** Read and defensively parse a JSON success body. */
async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new TicketApiError('server', messageForTicketError('server'));
  }
}

/**
 * Defensively parse a creation-success body, reading only the safe identifiers. A
 * created ticket must carry non-empty string `issueId` and `issueKey`; any other
 * shape is reduced to a `server` {@link TicketApiError}. Extra fields are ignored.
 */
function parseCreated(body: unknown): CreatedTicket {
  if (typeof body === 'object' && body !== null) {
    const issueId = (body as { issueId?: unknown }).issueId;
    const issueKey = (body as { issueKey?: unknown }).issueKey;
    if (
      typeof issueId === 'string' &&
      issueId.length > 0 &&
      typeof issueKey === 'string' &&
      issueKey.length > 0
    ) {
      return { issueId, issueKey };
    }
  }
  throw new TicketApiError('server', messageForTicketError('server'));
}

/**
 * Create a Jira issue for the caller's tenant. Resolves to the safe issue id/key on
 * HTTP 201, and rejects with a typed {@link TicketApiError} on validation,
 * connection, Jira, authentication, network, or unexpected-server failures. The
 * request is never retried automatically.
 */
export async function createTicket(input: TicketCreationRequest): Promise<CreatedTicket> {
  let response: Response;
  try {
    response = await fetch('/api/tickets', {
      method: 'POST',
      headers: JSON_HEADERS,
      credentials: 'same-origin',
      body: JSON.stringify({
        projectKey: input.projectKey,
        title: input.title,
        description: input.description,
      }),
    });
  } catch {
    throw new TicketApiError('network', messageForTicketError('network'));
  }

  if (!response.ok) {
    throw await errorForResponse(response);
  }

  return parseCreated(await readJson(response));
}

// ---------------------------------------------------------------------------
// Recent-ticket listing
// ---------------------------------------------------------------------------

/** A single recent ticket returned by the server, with values hydrated from Jira. */
export interface RecentTicket {
  issueId: string;
  issueKey: string;
  title: string;
  createdAt: string;
  url: string;
}

/** The success shape for a recent-ticket list response. */
export interface ListRecentTicketsResult {
  tickets: RecentTicket[];
}

/**
 * Error kinds for recent-ticket read failures. These are never uncertain outcomes
 * (no ticket is created on a read), so no duplicate-creation warning applies.
 */
export type RecentTicketsErrorKind =
  | 'invalid_request'
  | 'authentication'
  | 'not_connected'
  | 'credentials_rejected'
  | 'timeout'
  | 'unreachable'
  | 'not_configured'
  | 'internal_error'
  | 'network'
  | 'server';

/** A typed read failure carrying only a UI-safe kind. */
export class RecentTicketsApiError extends Error {
  readonly kind: RecentTicketsErrorKind;

  constructor(kind: RecentTicketsErrorKind, message: string) {
    super(message);
    this.name = 'RecentTicketsApiError';
    this.kind = kind;
  }
}

/** Generic, UI-safe copy for each read error kind. Never includes backend text. */
export function messageForReadError(kind: RecentTicketsErrorKind): string {
  switch (kind) {
    case 'invalid_request':
      return 'The project key is not valid.';
    case 'authentication':
      return 'Your session is no longer valid. Please sign in again.';
    case 'not_connected':
      return 'Your tenant is not connected to Jira. Connect Jira to view recent tickets.';
    case 'credentials_rejected':
      return 'The stored Jira credentials were rejected. Reconnect Jira and try again.';
    case 'timeout':
      return 'Jira did not respond in time. Try again.';
    case 'unreachable':
      return 'Jira could not be reached. Try again.';
    case 'not_configured':
      return 'Jira integration is not configured on the server. Contact an administrator.';
    case 'internal_error':
      return 'Something went wrong on the server. Try again.';
    case 'network':
      return 'Unable to reach the server. Try again.';
    case 'server':
    default:
      return 'Something went wrong. Try again.';
  }
}

/** Whether a URL is a safe Jira Cloud issue URL on an *.atlassian.net host. */
function isValidJiraUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === 'https:' &&
      /^[^.]+\.atlassian\.net$/.test(parsed.hostname) &&
      parsed.pathname.startsWith('/browse/')
    );
  } catch {
    return false;
  }
}

/** Map a backend error code to a read error kind. */
function readKindForCode(code: string | undefined): RecentTicketsErrorKind | undefined {
  switch (code) {
    case 'invalid_request':
      return 'invalid_request';
    case 'unauthenticated':
      return 'authentication';
    case 'jira_not_connected':
      return 'not_connected';
    case 'jira_credentials_rejected':
      return 'credentials_rejected';
    case 'jira_timeout':
      return 'timeout';
    case 'jira_unreachable':
      return 'unreachable';
    case 'jira_not_configured':
      return 'not_configured';
    case 'internal_error':
      return 'internal_error';
    default:
      return undefined;
  }
}

async function readErrorCodeForRead(response: Response): Promise<string | undefined> {
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
    // Non-JSON or missing body: return undefined for unknown mapping.
  }
  return undefined;
}

async function readErrorForResponse(response: Response): Promise<RecentTicketsApiError> {
  const kind = readKindForCode(await readErrorCodeForRead(response));
  if (kind) {
    return new RecentTicketsApiError(kind, messageForReadError(kind));
  }
  if (response.status === 401) {
    return new RecentTicketsApiError('authentication', messageForReadError('authentication'));
  }
  return new RecentTicketsApiError('server', messageForReadError('server'));
}

/**
 * Defensively validate a ticket item from the response. Returns the parsed item or
 * throws a `server` {@link RecentTicketsApiError} if the item is malformed.
 */
function parseTicketItem(item: unknown): RecentTicket {
  if (typeof item !== 'object' || item === null) {
    throw new RecentTicketsApiError('server', messageForReadError('server'));
  }

  const r = item as Record<string, unknown>;

  if (
    typeof r.issueId !== 'string' || r.issueId.length === 0 ||
    typeof r.issueKey !== 'string' || r.issueKey.length === 0 ||
    typeof r.title !== 'string' || r.title.length === 0 ||
    typeof r.createdAt !== 'string' || r.createdAt.length === 0 ||
    typeof r.url !== 'string' || r.url.length === 0
  ) {
    throw new RecentTicketsApiError('server', messageForReadError('server'));
  }

  if (isNaN(new Date(r.createdAt).getTime())) {
    throw new RecentTicketsApiError('server', messageForReadError('server'));
  }

  if (!isValidJiraUrl(r.url)) {
    throw new RecentTicketsApiError('server', messageForReadError('server'));
  }

  return {
    issueId: r.issueId,
    issueKey: r.issueKey,
    title: r.title,
    createdAt: r.createdAt,
    url: r.url,
  };
}

/**
 * Parse and validate the full recent-tickets success response. Throws a `server`
 * error if the top-level shape is wrong or any ticket item is malformed.
 */
function parseRecentTicketsBody(body: unknown): RecentTicket[] {
  if (
    typeof body !== 'object' ||
    body === null ||
    !Array.isArray((body as { tickets?: unknown }).tickets)
  ) {
    throw new RecentTicketsApiError('server', messageForReadError('server'));
  }

  return ((body as { tickets: unknown[] }).tickets).map(parseTicketItem);
}

/**
 * List the ten most recent tickets for the caller's tenant and the given project.
 * Resolves to `{ tickets }` on success. Rejects with {@link RecentTicketsApiError}
 * on server, Jira, authentication, network, or malformed-response failures.
 *
 * An aborted request propagates the `AbortError` from fetch so callers can
 * distinguish abort from a real network failure.
 */
export async function listRecentTickets(
  projectKey: string,
  signal?: AbortSignal,
): Promise<ListRecentTicketsResult> {
  const params = new URLSearchParams({ projectKey });
  let response: Response;
  try {
    response = await fetch(`/api/tickets?${params.toString()}`, {
      method: 'GET',
      credentials: 'same-origin',
      signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw err;
    }
    throw new RecentTicketsApiError('network', messageForReadError('network'));
  }

  if (!response.ok) {
    throw await readErrorForResponse(response);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new RecentTicketsApiError('server', messageForReadError('server'));
  }

  return { tickets: parseRecentTicketsBody(body) };
}
