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
 * Sanitized outcome of creating a Jira issue. On success it carries only the
 * non-empty Jira issue id and key. A 401 maps to `credentials_rejected`; every
 * other rejection (a Jira-rejected creation, a malformed or invalid response, a
 * redirect, rate limiting, or a 5xx) collapses into `unavailable`, and a stalled
 * request maps to `timeout`. No raw Jira content ever escapes.
 */
export type IssueCreationResult =
  | { ok: true; issueId: string; issueKey: string }
  | { ok: false; reason: 'credentials_rejected' | 'timeout' | 'unavailable' };

export interface CreateIssueInput {
  /** Canonical Jira project id resolved by project validation. */
  projectId: string;
  /** Non-subtask `Task` issue-type id resolved by project validation. */
  issueTypeId: string;
  /** Plain-text issue summary (the validated ticket title). */
  summary: string;
  /** Plain-text description; converted to a minimal ADF document. */
  description: string;
}

/**
 * One runtime-validated Jira issue hydrated by a bulk fetch. It carries only the
 * minimal, current fields the recent-tickets flow needs: the immutable id, the
 * current issue key, the current summary (title), the Jira creation timestamp,
 * and the current project key (used to detect issues that moved to another
 * project). No raw Jira body, self/redirect URL, or other field is exposed.
 */
export interface HydratedJiraIssue {
  id: string;
  key: string;
  summary: string;
  created: string;
  projectKey: string;
}

/**
 * Sanitized outcome of a single bulk fetch. On success it carries only the
 * successfully hydrated, fully validated issues; requested issues that Jira
 * omits (deleted, moved away, or inaccessible) are simply absent and are the
 * caller's responsibility to treat as skipped. A 401 maps to
 * `credentials_rejected`, a stall to `timeout`, and every other rejection — a
 * redirect, rate limit, 5xx, network error, invalid JSON, or a malformed success
 * shape (including a malformed individual issue) — collapses into `unavailable`.
 * Individual Jira issue errors in the response are never read or exposed.
 */
export type BulkFetchResult =
  | { ok: true; issues: HydratedJiraIssue[] }
  | { ok: false; reason: 'credentials_rejected' | 'timeout' | 'unavailable' };

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

/** Extract a non-empty created-issue id and key, validating the shape at runtime. */
function extractCreatedIssue(body: unknown): { id: string; key: string } | null {
  if (typeof body !== 'object' || body === null) {
    return null;
  }
  const record = body as Record<string, unknown>;
  if (!isNonEmptyString(record.id) || !isNonEmptyString(record.key)) {
    return null;
  }
  return { id: record.id, key: record.key };
}

/** The minimal Jira fields requested per issue in a bulk fetch. */
const BULK_FETCH_FIELDS = ['summary', 'created', 'project'] as const;

/**
 * Validate a single hydrated issue's shape at runtime. Returns the sanitized
 * issue or null on any deviation (missing/invalid id, key, summary, created, or
 * project key). A malformed individual issue is treated by the caller as a
 * malformed success response, not a trusted partial result.
 */
function parseHydratedIssue(value: unknown): HydratedJiraIssue | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (!isNonEmptyString(record.id) || !isNonEmptyString(record.key)) {
    return null;
  }
  const fields = record.fields;
  if (typeof fields !== 'object' || fields === null) {
    return null;
  }
  const fieldRecord = fields as Record<string, unknown>;
  if (!isNonEmptyString(fieldRecord.summary) || !isNonEmptyString(fieldRecord.created)) {
    return null;
  }
  const project = fieldRecord.project;
  if (typeof project !== 'object' || project === null) {
    return null;
  }
  const projectKey = (project as Record<string, unknown>).key;
  if (!isNonEmptyString(projectKey)) {
    return null;
  }
  return {
    id: record.id,
    key: record.key,
    summary: fieldRecord.summary,
    created: fieldRecord.created,
    projectKey,
  };
}

/**
 * Validate the complete bulk-fetch success response at runtime. The top-level
 * `issues` array must be present; each present issue must validate fully (a
 * single malformed issue invalidates the whole response). `issueErrors` and any
 * other top-level field are intentionally ignored, so omitted issues are simply
 * absent. Returns the validated issues, or null when the response is malformed.
 */
function parseBulkFetchBody(body: unknown): HydratedJiraIssue[] | null {
  if (typeof body !== 'object' || body === null) {
    return null;
  }
  const issues = (body as Record<string, unknown>).issues;
  if (!Array.isArray(issues)) {
    return null;
  }
  const hydrated: HydratedJiraIssue[] = [];
  for (const item of issues) {
    const issue = parseHydratedIssue(item);
    if (issue === null) {
      return null;
    }
    hydrated.push(issue);
  }
  return hydrated;
}

interface AdfNode {
  type: string;
  text?: string;
  content?: AdfNode[];
  version?: number;
}

/**
 * Convert plain text into a minimal valid Atlassian Document Format document. The
 * text is rendered as a single paragraph in which internal line breaks are
 * preserved deterministically with ADF `hardBreak` nodes: each line becomes a
 * non-empty `text` node (ADF forbids empty text nodes) and consecutive lines are
 * separated by a `hardBreak`. This intentionally supports no HTML, Markdown,
 * rich-text features, mentions, links, or custom fields.
 */
function descriptionToAdf(description: string): AdfNode {
  const lines = description.replace(/\r\n?/g, '\n').split('\n');
  const content: AdfNode[] = [];
  lines.forEach((line, index) => {
    if (index > 0) {
      content.push({ type: 'hardBreak' });
    }
    if (line.length > 0) {
      content.push({ type: 'text', text: line });
    }
  });
  return { type: 'doc', version: 1, content: [{ type: 'paragraph', content }] };
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
   * Create a Jira issue (`POST /rest/api/3/issue`) of the fixed, non-subtask
   * `Task` type. The caller supplies the validated canonical project id and the
   * resolved Task issue-type id; the issue type is never chosen by request input.
   * The description is converted to a minimal ADF document. Returns the non-empty
   * Jira issue id and key, or a sanitized failure.
   */
  async createIssue(input: CreateIssueInput): Promise<IssueCreationResult> {
    const body = {
      fields: {
        project: { id: input.projectId },
        issuetype: { id: input.issueTypeId },
        summary: input.summary,
        description: descriptionToAdf(input.description),
      },
    };
    const outcome = await this.request('/rest/api/3/issue', { method: 'POST', body });
    if (!outcome.ok) {
      switch (outcome.reason) {
        case 'unauthorized':
          return { ok: false, reason: 'credentials_rejected' };
        // A forbidden, not-found, redirect, rate-limit, or 5xx response all mean
        // Jira did not create the issue; none is a credential problem here.
        case 'forbidden':
        case 'not_found':
        case 'unavailable':
          return { ok: false, reason: 'unavailable' };
        case 'timeout':
          return { ok: false, reason: 'timeout' };
      }
    }

    const created = extractCreatedIssue(outcome.body);
    if (created === null) {
      return { ok: false, reason: 'unavailable' };
    }
    return { ok: true, issueId: created.id, issueKey: created.key };
  }

  /**
   * Bulk-fetch issues by their immutable Jira issue ids
   * (`POST /rest/api/3/issue/bulkfetch`) requesting only the minimal
   * `summary`, `created`, and `project` fields. It sends exactly one request and
   * runtime-validates the complete success response, returning only the fully
   * hydrated issues. Jira may return them in any order and may omit deleted,
   * moved, or inaccessible issues; the caller restores local order and treats
   * omitted ids as skipped. A 401 maps to `credentials_rejected`, a stall to
   * `timeout`, and every other rejection (redirect, rate limit, 5xx, network
   * error, invalid JSON, or a malformed success shape) to `unavailable`. No raw
   * Jira content or individual issue error ever escapes.
   */
  async bulkFetchIssues(issueIds: string[]): Promise<BulkFetchResult> {
    const body = {
      issueIdsOrKeys: issueIds,
      fields: [...BULK_FETCH_FIELDS],
    };
    const outcome = await this.request('/rest/api/3/issue/bulkfetch', { method: 'POST', body });
    if (!outcome.ok) {
      switch (outcome.reason) {
        case 'unauthorized':
          return { ok: false, reason: 'credentials_rejected' };
        case 'forbidden':
        case 'not_found':
        case 'unavailable':
          return { ok: false, reason: 'unavailable' };
        case 'timeout':
          return { ok: false, reason: 'timeout' };
      }
    }

    const issues = parseBulkFetchBody(outcome.body);
    if (issues === null) {
      return { ok: false, reason: 'unavailable' };
    }
    return { ok: true, issues };
  }

  /**
   * Perform a single authenticated request against the validated origin and parse
   * a JSON body. GET is the default; passing a body sends a JSON POST. A single
   * try/finally keeps the timeout armed across the request, the status check, and
   * the full body read, so a stall while reading the body maps to `timeout`
   * rather than `unavailable`. Redirects (status 3xx, or an opaque redirect with
   * status 0) and every other non-2xx status are mapped to a sanitized reason; no
   * raw response detail escapes.
   */
  private async request(
    path: string,
    options: { method?: string; body?: unknown } = {},
  ): Promise<RequestOutcome> {
    const url = `${this.origin}${path}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    const headers: Record<string, string> = {
      Authorization: this.authorization,
      Accept: 'application/json',
    };
    const init: RequestInit = {
      method: options.method ?? 'GET',
      headers,
      redirect: 'manual',
      signal: controller.signal,
    };
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(options.body);
    }

    try {
      let response: Response;
      try {
        response = await this.fetch(url, init);
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
