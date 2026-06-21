import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TenantRepository } from '../src/repositories/tenant-repository.js';
import { UserRepository } from '../src/repositories/user-repository.js';
import { DEMO_TENANTS, DEMO_USERS, seedDemoData } from '../src/database/seed-data.js';
import { createMigratedMemoryDb } from './helpers.js';

describe('demo seed data', () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = createMigratedMemoryDb();
  });

  afterEach(() => {
    db.close();
  });

  it('creates exactly two tenants and the expected demo users', () => {
    const result = seedDemoData(db);
    expect(result).toEqual({ tenantsCreated: 2, usersCreated: 3 });

    const tenants = new TenantRepository(db).list();
    expect(tenants.map((t) => t.id)).toEqual(['tenant-acme', 'tenant-globex']);

    const users = new UserRepository(db);
    expect(users.list('tenant-acme').map((u) => u.email)).toEqual([
      'alice@example.com',
      'bob@example.com',
    ]);
    expect(users.list('tenant-globex').map((u) => u.email)).toEqual(['alice@example.com']);
  });

  it('is idempotent: running twice creates no duplicates', () => {
    seedDemoData(db);
    const second = seedDemoData(db);
    expect(second).toEqual({ tenantsCreated: 0, usersCreated: 0 });

    const tenantCount = (
      db.prepare('SELECT COUNT(*) AS n FROM tenants').get() as { n: number }
    ).n;
    const userCount = (db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
    expect(tenantCount).toBe(DEMO_TENANTS.length);
    expect(userCount).toBe(DEMO_USERS.length);
  });
});
