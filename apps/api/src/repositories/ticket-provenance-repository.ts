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
 * Stable keyset cursor identifying the last candidate already loaded. The next
 * batch selects only rows ordered strictly after it under (created_at DESC,
 * id DESC). It is an internal pagination detail, never derived from request input.
 */
export interface RecentTicketCandidateCursor {
  createdAt: string;
  id: string;
}

/**
 * A single local provenance candidate for hydration. It carries only the
 * identifiers the recent-tickets flow needs: the immutable Jira issue id used to
 * hydrate from Jira, plus the keyset fields (created_at, id) used to advance the
 * internal cursor and to preserve stable local order.
 */
export interface RecentTicketCandidate {
  id: string;
  jiraIssueId: string;
  createdAt: string;
}

export interface ListRecentCandidatesInput {
  tenantId: string;
  jiraSiteUrl: string;
  jiraProjectKey: string;
  /** Fixed internal batch size; never a user-controlled limit. */
  limit: number;
  /** Absent for the first batch; the last loaded candidate for later batches. */
  cursor?: RecentTicketCandidateCursor;
}

interface RecentTicketCandidateRow {
  id: string;
  jira_issue_id: string;
  created_at: string;
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

  /**
   * Load one batch of recent app-created provenance candidates for a single
   * tenant, currently connected Jira site, and normalized project key, newest
   * first. Ordering is stable (`created_at DESC, id DESC`) and pagination is
   * keyset: the first batch passes no cursor, and a later batch selects only rows
   * strictly after the cursor under the same order
   * (`created_at < cursor.createdAt OR (created_at = cursor.createdAt AND id <
   * cursor.id)`), so concurrent inserts never shift or duplicate a page. The
   * query is always tenant-scoped and never filters by created_by_user_id, so two
   * users in the same tenant see the same tenant-owned rows. The connection id is
   * deliberately not part of the visibility boundary: the site URL snapshot
   * identifies where the issue was created even after the connection row is
   * replaced.
   */
  listRecentCandidates(input: ListRecentCandidatesInput): RecentTicketCandidate[] {
    const params: (string | number)[] = [input.tenantId, input.jiraSiteUrl, input.jiraProjectKey];
    let cursorClause = '';
    if (input.cursor) {
      cursorClause = ' AND (created_at < ? OR (created_at = ? AND id < ?))';
      params.push(input.cursor.createdAt, input.cursor.createdAt, input.cursor.id);
    }
    params.push(input.limit);

    const rows = this.db
      .prepare(
        `SELECT id, jira_issue_id, created_at
         FROM jira_ticket_provenance
         WHERE tenant_id = ? AND jira_site_url = ? AND jira_project_key = ?${cursorClause}
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
      )
      .all(...params) as unknown as RecentTicketCandidateRow[];

    return rows.map((row) => ({
      id: row.id,
      jiraIssueId: row.jira_issue_id,
      createdAt: row.created_at,
    }));
  }
}
