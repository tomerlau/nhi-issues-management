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

const validBody = {
  projectKey: 'ABC',
  title: 'Leaked service-account key',
  description: 'Found a leaked key in the repo.',
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

function happyPathFetch(created = { id: '10500', key: 'ABC-42' }): FetchLike {
  return vi.fn(async (_url: string, init?: RequestInit) => {
    if ((init?.method ?? 'GET') === 'POST') {
      return jsonResponse(created, 201);
    }
    return jsonResponse(VALID_PROJECT_BODY);
  }) as unknown as FetchLike;
}

const encryptionKey = randomBytes(32);

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

describe('ticket creation endpoint', () => {
  let db: DatabaseSync;

  beforeEach(async () => {
    db = await createSeededMemoryDb();
  });

  afterEach(() => {
    db.close();
  });

  /** Seed a tenant connection directly so tests start with Jira already connected. */
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

  describe('authentication and caching', () => {
    it('rejects an unauthenticated POST', async () => {
      const app = appWith(db, { encryptionKey, fetch: happyPathFetch() });
      const res = await request(app).post('/api/tickets').send(validBody);
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('unauthenticated');
    });

    it('sets Cache-Control: no-store on responses', async () => {
      storeConnection('tenant-acme', 'user-acme-alice');
      const app = appWith(db, { encryptionKey, fetch: happyPathFetch() });
      const agent = await loginAgent(app, acmeAlice);
      const res = await agent.post('/api/tickets').send(validBody);
      expect(res.headers['cache-control']).toBe('no-store');
    });
  });

  describe('not configured', () => {
    it('returns 503 when no encryption key is configured', async () => {
      const app = appWith(db, { encryptionKey: null, fetch: happyPathFetch() });
      const agent = await loginAgent(app, acmeAlice);
      const res = await agent.post('/api/tickets').send(validBody);
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('jira_not_configured');
    });
  });

  describe('request validation', () => {
    it('rejects malformed JSON with a structured 400 and no-store', async () => {
      const app = appWith(db, { encryptionKey, fetch: happyPathFetch() });
      const agent = await loginAgent(app, acmeAlice);
      const res = await agent
        .post('/api/tickets')
        .set('Content-Type', 'application/json')
        .send('{ not valid json');
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('invalid_request');
      expect(res.headers['cache-control']).toBe('no-store');
    });

    it('rejects missing, wrong-typed, empty, and overlong fields without any Jira call', async () => {
      const fetch = vi.fn(async () => jsonResponse(VALID_PROJECT_BODY));
      const app = appWith(db, { encryptionKey, fetch: fetch as unknown as FetchLike });
      storeConnection('tenant-acme', 'user-acme-alice');
      const agent = await loginAgent(app, acmeAlice);

      const bodies = [
        {},
        { title: validBody.title, description: validBody.description },
        { projectKey: validBody.projectKey, description: validBody.description },
        { projectKey: validBody.projectKey, title: validBody.title },
        { projectKey: 123, title: validBody.title, description: validBody.description },
        { projectKey: validBody.projectKey, title: 5, description: validBody.description },
        { projectKey: validBody.projectKey, title: validBody.title, description: false },
        { projectKey: '', title: validBody.title, description: validBody.description },
        { projectKey: 'a', title: validBody.title, description: validBody.description },
        { projectKey: 'AB CD', title: validBody.title, description: validBody.description },
        { projectKey: 'A'.repeat(30), title: validBody.title, description: validBody.description },
        { projectKey: validBody.projectKey, title: '   ', description: validBody.description },
        { projectKey: validBody.projectKey, title: 'a'.repeat(300), description: validBody.description },
        { projectKey: validBody.projectKey, title: validBody.title, description: '   ' },
        { projectKey: validBody.projectKey, title: validBody.title, description: 'a'.repeat(6000) },
      ];
      for (const body of bodies) {
        const res = await agent.post('/api/tickets').send(body);
        expect(res.status, JSON.stringify(body)).toBe(400);
        expect(res.body.error.code).toBe('invalid_request');
      }
      expect(fetch).not.toHaveBeenCalled();
    });
  });

  describe('outcome mapping', () => {
    it('creates a ticket and returns 201 with the issue id and key', async () => {
      storeConnection('tenant-acme', 'user-acme-alice');
      const app = appWith(db, { encryptionKey, fetch: happyPathFetch() });
      const agent = await loginAgent(app, acmeAlice);
      const res = await agent.post('/api/tickets').send(validBody);
      expect(res.status).toBe(201);
      expect(res.body).toEqual({ issueId: '10500', issueKey: 'ABC-42' });
    });

    it('returns 409 when the tenant has no Jira connection', async () => {
      const app = appWith(db, { encryptionKey, fetch: happyPathFetch() });
      const agent = await loginAgent(app, acmeAlice);
      const res = await agent.post('/api/tickets').send(validBody);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('jira_not_connected');
    });

    it('returns 422 when the project is inaccessible', async () => {
      storeConnection('tenant-acme', 'user-acme-alice');
      const fetch = vi.fn(async () => new Response('', { status: 404 })) as unknown as FetchLike;
      const app = appWith(db, { encryptionKey, fetch });
      const agent = await loginAgent(app, acmeAlice);
      const res = await agent.post('/api/tickets').send(validBody);
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('jira_project_inaccessible');
    });

    it('returns 422 when the project does not support the Task type', async () => {
      storeConnection('tenant-acme', 'user-acme-alice');
      const fetch = vi.fn(async () =>
        jsonResponse({ id: '1', key: 'ABC', issueTypes: [{ id: '1', name: 'Bug', subtask: false }] }),
      ) as unknown as FetchLike;
      const app = appWith(db, { encryptionKey, fetch });
      const agent = await loginAgent(app, acmeAlice);
      const res = await agent.post('/api/tickets').send(validBody);
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('jira_task_unsupported');
    });

    it('returns 502 when Jira rejects the credentials', async () => {
      storeConnection('tenant-acme', 'user-acme-alice');
      const fetch = vi.fn(async () => new Response('', { status: 401 })) as unknown as FetchLike;
      const app = appWith(db, { encryptionKey, fetch });
      const agent = await loginAgent(app, acmeAlice);
      const res = await agent.post('/api/tickets').send(validBody);
      expect(res.status).toBe(502);
      expect(res.body.error.code).toBe('jira_unreachable');
    });

    it('returns 502 when Jira is unreachable', async () => {
      storeConnection('tenant-acme', 'user-acme-alice');
      const fetch = vi.fn(async () => {
        throw new Error('ECONNREFUSED secret-internal-detail');
      }) as unknown as FetchLike;
      const app = appWith(db, { encryptionKey, fetch });
      const agent = await loginAgent(app, acmeAlice);
      const res = await agent.post('/api/tickets').send(validBody);
      expect(res.status).toBe(502);
      expect(res.body.error.code).toBe('jira_unreachable');
      expect(JSON.stringify(res.body)).not.toContain('ECONNREFUSED');
    });

    it('returns 504 on a Jira timeout', async () => {
      storeConnection('tenant-acme', 'user-acme-alice');
      const fetch = vi.fn(async () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        throw error;
      }) as unknown as FetchLike;
      const app = appWith(db, { encryptionKey, fetch });
      const agent = await loginAgent(app, acmeAlice);
      const res = await agent.post('/api/tickets').send(validBody);
      expect(res.status).toBe(504);
      expect(res.body.error.code).toBe('jira_timeout');
    });

    it('returns 503 when the stored credentials cannot be decrypted', async () => {
      storeConnection('tenant-acme', 'user-acme-alice');
      // A different app instance with a wrong key cannot decrypt the stored token.
      const app = appWith(db, { encryptionKey: randomBytes(32), fetch: happyPathFetch() });
      const agent = await loginAgent(app, acmeAlice);
      const res = await agent.post('/api/tickets').send(validBody);
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('jira_not_configured');
    });
  });

  describe('ownership and isolation', () => {
    it('derives tenant and creator from the session, ignoring client-supplied ownership fields', async () => {
      storeConnection('tenant-acme', 'user-acme-alice');
      const app = appWith(db, { encryptionKey, fetch: happyPathFetch() });
      const agent = await loginAgent(app, acmeBob);

      const res = await agent.post('/api/tickets').send({
        ...validBody,
        tenantId: 'tenant-globex',
        userId: 'user-globex-alice',
        createdByUserId: 'user-globex-alice',
        connectionId: 'spoofed-id',
        siteUrl: 'https://evil.atlassian.net',
        issueType: 'Bug',
      });
      expect(res.status).toBe(201);

      const rows = db
        .prepare('SELECT tenant_id, created_by_user_id, jira_site_url FROM jira_ticket_provenance')
        .all() as { tenant_id: string; created_by_user_id: string; jira_site_url: string }[];
      expect(rows).toEqual([
        {
          tenant_id: 'tenant-acme',
          created_by_user_id: 'user-acme-bob',
          jira_site_url: ACME_SITE,
        },
      ]);
    });

    it('lets two same-tenant users share the connection while recording each as creator', async () => {
      const connectionId = storeConnection('tenant-acme', 'user-acme-alice');
      // Each creation returns a distinct issue id so both provenance rows persist.
      let issueCounter = 0;
      const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
        if ((init?.method ?? 'GET') === 'POST') {
          issueCounter += 1;
          return jsonResponse({ id: `1050${issueCounter}`, key: `ABC-${issueCounter}` }, 201);
        }
        return jsonResponse(VALID_PROJECT_BODY);
      }) as unknown as FetchLike;
      const app = appWith(db, { encryptionKey, fetch });
      const alice = await loginAgent(app, acmeAlice);
      const bob = await loginAgent(app, acmeBob);

      expect((await alice.post('/api/tickets').send(validBody)).status).toBe(201);
      expect((await bob.post('/api/tickets').send(validBody)).status).toBe(201);

      const rows = db
        .prepare(
          'SELECT created_by_user_id, jira_connection_id FROM jira_ticket_provenance ORDER BY created_by_user_id',
        )
        .all() as { created_by_user_id: string; jira_connection_id: string }[];
      expect(rows).toEqual([
        { created_by_user_id: 'user-acme-alice', jira_connection_id: connectionId },
        { created_by_user_id: 'user-acme-bob', jira_connection_id: connectionId },
      ]);
    });

    it('keeps tenants isolated: a tenant without a connection gets 409 even if another tenant is connected', async () => {
      storeConnection('tenant-acme', 'user-acme-alice');
      const fetch = happyPathFetch();
      const app = appWith(db, { encryptionKey, fetch });
      const globex = await loginAgent(app, globexAlice);
      const res = await globex.post('/api/tickets').send(validBody);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('jira_not_connected');
      expect(db.prepare('SELECT COUNT(*) AS n FROM jira_ticket_provenance').get()).toEqual({ n: 0 });
    });
  });
});
