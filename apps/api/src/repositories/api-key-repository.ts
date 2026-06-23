import type { DatabaseSync } from 'node:sqlite';

export interface ApiKey {
  id: string;
  tenantId: string;
  userId: string;
  secretHash: string;
  createdAt: string;
}

interface ApiKeyRow {
  id: string;
  tenant_id: string;
  user_id: string;
  secret_hash: string;
  created_at: string;
}

function toApiKey(row: ApiKeyRow): ApiKey {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    secretHash: row.secret_hash,
    createdAt: row.created_at,
  };
}

export interface CreateApiKeyInput {
  id: string;
  tenantId: string;
  userId: string;
  secretHash: string;
  createdAt?: string;
}

/**
 * API keys are owned by exactly one user within one tenant. Lookup by key ID
 * is deliberately unscoped by tenant because the API key itself is the trusted
 * selector — the owning tenant and user are derived from the stored record, never
 * from the request.
 */
export class ApiKeyRepository {
  constructor(private readonly db: DatabaseSync) {}

  create(input: CreateApiKeyInput): ApiKey {
    const createdAt = input.createdAt ?? new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO api_keys (id, tenant_id, user_id, secret_hash, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(input.id, input.tenantId, input.userId, input.secretHash, createdAt);
    return {
      id: input.id,
      tenantId: input.tenantId,
      userId: input.userId,
      secretHash: input.secretHash,
      createdAt,
    };
  }

  /** Look up a key record by its public key ID. Unscoped — the key ID is the selector. */
  findById(keyId: string): ApiKey | null {
    const row = this.db
      .prepare(
        `SELECT id, tenant_id, user_id, secret_hash, created_at
         FROM api_keys WHERE id = ?`,
      )
      .get(keyId) as ApiKeyRow | undefined;
    return row ? toApiKey(row) : null;
  }

  /**
   * Physically delete the key row. Returns true when a row was deleted, false
   * when no row matched (idempotent for callers that do not need to distinguish).
   */
  deleteById(keyId: string): boolean {
    const result = this.db.prepare('DELETE FROM api_keys WHERE id = ?').run(keyId);
    return (result.changes as number) > 0;
  }
}
