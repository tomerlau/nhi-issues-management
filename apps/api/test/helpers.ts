import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../src/database/connection.js';
import { runMigrations } from '../src/database/migrator.js';
import { seedDemoData } from '../src/database/seed-data.js';

/** Open an isolated in-memory database with the full schema applied. */
export function createMigratedMemoryDb(): DatabaseSync {
  const db = openDatabase(':memory:');
  runMigrations(db);
  return db;
}

/** Open an isolated in-memory database with the schema applied and demo data seeded. */
export function createSeededMemoryDb(): DatabaseSync {
  const db = createMigratedMemoryDb();
  seedDemoData(db);
  return db;
}

/** Demo credentials seeded for tests, matching src/database/seed-data.ts. */
export const DEMO_CREDENTIALS = {
  acmeAlice: { email: 'alice@example.com', password: 'acme-alice-demo', tenantId: 'tenant-acme' },
  acmeBob: { email: 'bob@example.com', password: 'acme-bob-demo', tenantId: 'tenant-acme' },
  globexAlice: {
    email: 'alice@globex.example.com',
    password: 'globex-alice-demo',
    tenantId: 'tenant-globex',
  },
} as const;
