import type { DatabaseSync } from 'node:sqlite';
import { JiraConnectionRepository } from '../repositories/jira-connection-repository.js';
import type { AuthContext } from '../auth/auth-context.js';
import { decryptToken } from './token-cipher.js';
import { validateJiraSiteUrl } from './site-url.js';
import { JiraClient, type FetchLike } from './jira-client.js';

/**
 * Tenant-scoped outcome of validating a Jira project against the tenant's shared
 * connection. Each meaningful condition is distinguishable so later milestones
 * can react to them individually. No variant ever carries the plaintext token,
 * raw Jira content, or internal error detail.
 */
export type JiraProjectOutcome =
  | { status: 'valid'; projectId: string; projectKey: string; taskIssueTypeId: string }
  | { status: 'not_connected' }
  | { status: 'project_inaccessible' }
  | { status: 'task_unsupported' }
  | { status: 'credentials_rejected' }
  | { status: 'timeout' }
  | { status: 'unavailable' }
  | { status: 'configuration_error' };

export interface JiraIntegrationServiceOptions {
  db: DatabaseSync;
  encryptionKey: Buffer;
  fetch: FetchLike;
  timeoutMs?: number;
}

/**
 * Authenticated Jira access scoped to the tenant. It loads the tenant's single
 * shared connection only through the authenticated tenant boundary
 * (`JiraConnectionRepository.findByTenant(context.tenantId)`) and never accepts
 * a tenantId, userId, connectionId, site URL, email, or credential-ownership
 * value from untrusted request data — so cross-tenant access is impossible even
 * when another connection's id, key, site URL, or configurer is known.
 *
 * The stored token is decrypted only immediately before an outbound Jira
 * operation, bound to the stored connection's tenant alone (never context.userId
 * or configured_by_user_id). Every wrong-key, malformed-ciphertext,
 * unsupported-version, or authentication-tag failure collapses into one
 * sanitized `configuration_error`, as does an invalid stored site URL — which
 * additionally causes no network request to be made.
 */
export class JiraIntegrationService {
  private readonly repository: JiraConnectionRepository;
  private readonly encryptionKey: Buffer;
  private readonly fetch: FetchLike;
  private readonly timeoutMs?: number;

  constructor(options: JiraIntegrationServiceOptions) {
    this.repository = new JiraConnectionRepository(options.db);
    this.encryptionKey = options.encryptionKey;
    this.fetch = options.fetch;
    this.timeoutMs = options.timeoutMs;
  }

  async validateProject(context: AuthContext, projectIdOrKey: string): Promise<JiraProjectOutcome> {
    const connection = this.repository.findByTenant(context.tenantId);
    if (!connection) {
      return { status: 'not_connected' };
    }

    // Defense in depth: re-validate the stored origin before any network call.
    // An invalid stored URL never reaches the network.
    const site = validateJiraSiteUrl(connection.siteUrl);
    if (!site.ok) {
      return { status: 'configuration_error' };
    }

    // Decrypt just-in-time, bound to the stored connection's tenant only. Any
    // failure (wrong key, malformed ciphertext, removed v1 version, bad auth tag)
    // is collapsed into one sanitized configuration failure.
    let apiToken: string;
    try {
      apiToken = decryptToken(connection.encryptedToken, this.encryptionKey, {
        tenantId: connection.tenantId,
      });
    } catch {
      return { status: 'configuration_error' };
    }

    return this.runProjectValidation(site.origin, connection.email, apiToken, projectIdOrKey);
  }

  /**
   * Creates a short-lived client with the decrypted token in the smallest
   * practical scope and maps its sanitized outcome to the tenant-scoped result.
   */
  private async runProjectValidation(
    origin: string,
    email: string,
    apiToken: string,
    projectIdOrKey: string,
  ): Promise<JiraProjectOutcome> {
    const client = new JiraClient({
      origin,
      email,
      apiToken,
      fetch: this.fetch,
      timeoutMs: this.timeoutMs,
    });

    const outcome = await client.validateProject(projectIdOrKey);
    if (outcome.ok) {
      return {
        status: 'valid',
        projectId: outcome.projectId,
        projectKey: outcome.projectKey,
        taskIssueTypeId: outcome.taskIssueTypeId,
      };
    }
    switch (outcome.reason) {
      case 'project_inaccessible':
        return { status: 'project_inaccessible' };
      case 'task_unsupported':
        return { status: 'task_unsupported' };
      case 'credentials_rejected':
        return { status: 'credentials_rejected' };
      case 'timeout':
        return { status: 'timeout' };
      case 'unavailable':
        return { status: 'unavailable' };
    }
  }
}
