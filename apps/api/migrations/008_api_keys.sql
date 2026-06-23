-- Milestone 12 (migration 008): application-issued API key authentication.
--
-- Each row represents one API key issued to exactly one application user.
-- Ownership (tenant_id, user_id) is stored here and is the sole authoritative
-- source of identity for an API key request: request headers, bodies, query
-- parameters, and path parameters can never override it.
--
-- Security properties:
--   * The plaintext API key is never stored. Only a SHA-256 hash of the
--     random secret component is persisted (secret_hash). A plaintext key
--     revealed during provisioning cannot be derived from this hash.
--   * The key ID (id) is the public selector used to look up the record. The
--     secret is verified separately with a timing-safe comparison.
--   * FOREIGN KEY (tenant_id, user_id) references users(tenant_id, id) using
--     the composite unique index added by migration 002, binding every key to
--     a real user within the owning tenant. Cross-tenant access through a
--     stolen key ID is structurally impossible.
--   * No revoked_at column, no soft-delete. Revocation physically deletes the
--     row, so a deleted key is permanently indistinguishable from an unknown one.

CREATE TABLE api_keys (
  id           TEXT NOT NULL PRIMARY KEY,
  tenant_id    TEXT NOT NULL,
  user_id      TEXT NOT NULL,
  secret_hash  TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, id)
) STRICT;
