import type { DatabaseSync } from 'node:sqlite';
import { TenantRepository } from '../repositories/tenant-repository.js';
import { UserRepository } from '../repositories/user-repository.js';

/**
 * Fixed timestamp for seeded records so repeated seeding is byte-for-byte
 * deterministic and easy to inspect manually.
 */
const SEED_TIMESTAMP = '2026-01-01T00:00:00.000Z';

export const DEMO_TENANTS = [
  { id: 'tenant-acme', name: 'Acme Corp' },
  { id: 'tenant-globex', name: 'Globex Corp' },
] as const;

/**
 * `alice@example.com` deliberately appears in both tenants to demonstrate that
 * email uniqueness is scoped per tenant, not global. These demo records carry
 * no credentials; authentication arrives in Milestone 3.
 */
export const DEMO_USERS = [
  {
    tenantId: 'tenant-acme',
    id: 'user-acme-alice',
    email: 'alice@example.com',
    displayName: 'Alice Anderson',
  },
  {
    tenantId: 'tenant-acme',
    id: 'user-acme-bob',
    email: 'bob@example.com',
    displayName: 'Bob Brown',
  },
  {
    tenantId: 'tenant-globex',
    id: 'user-globex-alice',
    email: 'alice@example.com',
    displayName: 'Alice Globex',
  },
] as const;

export interface SeedResult {
  tenantsCreated: number;
  usersCreated: number;
}

/**
 * Insert the demo tenants and users. Idempotent: existing records (matched by
 * tenant id, and by tenant-scoped email for users) are left untouched, so
 * running the seed repeatedly never duplicates or overwrites data.
 */
export function seedDemoData(db: DatabaseSync): SeedResult {
  const tenants = new TenantRepository(db);
  const users = new UserRepository(db);

  let tenantsCreated = 0;
  for (const tenant of DEMO_TENANTS) {
    if (!tenants.findById(tenant.id)) {
      tenants.create({ id: tenant.id, name: tenant.name, createdAt: SEED_TIMESTAMP });
      tenantsCreated += 1;
    }
  }

  let usersCreated = 0;
  for (const user of DEMO_USERS) {
    if (!users.findByEmail(user.tenantId, user.email)) {
      users.create(user.tenantId, {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        createdAt: SEED_TIMESTAMP,
      });
      usersCreated += 1;
    }
  }

  return { tenantsCreated, usersCreated };
}
