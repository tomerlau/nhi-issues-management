import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export interface JiraConnection {
  id: string;
  tenantId: string;
  userId: string;
  siteUrl: string;
  email: string;
  accountId: string;
  encryptedToken: string;
  createdAt: string;
  updatedAt: string;
}

interface JiraConnectionRow {
  id: string;
  tenant_id: string;
  user_id: string;
  site_url: string;
  email: string;
  account_id: string;
  encrypted_token: string;
  created_at: string;
  updated_at: string;
}

export interface UpsertJiraConnectionInput {
  siteUrl: string;
  email: string;
  accountId: string;
  encryptedToken: string;
}

function toConnection(row: JiraConnectionRow): JiraConnection {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    siteUrl: row.site_url,
    email: row.email,
    accountId: row.account_id,
    encryptedToken: row.encrypted_token,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * The Jira connection is owned by exactly one application user, identified by
 * the (tenantId, userId) pair. Every read and write requires both parts of the
 * owner: there is intentionally no lookup by connection id or by user id alone,
 * so a connection can never be reached or modified through another tenant's or
 * user's context. Reconnection updates only the owner's own row.
 */
export class JiraConnectionRepository {
  constructor(private readonly db: DatabaseSync) {}

  findByOwner(tenantId: string, userId: string): JiraConnection | null {
    const row = this.db
      .prepare(
        `SELECT id, tenant_id, user_id, site_url, email, account_id, encrypted_token,
                created_at, updated_at
         FROM jira_connections WHERE tenant_id = ? AND user_id = ?`,
      )
      .get(tenantId, userId) as JiraConnectionRow | undefined;
    return row ? toConnection(row) : null;
  }

  /**
   * Create or replace the owner's single connection. Both branches are scoped to
   * (tenantId, userId), so a reconnection only ever rewrites the caller's row.
   */
  upsert(
    tenantId: string,
    userId: string,
    input: UpsertJiraConnectionInput,
  ): JiraConnection {
    const now = new Date().toISOString();
    const existing = this.findByOwner(tenantId, userId);

    if (existing) {
      this.db
        .prepare(
          `UPDATE jira_connections
           SET site_url = ?, email = ?, account_id = ?, encrypted_token = ?, updated_at = ?
           WHERE tenant_id = ? AND user_id = ?`,
        )
        .run(
          input.siteUrl,
          input.email,
          input.accountId,
          input.encryptedToken,
          now,
          tenantId,
          userId,
        );
    } else {
      this.db
        .prepare(
          `INSERT INTO jira_connections
             (id, tenant_id, user_id, site_url, email, account_id, encrypted_token,
              created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          randomUUID(),
          tenantId,
          userId,
          input.siteUrl,
          input.email,
          input.accountId,
          input.encryptedToken,
          now,
          now,
        );
    }

    return this.findByOwner(tenantId, userId)!;
  }
}
