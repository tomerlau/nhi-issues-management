-- Milestone 5 correction (migration 004): Jira connection becomes a tenant-wide
-- organization integration, replacing the previous one-connection-per-user model.
--
-- The product decision is that a Jira connection is shared by every user in a
-- tenant: any tenant user can read its safe status and any tenant user can create
-- or replace it. The column `user_id` is therefore replaced by
-- `configured_by_user_id`, which records the last user who successfully
-- configured the connection. It is audit metadata only, not an authorization
-- boundary; authorization is the tenant scope.
--
-- SQLite cannot drop or replace a table constraint in place, so the table is
-- rebuilt. This migration runs inside the migrator's transaction with foreign-key
-- enforcement on; nothing references `jira_connections`, so the rebuild is safe.
--
-- Existing rows are preserved where possible. Encrypted tokens are bound (through
-- the cipher AAD) to the original `(tenant_id, user_id)`, so the previous
-- `user_id` is carried over verbatim as `configured_by_user_id`, keeping existing
-- ciphertext decryptable. The previous schema allowed one connection per
-- (tenant_id, user_id), so a single tenant may already hold several legacy rows;
-- the new `UNIQUE (tenant_id)` constraint permits only one. Exactly one row per
-- tenant is retained deterministically: the greatest `updated_at`, breaking ties
-- by the greatest `id`.

CREATE TABLE jira_connections_new (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  configured_by_user_id TEXT NOT NULL,
  site_url TEXT NOT NULL,
  email TEXT NOT NULL,
  account_id TEXT NOT NULL,
  encrypted_token TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (tenant_id, configured_by_user_id) REFERENCES users(tenant_id, id),
  UNIQUE (tenant_id)
) STRICT;

-- Keep exactly one legacy row per tenant: greatest updated_at, then greatest id.
-- The previous owner's user_id becomes configured_by_user_id so the ciphertext,
-- whose AAD binds (tenant_id, user_id), stays decryptable.
INSERT INTO jira_connections_new
  (id, tenant_id, configured_by_user_id, site_url, email, account_id,
   encrypted_token, created_at, updated_at)
SELECT id, tenant_id, user_id, site_url, email, account_id,
       encrypted_token, created_at, updated_at
FROM jira_connections AS jc
WHERE jc.id = (
  SELECT candidate.id
  FROM jira_connections AS candidate
  WHERE candidate.tenant_id = jc.tenant_id
  ORDER BY candidate.updated_at DESC, candidate.id DESC
  LIMIT 1
);

DROP TABLE jira_connections;
ALTER TABLE jira_connections_new RENAME TO jira_connections;
