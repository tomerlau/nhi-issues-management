import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TenantRepository } from '../src/repositories/tenant-repository.js';
import { UserRepository } from '../src/repositories/user-repository.js';
import { createMigratedMemoryDb } from './helpers.js';

describe('tenant-scoped repositories', () => {
  let db: DatabaseSync;
  let tenants: TenantRepository;
  let users: UserRepository;

  beforeEach(() => {
    db = createMigratedMemoryDb();
    tenants = new TenantRepository(db);
    users = new UserRepository(db);
    tenants.create({ id: 'tenant-a', name: 'Tenant A' });
    tenants.create({ id: 'tenant-b', name: 'Tenant B' });
  });

  afterEach(() => {
    db.close();
  });

  it('rejects a user for a nonexistent tenant (foreign key)', () => {
    expect(() =>
      users.create('tenant-missing', {
        id: 'u1',
        email: 'x@example.com',
        displayName: 'X',
      }),
    ).toThrow();
  });

  it('rejects a duplicate email within the same tenant', () => {
    users.create('tenant-a', { id: 'u1', email: 'dup@example.com', displayName: 'One' });
    expect(() =>
      users.create('tenant-a', { id: 'u2', email: 'dup@example.com', displayName: 'Two' }),
    ).toThrow();
  });

  it('rejects the same email across two different tenants (global uniqueness)', () => {
    users.create('tenant-a', { id: 'ua', email: 'shared@example.com', displayName: 'A' });
    expect(() =>
      users.create('tenant-b', { id: 'ub', email: 'shared@example.com', displayName: 'B' }),
    ).toThrow();
  });

  it('finds a user globally by email and derives its tenant (authentication lookup)', () => {
    users.create('tenant-b', { id: 'ub', email: 'global@example.com', displayName: 'B' });
    const found = users.findByEmailForAuthentication('global@example.com');
    expect(found).toMatchObject({ id: 'ub', tenantId: 'tenant-b', email: 'global@example.com' });
    expect(users.findByEmailForAuthentication('absent@example.com')).toBeNull();
  });

  it('retrieves a user with the correct tenant and user ids', () => {
    users.create('tenant-a', { id: 'ua', email: 'a@example.com', displayName: 'A' });
    const found = users.findById('tenant-a', 'ua');
    expect(found).toMatchObject({ id: 'ua', tenantId: 'tenant-a', email: 'a@example.com' });
  });

  it('does not retrieve a user through another tenant context', () => {
    users.create('tenant-a', { id: 'ua', email: 'a@example.com', displayName: 'A' });
    expect(users.findById('tenant-b', 'ua')).toBeNull();
    expect(users.findByEmail('tenant-b', 'a@example.com')).toBeNull();
  });

  it('lists only the users belonging to the requested tenant', () => {
    users.create('tenant-a', { id: 'ua1', email: 'a1@example.com', displayName: 'A1' });
    users.create('tenant-a', { id: 'ua2', email: 'a2@example.com', displayName: 'A2' });
    users.create('tenant-b', { id: 'ub1', email: 'b1@example.com', displayName: 'B1' });

    const tenantAUsers = users.list('tenant-a').map((u) => u.id);
    expect(tenantAUsers).toEqual(['ua1', 'ua2']);

    const tenantBUsers = users.list('tenant-b').map((u) => u.id);
    expect(tenantBUsers).toEqual(['ub1']);
  });
});
