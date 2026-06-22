import type { DatabaseSync } from 'node:sqlite';
import type { AuthContext } from '../auth/auth-context.js';
import { TicketProvenanceRepository } from '../repositories/ticket-provenance-repository.js';
import {
  JiraIntegrationService,
  type TicketCreationInput,
} from './jira-integration-service.js';
import type { FetchLike } from './jira-client.js';

/**
 * Outcome of the ticket-creation domain flow. It mirrors the Jira integration
 * outcomes and adds `persistence_failed` for the approved POC case where Jira
 * created the issue but local provenance could not be recorded. No variant ever
 * carries the plaintext token, credentials, or raw Jira content.
 */
export type CreateTicketResult =
  | { status: 'created'; issueId: string; issueKey: string }
  | { status: 'not_connected' }
  | { status: 'project_inaccessible' }
  | { status: 'task_unsupported' }
  | { status: 'credentials_rejected' }
  | { status: 'timeout' }
  | { status: 'unavailable' }
  | { status: 'configuration_error' }
  | { status: 'persistence_failed' };

export interface TicketServiceOptions {
  db: DatabaseSync;
  encryptionKey: Buffer;
  fetch: FetchLike;
  timeoutMs?: number;
}

/**
 * The ticket-creation domain service. It receives the authenticated context and
 * already-validated ticket input, delegates Jira creation to the tenant-scoped
 * integration layer, and records local provenance only after Jira confirms a
 * successful creation.
 *
 * Approved POC behavior: Jira creation and SQLite provenance persistence are
 * sequential and are not a distributed transaction. No pending record is written
 * before Jira is called. If Jira creates the issue but provenance persistence
 * fails, the result is `persistence_failed` and the already-created Jira issue
 * may remain untracked by the application; there is no compensation, retry,
 * idempotency key, or reconciliation.
 */
export class TicketService {
  private readonly integration: JiraIntegrationService;
  private readonly provenance: TicketProvenanceRepository;

  constructor(options: TicketServiceOptions) {
    this.integration = new JiraIntegrationService({
      db: options.db,
      encryptionKey: options.encryptionKey,
      fetch: options.fetch,
      timeoutMs: options.timeoutMs,
    });
    this.provenance = new TicketProvenanceRepository(options.db);
  }

  async createTicket(
    context: AuthContext,
    input: TicketCreationInput,
  ): Promise<CreateTicketResult> {
    const outcome = await this.integration.createTicket(context, input);
    if (outcome.status !== 'created') {
      return outcome;
    }

    // Insert provenance only after Jira returns a validated successful creation,
    // using the exact connection and project metadata the integration layer used.
    try {
      this.provenance.insert({
        tenantId: context.tenantId,
        createdByUserId: context.userId,
        jiraConnectionId: outcome.connectionId,
        jiraSiteUrl: outcome.siteUrl,
        jiraProjectId: outcome.projectId,
        jiraProjectKey: outcome.projectKey,
        jiraIssueId: outcome.issueId,
        jiraIssueKey: outcome.issueKey,
      });
    } catch {
      // The Jira issue exists but could not be tracked locally (POC tradeoff).
      return { status: 'persistence_failed' };
    }

    return { status: 'created', issueId: outcome.issueId, issueKey: outcome.issueKey };
  }
}
