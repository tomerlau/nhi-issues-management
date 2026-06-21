-- Milestone 3: application authentication.
--
-- 1. Make user email addresses globally unique (replacing the Milestone 2
--    per-tenant uniqueness) and add a composite key so authentication tables can
--    reference a user by (tenant_id, id).
-- 2. Add tables for password credentials and server-side sessions.
--
-- SQLite cannot drop or replace a table constraint in place, so the users table
-- is rebuilt. This migration runs inside the migrator's transaction; foreign-key
-- enforcement stays on, which is safe here because no table references users yet
-- (the credential and session tables are created afterwards).

-- The only known cross-tenant email collision is the Milestone 2 demo seed, where
-- the Globex demo user shared alice@example.com with the Acme demo user. Rewrite
-- that exact row so the global uniqueness constraint can be enforced and so the
-- updated seed stays idempotent.
UPDATE users
SET email = 'alice@globex.example.com'
WHERE id = 'user-globex-alice' AND email = 'alice@example.com';

CREATE TABLE users_new (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  UNIQUE (tenant_id, id)
) STRICT;

INSERT INTO users_new (id, tenant_id, email, display_name, created_at)
SELECT id, tenant_id, email, display_name, created_at FROM users;

DROP TABLE users;
ALTER TABLE users_new RENAME TO users;

-- Password credentials are stored separately from the user record so a hash is
-- never read or returned as part of normal user queries. The composite foreign
-- key keeps a credential bound to the owning tenant and user together.
CREATE TABLE user_credentials (
  user_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, id)
) STRICT;

-- Sessions store only the SHA-256 hash of the opaque session token; the raw
-- token lives only in the client cookie. tenant_id and user_id are both recorded
-- so a session is always resolved within its owning tenant scope.
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, id)
) STRICT;

CREATE INDEX idx_sessions_tenant_user ON sessions (tenant_id, user_id);
