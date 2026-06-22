/**
 * A small, focused Jira credential verifier. It is intentionally not the
 * reusable Jira integration layer planned for M7: it does one thing, validate a
 * submitted Jira Cloud API token, and returns a sanitized outcome.
 *
 * Credentials are validated with `GET {origin}/rest/api/3/myself` using Jira
 * Cloud Basic authentication (email + API token). The Authorization header is
 * built only in memory for the outbound request and is never persisted or
 * logged. The HTTP transport is injected so tests never reach live Jira.
 */

/** Injectable transport, structurally compatible with the global `fetch`. */
export type FetchLike = typeof fetch;

export type JiraVerifyOutcome =
  | { ok: true; accountId: string }
  | { ok: false; reason: 'credentials_rejected' | 'timeout' | 'unavailable' };

export interface JiraVerifierOptions {
  fetch: FetchLike;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 8000;

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

/** Extract a non-empty Jira account id, validating the response shape at runtime. */
function extractAccountId(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) {
    return null;
  }
  const accountId = (body as Record<string, unknown>).accountId;
  if (typeof accountId !== 'string' || accountId.trim().length === 0) {
    return null;
  }
  return accountId;
}

export async function verifyJiraCredentials(
  origin: string,
  email: string,
  apiToken: string,
  options: JiraVerifierOptions,
): Promise<JiraVerifyOutcome> {
  // Built from the already-validated normalized origin, never from raw input.
  const endpoint = `${origin}/rest/api/3/myself`;
  const authorization = `Basic ${Buffer.from(`${email}:${apiToken}`, 'utf8').toString('base64')}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  // A single try/finally keeps the timeout active across the entire operation —
  // the request, the status evaluation, and the full body read — and clears it
  // only once everything has finished. A timeout that fires while the body is
  // still being read therefore maps to `timeout`, not `unavailable`.
  try {
    let response: Response;
    try {
      response = await options.fetch(endpoint, {
        method: 'GET',
        headers: { Authorization: authorization, Accept: 'application/json' },
        // Do not follow arbitrary redirects to other hosts.
        redirect: 'manual',
        signal: controller.signal,
      });
    } catch (error) {
      return {
        ok: false,
        reason: isAbortError(error) || controller.signal.aborted ? 'timeout' : 'unavailable',
      };
    }

    if (response.status === 401 || response.status === 403) {
      return { ok: false, reason: 'credentials_rejected' };
    }
    // Anything that is not a 2xx success (including 3xx redirects, which are not
    // followed, and opaque redirect responses with status 0) is upstream failure.
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

    const accountId = extractAccountId(body);
    if (accountId === null) {
      return { ok: false, reason: 'unavailable' };
    }

    return { ok: true, accountId };
  } finally {
    clearTimeout(timeout);
  }
}
