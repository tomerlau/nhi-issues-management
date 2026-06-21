import type { DatabaseSync } from 'node:sqlite';

export interface Session {
  tokenHash: string;
  tenantId: string;
  userId: string;
  createdAt: string;
  expiresAt: string;
}

interface SessionRow {
  token_hash: string;
  tenant_id: string;
  user_id: string;
  created_at: string;
  expires_at: string;
}

export interface CreateSessionInput {
  tokenHash: string;
  tenantId: string;
  userId: string;
  createdAt: string;
  expiresAt: string;
}

function toSession(row: SessionRow): Session {
  return {
    tokenHash: row.token_hash,
    tenantId: row.tenant_id,
    userId: row.user_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

/**
 * Server-side sessions keyed by the SHA-256 hash of the opaque token. The raw
 * token is never stored. Lookups are filtered by expiry so an expired row never
 * authenticates, and deletion is scoped to a single token hash so logging out of
 * one session leaves every other session untouched.
 */
export class SessionRepository {
  constructor(private readonly db: DatabaseSync) {}

  create(input: CreateSessionInput): Session {
    this.db
      .prepare(
        `INSERT INTO sessions (token_hash, tenant_id, user_id, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(input.tokenHash, input.tenantId, input.userId, input.createdAt, input.expiresAt);
    return { ...input };
  }

  /** Return the session only if it exists and has not expired at `nowIso`. */
  findActiveByTokenHash(tokenHash: string, nowIso: string): Session | null {
    const row = this.db
      .prepare(
        `SELECT token_hash, tenant_id, user_id, created_at, expires_at
         FROM sessions WHERE token_hash = ? AND expires_at > ?`,
      )
      .get(tokenHash, nowIso) as SessionRow | undefined;
    return row ? toSession(row) : null;
  }

  /** Delete a single session by token hash. Idempotent: a no-op if absent. */
  deleteByTokenHash(tokenHash: string): void {
    this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
  }
}
