import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export interface TicketProvenance {
  id: string;
  tenantId: string;
  createdByUserId: string;
  jiraConnectionId: string;
  jiraSiteUrl: string;
  jiraProjectId: string;
  jiraProjectKey: string;
  jiraIssueId: string;
  jiraIssueKey: string;
  createdAt: string;
}

export interface InsertTicketProvenanceInput {
  tenantId: string;
  createdByUserId: string;
  jiraConnectionId: string;
  jiraSiteUrl: string;
  jiraProjectId: string;
  jiraProjectKey: string;
  jiraIssueId: string;
  jiraIssueKey: string;
}

/**
 * Records local provenance for successfully created Jira tickets. Every write is
 * tenant-scoped: the owning `tenantId` is always part of the inserted row and is
 * enforced by the composite foreign keys into `users(tenant_id, id)` and
 * `jira_connections(tenant_id, id)`. The table stores only stable identifiers and
 * an audit trail — never the ticket title, description, credentials, or any raw
 * Jira response — because Jira remains the source of truth for mutable issue
 * contents. A duplicate `(tenant_id, jira_site_url, jira_issue_id)` is rejected by
 * the database unique constraint, surfacing here as a thrown error.
 */
export class TicketProvenanceRepository {
  constructor(private readonly db: DatabaseSync) {}

  insert(input: InsertTicketProvenanceInput): TicketProvenance {
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO jira_ticket_provenance
           (id, tenant_id, created_by_user_id, jira_connection_id, jira_site_url,
            jira_project_id, jira_project_key, jira_issue_id, jira_issue_key, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.tenantId,
        input.createdByUserId,
        input.jiraConnectionId,
        input.jiraSiteUrl,
        input.jiraProjectId,
        input.jiraProjectKey,
        input.jiraIssueId,
        input.jiraIssueKey,
        createdAt,
      );

    return { id, createdAt, ...input };
  }
}
