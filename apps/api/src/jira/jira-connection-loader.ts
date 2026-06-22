import { JiraConnectionRepository } from '../repositories/jira-connection-repository.js';
import type { AuthContext } from '../auth/auth-context.js';
import { decryptToken } from './token-cipher.js';
import { validateJiraSiteUrl } from './site-url.js';
import { JiraClient, type FetchLike } from './jira-client.js';

/**
 * The tenant's loaded Jira connection snapshot together with a single short-lived
 * client bound to it. `origin` is the re-validated current Jira Cloud origin and
 * is the only trusted base for constructing safe issue URLs. The snapshot is
 * captured once so an entire multi-batch request reuses the same site and client
 * even if another tenant user replaces the connection concurrently.
 */
export interface LoadedTenantConnection {
  client: JiraClient;
  /** Re-validated current Jira Cloud origin (e.g. https://acme.atlassian.net). */
  origin: string;
  /** Stored site URL of the currently connected Jira site. */
  siteUrl: string;
}

/**
 * Sanitized outcome of loading the tenant's shared Jira connection. A missing
 * connection is distinct from a configuration failure (an invalid stored site URL
 * or an undecryptable token), and no variant ever carries the plaintext token.
 */
export type LoadTenantConnectionResult =
  | { ok: true; connection: LoadedTenantConnection }
  | { ok: false; status: 'not_connected' | 'configuration_error' };

export interface LoadTenantConnectionOptions {
  repository: JiraConnectionRepository;
  encryptionKey: Buffer;
  fetch: FetchLike;
  timeoutMs?: number;
}

/**
 * Load the tenant's single shared Jira connection exactly once and construct one
 * short-lived JiraClient bound to it. This narrowly-scoped helper mirrors the
 * existing integration-service connection handling: the connection is loaded only
 * through the tenant boundary (`findByTenant(context.tenantId)`), the stored site
 * URL is re-validated before any network use (defense in depth), and the token is
 * decrypted just-in-time bound to the stored tenant alone — every decryption
 * failure collapses into one sanitized `configuration_error`.
 *
 * Callers reuse the returned client and origin snapshot for every batch in a
 * single request and must not reload the connection between batches, so one
 * request can never mix two Jira sites if the tenant connection is replaced
 * concurrently.
 */
export function loadTenantConnection(
  options: LoadTenantConnectionOptions,
  context: AuthContext,
): LoadTenantConnectionResult {
  const connection = options.repository.findByTenant(context.tenantId);
  if (!connection) {
    return { ok: false, status: 'not_connected' };
  }

  const site = validateJiraSiteUrl(connection.siteUrl);
  if (!site.ok) {
    return { ok: false, status: 'configuration_error' };
  }

  let apiToken: string;
  try {
    apiToken = decryptToken(connection.encryptedToken, options.encryptionKey, {
      tenantId: connection.tenantId,
    });
  } catch {
    return { ok: false, status: 'configuration_error' };
  }

  const client = new JiraClient({
    origin: site.origin,
    email: connection.email,
    apiToken,
    fetch: options.fetch,
    timeoutMs: options.timeoutMs,
  });

  return {
    ok: true,
    connection: { client, origin: site.origin, siteUrl: connection.siteUrl },
  };
}
