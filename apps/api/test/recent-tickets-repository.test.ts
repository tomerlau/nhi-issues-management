import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TicketProvenanceRepository } from '../src/repositories/ticket-provenance-repository.js';
import { JiraConnectionRepository } from '../src/repositories/jira-connection-repository.js';
import { createSeededMemoryDb } from './helpers.js';

const ACME_SITE = 'https://acme.atlassian.net';
const OTHER_SITE = 'https://other.atlassian.net';

/** Insert one provenance row directly so created_at and id are fully controlled. */
function insertProvenance(
  db: DatabaseSync,
  row: {
    id: string;
    tenantId: string;
    createdByUserId: string;
    jiraConnectionId: string;
    jiraSiteUrl: string;
    jiraProjectKey: string;
    jiraIssueId: string;
    createdAt: string;
  },
): void {
  db.prepare(
    `INSERT INTO jira_ticket_provenance
       (id, tenant_id, created_by_user_id, jira_connection_id, jira_site_url,
        jira_project_id, jira_project_key, jira_issue_id, jira_issue_key, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.tenantId,
    row.createdByUserId,
    row.jiraConnectionId,
    row.jiraSiteUrl,
    'proj-id',
    row.jiraProjectKey,
    row.jiraIssueId,
    `${row.jiraProjectKey}-${row.jiraIssueId}`,
    row.createdAt,
  );
}

describe('TicketProvenanceRepository.listRecentCandidates', () => {
  let db: DatabaseSync;
  let repo: TicketProvenanceRepository;
  let acmeConnectionId: string;
  let globexConnectionId: string;

  beforeEach(async () => {
    db = await createSeededMemoryDb();
    repo = new TicketProvenanceRepository(db);
    const connections = new JiraConnectionRepository(db);
    acmeConnectionId = connections.upsert('tenant-acme', {
      configuredByUserId: 'user-acme-alice',
      siteUrl: ACME_SITE,
      email: 'c@example.com',
      accountId: 'acc-1',
      encryptedToken: 'enc',
    }).id;
    globexConnectionId = connections.upsert('tenant-globex', {
      configuredByUserId: 'user-globex-alice',
      siteUrl: ACME_SITE,
      email: 'c@example.com',
      accountId: 'acc-2',
      encryptedToken: 'enc',
    }).id;
  });

  afterEach(() => {
    db.close();
  });

  function seedAcme(
    issueId: string,
    createdAt: string,
    overrides: { projectKey?: string; siteUrl?: string; userId?: string; id?: string } = {},
  ): void {
    insertProvenance(db, {
      id: overrides.id ?? `row-${issueId}`,
      tenantId: 'tenant-acme',
      createdByUserId: overrides.userId ?? 'user-acme-alice',
      jiraConnectionId: acmeConnectionId,
      jiraSiteUrl: overrides.siteUrl ?? ACME_SITE,
      jiraProjectKey: overrides.projectKey ?? 'ABC',
      jiraIssueId: issueId,
      createdAt,
    });
  }

  it('returns only rows for the requested tenant, site, and project, newest first', () => {
    seedAcme('1', '2026-01-01T00:00:00.000Z');
    seedAcme('2', '2026-01-03T00:00:00.000Z');
    seedAcme('3', '2026-01-02T00:00:00.000Z');
    seedAcme('4', '2026-06-01T00:00:00.000Z', { projectKey: 'XYZ' });
    seedAcme('5', '2026-06-01T00:00:00.000Z', { siteUrl: OTHER_SITE });
    insertProvenance(db, {
      id: 'row-globex',
      tenantId: 'tenant-globex',
      createdByUserId: 'user-globex-alice',
      jiraConnectionId: globexConnectionId,
      jiraSiteUrl: ACME_SITE,
      jiraProjectKey: 'ABC',
      jiraIssueId: '99',
      createdAt: '2026-06-01T00:00:00.000Z',
    });

    const result = repo.listRecentCandidates({
      tenantId: 'tenant-acme',
      jiraSiteUrl: ACME_SITE,
      jiraProjectKey: 'ABC',
      limit: 25,
    });
    expect(result.map((c) => c.jiraIssueId)).toEqual(['2', '3', '1']);
  });

  it('breaks a created_at tie by id descending', () => {
    const sameTime = '2026-01-01T00:00:00.000Z';
    seedAcme('a', sameTime, { id: 'row-aaa' });
    seedAcme('b', sameTime, { id: 'row-ccc' });
    seedAcme('c', sameTime, { id: 'row-bbb' });

    const result = repo.listRecentCandidates({
      tenantId: 'tenant-acme',
      jiraSiteUrl: ACME_SITE,
      jiraProjectKey: 'ABC',
      limit: 25,
    });
    expect(result.map((c) => c.id)).toEqual(['row-ccc', 'row-bbb', 'row-aaa']);
  });

  it('does not filter by creator: same-tenant rows from two users are all returned', () => {
    seedAcme('1', '2026-01-02T00:00:00.000Z', { userId: 'user-acme-alice' });
    seedAcme('2', '2026-01-01T00:00:00.000Z', { userId: 'user-acme-bob' });

    const result = repo.listRecentCandidates({
      tenantId: 'tenant-acme',
      jiraSiteUrl: ACME_SITE,
      jiraProjectKey: 'ABC',
      limit: 25,
    });
    expect(result.map((c) => c.jiraIssueId)).toEqual(['1', '2']);
  });

  it('respects the batch limit', () => {
    for (let i = 0; i < 5; i += 1) {
      seedAcme(`${i}`, `2026-01-0${i + 1}T00:00:00.000Z`);
    }
    const result = repo.listRecentCandidates({
      tenantId: 'tenant-acme',
      jiraSiteUrl: ACME_SITE,
      jiraProjectKey: 'ABC',
      limit: 2,
    });
    expect(result).toHaveLength(2);
    expect(result.map((c) => c.jiraIssueId)).toEqual(['4', '3']);
  });

  it('paginates by keyset cursor without gaps or duplicates', () => {
    const ids: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      const issueId = `${i}`;
      ids.push(issueId);
      seedAcme(issueId, `2026-01-0${i + 1}T00:00:00.000Z`);
    }

    const seen: string[] = [];
    let cursor: { createdAt: string; id: string } | undefined;
    for (;;) {
      const batch = repo.listRecentCandidates({
        tenantId: 'tenant-acme',
        jiraSiteUrl: ACME_SITE,
        jiraProjectKey: 'ABC',
        limit: 2,
        cursor,
      });
      if (batch.length === 0) {
        break;
      }
      seen.push(...batch.map((c) => c.jiraIssueId));
      const last = batch[batch.length - 1];
      cursor = { createdAt: last.createdAt, id: last.id };
      if (batch.length < 2) {
        break;
      }
    }

    expect(seen).toEqual(['5', '4', '3', '2', '1', '0']);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('advances past a created_at tie using the id tiebreak in the cursor', () => {
    const sameTime = '2026-01-01T00:00:00.000Z';
    seedAcme('a', sameTime, { id: 'row-aaa' });
    seedAcme('b', sameTime, { id: 'row-bbb' });
    seedAcme('c', sameTime, { id: 'row-ccc' });

    const first = repo.listRecentCandidates({
      tenantId: 'tenant-acme',
      jiraSiteUrl: ACME_SITE,
      jiraProjectKey: 'ABC',
      limit: 1,
    });
    expect(first.map((c) => c.id)).toEqual(['row-ccc']);

    const second = repo.listRecentCandidates({
      tenantId: 'tenant-acme',
      jiraSiteUrl: ACME_SITE,
      jiraProjectKey: 'ABC',
      limit: 25,
      cursor: { createdAt: first[0].createdAt, id: first[0].id },
    });
    expect(second.map((c) => c.id)).toEqual(['row-bbb', 'row-aaa']);
  });
});
