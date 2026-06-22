import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RecentTicketsService } from '../src/jira/recent-tickets-service.js';
import { JiraConnectionRepository } from '../src/repositories/jira-connection-repository.js';
import { encryptToken } from '../src/jira/token-cipher.js';
import type { AuthContext } from '../src/auth/auth-context.js';
import type { FetchLike } from '../src/jira/jira-client.js';
import { createSeededMemoryDb } from './helpers.js';

const ACME_SITE = 'https://acme.atlassian.net';
const ACME_ORIGIN = 'https://acme.atlassian.net';
const PLAINTEXT_TOKEN = 'super-secret-jira-api-token';

const ACME: AuthContext = { userId: 'user-acme-alice', tenantId: 'tenant-acme' };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function issuePayload(
  id: string,
  key: string,
  summary: string,
  created: string,
  projectKey: string,
): Record<string, unknown> {
  return { id, key, fields: { summary, created, project: { key: projectKey } } };
}

describe('RecentTicketsService', () => {
  let db: DatabaseSync;
  let encryptionKey: Buffer;
  let connectionId: string;

  beforeEach(async () => {
    db = await createSeededMemoryDb();
    encryptionKey = randomBytes(32);
    const connections = new JiraConnectionRepository(db);
    connectionId = connections.upsert('tenant-acme', {
      configuredByUserId: 'user-acme-alice',
      siteUrl: ACME_SITE,
      email: 'configurer@example.com',
      accountId: 'acc-1',
      encryptedToken: encryptToken(PLAINTEXT_TOKEN, encryptionKey, { tenantId: 'tenant-acme' }),
    }).id;
  });

  afterEach(() => {
    db.close();
  });

  let issueSeq = 0;
  function seedProvenance(
    issueId: string,
    createdAt: string,
    opts: { projectKey?: string; siteUrl?: string; userId?: string } = {},
  ): void {
    issueSeq += 1;
    db.prepare(
      `INSERT INTO jira_ticket_provenance
         (id, tenant_id, created_by_user_id, jira_connection_id, jira_site_url,
          jira_project_id, jira_project_key, jira_issue_id, jira_issue_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      `row-${issueSeq}`,
      'tenant-acme',
      opts.userId ?? 'user-acme-alice',
      connectionId,
      opts.siteUrl ?? ACME_SITE,
      'proj-id',
      opts.projectKey ?? 'ABC',
      issueId,
      `STALE-${issueId}`,
      createdAt,
    );
  }

  function service(fetch: FetchLike): RecentTicketsService {
    return new RecentTicketsService({ db, encryptionKey, fetch });
  }

  it('returns hydrated tickets in local provenance order with safe URLs', async () => {
    seedProvenance('10001', '2026-01-01T00:00:00.000Z');
    seedProvenance('10002', '2026-01-02T00:00:00.000Z');

    // Jira returns current keys/titles in a different order than provenance.
    const fetch = vi.fn(async () =>
      jsonResponse({
        issues: [
          issuePayload('10001', 'ABC-1', 'Current title 1', '2026-01-01T10:00:00.000Z', 'ABC'),
          issuePayload('10002', 'ABC-2', 'Current title 2', '2026-01-02T10:00:00.000Z', 'ABC'),
        ],
      }),
    ) as unknown as FetchLike;

    const outcome = await service(fetch).listRecentTickets(ACME, { projectKey: 'ABC' });
    expect(outcome).toEqual({
      status: 'ok',
      tickets: [
        {
          issueId: '10002',
          issueKey: 'ABC-2',
          title: 'Current title 2',
          createdAt: '2026-01-02T10:00:00.000Z',
          url: `${ACME_ORIGIN}/browse/ABC-2`,
        },
        {
          issueId: '10001',
          issueKey: 'ABC-1',
          title: 'Current title 1',
          createdAt: '2026-01-01T10:00:00.000Z',
          url: `${ACME_ORIGIN}/browse/ABC-1`,
        },
      ],
    });
  });

  it('returns an empty list when the tenant has no candidates', async () => {
    const fetch = vi.fn(async () => jsonResponse({ issues: [] })) as unknown as FetchLike;
    const outcome = await service(fetch).listRecentTickets(ACME, { projectKey: 'ABC' });
    expect(outcome).toEqual({ status: 'ok', tickets: [] });
    // No candidates means no Jira call is needed.
    expect(fetch).not.toHaveBeenCalled();
  });

  it('skips issues Jira omitted (deleted/inaccessible) and keeps the rest', async () => {
    seedProvenance('10001', '2026-01-01T00:00:00.000Z');
    seedProvenance('10002', '2026-01-02T00:00:00.000Z');
    const fetch = vi.fn(async () =>
      jsonResponse({ issues: [issuePayload('10001', 'ABC-1', 'Only one', '2026-01-01T10:00:00.000Z', 'ABC')] }),
    ) as unknown as FetchLike;
    const outcome = await service(fetch).listRecentTickets(ACME, { projectKey: 'ABC' });
    expect(outcome.status === 'ok' && outcome.tickets.map((t) => t.issueId)).toEqual(['10001']);
  });

  it('skips an issue that moved to a different project', async () => {
    seedProvenance('10001', '2026-01-01T00:00:00.000Z');
    const fetch = vi.fn(async () =>
      jsonResponse({ issues: [issuePayload('10001', 'XYZ-9', 'Moved away', '2026-01-01T10:00:00.000Z', 'XYZ')] }),
    ) as unknown as FetchLike;
    const outcome = await service(fetch).listRecentTickets(ACME, { projectKey: 'ABC' });
    expect(outcome).toEqual({ status: 'ok', tickets: [] });
  });

  it('caps the result at ten and stops fetching further batches', async () => {
    for (let i = 0; i < 30; i += 1) {
      const n = String(20000 + i);
      // Descending timestamps so newest is 20029.
      seedProvenance(n, `2026-02-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`);
    }
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      const requestedIds = JSON.parse(init?.body as string).issueIdsOrKeys as string[];
      return jsonResponse({
        issues: requestedIds.map((id) => issuePayload(id, `ABC-${id}`, `T-${id}`, '2026-02-01T00:00:00.000Z', 'ABC')),
      });
    }) as unknown as FetchLike;

    const outcome = await service(fetch).listRecentTickets(ACME, { projectKey: 'ABC' });
    expect(outcome.status).toBe('ok');
    expect(outcome.status === 'ok' && outcome.tickets).toHaveLength(10);
    // The first batch of 25 already yields ten valid tickets, so only one fetch runs.
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('loads later batches when early candidates are all skipped', async () => {
    // 30 candidates; Jira omits the first 25, so a second batch is needed.
    for (let i = 0; i < 30; i += 1) {
      const n = String(30000 + i);
      seedProvenance(n, `2026-03-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`);
    }
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      const requestedIds = JSON.parse(init?.body as string).issueIdsOrKeys as string[];
      // Only ids >= 30025 (the oldest five) hydrate; the newest 25 are omitted.
      const issues = requestedIds
        .filter((id) => Number(id) >= 30025)
        .map((id) => issuePayload(id, `ABC-${id}`, `T-${id}`, '2026-03-01T00:00:00.000Z', 'ABC'));
      return jsonResponse({ issues });
    }) as unknown as FetchLike;

    const outcome = await service(fetch).listRecentTickets(ACME, { projectKey: 'ABC' });
    expect(outcome.status === 'ok' && outcome.tickets).toHaveLength(5);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('loads the connection once and reuses one client and origin for all batches', async () => {
    for (let i = 0; i < 30; i += 1) {
      const n = String(40000 + i);
      seedProvenance(n, `2026-04-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`);
    }
    const urls: string[] = [];
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      urls.push(url);
      const requestedIds = JSON.parse(init?.body as string).issueIdsOrKeys as string[];
      const issues = requestedIds
        .filter((id) => Number(id) >= 40025)
        .map((id) => issuePayload(id, `ABC-${id}`, `T-${id}`, '2026-04-01T00:00:00.000Z', 'ABC'));
      return jsonResponse({ issues });
    }) as unknown as FetchLike;

    await service(fetch).listRecentTickets(ACME, { projectKey: 'ABC' });
    // Every batch targets the same origin-built URL.
    expect(new Set(urls)).toEqual(new Set([`${ACME_ORIGIN}/rest/api/3/issue/bulkfetch`]));
  });

  it('returns not_connected when the tenant has no Jira connection', async () => {
    const fetch = vi.fn(async () => jsonResponse({ issues: [] })) as unknown as FetchLike;
    const globex: AuthContext = { userId: 'user-globex-alice', tenantId: 'tenant-globex' };
    expect(await service(fetch).listRecentTickets(globex, { projectKey: 'ABC' })).toEqual({
      status: 'not_connected',
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('returns configuration_error when the stored token cannot be decrypted', async () => {
    seedProvenance('10001', '2026-01-01T00:00:00.000Z');
    const wrongKeyService = new RecentTicketsService({
      db,
      encryptionKey: randomBytes(32),
      fetch: vi.fn(async () => jsonResponse({ issues: [] })) as unknown as FetchLike,
    });
    expect(await wrongKeyService.listRecentTickets(ACME, { projectKey: 'ABC' })).toEqual({
      status: 'configuration_error',
    });
  });

  it.each([
    [401, 'credentials_rejected'],
    [503, 'unavailable'],
  ] as const)('maps a Jira %s during hydration to %s', async (status, expected) => {
    seedProvenance('10001', '2026-01-01T00:00:00.000Z');
    const fetch = vi.fn(async () => new Response('internal', { status })) as unknown as FetchLike;
    expect(await service(fetch).listRecentTickets(ACME, { projectKey: 'ABC' })).toEqual({ status: expected });
  });

  it('maps a hydration timeout to timeout', async () => {
    seedProvenance('10001', '2026-01-01T00:00:00.000Z');
    const fetch = vi.fn(async () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      throw error;
    }) as unknown as FetchLike;
    expect(await service(fetch).listRecentTickets(ACME, { projectKey: 'ABC' })).toEqual({ status: 'timeout' });
  });

  it('excludes provenance recorded against a previously connected site', async () => {
    // A row recorded when the tenant was connected to a different site.
    seedProvenance('10001', '2026-01-01T00:00:00.000Z', { siteUrl: 'https://old.atlassian.net' });
    seedProvenance('10002', '2026-01-02T00:00:00.000Z');
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      const requestedIds = JSON.parse(init?.body as string).issueIdsOrKeys as string[];
      return jsonResponse({
        issues: requestedIds.map((id) => issuePayload(id, `ABC-${id}`, `T-${id}`, '2026-01-02T10:00:00.000Z', 'ABC')),
      });
    }) as unknown as FetchLike;

    const outcome = await service(fetch).listRecentTickets(ACME, { projectKey: 'ABC' });
    expect(outcome.status === 'ok' && outcome.tickets.map((t) => t.issueId)).toEqual(['10002']);
    // The old-site issue id is never even requested from Jira.
    const requested = JSON.parse((fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body).issueIdsOrKeys;
    expect(requested).toEqual(['10002']);
  });

  it('percent-encodes the issue key when building the browse URL', async () => {
    seedProvenance('10001', '2026-01-01T00:00:00.000Z');
    const fetch = vi.fn(async () =>
      jsonResponse({ issues: [issuePayload('10001', 'AB C/1', 'Weird key', '2026-01-01T10:00:00.000Z', 'ABC')] }),
    ) as unknown as FetchLike;
    const outcome = await service(fetch).listRecentTickets(ACME, { projectKey: 'ABC' });
    expect(outcome.status === 'ok' && outcome.tickets[0].url).toBe(`${ACME_ORIGIN}/browse/AB%20C%2F1`);
  });
});
