import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createMigratedMemoryDb } from './helpers.js';

describe('GET /api/health', () => {
  const db = createMigratedMemoryDb();
  const app = createApp(db);

  afterAll(() => {
    db.close();
  });

  it('returns HTTP 200', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
  });

  it('returns exactly { status: "ok" }', async () => {
    const res = await request(app).get('/api/health');
    expect(res.body).toEqual({ status: 'ok' });
  });
});
