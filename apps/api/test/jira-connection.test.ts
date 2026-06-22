import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, type AppOptions } from '../src/app.js';
import type { FetchLike } from '../src/jira/jira-verifier.js';
import { createSeededMemoryDb, DEMO_CREDENTIALS } from './helpers.js';

const { acmeAlice, acmeBob, globexAlice } = DEMO_CREDENTIALS;

const VALID_SITE = 'https://acme.atlassian.net';
const VALID_TOKEN = 'valid-jira-api-token';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** A fetch that always reports valid credentials, returning a fixed account id. */
function okFetch(accountId = 'acc-001'): FetchLike {
  return vi.fn(async () => jsonResponse({ accountId })) as unknown as FetchLike;
}

const encryptionKey = randomBytes(32);

function appWith(db: DatabaseSync, jira: AppOptions['jira']) {
  return createApp(db, { cookieSecure: false, jira });
}

/** Log a user in on a fresh agent bound to the given app. */
async function loginAgent(
  app: ReturnType<typeof createApp>,
  creds: { email: string; password: string },
) {
  const agent = request.agent(app);
  await agent.post('/api/auth/login').send({ email: creds.email, password: creds.password });
  return agent;
}

describe('jira connection endpoints', () => {
  let db: DatabaseSync;

  beforeEach(async () => {
    db = await createSeededMemoryDb();
  });

  afterEach(() => {
    db.close();
  });

  describe('authentication and caching', () => {
    it('rejects an unauthenticated POST', async () => {
      const app = appWith(db, { encryptionKey, fetch: okFetch() });
      const res = await request(app)
        .post('/api/jira/connection')
        .send({ siteUrl: VALID_SITE, email: acmeAlice.email, apiToken: VALID_TOKEN });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('unauthenticated');
    });

    it('rejects an unauthenticated GET', async () => {
      const app = appWith(db, { encryptionKey, fetch: okFetch() });
      const res = await request(app).get('/api/jira/connection');
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('unauthenticated');
    });

    it('sets Cache-Control: no-store on GET and POST', async () => {
      const app = appWith(db, { encryptionKey, fetch: okFetch() });
      const agent = await loginAgent(app, acmeAlice);

      const get = await agent.get('/api/jira/connection');
      expect(get.headers['cache-control']).toBe('no-store');

      const post = await agent
        .post('/api/jira/connection')
        .send({ siteUrl: VALID_SITE, email: acmeAlice.email, apiToken: VALID_TOKEN });
      expect(post.headers['cache-control']).toBe('no-store');
    });
  });

  describe('status responses', () => {
    it('returns disconnected before any connection', async () => {
      const app = appWith(db, { encryptionKey, fetch: okFetch() });
      const agent = await loginAgent(app, acmeAlice);
      const res = await agent.get('/api/jira/connection');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ connected: false });
    });

    it('returns connected status with only safe fields after connecting', async () => {
      const app = appWith(db, { encryptionKey, fetch: okFetch() });
      const agent = await loginAgent(app, acmeAlice);

      const connect = await agent
        .post('/api/jira/connection')
        .send({ siteUrl: `${VALID_SITE}/`, email: '  Alice@Example.com ', apiToken: VALID_TOKEN });
      expect(connect.status).toBe(200);
      expect(connect.body).toEqual({
        connected: true,
        siteUrl: 'https://acme.atlassian.net',
        email: 'alice@example.com',
      });

      const status = await agent.get('/api/jira/connection');
      expect(status.body).toEqual({
        connected: true,
        siteUrl: 'https://acme.atlassian.net',
        email: 'alice@example.com',
      });
      // No credential material leaks into the response.
      const serialized = JSON.stringify(status.body);
      expect(serialized).not.toContain(VALID_TOKEN);
      expect(serialized.toLowerCase()).not.toContain('token');
      expect(serialized.toLowerCase()).not.toContain('authorization');
      expect(serialized).not.toContain('accountId');
    });

    it('returns 200 for both first connection and reconnection', async () => {
      const app = appWith(db, { encryptionKey, fetch: okFetch() });
      const agent = await loginAgent(app, acmeAlice);

      const first = await agent
        .post('/api/jira/connection')
        .send({ siteUrl: VALID_SITE, email: acmeAlice.email, apiToken: VALID_TOKEN });
      expect(first.status).toBe(200);

      const again = await agent
        .post('/api/jira/connection')
        .send({ siteUrl: 'https://acme2.atlassian.net', email: acmeAlice.email, apiToken: 'rotated' });
      expect(again.status).toBe(200);
      expect(again.body.siteUrl).toBe('https://acme2.atlassian.net');
    });
  });

  describe('request validation', () => {
    it('rejects malformed JSON with a structured 400 and no-store', async () => {
      const app = appWith(db, { encryptionKey, fetch: okFetch() });
      const agent = await loginAgent(app, acmeAlice);
      const res = await agent
        .post('/api/jira/connection')
        .set('Content-Type', 'application/json')
        .send('{ not valid json');
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('invalid_request');
      expect(res.headers['cache-control']).toBe('no-store');
    });

    it('rejects missing, wrong-typed, empty, and overlong fields', async () => {
      const app = appWith(db, { encryptionKey, fetch: okFetch() });
      const agent = await loginAgent(app, acmeAlice);

      const bodies = [
        {},
        { siteUrl: VALID_SITE },
        { email: acmeAlice.email, apiToken: VALID_TOKEN },
        { siteUrl: 123, email: acmeAlice.email, apiToken: VALID_TOKEN },
        { siteUrl: VALID_SITE, email: 123, apiToken: VALID_TOKEN },
        { siteUrl: VALID_SITE, email: acmeAlice.email, apiToken: 999 },
        { siteUrl: '', email: acmeAlice.email, apiToken: VALID_TOKEN },
        { siteUrl: VALID_SITE, email: '', apiToken: VALID_TOKEN },
        { siteUrl: VALID_SITE, email: acmeAlice.email, apiToken: '' },
        { siteUrl: VALID_SITE, email: `${'a'.repeat(300)}@x.com`, apiToken: VALID_TOKEN },
        { siteUrl: VALID_SITE, email: acmeAlice.email, apiToken: 'a'.repeat(2000) },
      ];
      for (const body of bodies) {
        const res = await agent.post('/api/jira/connection').send(body);
        expect(res.status, JSON.stringify(body)).toBe(400);
        expect(res.body.error.code).toBe('invalid_request');
      }
    });

    it('rejects an invalid site URL without making any HTTP request', async () => {
      const fetchSpy = vi.fn(async () => jsonResponse({ accountId: 'x' }));
      const app = appWith(db, { encryptionKey, fetch: fetchSpy as unknown as FetchLike });
      const agent = await loginAgent(app, acmeAlice);

      const res = await agent
        .post('/api/jira/connection')
        .send({ siteUrl: 'http://example.atlassian.net', email: acmeAlice.email, apiToken: VALID_TOKEN });
      expect(res.status).toBe(400);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('ignores client-supplied tenant/user identifiers', async () => {
      const app = appWith(db, { encryptionKey, fetch: okFetch() });
      const agent = await loginAgent(app, acmeAlice);

      await agent.post('/api/jira/connection').send({
        siteUrl: VALID_SITE,
        email: acmeAlice.email,
        apiToken: VALID_TOKEN,
        tenantId: 'tenant-globex',
        userId: 'user-globex-alice',
      });

      // The connection is owned by the session user (acme alice), not the spoofed ids.
      const rows = db
        .prepare('SELECT tenant_id, user_id FROM jira_connections')
        .all() as { tenant_id: string; user_id: string }[];
      expect(rows).toEqual([{ tenant_id: 'tenant-acme', user_id: 'user-acme-alice' }]);
    });
  });

  describe('verification outcomes', () => {
    it('maps rejected credentials to 422', async () => {
      const fetch = vi.fn(async () => new Response('', { status: 401 })) as unknown as FetchLike;
      const app = appWith(db, { encryptionKey, fetch });
      const agent = await loginAgent(app, acmeAlice);
      const res = await agent
        .post('/api/jira/connection')
        .send({ siteUrl: VALID_SITE, email: acmeAlice.email, apiToken: 'bad' });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('jira_credentials_rejected');
    });

    it('maps a timeout to 504', async () => {
      const fetch = vi.fn(async () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        throw error;
      }) as unknown as FetchLike;
      const app = appWith(db, { encryptionKey, fetch });
      const agent = await loginAgent(app, acmeAlice);
      const res = await agent
        .post('/api/jira/connection')
        .send({ siteUrl: VALID_SITE, email: acmeAlice.email, apiToken: VALID_TOKEN });
      expect(res.status).toBe(504);
      expect(res.body.error.code).toBe('jira_timeout');
    });

    it('maps an upstream failure to 502', async () => {
      const fetch = vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }) as unknown as FetchLike;
      const app = appWith(db, { encryptionKey, fetch });
      const agent = await loginAgent(app, acmeAlice);
      const res = await agent
        .post('/api/jira/connection')
        .send({ siteUrl: VALID_SITE, email: acmeAlice.email, apiToken: VALID_TOKEN });
      expect(res.status).toBe(502);
      expect(res.body.error.code).toBe('jira_unreachable');
    });

    it('does not leak raw upstream errors in the response', async () => {
      const fetch = vi.fn(async () => {
        throw new Error('connect ECONNREFUSED 10.0.0.1:443 secret-internal-detail');
      }) as unknown as FetchLike;
      const app = appWith(db, { encryptionKey, fetch });
      const agent = await loginAgent(app, acmeAlice);
      const res = await agent
        .post('/api/jira/connection')
        .send({ siteUrl: VALID_SITE, email: acmeAlice.email, apiToken: VALID_TOKEN });
      expect(JSON.stringify(res.body)).not.toContain('ECONNREFUSED');
    });
  });

  describe('persistence and encryption', () => {
    it('stores a connection only after verification succeeds, with an encrypted token', async () => {
      const app = appWith(db, { encryptionKey, fetch: okFetch() });
      const agent = await loginAgent(app, acmeAlice);
      await agent
        .post('/api/jira/connection')
        .send({ siteUrl: VALID_SITE, email: acmeAlice.email, apiToken: VALID_TOKEN });

      const rows = db.prepare('SELECT * FROM jira_connections').all() as Record<string, unknown>[];
      expect(rows).toHaveLength(1);
      const dump = JSON.stringify(rows[0]);
      // Plaintext token never appears anywhere in the stored row.
      expect(dump).not.toContain(VALID_TOKEN);
      expect(rows[0].encrypted_token).not.toBe(VALID_TOKEN);
      expect(String(rows[0].encrypted_token)).toMatch(/^v1\./);
    });

    it('stores nothing when the first connection fails verification', async () => {
      const fetch = vi.fn(async () => new Response('', { status: 401 })) as unknown as FetchLike;
      const app = appWith(db, { encryptionKey, fetch });
      const agent = await loginAgent(app, acmeAlice);
      await agent
        .post('/api/jira/connection')
        .send({ siteUrl: VALID_SITE, email: acmeAlice.email, apiToken: 'bad' });

      const rows = db.prepare('SELECT * FROM jira_connections').all();
      expect(rows).toHaveLength(0);
    });

    it('preserves the existing connection when a reconnection fails', async () => {
      const okApp = appWith(db, { encryptionKey, fetch: okFetch('acc-keep') });
      const agent = await loginAgent(okApp, acmeAlice);
      await agent
        .post('/api/jira/connection')
        .send({ siteUrl: VALID_SITE, email: acmeAlice.email, apiToken: VALID_TOKEN });

      const before = db.prepare('SELECT * FROM jira_connections').get() as Record<string, unknown>;

      // New app instance over the same db whose fetch now rejects credentials.
      const failFetch = vi.fn(async () => new Response('', { status: 401 })) as unknown as FetchLike;
      const failApp = appWith(db, { encryptionKey, fetch: failFetch });
      const agent2 = await loginAgent(failApp, acmeAlice);
      const res = await agent2
        .post('/api/jira/connection')
        .send({ siteUrl: 'https://other.atlassian.net', email: acmeAlice.email, apiToken: 'bad' });
      expect(res.status).toBe(422);

      const after = db.prepare('SELECT * FROM jira_connections').get() as Record<string, unknown>;
      expect(after).toEqual(before);
    });

    it('replaces only the current user connection on successful reconnection', async () => {
      const app = appWith(db, { encryptionKey, fetch: okFetch() });
      const agent = await loginAgent(app, acmeAlice);
      await agent
        .post('/api/jira/connection')
        .send({ siteUrl: VALID_SITE, email: acmeAlice.email, apiToken: VALID_TOKEN });
      const firstId = (db.prepare('SELECT id FROM jira_connections').get() as { id: string }).id;

      await agent
        .post('/api/jira/connection')
        .send({ siteUrl: 'https://acme3.atlassian.net', email: acmeAlice.email, apiToken: 'rotated' });

      const rows = db.prepare('SELECT id, site_url FROM jira_connections').all() as {
        id: string;
        site_url: string;
      }[];
      expect(rows).toHaveLength(1);
      // Same owner row is updated in place (id preserved), not duplicated.
      expect(rows[0].id).toBe(firstId);
      expect(rows[0].site_url).toBe('https://acme3.atlassian.net');
    });
  });

  describe('tenant and user isolation', () => {
    it('keeps two users in the same tenant isolated', async () => {
      const app = appWith(db, { encryptionKey, fetch: okFetch() });
      const alice = await loginAgent(app, acmeAlice);
      const bob = await loginAgent(app, acmeBob);

      await alice
        .post('/api/jira/connection')
        .send({ siteUrl: 'https://alice.atlassian.net', email: acmeAlice.email, apiToken: VALID_TOKEN });

      // Bob sees no connection of his own.
      expect((await bob.get('/api/jira/connection')).body).toEqual({ connected: false });

      await bob
        .post('/api/jira/connection')
        .send({ siteUrl: 'https://bob.atlassian.net', email: acmeBob.email, apiToken: VALID_TOKEN });

      expect((await alice.get('/api/jira/connection')).body.siteUrl).toBe('https://alice.atlassian.net');
      expect((await bob.get('/api/jira/connection')).body.siteUrl).toBe('https://bob.atlassian.net');

      const owners = db
        .prepare('SELECT tenant_id, user_id, site_url FROM jira_connections ORDER BY user_id')
        .all();
      expect(owners).toEqual([
        { tenant_id: 'tenant-acme', user_id: 'user-acme-alice', site_url: 'https://alice.atlassian.net' },
        { tenant_id: 'tenant-acme', user_id: 'user-acme-bob', site_url: 'https://bob.atlassian.net' },
      ]);
    });

    it('keeps users in different tenants isolated', async () => {
      const app = appWith(db, { encryptionKey, fetch: okFetch() });
      const acme = await loginAgent(app, acmeAlice);
      const globex = await loginAgent(app, globexAlice);

      await acme
        .post('/api/jira/connection')
        .send({ siteUrl: 'https://acme.atlassian.net', email: acmeAlice.email, apiToken: VALID_TOKEN });

      expect((await globex.get('/api/jira/connection')).body).toEqual({ connected: false });
    });
  });

  describe('terminal error handling', () => {
    const SENTINEL = 'SENTINEL-SECRET-9c3f-do-not-leak';

    it('maps an unexpected exception to a sanitized 500 without leaking detail', async () => {
      // The verifier reads `response.status` outside its try/catch, so a getter
      // that throws produces an unexpected rejection that escapes the route and
      // reaches the terminal error handler. The thrown message carries a
      // sentinel secret that must never appear in the response.
      const fetch = vi.fn(
        async () =>
          ({
            get status(): number {
              throw new Error(`boom ${SENTINEL}`);
            },
            json: async () => ({}),
          }) as unknown as Response,
      ) as unknown as FetchLike;
      const app = appWith(db, { encryptionKey, fetch });
      const agent = await loginAgent(app, acmeAlice);

      const res = await agent
        .post('/api/jira/connection')
        .send({ siteUrl: VALID_SITE, email: acmeAlice.email, apiToken: VALID_TOKEN });

      expect(res.status).toBe(500);
      expect(res.body).toEqual({
        error: { code: 'internal_error', message: 'An unexpected error occurred.' },
      });
      expect(res.headers['cache-control']).toBe('no-store');

      const serialized = JSON.stringify(res.body);
      expect(serialized).not.toContain(SENTINEL);
      expect(serialized.toLowerCase()).not.toContain('stack');
      expect(serialized).not.toContain('boom');
    });
  });

  describe('not configured', () => {
    it('returns 503 for GET and POST when no encryption key is configured', async () => {
      const app = appWith(db, { encryptionKey: null, fetch: okFetch() });
      const agent = await loginAgent(app, acmeAlice);

      const get = await agent.get('/api/jira/connection');
      expect(get.status).toBe(503);
      expect(get.body.error.code).toBe('jira_not_configured');

      const post = await agent
        .post('/api/jira/connection')
        .send({ siteUrl: VALID_SITE, email: acmeAlice.email, apiToken: VALID_TOKEN });
      expect(post.status).toBe(503);
      expect(post.body.error.code).toBe('jira_not_configured');
    });
  });
});
