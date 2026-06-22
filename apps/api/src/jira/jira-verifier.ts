/**
 * A small, focused Jira credential verifier. It validates a submitted Jira Cloud
 * API token and returns a sanitized outcome, preserving the Milestone 5 contract.
 *
 * It no longer maintains its own HTTP implementation: it delegates to the central
 * `JiraClient`, which owns all Jira HTTP behavior (Basic authentication built in
 * memory, an explicit timeout across the full response lifecycle, no redirect
 * following, and sanitized outcomes). Credentials are validated by loading the
 * Jira account identity (`GET {origin}/rest/api/3/myself`). The HTTP transport is
 * injected so tests never reach live Jira.
 */

import { JiraClient, type FetchLike } from './jira-client.js';

export type { FetchLike };

export type JiraVerifyOutcome =
  | { ok: true; accountId: string }
  | { ok: false; reason: 'credentials_rejected' | 'timeout' | 'unavailable' };

export interface JiraVerifierOptions {
  fetch: FetchLike;
  timeoutMs?: number;
}

export async function verifyJiraCredentials(
  origin: string,
  email: string,
  apiToken: string,
  options: JiraVerifierOptions,
): Promise<JiraVerifyOutcome> {
  const client = new JiraClient({
    origin,
    email,
    apiToken,
    fetch: options.fetch,
    timeoutMs: options.timeoutMs,
  });
  return client.loadAccountIdentity();
}
