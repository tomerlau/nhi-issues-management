/**
 * The single backend abstraction for authenticated Jira Cloud REST access. It
 * owns all Jira HTTP behavior so the rest of the application never builds Jira
 * requests, handles Jira responses, or touches the Authorization header
 * directly. It is intentionally small and Jira-specific — not a general-purpose
 * Atlassian SDK.
 *
 * Security properties:
 * - Requests target only the already-validated direct Jira Cloud `origin`; the
 *   URL is built from that origin plus application-controlled paths, never from
 *   raw input or a response's own URL.
 * - Basic authentication is built once in memory from the Atlassian email and
 *   decrypted API token. The plaintext token and the Authorization header are
 *   never persisted, logged, or returned.
 * - Redirects are never followed (`redirect: 'manual'`).
 * - An explicit timeout bounds the entire response lifecycle, including the full
 *   body read.
 * - No raw Jira body, network error, redirect location, stack trace, or internal
 *   exception message is ever returned; every failure is a sanitized outcome.
 */

/** Injectable transport, structurally compatible with the global `fetch`. */
export type FetchLike = typeof fetch;

const DEFAULT_TIMEOUT_MS = 8000;

/** The fixed issue type this POC requires; matched by exact name, non-subtask. */
const REQUIRED_ISSUE_TYPE_NAME = 'Task';

export interface JiraClientOptions {
  /** Already-validated, normalized HTTPS Jira Cloud origin (no trailing slash). */
  origin: string;
  /** Atlassian account email used for Basic authentication. */
  email: string;
  /** Decrypted Jira API token; held only in memory for the client's lifetime. */
  apiToken: string;
  /** Injectable transport; the global `fetch` in production. */
  fetch: FetchLike;
  /** Outbound request timeout in milliseconds. */
  timeoutMs?: number;
}

export type AccountIdentityResult =
  | { ok: true; accountId: string }
  | { ok: false; reason: 'credentials_rejected' | 'timeout' | 'unavailable' };

export type ProjectValidationResult =
  | { ok: true; projectId: string; projectKey: string; taskIssueTypeId: string }
  | {
      ok: false;
      reason:
        | 'project_inaccessible'
        | 'task_unsupported'
        | 'credentials_rejected'
        | 'timeout'
        | 'unavailable';
    };

/**
 * Sanitized low-level outcome of a single Jira request, with the body parsed on
 * success. The failure reasons are deliberately HTTP-shaped (`unauthorized` vs
 * `forbidden` kept distinct) so each public operation can apply its own contract:
 * `/myself` treats both as rejected credentials, while project validation treats
 * a 403 as an inaccessible project rather than invalid credentials.
 */
type RequestOutcome =
  | { ok: true; body: unknown }
  | {
      ok: false;
      reason: 'unauthorized' | 'forbidden' | 'not_found' | 'timeout' | 'unavailable';
    };

interface JiraIssueType {
  id: string;
  name: string;
  subtask: boolean;
}

interface JiraProject {
  id: string;
  key: string;
  issueTypes: JiraIssueType[];
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Extract a non-empty Jira account id, validating the response shape at runtime. */
function extractAccountId(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) {
    return null;
  }
  const accountId = (body as Record<string, unknown>).accountId;
  return isNonEmptyString(accountId) ? accountId : null;
}

function parseIssueType(value: unknown): JiraIssueType | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (!isNonEmptyString(record.id) || typeof record.name !== 'string' || typeof record.subtask !== 'boolean') {
    return null;
  }
  return { id: record.id, name: record.name, subtask: record.subtask };
}

/** Validate the project response shape at runtime; return null on any deviation. */
function parseProject(body: unknown): JiraProject | null {
  if (typeof body !== 'object' || body === null) {
    return null;
  }
  const record = body as Record<string, unknown>;
  if (!isNonEmptyString(record.id) || !isNonEmptyString(record.key) || !Array.isArray(record.issueTypes)) {
    return null;
  }
  const issueTypes: JiraIssueType[] = [];
  for (const item of record.issueTypes) {
    const issueType = parseIssueType(item);
    if (issueType === null) {
      return null;
    }
    issueTypes.push(issueType);
  }
  return { id: record.id, key: record.key, issueTypes };
}

/** The id of a non-subtask issue type named exactly `Task`, or null if absent. */
function findTaskIssueTypeId(issueTypes: JiraIssueType[]): string | null {
  const match = issueTypes.find(
    (issueType) => issueType.subtask === false && issueType.name === REQUIRED_ISSUE_TYPE_NAME,
  );
  return match ? match.id : null;
}

export class JiraClient {
  private readonly origin: string;
  private readonly authorization: string;
  private readonly fetch: FetchLike;
  private readonly timeoutMs: number;

  constructor(options: JiraClientOptions) {
    this.origin = options.origin;
    // Built once in memory; never stored as plaintext token, never logged.
    this.authorization = `Basic ${Buffer.from(`${options.email}:${options.apiToken}`, 'utf8').toString('base64')}`;
    this.fetch = options.fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * Load the current Jira account identity (`GET /rest/api/3/myself`). Used by
   * the credential-verification flow. Returns the account id or a sanitized
   * failure.
   */
  async loadAccountIdentity(): Promise<AccountIdentityResult> {
    const outcome = await this.request('/rest/api/3/myself');
    if (!outcome.ok) {
      switch (outcome.reason) {
        // Credential verification treats both 401 and 403 as rejected credentials.
        case 'unauthorized':
        case 'forbidden':
          return { ok: false, reason: 'credentials_rejected' };
        case 'timeout':
          return { ok: false, reason: 'timeout' };
        // /myself never legitimately 404s; not_found is treated as unavailable.
        case 'not_found':
        case 'unavailable':
          return { ok: false, reason: 'unavailable' };
      }
    }
    const accountId = extractAccountId(outcome.body);
    if (accountId === null) {
      return { ok: false, reason: 'unavailable' };
    }
    return { ok: true, accountId };
  }

  /**
   * Validate a Jira project and resolve the fixed `Task` issue type
   * (`GET /rest/api/3/project/{projectIdOrKey}?expand=issueTypes`). Returns the
   * project id, canonical key, and the non-subtask `Task` issue-type id, or a
   * sanitized failure distinguishing an inaccessible project from one that does
   * not support `Task`.
   */
  async validateProject(projectIdOrKey: string): Promise<ProjectValidationResult> {
    // The dynamic project identifier is encoded; the rest of the path and the
    // query are fixed application-controlled values.
    const path = `/rest/api/3/project/${encodeURIComponent(projectIdOrKey)}?expand=issueTypes`;
    const outcome = await this.request(path);
    if (!outcome.ok) {
      switch (outcome.reason) {
        case 'unauthorized':
          return { ok: false, reason: 'credentials_rejected' };
        // A 403 means the authenticated account cannot access this project, not
        // that the Jira credentials themselves are invalid.
        case 'forbidden':
        case 'not_found':
          return { ok: false, reason: 'project_inaccessible' };
        case 'timeout':
          return { ok: false, reason: 'timeout' };
        case 'unavailable':
          return { ok: false, reason: 'unavailable' };
      }
    }

    const project = parseProject(outcome.body);
    if (project === null) {
      return { ok: false, reason: 'unavailable' };
    }
    const taskIssueTypeId = findTaskIssueTypeId(project.issueTypes);
    if (taskIssueTypeId === null) {
      return { ok: false, reason: 'task_unsupported' };
    }
    return { ok: true, projectId: project.id, projectKey: project.key, taskIssueTypeId };
  }

  /**
   * Perform a single authenticated GET against the validated origin and parse a
   * JSON body. A single try/finally keeps the timeout armed across the request,
   * the status check, and the full body read, so a stall while reading the body
   * maps to `timeout` rather than `unavailable`. Redirects (status 3xx, or an
   * opaque redirect with status 0) and every other non-2xx status are mapped to
   * a sanitized reason; no raw response detail escapes.
   */
  private async request(path: string): Promise<RequestOutcome> {
    const url = `${this.origin}${path}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      let response: Response;
      try {
        response = await this.fetch(url, {
          method: 'GET',
          headers: { Authorization: this.authorization, Accept: 'application/json' },
          redirect: 'manual',
          signal: controller.signal,
        });
      } catch (error) {
        return {
          ok: false,
          reason: isAbortError(error) || controller.signal.aborted ? 'timeout' : 'unavailable',
        };
      }

      if (response.status === 401) {
        return { ok: false, reason: 'unauthorized' };
      }
      if (response.status === 403) {
        return { ok: false, reason: 'forbidden' };
      }
      if (response.status === 404) {
        return { ok: false, reason: 'not_found' };
      }
      // Anything that is not 2xx — including 3xx redirects (not followed), opaque
      // redirects with status 0, 429 rate limiting, and 5xx — is upstream failure.
      if (response.status < 200 || response.status >= 300) {
        return { ok: false, reason: 'unavailable' };
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch (error) {
        return {
          ok: false,
          reason: isAbortError(error) || controller.signal.aborted ? 'timeout' : 'unavailable',
        };
      }
      return { ok: true, body };
    } finally {
      clearTimeout(timeout);
    }
  }
}
