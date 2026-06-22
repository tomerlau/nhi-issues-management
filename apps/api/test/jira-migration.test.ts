import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/database/connection.js';
import { runMigrations, MIGRATIONS_DIR } from '../src/database/migrator.js';
import { decryptToken, encryptToken } from '../src/jira/token-cipher.js';

const PRE_TENANT_WIDE = [
  '001_initial_schema.sql',
  '002_authentication.sql',
  '003_jira_connections.sql',
];

const MIGRATIONS = [...PRE_TENANT_WIDE, '004_jira_connection_tenant_wide.sql'];

interface ColumnInfo {
  name: string;
  notnull: number;
}

function tableColumns(db: ReturnType<typeof openDatabase>, table: string): ColumnInfo[] {
  return db.prepare(`PRAGMA table_info(${table})`).all() as unknown as ColumnInfo[];
}

function seedTenantAndUsers(db: ReturnType<typeof openDatabase>): void {
  db.exec(`
    INSERT INTO tenants (id, name, created_at) VALUES ('t1', 'T1', '2026-01-01T00:00:00.000Z');
    INSERT INTO users (id, tenant_id, email, display_name, created_at)
      VALUES ('u1', 't1', 'u1@example.com', 'U1', '2026-01-01T00:00:00.000Z');
    INSERT INTO users (id, tenant_id, email, display_name, created_at)
      VALUES ('u2', 't1', 'u2@example.com', 'U2', '2026-01-01T00:00:00.000Z');
  `);
}

describe('jira_connections migration', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nhi-jira-mig-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function copyMigrations(files: string[]): void {
    for (const file of files) {
      fs.copyFileSync(path.join(MIGRATIONS_DIR, file), path.join(dir, file));
    }
  }

  it('applies on a fresh database and creates the tenant-wide jira_connections table', () => {
    copyMigrations(MIGRATIONS);
    const db = openDatabase(':memory:');
    expect(runMigrations(db, dir)).toEqual(MIGRATIONS);

    const columns = tableColumns(db, 'jira_connections').map((c) => c.name);
    expect(columns).toEqual([
      'id',
      'tenant_id',
      'configured_by_user_id',
      'site_url',
      'email',
      'account_id',
      'encrypted_token',
      'created_at',
      'updated_at',
    ]);
    db.close();
  });

  it('upgrades an existing per-user schema by applying only migration 004', () => {
    // Start from the pre-correction schema (migrations 001..003 only).
    copyMigrations(PRE_TENANT_WIDE);
    const db = openDatabase(':memory:');
    expect(runMigrations(db, dir)).toEqual(PRE_TENANT_WIDE);

    // Now make 004 available and re-run; only the new migration is applied.
    copyMigrations(['004_jira_connection_tenant_wide.sql']);
    expect(runMigrations(db, dir)).toEqual(['004_jira_connection_tenant_wide.sql']);
    db.close();
  });

  it('is idempotent: a second run applies nothing', () => {
    copyMigrations(MIGRATIONS);
    const db = openDatabase(':memory:');
    runMigrations(db, dir);
    expect(runMigrations(db, dir)).toEqual([]);
    db.close();
  });

  it('enforces one connection per tenant', () => {
    copyMigrations(MIGRATIONS);
    const db = openDatabase(':memory:');
    runMigrations(db, dir);
    seedTenantAndUsers(db);

    const insert = db.prepare(
      `INSERT INTO jira_connections
         (id, tenant_id, configured_by_user_id, site_url, email, account_id,
          encrypted_token, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insert.run('c1', 't1', 'u1', 'https://x.atlassian.net', 'u1@example.com', 'acc', 'enc', 'now', 'now');

    // A second connection for the same tenant (even by a different user) is rejected.
    expect(() =>
      insert.run('c2', 't1', 'u2', 'https://y.atlassian.net', 'u2@example.com', 'acc', 'enc', 'now', 'now'),
    ).toThrow();
    db.close();
  });

  it('rejects a connection whose (tenant_id, configured_by_user_id) does not match a user', () => {
    copyMigrations(MIGRATIONS);
    const db = openDatabase(':memory:');
    runMigrations(db, dir);
    seedTenantAndUsers(db);

    const insert = db.prepare(
      `INSERT INTO jira_connections
         (id, tenant_id, configured_by_user_id, site_url, email, account_id,
          encrypted_token, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    // user 'u1' belongs to tenant 't1', not 't2': composite FK must reject it.
    expect(() =>
      insert.run('c1', 't2', 'u1', 'https://x.atlassian.net', 'u1@example.com', 'acc', 'enc', 'now', 'now'),
    ).toThrow();
    db.close();
  });

  describe('legacy per-user row migration', () => {
    // Apply 001..003 (the per-user schema), insert legacy rows, then apply 004.
    function migrateWithLegacyRows(
      db: ReturnType<typeof openDatabase>,
      rows: Array<{
        id: string;
        tenantId: string;
        userId: string;
        siteUrl: string;
        email: string;
        accountId: string;
        encryptedToken: string;
        updatedAt: string;
      }>,
    ): void {
      copyMigrations(PRE_TENANT_WIDE);
      runMigrations(db, dir);
      seedTenantAndUsers(db);

      const insert = db.prepare(
        `INSERT INTO jira_connections
           (id, tenant_id, user_id, site_url, email, account_id, encrypted_token, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const r of rows) {
        insert.run(
          r.id,
          r.tenantId,
          r.userId,
          r.siteUrl,
          r.email,
          r.accountId,
          r.encryptedToken,
          '2026-01-01T00:00:00.000Z',
          r.updatedAt,
        );
      }

      copyMigrations(['004_jira_connection_tenant_wide.sql']);
      expect(runMigrations(db, dir)).toEqual(['004_jira_connection_tenant_wide.sql']);
    }

    it('preserves a single legacy row and carries user_id into configured_by_user_id', () => {
      const db = openDatabase(':memory:');
      migrateWithLegacyRows(db, [
        {
          id: 'c1',
          tenantId: 't1',
          userId: 'u1',
          siteUrl: 'https://x.atlassian.net',
          email: 'u1@example.com',
          accountId: 'acc-1',
          encryptedToken: 'enc-1',
          updatedAt: '2026-02-01T00:00:00.000Z',
        },
      ]);

      const rows = db.prepare('SELECT * FROM jira_connections').all() as Record<string, unknown>[];
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: 'c1',
        tenant_id: 't1',
        configured_by_user_id: 'u1',
        site_url: 'https://x.atlassian.net',
        encrypted_token: 'enc-1',
      });
      db.close();
    });

    it('keeps exactly one row per tenant: greatest updated_at wins', () => {
      const db = openDatabase(':memory:');
      migrateWithLegacyRows(db, [
        {
          id: 'older',
          tenantId: 't1',
          userId: 'u1',
          siteUrl: 'https://old.atlassian.net',
          email: 'u1@example.com',
          accountId: 'acc-old',
          encryptedToken: 'enc-old',
          updatedAt: '2026-02-01T00:00:00.000Z',
        },
        {
          id: 'newer',
          tenantId: 't1',
          userId: 'u2',
          siteUrl: 'https://new.atlassian.net',
          email: 'u2@example.com',
          accountId: 'acc-new',
          encryptedToken: 'enc-new',
          updatedAt: '2026-03-01T00:00:00.000Z',
        },
      ]);

      const rows = db.prepare('SELECT id, configured_by_user_id FROM jira_connections').all() as {
        id: string;
        configured_by_user_id: string;
      }[];
      expect(rows).toEqual([{ id: 'newer', configured_by_user_id: 'u2' }]);
      db.close();
    });

    it('breaks an updated_at tie by greatest id', () => {
      const db = openDatabase(':memory:');
      const sameTime = '2026-02-01T00:00:00.000Z';
      migrateWithLegacyRows(db, [
        {
          id: 'aaa',
          tenantId: 't1',
          userId: 'u1',
          siteUrl: 'https://a.atlassian.net',
          email: 'u1@example.com',
          accountId: 'acc-a',
          encryptedToken: 'enc-a',
          updatedAt: sameTime,
        },
        {
          id: 'bbb',
          tenantId: 't1',
          userId: 'u2',
          siteUrl: 'https://b.atlassian.net',
          email: 'u2@example.com',
          accountId: 'acc-b',
          encryptedToken: 'enc-b',
          updatedAt: sameTime,
        },
      ]);

      const rows = db.prepare('SELECT id FROM jira_connections').all() as { id: string }[];
      expect(rows).toEqual([{ id: 'bbb' }]);
      db.close();
    });

    it('retains one independent row for each tenant', () => {
      const db = openDatabase(':memory:');
      copyMigrations(PRE_TENANT_WIDE);
      runMigrations(db, dir);
      db.exec(`
        INSERT INTO tenants (id, name, created_at) VALUES ('t1', 'T1', '2026-01-01T00:00:00.000Z');
        INSERT INTO tenants (id, name, created_at) VALUES ('t2', 'T2', '2026-01-01T00:00:00.000Z');
        INSERT INTO users (id, tenant_id, email, display_name, created_at)
          VALUES ('u1', 't1', 'u1@example.com', 'U1', '2026-01-01T00:00:00.000Z');
        INSERT INTO users (id, tenant_id, email, display_name, created_at)
          VALUES ('u3', 't2', 'u3@example.com', 'U3', '2026-01-01T00:00:00.000Z');
      `);
      const insert = db.prepare(
        `INSERT INTO jira_connections
           (id, tenant_id, user_id, site_url, email, account_id, encrypted_token, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      insert.run('c1', 't1', 'u1', 'https://t1.atlassian.net', 'u1@example.com', 'a1', 'e1', 'now', 'now');
      insert.run('c2', 't2', 'u3', 'https://t2.atlassian.net', 'u3@example.com', 'a2', 'e2', 'now', 'now');

      copyMigrations(['004_jira_connection_tenant_wide.sql']);
      runMigrations(db, dir);

      const rows = db
        .prepare('SELECT tenant_id, configured_by_user_id FROM jira_connections ORDER BY tenant_id')
        .all();
      expect(rows).toEqual([
        { tenant_id: 't1', configured_by_user_id: 'u1' },
        { tenant_id: 't2', configured_by_user_id: 'u3' },
      ]);
      db.close();
    });

    it('keeps existing ciphertext decryptable using the migrated configured_by_user_id', () => {
      const db = openDatabase(':memory:');
      const key = randomBytes(32);
      const plaintext = 'legacy-jira-api-token';
      // Encrypt exactly as Milestone 5 did: bound to (tenantId, owning user id).
      const ciphertext = encryptToken(plaintext, key, {
        tenantId: 't1',
        configuredByUserId: 'u1',
      });

      migrateWithLegacyRows(db, [
        {
          id: 'c1',
          tenantId: 't1',
          userId: 'u1',
          siteUrl: 'https://x.atlassian.net',
          email: 'u1@example.com',
          accountId: 'acc-1',
          encryptedToken: ciphertext,
          updatedAt: '2026-02-01T00:00:00.000Z',
        },
      ]);

      const row = db
        .prepare('SELECT tenant_id, configured_by_user_id, encrypted_token FROM jira_connections')
        .get() as { tenant_id: string; configured_by_user_id: string; encrypted_token: string };
      // Decryption uses the configured_by_user_id stored on the row, not a
      // currently-requesting user's id.
      const decrypted = decryptToken(row.encrypted_token, key, {
        tenantId: row.tenant_id,
        configuredByUserId: row.configured_by_user_id,
      });
      expect(decrypted).toBe(plaintext);
      db.close();
    });
  });
});
