import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/database/connection.js';
import { runMigrations, MIGRATIONS_DIR } from '../src/database/migrator.js';

const M2_MIGRATION = '001_initial_schema.sql';
const AUTH_MIGRATION = '002_authentication.sql';

/**
 * Reproduce a real Milestone 2 database: only migration 001 applied, seeded with
 * the original demo data where the Globex user shared alice@example.com with the
 * Acme user. Then apply the remaining migrations and confirm the upgrade
 * succeeds and enforces global email uniqueness.
 */
describe('milestone 2 -> milestone 3 migration upgrade', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nhi-upgrade-'));
    fs.copyFileSync(path.join(MIGRATIONS_DIR, M2_MIGRATION), path.join(dir, M2_MIGRATION));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function seedMilestone2Database(): ReturnType<typeof openDatabase> {
    const db = openDatabase(':memory:');
    // Apply only the Milestone 2 schema.
    expect(runMigrations(db, dir)).toEqual([M2_MIGRATION]);

    db.exec(`
      INSERT INTO tenants (id, name, created_at) VALUES
        ('tenant-acme', 'Acme Corp', '2026-01-01T00:00:00.000Z'),
        ('tenant-globex', 'Globex Corp', '2026-01-01T00:00:00.000Z');
      INSERT INTO users (id, tenant_id, email, display_name, created_at) VALUES
        ('user-acme-alice', 'tenant-acme', 'alice@example.com', 'Alice Anderson', '2026-01-01T00:00:00.000Z'),
        ('user-globex-alice', 'tenant-globex', 'alice@example.com', 'Alice Globex', '2026-01-01T00:00:00.000Z');
    `);
    return db;
  }

  it('upgrades a seeded Milestone 2 schema and resolves the duplicate email', () => {
    const db = seedMilestone2Database();
    fs.copyFileSync(path.join(MIGRATIONS_DIR, AUTH_MIGRATION), path.join(dir, AUTH_MIGRATION));

    expect(() => runMigrations(db, dir)).not.toThrow();

    const globex = db
      .prepare('SELECT email FROM users WHERE id = ?')
      .get('user-globex-alice') as { email: string };
    expect(globex.email).toBe('alice@globex.example.com');

    const acme = db
      .prepare('SELECT email FROM users WHERE id = ?')
      .get('user-acme-alice') as { email: string };
    expect(acme.email).toBe('alice@example.com');

    db.close();
  });

  it('enforces global email uniqueness after the upgrade', () => {
    const db = seedMilestone2Database();
    fs.copyFileSync(path.join(MIGRATIONS_DIR, AUTH_MIGRATION), path.join(dir, AUTH_MIGRATION));
    runMigrations(db, dir);

    expect(() =>
      db
        .prepare('INSERT INTO users (id, tenant_id, email, display_name, created_at) VALUES (?, ?, ?, ?, ?)')
        .run('user-globex-bob', 'tenant-globex', 'alice@example.com', 'Bob', '2026-01-01T00:00:00.000Z'),
    ).toThrow();

    db.close();
  });
});
