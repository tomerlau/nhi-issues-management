import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, type AppOptions } from '../src/app.js';
import { JiraConnectionRepository } from '../src/repositories/jira-connection-repository.js';
import { encryptToken } from '../src/jira/token-cipher.js';
import type { FetchLike } from '../src/jira/jira-client.js';
import { ApiKeyService } from '../src/auth/api-key-service.js';
import { createSeededMemoryDb, DEMO_CREDENTIALS } from './helpers.js';

const { acmeAlice } = DEMO_CREDENTIALS;

const ACME_SITE = 'https://acme.atlassian.net';
const GLOBEX_SITE = 'https://globex.atlassian.net';
const PLAINTEXT_TOKEN = 'super-secret-jira-api-token';

const validBody = {
  projectKey: 'ABC',
  title: 'Stale Service Account: svc-deploy-prod',
  description: 'Finding details',
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

describe('external ticket endpoint POST /api/v1/tickets', () => {
  let db: DatabaseSync;
  let apiKeyService: ApiKeyService;

  beforeEach(async () => {
    db = await createSeededMemoryDb();
    apiKeyService = new ApiKeyService(db);
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

  // Test 1: Valid API key creates a Jira ticket and returns 201
  it('creates a ticket with a valid API key and returns 201 with issueId and issueKey', async () => {
    storeConnection('tenant-acme', 'user-acme-alice');
    const { fullKey } = apiKeyService.create('tenant-acme', 'user-acme-alice');
    const app = appWith(db, { encryptionKey, fetch: happyPathFetch() });

    const res = await request(app)
      .post('/api/v1/tickets')
      .set('Authorization', `Bearer ${fullKey}`)
      .send(validBody);

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ issueId: '10500', issueKey: 'ABC-42' });
  });

  // Test 2: Provenance contains the API-key owner's tenantId and userId
  it('records the API-key owner tenantId and userId in provenance', async () => {
    storeConnection('tenant-acme', 'user-acme-alice');
    const { fullKey } = apiKeyService.create('tenant-acme', 'user-acme-bob');
    const app = appWith(db, { encryptionKey, fetch: happyPathFetch() });

    const res = await request(app)
      .post('/api/v1/tickets')
      .set('Authorization', `Bearer ${fullKey}`)
      .send(validBody);

    expect(res.status).toBe(201);

    const rows = db
      .prepare(
        'SELECT tenant_id, created_by_user_id, jira_site_url FROM jira_ticket_provenance',
      )
      .all() as { tenant_id: string; created_by_user_id: string; jira_site_url: string }[];

    expect(rows).toEqual([
      {
        tenant_id: 'tenant-acme',
        created_by_user_id: 'user-acme-bob',
        jira_site_url: ACME_SITE,
      },
    ]);
  });

  // Tests 3–9: Authentication failures
  describe('authentication failures', () => {
    // Test 3: Missing Authorization header returns 401
    it('returns 401 when Authorization header is missing', async () => {
      const app = appWith(db, { encryptionKey, fetch: happyPathFetch() });
      const res = await request(app).post('/api/v1/tickets').send(validBody);
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('unauthenticated');
    });

    // Test 4: Wrong authentication scheme returns 401
    it('returns 401 for a wrong authentication scheme (Basic)', async () => {
      const app = appWith(db, { encryptionKey, fetch: happyPathFetch() });
      const res = await request(app)
        .post('/api/v1/tickets')
        .set('Authorization', 'Basic dXNlcjpwYXNz')
        .send(validBody);
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('unauthenticated');
    });

    // Test 5: Malformed API key returns 401
    it('returns 401 for a malformed API key format', async () => {
      const app = appWith(db, { encryptionKey, fetch: happyPathFetch() });
      const res = await request(app)
        .post('/api/v1/tickets')
        .set('Authorization', 'Bearer not_a_valid_nhi_key')
        .send(validBody);
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('unauthenticated');
    });

    // Test 6: Unknown key ID returns 401
    it('returns 401 for an unknown key ID', async () => {
      const app = appWith(db, { encryptionKey, fetch: happyPathFetch() });
      const res = await request(app)
        .post('/api/v1/tickets')
        .set('Authorization', `Bearer nhi_unknownkeyid.${'a'.repeat(43)}`)
        .send(validBody);
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('unauthenticated');
    });

    // Test 7: Correct ID with wrong secret returns 401
    it('returns 401 for a correct key ID with the wrong secret', async () => {
      const { keyId } = apiKeyService.create('tenant-acme', 'user-acme-alice');
      const app = appWith(db, { encryptionKey, fetch: happyPathFetch() });
      const res = await request(app)
        .post('/api/v1/tickets')
        .set('Authorization', `Bearer nhi_${keyId}.${'z'.repeat(43)}`)
        .send(validBody);
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('unauthenticated');
    });

    // Test 8: Revoked key returns 401
    it('returns 401 for a revoked key, same as unknown key', async () => {
      const { fullKey, keyId } = apiKeyService.create('tenant-acme', 'user-acme-alice');
      apiKeyService.revoke(keyId);
      const app = appWith(db, { encryptionKey, fetch: happyPathFetch() });
      const res = await request(app)
        .post('/api/v1/tickets')
        .set('Authorization', `Bearer ${fullKey}`)
        .send(validBody);
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('unauthenticated');
    });

    // Test 9: All authentication failures have the same sanitized response
    it('all authentication failures return the same sanitized 401 response', async () => {
      const { fullKey, keyId } = apiKeyService.create('tenant-acme', 'user-acme-alice');
      apiKeyService.revoke(keyId);
      const app = appWith(db, { encryptionKey, fetch: happyPathFetch() });

      const cases = [
        // Missing header
        request(app).post('/api/v1/tickets').send(validBody),
        // Wrong scheme
        request(app)
          .post('/api/v1/tickets')
          .set('Authorization', 'Basic abc')
          .send(validBody),
        // Malformed key
        request(app)
          .post('/api/v1/tickets')
          .set('Authorization', 'Bearer bad_format')
          .send(validBody),
        // Unknown ID
        request(app)
          .post('/api/v1/tickets')
          .set('Authorization', `Bearer nhi_nope.${'x'.repeat(43)}`)
          .send(validBody),
        // Wrong secret
        request(app)
          .post('/api/v1/tickets')
          .set('Authorization', `Bearer nhi_${keyId}.${'y'.repeat(43)}`)
          .send(validBody),
        // Deleted key
        request(app)
          .post('/api/v1/tickets')
          .set('Authorization', `Bearer ${fullKey}`)
          .send(validBody),
      ];

      const results = await Promise.all(cases);
      for (const res of results) {
        expect(res.status).toBe(401);
        expect(res.body).toEqual({
          error: { code: 'unauthenticated', message: 'Authentication required.' },
        });
        expect(res.headers['cache-control']).toContain('no-store');
      }
    });

    // Test 10: A valid session cookie without an API key returns 401
    it('rejects a valid session cookie without an API key with 401', async () => {
      storeConnection('tenant-acme', 'user-acme-alice');
      const app = appWith(db, { encryptionKey, fetch: happyPathFetch() });
      const agent = await loginAgent(app, acmeAlice);

      // The agent has a session cookie but no Authorization header.
      const res = await agent.post('/api/v1/tickets').send(validBody);
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('unauthenticated');
    });
  });

  // Tests 11–13: Request validation
  describe('request validation', () => {
    // Test 11: Malformed JSON returns 400 without calling Jira
    it('returns 400 for malformed JSON without calling Jira', async () => {
      const { fullKey } = apiKeyService.create('tenant-acme', 'user-acme-alice');
      const fetch = vi.fn() as unknown as FetchLike;
      const app = appWith(db, { encryptionKey, fetch });

      const res = await request(app)
        .post('/api/v1/tickets')
        .set('Authorization', `Bearer ${fullKey}`)
        .set('Content-Type', 'application/json')
        .send('{ not valid json');

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('invalid_request');
      expect(res.headers['cache-control']).toContain('no-store');
      expect(fetch).not.toHaveBeenCalled();
    });

    // Test 12: Oversized body returns 400 without calling Jira
    it('returns 400 for an oversized body without calling Jira', async () => {
      storeConnection('tenant-acme', 'user-acme-alice');
      const { fullKey } = apiKeyService.create('tenant-acme', 'user-acme-alice');
      const fetch = vi.fn() as unknown as FetchLike;
      const app = appWith(db, { encryptionKey, fetch });

      const oversizedBody = { ...validBody, description: 'a'.repeat(11_000) };
      const res = await request(app)
        .post('/api/v1/tickets')
        .set('Authorization', `Bearer ${fullKey}`)
        .send(oversizedBody);

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('invalid_request');
      expect(res.headers['cache-control']).toContain('no-store');
      expect(fetch).not.toHaveBeenCalled();
      // Body content must not appear in the error response.
      const dump = JSON.stringify(res.body);
      expect(dump).not.toContain('aaaa');
      expect(dump).not.toContain('entity too large');
    });

    // Test 13: Missing, invalid-type, empty, malformed, and overlong fields return 400
    it('rejects missing, wrong-typed, empty, malformed, and overlong fields with 400', async () => {
      storeConnection('tenant-acme', 'user-acme-alice');
      const { fullKey } = apiKeyService.create('tenant-acme', 'user-acme-alice');
      const fetch = vi.fn() as unknown as FetchLike;
      const app = appWith(db, { encryptionKey, fetch });

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
        {
          projectKey: validBody.projectKey,
          title: 'a'.repeat(300),
          description: validBody.description,
        },
        { projectKey: validBody.projectKey, title: validBody.title, description: '   ' },
        {
          projectKey: validBody.projectKey,
          title: validBody.title,
          description: 'a'.repeat(6000),
        },
      ];

      for (const body of bodies) {
        const res = await request(app)
          .post('/api/v1/tickets')
          .set('Authorization', `Bearer ${fullKey}`)
          .send(body);
        expect(res.status, JSON.stringify(body)).toBe(400);
        expect(res.body.error.code).toBe('invalid_request');
      }
      expect(fetch).not.toHaveBeenCalled();
    });

    // Test 14: Lowercase projectKey is normalized consistently with the UI endpoint
    it('normalizes lowercase projectKey to uppercase, matching the UI endpoint behavior', async () => {
      storeConnection('tenant-acme', 'user-acme-alice');
      const { fullKey } = apiKeyService.create('tenant-acme', 'user-acme-alice');

      const scrumProjectBody = {
        id: '10002',
        key: 'SCRUM',
        issueTypes: [{ id: '2', name: 'Task', subtask: false }],
      };
      const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
        if ((init?.method ?? 'GET') === 'POST') {
          return jsonResponse({ id: '20001', key: 'SCRUM-42' }, 201);
        }
        return jsonResponse(scrumProjectBody);
      }) as unknown as FetchLike;

      const app = appWith(db, { encryptionKey, fetch });

      const res = await request(app)
        .post('/api/v1/tickets')
        .set('Authorization', `Bearer ${fullKey}`)
        .send({ ...validBody, projectKey: 'scrum' });

      expect(res.status).toBe(201);
      expect(res.body).toEqual({ issueId: '20001', issueKey: 'SCRUM-42' });

      // The project-validation URL must contain the normalized key SCRUM, not lowercase scrum.
      const calledUrls = (fetch as ReturnType<typeof vi.fn>).mock.calls.map(
        (args: unknown[]) => args[0] as string,
      );
      expect(calledUrls.some((url) => url.includes('SCRUM'))).toBe(true);
      expect(calledUrls.every((url) => !url.includes('scrum'))).toBe(true);

      const row = db
        .prepare('SELECT jira_project_key FROM jira_ticket_provenance')
        .get() as { jira_project_key: string };
      expect(row.jira_project_key).toBe('SCRUM');
    });
  });

  // Test 15: Jira not connected returns 409
  it('returns 409 when the API-key owner tenant has no Jira connection', async () => {
    const { fullKey } = apiKeyService.create('tenant-acme', 'user-acme-alice');
    const app = appWith(db, { encryptionKey, fetch: happyPathFetch() });

    const res = await request(app)
      .post('/api/v1/tickets')
      .set('Authorization', `Bearer ${fullKey}`)
      .send(validBody);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('jira_not_connected');
  });

  // Test 16: Project inaccessible returns 422
  it('returns 422 when the project is inaccessible', async () => {
    storeConnection('tenant-acme', 'user-acme-alice');
    const { fullKey } = apiKeyService.create('tenant-acme', 'user-acme-alice');
    const fetch = vi.fn(async () => new Response('', { status: 404 })) as unknown as FetchLike;
    const app = appWith(db, { encryptionKey, fetch });

    const res = await request(app)
      .post('/api/v1/tickets')
      .set('Authorization', `Bearer ${fullKey}`)
      .send(validBody);

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('jira_project_inaccessible');
  });

  // Test 17: Task unsupported returns 422
  it('returns 422 when the project does not support the Task issue type', async () => {
    storeConnection('tenant-acme', 'user-acme-alice');
    const { fullKey } = apiKeyService.create('tenant-acme', 'user-acme-alice');
    const fetch = vi.fn(async () =>
      jsonResponse({ id: '1', key: 'ABC', issueTypes: [{ id: '1', name: 'Bug', subtask: false }] }),
    ) as unknown as FetchLike;
    const app = appWith(db, { encryptionKey, fetch });

    const res = await request(app)
      .post('/api/v1/tickets')
      .set('Authorization', `Bearer ${fullKey}`)
      .send(validBody);

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('jira_task_unsupported');
  });

  // Test 18: Jira credentials rejected returns 502
  it('returns 502 with a distinct credential error when Jira rejects the stored credentials', async () => {
    storeConnection('tenant-acme', 'user-acme-alice');
    const { fullKey } = apiKeyService.create('tenant-acme', 'user-acme-alice');
    const fetch = vi.fn(async () => new Response('', { status: 401 })) as unknown as FetchLike;
    const app = appWith(db, { encryptionKey, fetch });

    const res = await request(app)
      .post('/api/v1/tickets')
      .set('Authorization', `Bearer ${fullKey}`)
      .send(validBody);

    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('jira_credentials_rejected');
    expect(res.body.error.message).toBe(
      'The stored Jira credentials were rejected. Reconnect Jira and try again.',
    );
  });

  // Test 19: Jira network failure returns 502
  it('returns 502 when Jira is unreachable (network failure)', async () => {
    storeConnection('tenant-acme', 'user-acme-alice');
    const { fullKey } = apiKeyService.create('tenant-acme', 'user-acme-alice');
    const fetch = vi.fn(async () => {
      throw new Error('ECONNREFUSED secret-internal-detail');
    }) as unknown as FetchLike;
    const app = appWith(db, { encryptionKey, fetch });

    const res = await request(app)
      .post('/api/v1/tickets')
      .set('Authorization', `Bearer ${fullKey}`)
      .send(validBody);

    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('jira_unreachable');
    expect(JSON.stringify(res.body)).not.toContain('ECONNREFUSED');
    expect(JSON.stringify(res.body)).not.toContain('secret-internal-detail');
  });

  // Test 20: Jira upstream 5xx returns 502
  it('returns 502 jira_unreachable when Jira returns a 5xx', async () => {
    storeConnection('tenant-acme', 'user-acme-alice');
    const { fullKey } = apiKeyService.create('tenant-acme', 'user-acme-alice');
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'POST') {
        return new Response('upstream boom internal-trace', { status: 503 });
      }
      return jsonResponse(VALID_PROJECT_BODY);
    }) as unknown as FetchLike;
    const app = appWith(db, { encryptionKey, fetch });

    const res = await request(app)
      .post('/api/v1/tickets')
      .set('Authorization', `Bearer ${fullKey}`)
      .send(validBody);

    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('jira_unreachable');
    expect(JSON.stringify(res.body)).not.toContain('upstream boom');
  });

  // Test 21: Jira timeout returns 504
  it('returns 504 on a Jira timeout', async () => {
    storeConnection('tenant-acme', 'user-acme-alice');
    const { fullKey } = apiKeyService.create('tenant-acme', 'user-acme-alice');
    const fetch = vi.fn(async () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      throw error;
    }) as unknown as FetchLike;
    const app = appWith(db, { encryptionKey, fetch });

    const res = await request(app)
      .post('/api/v1/tickets')
      .set('Authorization', `Bearer ${fullKey}`)
      .send(validBody);

    expect(res.status).toBe(504);
    expect(res.body.error.code).toBe('jira_timeout');
  });

  // Test 22: Credential decryption/configuration failure returns 503
  it('returns 503 when the stored credentials cannot be decrypted (wrong key)', async () => {
    storeConnection('tenant-acme', 'user-acme-alice');
    const { fullKey } = apiKeyService.create('tenant-acme', 'user-acme-alice');
    // A different encryption key cannot decrypt the stored token.
    const app = appWith(db, { encryptionKey: randomBytes(32), fetch: happyPathFetch() });

    const res = await request(app)
      .post('/api/v1/tickets')
      .set('Authorization', `Bearer ${fullKey}`)
      .send(validBody);

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('jira_not_configured');
  });

  // Test 23: Provenance persistence failure returns 500
  it('returns 500 when Jira confirms creation but provenance persistence fails', async () => {
    storeConnection('tenant-acme', 'user-acme-alice');
    const { fullKey } = apiKeyService.create('tenant-acme', 'user-acme-alice');

    // Seed a provenance row with the same issue ID to force a UNIQUE constraint failure.
    const connectionId = storeConnection('tenant-acme', 'user-acme-alice');
    db.exec(`
      INSERT INTO jira_ticket_provenance
        (id, tenant_id, created_by_user_id, jira_connection_id, jira_site_url,
         jira_project_id, jira_project_key, jira_issue_id, jira_issue_key, created_at)
      VALUES
        ('prov-dup', 'tenant-acme', 'user-acme-alice', '${connectionId}',
         '${ACME_SITE}', '10001', 'ABC', '10500', 'ABC-42',
         '2026-01-01T00:00:00.000Z')
    `);

    const app = appWith(db, { encryptionKey, fetch: happyPathFetch() });

    const res = await request(app)
      .post('/api/v1/tickets')
      .set('Authorization', `Bearer ${fullKey}`)
      .send(validBody);

    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('internal_error');
  });

  // Tests 24–25: Same-tenant and cross-tenant isolation
  describe('ownership and tenant isolation', () => {
    // Test 24: Same-tenant API keys use the shared tenant Jira connection
    it('same-tenant API keys use the shared tenant Jira connection', async () => {
      const connectionId = storeConnection('tenant-acme', 'user-acme-alice');
      let counter = 0;
      const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
        if ((init?.method ?? 'GET') === 'POST') {
          counter += 1;
          return jsonResponse({ id: `1050${counter}`, key: `ABC-${counter}` }, 201);
        }
        return jsonResponse(VALID_PROJECT_BODY);
      }) as unknown as FetchLike;
      const app = appWith(db, { encryptionKey, fetch });

      const { fullKey: keyAlice } = apiKeyService.create('tenant-acme', 'user-acme-alice');
      const { fullKey: keyBob } = apiKeyService.create('tenant-acme', 'user-acme-bob');

      const resAlice = await request(app)
        .post('/api/v1/tickets')
        .set('Authorization', `Bearer ${keyAlice}`)
        .send(validBody);
      const resBob = await request(app)
        .post('/api/v1/tickets')
        .set('Authorization', `Bearer ${keyBob}`)
        .send(validBody);

      expect(resAlice.status).toBe(201);
      expect(resBob.status).toBe(201);

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

    // Test 25: Cross-tenant API keys remain isolated
    it('a cross-tenant API key never uses another tenant Jira connection', async () => {
      storeConnection('tenant-acme', 'user-acme-alice', ACME_SITE);
      storeConnection('tenant-globex', 'user-globex-alice', GLOBEX_SITE);

      const { fullKey: acmeKey } = apiKeyService.create('tenant-acme', 'user-acme-alice');
      const { fullKey: globexKey } = apiKeyService.create(
        'tenant-globex',
        'user-globex-alice',
      );

      const acmeFetch = vi.fn(async (_url: string, init?: RequestInit) => {
        if ((init?.method ?? 'GET') === 'POST') {
          return jsonResponse({ id: 'acme-100', key: 'ABC-1' }, 201);
        }
        return jsonResponse(VALID_PROJECT_BODY);
      }) as unknown as FetchLike;

      const app = appWith(db, { encryptionKey, fetch: acmeFetch });

      const acmeRes = await request(app)
        .post('/api/v1/tickets')
        .set('Authorization', `Bearer ${acmeKey}`)
        .send(validBody);

      const globexRes = await request(app)
        .post('/api/v1/tickets')
        .set('Authorization', `Bearer ${globexKey}`)
        .send(validBody);

      expect(acmeRes.status).toBe(201);
      expect(globexRes.status).toBe(201);

      const rows = db
        .prepare('SELECT tenant_id, created_by_user_id, jira_site_url FROM jira_ticket_provenance ORDER BY tenant_id')
        .all() as { tenant_id: string; created_by_user_id: string; jira_site_url: string }[];

      // Each key's provenance must use its own tenant's connection.
      expect(rows[0].tenant_id).toBe('tenant-acme');
      expect(rows[0].created_by_user_id).toBe('user-acme-alice');
      expect(rows[0].jira_site_url).toBe(ACME_SITE);

      expect(rows[1].tenant_id).toBe('tenant-globex');
      expect(rows[1].created_by_user_id).toBe('user-globex-alice');
      expect(rows[1].jira_site_url).toBe(GLOBEX_SITE);
    });

    // Test 26: Spoofed ownership fields in the request body cannot change the resolved context
    it('ignores spoofed tenantId, userId, connectionId, siteUrl, and similar fields in the body', async () => {
      storeConnection('tenant-acme', 'user-acme-alice');
      const { fullKey } = apiKeyService.create('tenant-acme', 'user-acme-bob');
      const app = appWith(db, { encryptionKey, fetch: happyPathFetch() });

      const res = await request(app)
        .post('/api/v1/tickets')
        .set('Authorization', `Bearer ${fullKey}`)
        .send({
          ...validBody,
          tenantId: 'tenant-globex',
          userId: 'user-globex-alice',
          createdByUserId: 'user-globex-alice',
          connectionId: 'spoofed-connection-id',
          siteUrl: 'https://evil.atlassian.net',
          issueType: 'Bug',
        });

      expect(res.status).toBe(201);

      const rows = db
        .prepare(
          'SELECT tenant_id, created_by_user_id, jira_site_url FROM jira_ticket_provenance',
        )
        .all() as { tenant_id: string; created_by_user_id: string; jira_site_url: string }[];

      expect(rows).toEqual([
        {
          tenant_id: 'tenant-acme',
          created_by_user_id: 'user-acme-bob',
          jira_site_url: ACME_SITE,
        },
      ]);
    });
  });

  // Test 27: Responses do not contain API keys, Jira tokens, Authorization headers, or raw upstream content
  it('responses do not contain secrets, credentials, or raw upstream content', async () => {
    storeConnection('tenant-acme', 'user-acme-alice');
    const { fullKey } = apiKeyService.create('tenant-acme', 'user-acme-alice');
    const app = appWith(db, { encryptionKey, fetch: happyPathFetch() });

    const successRes = await request(app)
      .post('/api/v1/tickets')
      .set('Authorization', `Bearer ${fullKey}`)
      .send(validBody);

    const errorRes = await request(app)
      .post('/api/v1/tickets')
      .set('Authorization', 'Bearer bad_key')
      .send(validBody);

    for (const res of [successRes, errorRes]) {
      const body = JSON.stringify(res.body);
      expect(body).not.toContain(PLAINTEXT_TOKEN);
      expect(body).not.toContain(fullKey);
      // Authorization header value must not appear in responses.
      expect(body).not.toContain('Bearer');
      expect(body).not.toContain('nhi_');
    }
  });

  // Test 27 (caching): All responses carry Cache-Control: no-store
  it('sets Cache-Control: no-store on all responses', async () => {
    storeConnection('tenant-acme', 'user-acme-alice');
    const { fullKey } = apiKeyService.create('tenant-acme', 'user-acme-alice');
    const app = appWith(db, { encryptionKey, fetch: happyPathFetch() });

    const successRes = await request(app)
      .post('/api/v1/tickets')
      .set('Authorization', `Bearer ${fullKey}`)
      .send(validBody);

    const unauthRes = await request(app).post('/api/v1/tickets').send(validBody);

    expect(successRes.headers['cache-control']).toContain('no-store');
    expect(unauthRes.headers['cache-control']).toContain('no-store');
  });

  // Test 28: Existing POST /api/tickets session behavior remains unchanged
  describe('existing session endpoint is unchanged', () => {
    it('POST /api/tickets still works with session auth and is independent of the external endpoint', async () => {
      storeConnection('tenant-acme', 'user-acme-alice');
      const app = appWith(db, { encryptionKey, fetch: happyPathFetch() });
      const agent = await loginAgent(app, acmeAlice);

      const res = await agent.post('/api/tickets').send(validBody);
      expect(res.status).toBe(201);
      expect(res.body).toEqual({ issueId: '10500', issueKey: 'ABC-42' });
    });

    it('POST /api/tickets still rejects unauthenticated requests with 401', async () => {
      const app = appWith(db, { encryptionKey, fetch: happyPathFetch() });
      const res = await request(app).post('/api/tickets').send(validBody);
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('unauthenticated');
    });

    it('POST /api/tickets rejects an API key with 401 (session-only endpoint)', async () => {
      const { fullKey } = apiKeyService.create('tenant-acme', 'user-acme-alice');
      const app = appWith(db, { encryptionKey, fetch: happyPathFetch() });

      const res = await request(app)
        .post('/api/tickets')
        .set('Authorization', `Bearer ${fullKey}`)
        .send(validBody);
      // requireAuth checks session cookie, not the Authorization header.
      expect(res.status).toBe(401);
    });
  });
});
