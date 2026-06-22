import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export interface JiraConnection {
  id: string;
  tenantId: string;
  configuredByUserId: string;
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
  configured_by_user_id: string;
  site_url: string;
  email: string;
  account_id: string;
  encrypted_token: string;
  created_at: string;
  updated_at: string;
}

export interface UpsertJiraConnectionInput {
  configuredByUserId: string;
  siteUrl: string;
  email: string;
  accountId: string;
  encryptedToken: string;
}

function toConnection(row: JiraConnectionRow): JiraConnection {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    configuredByUserId: row.configured_by_user_id,
    siteUrl: row.site_url,
    email: row.email,
    accountId: row.account_id,
    encryptedToken: row.encrypted_token,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * The Jira connection is a tenant-wide integration shared by every user in the
 * tenant. Ownership is the tenant alone: every read and write requires
 * `tenantId`, and there is intentionally no lookup or mutation path by connection
 * id, user id, or any client-provided ownership field, so a connection can never
 * be reached or modified through another tenant's context. `configuredByUserId`
 * records the last user who successfully configured the connection for audit; it
 * is not an authorization boundary.
 */
export class JiraConnectionRepository {
  constructor(private readonly db: DatabaseSync) {}

  findByTenant(tenantId: string): JiraConnection | null {
    const row = this.db
      .prepare(
        `SELECT id, tenant_id, configured_by_user_id, site_url, email, account_id,
                encrypted_token, created_at, updated_at
         FROM jira_connections WHERE tenant_id = ?`,
      )
      .get(tenantId) as JiraConnectionRow | undefined;
    return row ? toConnection(row) : null;
  }

  /**
   * Create or replace the tenant's single shared connection. A replacement
   * updates the existing row in place, preserving its id and created_at while
   * rewriting the connection fields, the encrypted token, configured_by_user_id,
   * and updated_at. Both branches are scoped to tenantId only.
   */
  upsert(tenantId: string, input: UpsertJiraConnectionInput): JiraConnection {
    const now = new Date().toISOString();
    const existing = this.findByTenant(tenantId);

    if (existing) {
      this.db
        .prepare(
          `UPDATE jira_connections
           SET configured_by_user_id = ?, site_url = ?, email = ?, account_id = ?,
               encrypted_token = ?, updated_at = ?
           WHERE tenant_id = ?`,
        )
        .run(
          input.configuredByUserId,
          input.siteUrl,
          input.email,
          input.accountId,
          input.encryptedToken,
          now,
          tenantId,
        );
    } else {
      this.db
        .prepare(
          `INSERT INTO jira_connections
             (id, tenant_id, configured_by_user_id, site_url, email, account_id,
              encrypted_token, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          randomUUID(),
          tenantId,
          input.configuredByUserId,
          input.siteUrl,
          input.email,
          input.accountId,
          input.encryptedToken,
          now,
          now,
        );
    }

    return this.findByTenant(tenantId)!;
  }
}
