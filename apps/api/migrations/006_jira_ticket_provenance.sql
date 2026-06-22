-- Milestone 8 (migration 006): local provenance for successfully created Jira
-- tickets.
--
-- This forward-only migration records the fact that an NHI finding ticket was
-- created in Jira, after Jira confirmed the creation. Jira remains the source of
-- truth for the ticket's mutable contents: this table deliberately stores no
-- title, description, credentials, authorization headers, raw Jira responses, or
-- any other mutable issue content -- only stable identifiers and an audit trail.
--
-- Tenant-safe relationships:
--   * (tenant_id, created_by_user_id) references users(tenant_id, id), so a
--     provenance row is always bound to a user within the owning tenant.
--   * (tenant_id, jira_connection_id) references jira_connections(tenant_id, id),
--     so the recorded connection always belongs to the same tenant. The existing
--     jira_connections table has a PRIMARY KEY on id and UNIQUE (tenant_id), but
--     no UNIQUE index on (tenant_id, id) for SQLite to use as a foreign-key
--     parent, so this migration adds one first. id is already unique, so the
--     index builds cleanly over any existing rows.
--
-- The Jira site URL is stored as a snapshot because the tenant's shared Jira
-- connection can later be replaced in place (its row id is preserved while the
-- site URL is rewritten); the provenance must retain the site the issue was
-- actually created against.
--
-- UNIQUE (tenant_id, jira_site_url, jira_issue_id) prevents recording the same
-- Jira issue more than once for the same tenant and Jira site.

CREATE UNIQUE INDEX ux_jira_connections_tenant_id ON jira_connections (tenant_id, id);

CREATE TABLE jira_ticket_provenance (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  created_by_user_id TEXT NOT NULL,
  jira_connection_id TEXT NOT NULL,
  jira_site_url TEXT NOT NULL,
  jira_project_id TEXT NOT NULL,
  jira_project_key TEXT NOT NULL,
  jira_issue_id TEXT NOT NULL,
  jira_issue_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (tenant_id, created_by_user_id) REFERENCES users(tenant_id, id),
  FOREIGN KEY (tenant_id, jira_connection_id) REFERENCES jira_connections(tenant_id, id),
  UNIQUE (tenant_id, jira_site_url, jira_issue_id)
) STRICT;
