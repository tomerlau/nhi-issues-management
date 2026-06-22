import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, type AppOptions } from '../src/app.js';
import { JiraConnectionRepository } from '../src/repositories/jira-connection-repository.js';
import { encryptToken } from '../src/jira/token-cipher.js';
import type { FetchLike } from '../src/jira/jira-client.js';
import { createSeededMemoryDb, DEMO_CREDENTIALS } from './helpers.js';

const { acmeAlice, acmeBob, globexAlice } = DEMO_CREDENTIALS;

const ACME_SITE = 'https://acme.atlassian.net';
const PLAINTEXT_TOKEN = 'super-secret-jira-api-token';
const encryptionKey = randomBytes(32);

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

/** A fetch that hydrates exactly the requested ids in project ABC. */
function hydratingFetch(): FetchLike {
  return vi.fn(async (_url: string, init?: RequestInit) => {
    const ids = JSON.parse(init?.body as string).issueIdsOrKeys as string[];
    return jsonResponse({
      issues: ids.map((id) => issuePayload(id, `ABC-${id}`, `Title ${id}`, '2026-01-01T00:00:00.000Z', 'ABC')),
    });
  }) as unknown as FetchLike;
}

function appWith(db: DatabaseSync, jira: AppOptions['jira']) {
  return createApp(db, { cookieSecure: false, jira });
}

async function loginAgent(
  app: ReturnType<typeof createApp>,
  creds: { email: string; password: string },
) {
  const agent = request.agent(app);
  await agent.post('/api/auth/login').send({ email: creds.email, password: creds.password });
  return agent;
}

describe('recent tickets endpoint', () => {
  let db: DatabaseSync;
  let connectionId: string;

  beforeEach(async () => {
    db = await createSeededMemoryDb();
  });

  afterEach(() => {
    db.close();
  });

  function storeConnection(tenantId: string, userId: string, siteUrl = ACME_SITE): string {
    const repository = new JiraConnectionRepository(db);
    const connection = repository.upsert(tenantId, {
      configuredByUserId: userId,
      siteUrl,
      email: 'configurer@example.com',
      accountId: 'acc-1',
      encryptedToken: encryptToken(PLAINTEXT_TOKEN, encryptionKey, { tenantId }),
    });
    return connection.id;
  }

  let seq = 0;
  function seedProvenance(
    tenantId: string,
    userId: string,
    conn: string,
    issueId: string,
    createdAt: string,
    opts: { projectKey?: string; siteUrl?: string } = {},
  ): void {
    seq += 1;
    db.prepare(
      `INSERT INTO jira_ticket_provenance
         (id, tenant_id, created_by_user_id, jira_connection_id, jira_site_url,
          jira_project_id, jira_project_key, jira_issue_id, jira_issue_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      `row-${seq}`,
      tenantId,
      userId,
      conn,
      opts.siteUrl ?? ACME_SITE,
      'proj-id',
      opts.projectKey ?? 'ABC',
      issueId,
      `STALE-${issueId}`,
      createdAt,
    );
  }

  describe('success', () => {
    it('returns 200 with hydrated tickets, no-store, in newest-first order', async () => {
      connectionId = storeConnection('tenant-acme', 'user-acme-alice');
      seedProvenance('tenant-acme', 'user-acme-alice', connectionId, '10001', '2026-01-01T00:00:00.000Z');
      seedProvenance('tenant-acme', 'user-acme-alice', connectionId, '10002', '2026-01-02T00:00:00.000Z');
      const app = appWith(db, { encryptionKey, fetch: hydratingFetch() });
      const agent = await loginAgent(app, acmeAlice);

      const res = await agent.get('/api/tickets?projectKey=ABC');
      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body.tickets.map((t: { issueId: string }) => t.issueId)).toEqual(['10002', '10001']);
      expect(res.body.tickets[0]).toEqual({
        issueId: '10002',
        issueKey: 'ABC-10002',
        title: 'Title 10002',
        createdAt: '2026-01-01T00:00:00.000Z',
        url: 'https://acme.atlassian.net/browse/ABC-10002',
      });
    });

    it('returns 200 with an empty array when there are no candidates', async () => {
      storeConnection('tenant-acme', 'user-acme-alice');
      const fetch = hydratingFetch();
      const app = appWith(db, { encryptionKey, fetch });
      const agent = await loginAgent(app, acmeAlice);
      const res = await agent.get('/api/tickets?projectKey=ABC');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ tickets: [] });
      expect(fetch).not.toHaveBeenCalled();
    });

    it('normalizes the project key (trim + uppercase) before matching', async () => {
      connectionId = storeConnection('tenant-acme', 'user-acme-alice');
      seedProvenance('tenant-acme', 'user-acme-alice', connectionId, '10001', '2026-01-01T00:00:00.000Z');
      const app = appWith(db, { encryptionKey, fetch: hydratingFetch() });
      const agent = await loginAgent(app, acmeAlice);
      const res = await agent.get('/api/tickets?projectKey=%20abc%20');
      expect(res.status).toBe(200);
      expect(res.body.tickets.map((t: { issueId: string }) => t.issueId)).toEqual(['10001']);
    });
  });

  describe('request validation (no Jira call)', () => {
    it.each([
      ['missing', '/api/tickets'],
      ['empty', '/api/tickets?projectKey='],
      ['too short', '/api/tickets?projectKey=A'],
      ['bad syntax', '/api/tickets?projectKey=AB-CD'],
      ['too long', `/api/tickets?projectKey=${'A'.repeat(30)}`],
      ['repeated', '/api/tickets?projectKey=ABC&projectKey=DEF'],
    ])('rejects a %s projectKey with 400 and never calls Jira', async (_label, url) => {
      storeConnection('tenant-acme', 'user-acme-alice');
      const fetch = hydratingFetch();
      const app = appWith(db, { encryptionKey, fetch });
      const agent = await loginAgent(app, acmeAlice);
      const res = await agent.get(url);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('invalid_request');
      expect(fetch).not.toHaveBeenCalled();
    });

    it('ignores client-supplied limit and cursor query parameters', async () => {
      connectionId = storeConnection('tenant-acme', 'user-acme-alice');
      for (let i = 0; i < 12; i += 1) {
        const n = String(10000 + i);
        seedProvenance(
          'tenant-acme',
          'user-acme-alice',
          connectionId,
          n,
          `2026-05-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`,
        );
      }
      const app = appWith(db, { encryptionKey, fetch: hydratingFetch() });
      const agent = await loginAgent(app, acmeAlice);
      const res = await agent.get('/api/tickets?projectKey=ABC&limit=1&cursor=abc');
      expect(res.status).toBe(200);
      // The fixed internal cap of ten applies regardless of the bogus limit=1.
      expect(res.body.tickets).toHaveLength(10);
    });
  });

  describe('auth and configuration', () => {
    it('rejects an unauthenticated request', async () => {
      const app = appWith(db, { encryptionKey, fetch: hydratingFetch() });
      const res = await request(app).get('/api/tickets?projectKey=ABC');
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('unauthenticated');
    });

    it('returns 503 when no encryption key is configured', async () => {
      const app = appWith(db, { encryptionKey: null, fetch: hydratingFetch() });
      const agent = await loginAgent(app, acmeAlice);
      const res = await agent.get('/api/tickets?projectKey=ABC');
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('jira_not_configured');
    });

    it('returns 503 when the stored credentials cannot be decrypted', async () => {
      storeConnection('tenant-acme', 'user-acme-alice');
      const app = appWith(db, { encryptionKey: randomBytes(32), fetch: hydratingFetch() });
      const agent = await loginAgent(app, acmeAlice);
      const res = await agent.get('/api/tickets?projectKey=ABC');
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('jira_not_configured');
    });
  });

  describe('outcome mapping', () => {
    it('returns 409 when the tenant has no Jira connection', async () => {
      const app = appWith(db, { encryptionKey, fetch: hydratingFetch() });
      const agent = await loginAgent(app, acmeAlice);
      const res = await agent.get('/api/tickets?projectKey=ABC');
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('jira_not_connected');
    });

    it('returns 502 jira_credentials_rejected on a 401 during hydration', async () => {
      connectionId = storeConnection('tenant-acme', 'user-acme-alice');
      seedProvenance('tenant-acme', 'user-acme-alice', connectionId, '10001', '2026-01-01T00:00:00.000Z');
      const fetch = vi.fn(async () => new Response('', { status: 401 })) as unknown as FetchLike;
      const app = appWith(db, { encryptionKey, fetch });
      const agent = await loginAgent(app, acmeAlice);
      const res = await agent.get('/api/tickets?projectKey=ABC');
      expect(res.status).toBe(502);
      expect(res.body.error.code).toBe('jira_credentials_rejected');
    });

    it('returns 502 jira_unreachable on a 5xx during hydration', async () => {
      connectionId = storeConnection('tenant-acme', 'user-acme-alice');
      seedProvenance('tenant-acme', 'user-acme-alice', connectionId, '10001', '2026-01-01T00:00:00.000Z');
      const fetch = vi.fn(async () => new Response('upstream boom', { status: 503 })) as unknown as FetchLike;
      const app = appWith(db, { encryptionKey, fetch });
      const agent = await loginAgent(app, acmeAlice);
      const res = await agent.get('/api/tickets?projectKey=ABC');
      expect(res.status).toBe(502);
      expect(res.body.error.code).toBe('jira_unreachable');
      expect(JSON.stringify(res.body)).not.toContain('upstream boom');
    });

    it('returns 502 jira_unreachable when a hydrated issue has an invalid created timestamp', async () => {
      connectionId = storeConnection('tenant-acme', 'user-acme-alice');
      seedProvenance('tenant-acme', 'user-acme-alice', connectionId, '10001', '2026-01-01T00:00:00.000Z');
      const fetch = vi.fn(async () =>
        jsonResponse({
          issues: [issuePayload('10001', 'ABC-10001', 'Title 10001', 'not-a-date', 'ABC')],
        }),
      ) as unknown as FetchLike;
      const app = appWith(db, { encryptionKey, fetch });
      const agent = await loginAgent(app, acmeAlice);
      const res = await agent.get('/api/tickets?projectKey=ABC');
      expect(res.status).toBe(502);
      expect(res.body.error.code).toBe('jira_unreachable');
      const dump = JSON.stringify(res.body);
      expect(dump).not.toContain('not-a-date');
      expect(dump).not.toContain('Title 10001');
    });

    it('returns 504 on a Jira timeout during hydration', async () => {
      connectionId = storeConnection('tenant-acme', 'user-acme-alice');
      seedProvenance('tenant-acme', 'user-acme-alice', connectionId, '10001', '2026-01-01T00:00:00.000Z');
      const fetch = vi.fn(async () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        throw error;
      }) as unknown as FetchLike;
      const app = appWith(db, { encryptionKey, fetch });
      const agent = await loginAgent(app, acmeAlice);
      const res = await agent.get('/api/tickets?projectKey=ABC');
      expect(res.status).toBe(504);
      expect(res.body.error.code).toBe('jira_timeout');
    });
  });

  describe('tenant sharing and isolation', () => {
    it('shows two same-tenant users the same tenant-owned tickets', async () => {
      connectionId = storeConnection('tenant-acme', 'user-acme-alice');
      seedProvenance('tenant-acme', 'user-acme-alice', connectionId, '10001', '2026-01-01T00:00:00.000Z');
      seedProvenance('tenant-acme', 'user-acme-bob', connectionId, '10002', '2026-01-02T00:00:00.000Z');
      const app = appWith(db, { encryptionKey, fetch: hydratingFetch() });

      const alice = await loginAgent(app, acmeAlice);
      const bob = await loginAgent(app, acmeBob);
      const aliceRes = await alice.get('/api/tickets?projectKey=ABC');
      const bobRes = await bob.get('/api/tickets?projectKey=ABC');

      const ids = (r: typeof aliceRes) => r.body.tickets.map((t: { issueId: string }) => t.issueId);
      expect(ids(aliceRes)).toEqual(['10002', '10001']);
      expect(ids(bobRes)).toEqual(['10002', '10001']);
    });

    it('keeps tenants isolated: another tenant never sees these rows', async () => {
      connectionId = storeConnection('tenant-acme', 'user-acme-alice');
      seedProvenance('tenant-acme', 'user-acme-alice', connectionId, '10001', '2026-01-01T00:00:00.000Z');
      // Globex is connected to the same site URL but must not see acme provenance.
      storeConnection('tenant-globex', 'user-globex-alice');
      const app = appWith(db, { encryptionKey, fetch: hydratingFetch() });
      const globex = await loginAgent(app, globexAlice);
      const res = await globex.get('/api/tickets?projectKey=ABC');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ tickets: [] });
    });
  });
});
