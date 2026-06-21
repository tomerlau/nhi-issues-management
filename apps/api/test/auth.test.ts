import type { DatabaseSync } from 'node:sqlite';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { SessionRepository } from '../src/repositories/session-repository.js';
import { hashSessionToken } from '../src/auth/session-token.js';
import { SESSION_COOKIE_NAME } from '../src/auth/cookies.js';
import { createSeededMemoryDb, DEMO_CREDENTIALS } from './helpers.js';

const { acmeAlice, acmeBob, globexAlice } = DEMO_CREDENTIALS;

function setCookieHeaders(res: request.Response): string[] {
  const header = res.headers['set-cookie'] as unknown as string[] | string | undefined;
  if (!header) {
    return [];
  }
  return Array.isArray(header) ? header : [header];
}

/** Pull the raw session token out of a Set-Cookie response header. */
function sessionCookieFrom(res: request.Response): string | null {
  for (const cookie of setCookieHeaders(res)) {
    const match = new RegExp(`^${SESSION_COOKIE_NAME}=([^;]*)`).exec(cookie);
    if (match) {
      return decodeURIComponent(match[1]);
    }
  }
  return null;
}

function sessionSetCookie(res: request.Response): string | undefined {
  return setCookieHeaders(res).find((cookie) => cookie.startsWith(`${SESSION_COOKIE_NAME}=`));
}

describe('authentication', () => {
  let db: DatabaseSync;

  beforeEach(async () => {
    db = await createSeededMemoryDb();
  });

  afterEach(() => {
    db.close();
  });

  describe('POST /api/auth/login', () => {
    it('authenticates valid credentials and returns only safe user fields', async () => {
      const app = createApp(db, { cookieSecure: false });
      const res = await request(app)
        .post('/api/auth/login')
        .send({ email: acmeAlice.email, password: acmeAlice.password });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        user: {
          id: 'user-acme-alice',
          tenantId: 'tenant-acme',
          email: 'alice@example.com',
          displayName: 'Alice Anderson',
        },
      });
      expect(res.headers['cache-control']).toBe('no-store');
      expect(sessionCookieFrom(res)).toBeTruthy();
    });

    it('normalizes the email (trim + lowercase) before lookup', async () => {
      const app = createApp(db, { cookieSecure: false });
      const res = await request(app)
        .post('/api/auth/login')
        .send({ email: '  ALICE@example.com  ', password: acmeAlice.password });
      expect(res.status).toBe(200);
      expect(res.body.user.id).toBe('user-acme-alice');
    });

    it('returns an identical generic 401 for unknown email and wrong password', async () => {
      const app = createApp(db, { cookieSecure: false });
      const unknown = await request(app)
        .post('/api/auth/login')
        .send({ email: 'nobody@example.com', password: 'whatever' });
      const wrong = await request(app)
        .post('/api/auth/login')
        .send({ email: acmeAlice.email, password: 'wrong-password' });

      expect(unknown.status).toBe(401);
      expect(wrong.status).toBe(401);
      expect(unknown.body).toEqual(wrong.body);
      expect(unknown.body).toEqual({
        error: { code: 'invalid_credentials', message: 'Invalid email or password.' },
      });
      expect(sessionCookieFrom(unknown)).toBeNull();
      expect(sessionCookieFrom(wrong)).toBeNull();
    });

    it('rejects missing or malformed fields with a structured 400', async () => {
      const app = createApp(db, { cookieSecure: false });
      for (const body of [
        {},
        { email: acmeAlice.email },
        { password: acmeAlice.password },
        { email: 123, password: acmeAlice.password },
        { email: '', password: acmeAlice.password },
        { email: acmeAlice.email, password: '' },
      ]) {
        const res = await request(app).post('/api/auth/login').send(body);
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('invalid_request');
      }
    });

    it('rejects excessively long inputs with a structured 400', async () => {
      const app = createApp(db, { cookieSecure: false });
      const longEmail = `${'a'.repeat(300)}@example.com`;
      const longPassword = 'p'.repeat(5000);

      const res1 = await request(app)
        .post('/api/auth/login')
        .send({ email: longEmail, password: acmeAlice.password });
      const res2 = await request(app)
        .post('/api/auth/login')
        .send({ email: acmeAlice.email, password: longPassword });

      expect(res1.status).toBe(400);
      expect(res2.status).toBe(400);
    });
  });

  describe('session cookie attributes', () => {
    it('omits Secure in development configuration', async () => {
      const app = createApp(db, { cookieSecure: false });
      const res = await request(app)
        .post('/api/auth/login')
        .send({ email: acmeAlice.email, password: acmeAlice.password });

      const cookie = sessionSetCookie(res)!;
      expect(cookie).toMatch(/HttpOnly/i);
      expect(cookie).toMatch(/SameSite=Lax/i);
      expect(cookie).toMatch(/Path=\//i);
      expect(cookie).toMatch(/Max-Age=28800/i);
      expect(cookie).not.toMatch(/Secure/i);
    });

    it('sets Secure in production configuration', async () => {
      const app = createApp(db, { cookieSecure: true });
      const res = await request(app)
        .post('/api/auth/login')
        .send({ email: acmeAlice.email, password: acmeAlice.password });

      const cookie = sessionSetCookie(res)!;
      expect(cookie).toMatch(/Secure/i);
      expect(cookie).toMatch(/HttpOnly/i);
      expect(cookie).toMatch(/SameSite=Lax/i);
    });
  });

  describe('session storage', () => {
    it('stores only the SHA-256 token hash, never the raw token', async () => {
      const app = createApp(db, { cookieSecure: false });
      const res = await request(app)
        .post('/api/auth/login')
        .send({ email: acmeAlice.email, password: acmeAlice.password });

      const rawToken = sessionCookieFrom(res)!;
      const rows = db
        .prepare('SELECT token_hash FROM sessions')
        .all() as { token_hash: string }[];

      expect(rows).toHaveLength(1);
      expect(rows[0].token_hash).not.toBe(rawToken);
      expect(rows[0].token_hash).toBe(hashSessionToken(rawToken));
      // The raw token must not appear anywhere in the sessions table.
      const dump = JSON.stringify(db.prepare('SELECT * FROM sessions').all());
      expect(dump).not.toContain(rawToken);
    });
  });

  describe('GET /api/auth/session', () => {
    it('restores the authenticated user from the cookie', async () => {
      const agent = request.agent(createApp(db, { cookieSecure: false }));
      await agent
        .post('/api/auth/login')
        .send({ email: acmeAlice.email, password: acmeAlice.password });

      const res = await agent.get('/api/auth/session');
      expect(res.status).toBe(200);
      expect(res.body.user.id).toBe('user-acme-alice');
      expect(res.headers['cache-control']).toBe('no-store');
    });

    it('restores a session created before an API process restart (same database)', async () => {
      const first = request.agent(createApp(db, { cookieSecure: false }));
      const login = await first
        .post('/api/auth/login')
        .send({ email: acmeAlice.email, password: acmeAlice.password });
      const rawToken = sessionCookieFrom(login)!;

      // A brand-new app instance over the same database simulates a restart.
      const restarted = createApp(db, { cookieSecure: false });
      const res = await request(restarted)
        .get('/api/auth/session')
        .set('Cookie', `${SESSION_COOKIE_NAME}=${rawToken}`);

      expect(res.status).toBe(200);
      expect(res.body.user.id).toBe('user-acme-alice');
    });

    it('returns 401 for a missing cookie', async () => {
      const app = createApp(db, { cookieSecure: false });
      const res = await request(app).get('/api/auth/session');
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('unauthenticated');
    });

    it('returns 401 for an invalid token', async () => {
      const app = createApp(db, { cookieSecure: false });
      const res = await request(app)
        .get('/api/auth/session')
        .set('Cookie', `${SESSION_COOKIE_NAME}=not-a-real-token`);
      expect(res.status).toBe(401);
    });

    it('returns 401 for an expired session', async () => {
      const sessions = new SessionRepository(db);
      const rawToken = 'expired-token-value';
      sessions.create({
        tokenHash: hashSessionToken(rawToken),
        tenantId: 'tenant-acme',
        userId: 'user-acme-alice',
        createdAt: '2020-01-01T00:00:00.000Z',
        expiresAt: '2020-01-01T08:00:00.000Z',
      });

      const app = createApp(db, { cookieSecure: false });
      const res = await request(app)
        .get('/api/auth/session')
        .set('Cookie', `${SESSION_COOKIE_NAME}=${rawToken}`);
      expect(res.status).toBe(401);
    });

    it('returns 401 for a revoked (deleted) session', async () => {
      const agent = request.agent(createApp(db, { cookieSecure: false }));
      const login = await agent
        .post('/api/auth/login')
        .send({ email: acmeAlice.email, password: acmeAlice.password });
      const rawToken = sessionCookieFrom(login)!;

      new SessionRepository(db).deleteByTokenHash(hashSessionToken(rawToken));

      const res = await agent.get('/api/auth/session');
      expect(res.status).toBe(401);
    });
  });

  describe('POST /api/auth/logout', () => {
    it('clears the cookie and is idempotent without a session', async () => {
      const app = createApp(db, { cookieSecure: false });
      const res = await request(app).post('/api/auth/logout');
      expect(res.status).toBe(200);
      const cookie = sessionSetCookie(res);
      // Clearing sets an expired cookie.
      expect(cookie).toMatch(/Expires=Thu, 01 Jan 1970/i);
    });

    it('revokes only the current session and leaves other sessions working', async () => {
      const app = createApp(db, { cookieSecure: false });

      const agentA = request.agent(app);
      const agentB = request.agent(app);
      await agentA
        .post('/api/auth/login')
        .send({ email: acmeAlice.email, password: acmeAlice.password });
      await agentB
        .post('/api/auth/login')
        .send({ email: acmeBob.email, password: acmeBob.password });

      const logout = await agentA.post('/api/auth/logout');
      expect(logout.status).toBe(200);

      expect((await agentA.get('/api/auth/session')).status).toBe(401);
      const stillB = await agentB.get('/api/auth/session');
      expect(stillB.status).toBe(200);
      expect(stillB.body.user.id).toBe('user-acme-bob');
    });
  });

  describe('concurrent multi-tenant sessions', () => {
    it('keeps two users from different tenants authenticated independently', async () => {
      const app = createApp(db, { cookieSecure: false });
      const acmeAgent = request.agent(app);
      const globexAgent = request.agent(app);

      await acmeAgent
        .post('/api/auth/login')
        .send({ email: acmeAlice.email, password: acmeAlice.password });
      await globexAgent
        .post('/api/auth/login')
        .send({ email: globexAlice.email, password: globexAlice.password });

      const acmeSession = await acmeAgent.get('/api/auth/session');
      const globexSession = await globexAgent.get('/api/auth/session');

      expect(acmeSession.body.user).toMatchObject({
        id: 'user-acme-alice',
        tenantId: 'tenant-acme',
      });
      expect(globexSession.body.user).toMatchObject({
        id: 'user-globex-alice',
        tenantId: 'tenant-globex',
      });
    });
  });

  describe('authentication context cannot be overridden by request input', () => {
    it('ignores userId/tenantId supplied in body, query, or headers', async () => {
      const agent = request.agent(createApp(db, { cookieSecure: false }));
      await agent
        .post('/api/auth/login')
        .send({ email: acmeAlice.email, password: acmeAlice.password });

      const res = await agent
        .get('/api/auth/session?userId=user-globex-alice&tenantId=tenant-globex')
        .set('X-User-Id', 'user-globex-alice')
        .set('X-Tenant-Id', 'tenant-globex')
        .send({ userId: 'user-globex-alice', tenantId: 'tenant-globex' });

      expect(res.status).toBe(200);
      expect(res.body.user).toMatchObject({
        id: 'user-acme-alice',
        tenantId: 'tenant-acme',
      });
    });

    it('refuses to authenticate when only spoofed identity input is provided', async () => {
      const app = createApp(db, { cookieSecure: false });
      const res = await request(app)
        .get('/api/auth/session?userId=user-acme-alice&tenantId=tenant-acme')
        .set('X-User-Id', 'user-acme-alice')
        .set('X-Tenant-Id', 'tenant-acme');
      expect(res.status).toBe(401);
    });
  });
});
