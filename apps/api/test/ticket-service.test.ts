import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TicketService } from '../src/jira/ticket-service.js';
import { JiraConnectionRepository } from '../src/repositories/jira-connection-repository.js';
import { encryptToken } from '../src/jira/token-cipher.js';
import type { FetchLike } from '../src/jira/jira-client.js';
import type { AuthContext } from '../src/auth/auth-context.js';
import { createSeededMemoryDb } from './helpers.js';

const PLAINTEXT_TOKEN = 'super-secret-jira-api-token';

const acmeAlice: AuthContext = { userId: 'user-acme-alice', tenantId: 'tenant-acme' };
const acmeBob: AuthContext = { userId: 'user-acme-bob', tenantId: 'tenant-acme' };
const globexAlice: AuthContext = { userId: 'user-globex-alice', tenantId: 'tenant-globex' };

const ACME_SITE = 'https://acme.atlassian.net';

const baseInput = {
  projectKey: 'ABC',
  title: 'NHI finding: leaked service-account key',
  description: 'A multi-line\ndescription.',
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const VALID_PROJECT_BODY = {
  id: '10001',
  key: 'ABC',
  issueTypes: [
    { id: '1', name: 'Bug', subtask: false },
    { id: '2', name: 'Task', subtask: false },
  ],
};

/**
 * A fetch that resolves project validation (GET) with a valid Task-supporting
 * project and issue creation (POST) with a fixed created issue. Each call is
 * recorded so tests can assert exactly which Jira requests were made.
 */
function happyPathFetch(created = { id: '10500', key: 'ABC-42' }): FetchLike {
  return vi.fn(async (_url: string, init?: RequestInit) => {
    if ((init?.method ?? 'GET') === 'POST') {
      return jsonResponse(created, 201);
    }
    return jsonResponse(VALID_PROJECT_BODY);
  }) as unknown as FetchLike;
}

describe('TicketService.createTicket', () => {
  let db: DatabaseSync;
  const key = randomBytes(32);

  beforeEach(async () => {
    db = await createSeededMemoryDb();
  });

  afterEach(() => {
    db.close();
  });

  function storeConnection(
    context: AuthContext,
    options: { siteUrl?: string } = {},
  ): string {
    const repository = new JiraConnectionRepository(db);
    const connection = repository.upsert(context.tenantId, {
      configuredByUserId: context.userId,
      siteUrl: options.siteUrl ?? ACME_SITE,
      email: 'configurer@example.com',
      accountId: 'acc-1',
      encryptedToken: encryptToken(PLAINTEXT_TOKEN, key, { tenantId: context.tenantId }),
    });
    return connection.id;
  }

  function service(fetch: FetchLike, encryptionKey: Buffer = key): TicketService {
    return new TicketService({ db, encryptionKey, fetch });
  }

  function provenanceRows(): Record<string, unknown>[] {
    return db
      .prepare('SELECT * FROM jira_ticket_provenance')
      .all() as Record<string, unknown>[];
  }

  it('creates the ticket and records exactly one provenance row on success', async () => {
    const connectionId = storeConnection(acmeAlice);
    const result = await service(happyPathFetch()).createTicket(acmeAlice, baseInput);

    expect(result).toEqual({ status: 'created', issueId: '10500', issueKey: 'ABC-42' });

    const rows = provenanceRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tenant_id: 'tenant-acme',
      created_by_user_id: 'user-acme-alice',
      jira_connection_id: connectionId,
      jira_site_url: ACME_SITE,
      jira_project_id: '10001',
      jira_project_key: 'ABC',
      jira_issue_id: '10500',
      jira_issue_key: 'ABC-42',
    });
    expect(typeof rows[0].id).toBe('string');
    expect(typeof rows[0].created_at).toBe('string');
  });

  it('records the session user as creator even when another tenant user configured the connection', async () => {
    // Alice configures the connection; Bob (same tenant) creates the ticket.
    storeConnection(acmeAlice);
    const result = await service(happyPathFetch()).createTicket(acmeBob, baseInput);
    expect(result.status).toBe('created');

    const rows = provenanceRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].created_by_user_id).toBe('user-acme-bob');
  });

  it('stores no ticket title or description in provenance', async () => {
    storeConnection(acmeAlice);
    await service(happyPathFetch()).createTicket(acmeAlice, baseInput);
    const dump = JSON.stringify(provenanceRows()[0]);
    expect(dump).not.toContain(baseInput.title);
    expect(dump).not.toContain('multi-line');
    expect(dump).not.toContain(PLAINTEXT_TOKEN);
  });

  it('writes no provenance when the tenant has no connection', async () => {
    const fetch = vi.fn() as unknown as FetchLike;
    const result = await service(fetch).createTicket(acmeAlice, baseInput);
    expect(result).toEqual({ status: 'not_connected' });
    expect(fetch).not.toHaveBeenCalled();
    expect(provenanceRows()).toHaveLength(0);
  });

  it('writes no provenance when project validation fails', async () => {
    storeConnection(acmeAlice);
    const fetch = vi.fn(async () => new Response('', { status: 404 })) as unknown as FetchLike;
    const result = await service(fetch).createTicket(acmeAlice, baseInput);
    expect(result).toEqual({ status: 'project_inaccessible' });
    expect(provenanceRows()).toHaveLength(0);
  });

  it('writes no provenance and does not create when the project lacks the Task type', async () => {
    storeConnection(acmeAlice);
    const fetch = vi.fn(async () =>
      jsonResponse({ id: '1', key: 'ABC', issueTypes: [{ id: '1', name: 'Bug', subtask: false }] }),
    ) as unknown as FetchLike;
    const result = await service(fetch).createTicket(acmeAlice, baseInput);
    expect(result).toEqual({ status: 'task_unsupported' });
    // Only the validation GET happened; no POST and no provenance.
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(provenanceRows()).toHaveLength(0);
  });

  it('writes no provenance when Jira rejects the issue creation', async () => {
    storeConnection(acmeAlice);
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'POST') {
        return new Response(JSON.stringify({ errors: { summary: 'required' } }), { status: 400 });
      }
      return jsonResponse(VALID_PROJECT_BODY);
    }) as unknown as FetchLike;
    const result = await service(fetch).createTicket(acmeAlice, baseInput);
    expect(result).toEqual({ status: 'unavailable' });
    expect(provenanceRows()).toHaveLength(0);
  });

  it('maps a wrong encryption key to configuration_error without any network call or provenance', async () => {
    storeConnection(acmeAlice);
    const fetch = vi.fn() as unknown as FetchLike;
    const result = await service(fetch, randomBytes(32)).createTicket(acmeAlice, baseInput);
    expect(result).toEqual({ status: 'configuration_error' });
    expect(fetch).not.toHaveBeenCalled();
    expect(provenanceRows()).toHaveLength(0);
  });

  it('reports persistence_failed when the Jira issue exists but provenance cannot be recorded', async () => {
    storeConnection(acmeAlice);
    // First creation succeeds and records provenance for issue 10500.
    await service(happyPathFetch({ id: '10500', key: 'ABC-1' })).createTicket(acmeAlice, baseInput);
    // A second creation returning the same issue id collides with the unique
    // (tenant, site, issue id) constraint, so provenance insertion throws.
    const result = await service(happyPathFetch({ id: '10500', key: 'ABC-1' })).createTicket(
      acmeAlice,
      baseInput,
    );
    expect(result).toEqual({ status: 'persistence_failed' });
    // The duplicate was not recorded; only the original row remains.
    expect(provenanceRows()).toHaveLength(1);
  });

  it('keeps tenants isolated: another tenant cannot use the connection or create a ticket', async () => {
    storeConnection(acmeAlice);
    const fetch = happyPathFetch();
    const result = await service(fetch).createTicket(globexAlice, baseInput);
    expect(result).toEqual({ status: 'not_connected' });
    expect(fetch).not.toHaveBeenCalled();
    expect(provenanceRows()).toHaveLength(0);
  });

  it('lets each tenant create against its own connection independently', async () => {
    const acmeConnectionId = storeConnection(acmeAlice, { siteUrl: ACME_SITE });
    const globexConnectionId = storeConnection(globexAlice, {
      siteUrl: 'https://globex.atlassian.net',
    });

    expect((await service(happyPathFetch({ id: '1', key: 'ACME-1' })).createTicket(acmeAlice, baseInput)).status).toBe(
      'created',
    );
    expect(
      (await service(happyPathFetch({ id: '2', key: 'GLBX-1' })).createTicket(globexAlice, baseInput)).status,
    ).toBe('created');

    const rows = db
      .prepare('SELECT tenant_id, jira_connection_id FROM jira_ticket_provenance ORDER BY tenant_id')
      .all() as { tenant_id: string; jira_connection_id: string }[];
    expect(rows).toEqual([
      { tenant_id: 'tenant-acme', jira_connection_id: acmeConnectionId },
      { tenant_id: 'tenant-globex', jira_connection_id: globexConnectionId },
    ]);
  });

  it('never returns the plaintext token in any result', async () => {
    storeConnection(acmeAlice);
    const result = await service(happyPathFetch()).createTicket(acmeAlice, baseInput);
    expect(JSON.stringify(result)).not.toContain(PLAINTEXT_TOKEN);
  });
});
