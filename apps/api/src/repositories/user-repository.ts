import type { DatabaseSync } from 'node:sqlite';

export interface User {
  id: string;
  tenantId: string;
  email: string;
  displayName: string;
  createdAt: string;
}

interface UserRow {
  id: string;
  tenant_id: string;
  email: string;
  display_name: string;
  created_at: string;
}

function toUser(row: UserRow): User {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    email: row.email,
    displayName: row.display_name,
    createdAt: row.created_at,
  };
}

export interface CreateUserInput {
  id: string;
  email: string;
  displayName: string;
  createdAt?: string;
}

/**
 * Users are owned by exactly one tenant, and `tenant_id` is the ownership
 * boundary. Every read and write requires the owning `tenantId`, so a user can
 * never be reached through another tenant's context. There is intentionally no
 * unscoped lookup (e.g. `findById(userId)` / `listAll()`).
 */
export class UserRepository {
  constructor(private readonly db: DatabaseSync) {}

  create(tenantId: string, input: CreateUserInput): User {
    const createdAt = input.createdAt ?? new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO users (id, tenant_id, email, display_name, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(input.id, tenantId, input.email, input.displayName, createdAt);
    return {
      id: input.id,
      tenantId,
      email: input.email,
      displayName: input.displayName,
      createdAt,
    };
  }

  findById(tenantId: string, userId: string): User | null {
    const row = this.db
      .prepare(
        `SELECT id, tenant_id, email, display_name, created_at
         FROM users WHERE tenant_id = ? AND id = ?`,
      )
      .get(tenantId, userId) as UserRow | undefined;
    return row ? toUser(row) : null;
  }

  findByEmail(tenantId: string, email: string): User | null {
    const row = this.db
      .prepare(
        `SELECT id, tenant_id, email, display_name, created_at
         FROM users WHERE tenant_id = ? AND email = ?`,
      )
      .get(tenantId, email) as UserRow | undefined;
    return row ? toUser(row) : null;
  }

  /**
   * Global, tenant-unaware lookup by email. This is the single deliberate
   * exception to tenant scoping: at login the caller has no tenant yet, so the
   * tenant is derived from the matched user. Email is globally unique, so this
   * returns at most one user. Do not use it for normal tenant-owned reads.
   */
  findByEmailForAuthentication(email: string): User | null {
    const row = this.db
      .prepare(
        `SELECT id, tenant_id, email, display_name, created_at
         FROM users WHERE email = ?`,
      )
      .get(email) as UserRow | undefined;
    return row ? toUser(row) : null;
  }

  list(tenantId: string): User[] {
    const rows = this.db
      .prepare(
        `SELECT id, tenant_id, email, display_name, created_at
         FROM users WHERE tenant_id = ? ORDER BY id`,
      )
      .all(tenantId) as unknown as UserRow[];
    return rows.map(toUser);
  }
}
