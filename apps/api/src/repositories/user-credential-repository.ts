import type { DatabaseSync } from 'node:sqlite';

export interface UserCredential {
  userId: string;
  tenantId: string;
  passwordHash: string;
  createdAt: string;
}

interface UserCredentialRow {
  user_id: string;
  tenant_id: string;
  password_hash: string;
  created_at: string;
}

export interface CreateCredentialInput {
  tenantId: string;
  userId: string;
  passwordHash: string;
  createdAt?: string;
}

/**
 * Password credentials are stored apart from the user record and are only ever
 * read through this repository, which is used solely by authentication. The
 * password hash is intentionally never surfaced by UserRepository or any API
 * response. Reads are tenant- and user-scoped, matching the composite foreign
 * key on the table.
 */
export class UserCredentialRepository {
  constructor(private readonly db: DatabaseSync) {}

  create(input: CreateCredentialInput): UserCredential {
    const createdAt = input.createdAt ?? new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO user_credentials (user_id, tenant_id, password_hash, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(input.userId, input.tenantId, input.passwordHash, createdAt);
    return {
      userId: input.userId,
      tenantId: input.tenantId,
      passwordHash: input.passwordHash,
      createdAt,
    };
  }

  findByUserId(tenantId: string, userId: string): UserCredential | null {
    const row = this.db
      .prepare(
        `SELECT user_id, tenant_id, password_hash, created_at
         FROM user_credentials WHERE tenant_id = ? AND user_id = ?`,
      )
      .get(tenantId, userId) as UserCredentialRow | undefined;
    return row
      ? {
          userId: row.user_id,
          tenantId: row.tenant_id,
          passwordHash: row.password_hash,
          createdAt: row.created_at,
        }
      : null;
  }
}
