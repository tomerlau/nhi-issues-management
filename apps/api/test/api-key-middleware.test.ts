import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import express from 'express';
import request from 'supertest';
import { createMigratedMemoryDb, createSeededMemoryDb, DEMO_CREDENTIALS } from './helpers.js';
import { ApiKeyService } from '../src/auth/api-key-service.js';
import { createRequireApiKeyAuth } from '../src/auth/api-key-middleware.js';
import { createApp } from '../src/app.js';
import { AuthService } from '../src/auth/auth-service.js';
import { createRequireAuth } from '../src/auth/auth-middleware.js';
import { SESSION_COOKIE_NAME } from '../src/auth/cookies.js';

/** Build a minimal Express app with one test-only route protected by API key auth. */
function buildApiKeyApp(db: DatabaseSync) {
  const apiKeyService = new ApiKeyService(db);
  const middleware = createRequireApiKeyAuth(apiKeyService);
  const app = express();
  app.use(express.json());

  // Test-only route: returns the resolved context.
  app.get('/test/protected', middleware, (req, res) => {
    res.status(200).json({ userId: req.auth!.context.userId, tenantId: req.auth!.context.tenantId });
  });

  // Test-only route: attempts to spoof tenantId via query parameter.
  app.get('/test/spoof', middleware, (req, res) => {
    res.status(200).json({ userId: req.auth!.context.userId, tenantId: req.auth!.context.tenantId });
  });

  return { app, apiKeyService };
}

describe('API key middleware', () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = createMigratedMemoryDb();
    db.exec(`
      INSERT INTO tenants (id, name, created_at) VALUES
        ('t-acme', 'Acme', '2026-01-01T00:00:00.000Z'),
        ('t-globex', 'Globex', '2026-01-01T00:00:00.000Z');
      INSERT INTO users (id, tenant_id, email, display_name, created_at) VALUES
        ('u-alice', 't-acme', 'alice@test.com', 'Alice', '2026-01-01T00:00:00.000Z'),
        ('u-globex', 't-globex', 'globex@test.com', 'Globex User', '2026-01-01T00:00:00.000Z');
    `);
  });

  afterEach(() => {
    db.close();
  });

  it('accepts a valid Bearer API key and resolves the correct context', async () => {
    const { app, apiKeyService } = buildApiKeyApp(db);
    const { fullKey } = apiKeyService.create('t-acme', 'u-alice');

    const res = await request(app)
      .get('/test/protected')
      .set('Authorization', `Bearer ${fullKey}`);

    expect(res.status).toBe(200);
    expect(res.body.userId).toBe('u-alice');
    expect(res.body.tenantId).toBe('t-acme');
  });

  it('returns 401 when Authorization header is missing', async () => {
    const { app } = buildApiKeyApp(db);
    const res = await request(app).get('/test/protected');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('unauthenticated');
  });

  it('returns 401 for a wrong authentication scheme (Basic)', async () => {
    const { app } = buildApiKeyApp(db);
    const res = await request(app)
      .get('/test/protected')
      .set('Authorization', 'Basic dXNlcjpwYXNz');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('unauthenticated');
  });

  it('returns 401 for a malformed API key format', async () => {
    const { app } = buildApiKeyApp(db);
    const res = await request(app)
      .get('/test/protected')
      .set('Authorization', 'Bearer not_a_valid_nhi_key');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('unauthenticated');
  });

  it('returns 401 for an unknown key ID', async () => {
    const { app } = buildApiKeyApp(db);
    const res = await request(app)
      .get('/test/protected')
      .set('Authorization', 'Bearer nhi_unknownkeyid.' + 'a'.repeat(43));
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('unauthenticated');
  });

  it('returns 401 for a correct key ID with the wrong secret', async () => {
    const { app, apiKeyService } = buildApiKeyApp(db);
    const { keyId } = apiKeyService.create('t-acme', 'u-alice');
    const wrongSecret = 'z'.repeat(43);
    const res = await request(app)
      .get('/test/protected')
      .set('Authorization', `Bearer nhi_${keyId}.${wrongSecret}`);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('unauthenticated');
  });

  it('returns 401 for a deleted key, same response as unknown key', async () => {
    const { app, apiKeyService } = buildApiKeyApp(db);
    const { fullKey, keyId } = apiKeyService.create('t-acme', 'u-alice');

    apiKeyService.revoke(keyId);

    const res = await request(app)
      .get('/test/protected')
      .set('Authorization', `Bearer ${fullKey}`);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('unauthenticated');
  });

  it('all 401 responses have the same sanitized shape', async () => {
    const { app, apiKeyService } = buildApiKeyApp(db);
    const { fullKey, keyId } = apiKeyService.create('t-acme', 'u-alice');
    apiKeyService.revoke(keyId);

    const cases = [
      // Missing header
      request(app).get('/test/protected'),
      // Wrong scheme
      request(app).get('/test/protected').set('Authorization', 'Basic abc'),
      // Malformed key
      request(app).get('/test/protected').set('Authorization', 'Bearer bad_format'),
      // Unknown ID
      request(app).get('/test/protected').set('Authorization', 'Bearer nhi_nope.' + 'x'.repeat(43)),
      // Wrong secret
      request(app).get('/test/protected').set('Authorization', `Bearer nhi_${keyId}.${'y'.repeat(43)}`),
      // Deleted key
      request(app).get('/test/protected').set('Authorization', `Bearer ${fullKey}`),
    ];

    const results = await Promise.all(cases);
    for (const res of results) {
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: { code: 'unauthenticated', message: 'Authentication required.' } });
    }
  });

  it('adds Cache-Control: no-store to 401 responses', async () => {
    const { app } = buildApiKeyApp(db);
    const res = await request(app).get('/test/protected');
    expect(res.status).toBe(401);
    expect(res.headers['cache-control']).toContain('no-store');
  });

  it('resolves keys for users in different tenants to their own stored owners', async () => {
    const { app, apiKeyService } = buildApiKeyApp(db);
    const acmeKey = apiKeyService.create('t-acme', 'u-alice');
    const globexKey = apiKeyService.create('t-globex', 'u-globex');

    const acmeRes = await request(app)
      .get('/test/protected')
      .set('Authorization', `Bearer ${acmeKey.fullKey}`);
    const globexRes = await request(app)
      .get('/test/protected')
      .set('Authorization', `Bearer ${globexKey.fullKey}`);

    expect(acmeRes.status).toBe(200);
    expect(acmeRes.body.tenantId).toBe('t-acme');
    expect(acmeRes.body.userId).toBe('u-alice');

    expect(globexRes.status).toBe(200);
    expect(globexRes.body.tenantId).toBe('t-globex');
    expect(globexRes.body.userId).toBe('u-globex');
  });

  it('client-supplied tenantId query parameter does not affect resolved context', async () => {
    const { app, apiKeyService } = buildApiKeyApp(db);
    const { fullKey } = apiKeyService.create('t-acme', 'u-alice');

    const res = await request(app)
      .get('/test/spoof?tenantId=t-globex&userId=u-globex')
      .set('Authorization', `Bearer ${fullKey}`);

    expect(res.status).toBe(200);
    expect(res.body.tenantId).toBe('t-acme');
    expect(res.body.userId).toBe('u-alice');
  });
});

describe('session authentication regression', () => {
  let db: DatabaseSync;

  beforeEach(async () => {
    db = await createSeededMemoryDb();
  });

  afterEach(() => {
    db.close();
  });

  it('session authentication still works with the full createApp', async () => {
    const app = createApp(db, { cookieSecure: false });

    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ email: DEMO_CREDENTIALS.acmeAlice.email, password: DEMO_CREDENTIALS.acmeAlice.password });

    expect(loginRes.status).toBe(200);
    expect(loginRes.body.user.tenantId).toBe('tenant-acme');

    const cookie = (loginRes.headers['set-cookie'] as unknown as string[])[0];
    const sessionRes = await request(app)
      .get('/api/auth/session')
      .set('Cookie', cookie);

    expect(sessionRes.status).toBe(200);
    expect(sessionRes.body.user).not.toBeNull();
    expect(sessionRes.body.user.tenantId).toBe('tenant-acme');
  });

  it('requireAuth session middleware is unaffected', async () => {
    const authService = new AuthService(db);
    const requireAuth = createRequireAuth(authService);
    const app = express();
    app.use(express.json());
    app.get('/test/session', requireAuth, (req, res) => {
      res.status(200).json({ userId: req.auth!.context.userId });
    });

    const loginApp = createApp(db, { cookieSecure: false });
    const loginRes = await request(loginApp)
      .post('/api/auth/login')
      .send({ email: DEMO_CREDENTIALS.acmeBob.email, password: DEMO_CREDENTIALS.acmeBob.password });

    const cookieHeader = (loginRes.headers['set-cookie'] as unknown as string[]).find(
      (c) => c.startsWith(SESSION_COOKIE_NAME + '='),
    );
    const res = await request(app)
      .get('/test/session')
      .set('Cookie', cookieHeader!);

    expect(res.status).toBe(200);
    expect(res.body.userId).toBe('user-acme-bob');
  });
});
