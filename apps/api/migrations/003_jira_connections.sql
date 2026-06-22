-- Milestone 5: Jira API-token connection (backend only).
--
-- One Jira Cloud connection per application user. Ownership is the
-- (tenant_id, user_id) pair, enforced both by the composite foreign key into
-- users(tenant_id, id) and by a UNIQUE constraint that allows at most one
-- connection per owner. The API token is stored only as an AES-256-GCM
-- encrypted, versioned serialized value; the plaintext token is never written.

CREATE TABLE jira_connections (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  site_url TEXT NOT NULL,
  email TEXT NOT NULL,
  account_id TEXT NOT NULL,
  encrypted_token TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, id),
  UNIQUE (tenant_id, user_id)
) STRICT;
