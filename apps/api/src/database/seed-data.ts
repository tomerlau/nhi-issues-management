import type { DatabaseSync } from 'node:sqlite';
import { TenantRepository } from '../repositories/tenant-repository.js';
import { UserRepository } from '../repositories/user-repository.js';
import { UserCredentialRepository } from '../repositories/user-credential-repository.js';
import { hashPassword } from '../auth/password.js';

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
 * Every demo email is globally unique. Each user has a documented demo password;
 * only the Argon2id hash is ever stored, never the plaintext. The passwords here
 * are intentionally public test credentials for the local POC.
 */
export const DEMO_USERS = [
  {
    tenantId: 'tenant-acme',
    id: 'user-acme-alice',
    email: 'alice@example.com',
    displayName: 'Alice Anderson',
    password: 'acme-alice-demo',
  },
  {
    tenantId: 'tenant-acme',
    id: 'user-acme-bob',
    email: 'bob@example.com',
    displayName: 'Bob Brown',
    password: 'acme-bob-demo',
  },
  {
    tenantId: 'tenant-globex',
    id: 'user-globex-alice',
    email: 'alice@globex.example.com',
    displayName: 'Alice Globex',
    password: 'globex-alice-demo',
  },
] as const;

export interface SeedResult {
  tenantsCreated: number;
  usersCreated: number;
  credentialsCreated: number;
}

/**
 * Insert the demo tenants, users, and password credentials. Idempotent:
 * existing records (tenants by id, users by tenant-scoped email, credentials by
 * tenant-scoped user id) are left untouched, so running the seed repeatedly
 * never duplicates, overwrites, or re-hashes data.
 */
export async function seedDemoData(db: DatabaseSync): Promise<SeedResult> {
  const tenants = new TenantRepository(db);
  const users = new UserRepository(db);
  const credentials = new UserCredentialRepository(db);

  let tenantsCreated = 0;
  for (const tenant of DEMO_TENANTS) {
    if (!tenants.findById(tenant.id)) {
      tenants.create({ id: tenant.id, name: tenant.name, createdAt: SEED_TIMESTAMP });
      tenantsCreated += 1;
    }
  }

  let usersCreated = 0;
  let credentialsCreated = 0;
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

    if (!credentials.findByUserId(user.tenantId, user.id)) {
      credentials.create({
        tenantId: user.tenantId,
        userId: user.id,
        passwordHash: await hashPassword(user.password),
        createdAt: SEED_TIMESTAMP,
      });
      credentialsCreated += 1;
    }
  }

  return { tenantsCreated, usersCreated, credentialsCreated };
}
