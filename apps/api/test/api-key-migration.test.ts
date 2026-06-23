import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/database/connection.js';
import { runMigrations, MIGRATIONS_DIR } from '../src/database/migrator.js';
import { createMigratedMemoryDb } from './helpers.js';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

describe('api_keys migration (008)', () => {
  it('applies all migrations including 008 without error', () => {
    const db = createMigratedMemoryDb();
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    expect(names).toContain('api_keys');
    db.close();
  });

  it('creates api_keys with the expected columns', () => {
    const db = createMigratedMemoryDb();
    const cols = db
      .prepare(`PRAGMA table_info(api_keys)`)
      .all() as Array<{ name: string; type: string; notnull: number; pk: number }>;
    const byName = Object.fromEntries(cols.map((c) => [c.name, c]));

    expect(byName['id']).toBeDefined();
    expect(byName['id'].pk).toBe(1);
    expect(byName['id'].notnull).toBe(1);

    expect(byName['tenant_id']).toBeDefined();
    expect(byName['tenant_id'].notnull).toBe(1);

    expect(byName['user_id']).toBeDefined();
    expect(byName['user_id'].notnull).toBe(1);

    expect(byName['secret_hash']).toBeDefined();
    expect(byName['secret_hash'].notnull).toBe(1);

    expect(byName['created_at']).toBeDefined();
    expect(byName['created_at'].notnull).toBe(1);

    db.close();
  });

  it('enforces the composite tenant/user foreign key', () => {
    const db = createMigratedMemoryDb();
    expect(() =>
      db
        .prepare(
          `INSERT INTO api_keys (id, tenant_id, user_id, secret_hash, created_at)
           VALUES ('key-1', 'tenant-nobody', 'user-nobody', 'abc123', '2026-01-01T00:00:00.000Z')`,
        )
        .run(),
    ).toThrow();
    db.close();
  });

  it('allows two keys for the same user', () => {
    const db = createMigratedMemoryDb();
    db.exec(`
      INSERT INTO tenants (id, name, created_at) VALUES ('t1', 'T1', '2026-01-01T00:00:00.000Z');
      INSERT INTO users (id, tenant_id, email, display_name, created_at)
        VALUES ('u1', 't1', 'u1@example.com', 'U1', '2026-01-01T00:00:00.000Z');
    `);
    expect(() => {
      db
        .prepare(
          `INSERT INTO api_keys (id, tenant_id, user_id, secret_hash, created_at)
           VALUES (?, 't1', 'u1', 'hash1', '2026-01-01T00:00:00.000Z')`,
        )
        .run('key-a');
      db
        .prepare(
          `INSERT INTO api_keys (id, tenant_id, user_id, secret_hash, created_at)
           VALUES (?, 't1', 'u1', 'hash2', '2026-01-01T00:00:00.000Z')`,
        )
        .run('key-b');
    }).not.toThrow();
    const count = db.prepare('SELECT count(*) as n FROM api_keys').get() as { n: number };
    expect(count.n).toBe(2);
    db.close();
  });

  it('does not persist a plaintext key field', () => {
    const db = createMigratedMemoryDb();
    const cols = db
      .prepare(`PRAGMA table_info(api_keys)`)
      .all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).not.toContain('secret');
    expect(names).not.toContain('plaintext');
    expect(names).not.toContain('key');
    expect(names).not.toContain('revoked_at');
    db.close();
  });

  it('upgrades from the M10 schema (through migrations 001-007) to include api_keys', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nhi-m12-upgrade-'));
    try {
      // Copy migrations 001-007 only.
      const allMigrations = fs
        .readdirSync(MIGRATIONS_DIR)
        .filter((f) => f.endsWith('.sql'))
        .sort();
      const m10Migrations = allMigrations.filter((f) => !f.startsWith('008'));
      for (const f of m10Migrations) {
        fs.copyFileSync(path.join(MIGRATIONS_DIR, f), path.join(dir, f));
      }

      const db = openDatabase(':memory:');
      const applied = runMigrations(db, dir);
      expect(applied).not.toContain('008_api_keys.sql');

      // Now add migration 008 and upgrade.
      fs.copyFileSync(
        path.join(MIGRATIONS_DIR, '008_api_keys.sql'),
        path.join(dir, '008_api_keys.sql'),
      );
      const upgradedApplied = runMigrations(db, dir);
      expect(upgradedApplied).toContain('008_api_keys.sql');

      // Table now exists.
      const result = db
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='api_keys'`)
        .get() as { name: string } | undefined;
      expect(result?.name).toBe('api_keys');

      db.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
