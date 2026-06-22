-- Milestone 10 (migration 007): index supporting the recent-tickets read access
-- pattern over jira_ticket_provenance.
--
-- The recent-tickets endpoint (GET /api/tickets?projectKey=...) loads the most
-- recent app-created provenance for a single tenant, the currently connected
-- Jira site, and one normalized project key, ordered by created_at DESC, id DESC,
-- using stable keyset pagination on (created_at, id). This index matches that
-- access pattern exactly: it equality-filters on
-- (tenant_id, jira_site_url, jira_project_key) and then provides the rows already
-- ordered by (created_at DESC, id DESC), so both the ordering and the keyset
-- cursor comparison are served directly by the index.
--
-- This migration is forward-only and additive: it creates a new index only and
-- changes no existing table, column, constraint, or migration. Existing
-- provenance rows are left untouched and are simply covered by the new index.

CREATE INDEX ix_jira_ticket_provenance_recent
  ON jira_ticket_provenance (tenant_id, jira_site_url, jira_project_key, created_at DESC, id DESC);
