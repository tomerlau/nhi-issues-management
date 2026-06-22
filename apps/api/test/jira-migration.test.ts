import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/database/connection.js';
import { runMigrations, MIGRATIONS_DIR } from '../src/database/migrator.js';

const MIGRATIONS = [
  '001_initial_schema.sql',
  '002_authentication.sql',
  '003_jira_connections.sql',
];

interface ColumnInfo {
  name: string;
  notnull: number;
}

function tableColumns(db: ReturnType<typeof openDatabase>, table: string): ColumnInfo[] {
  return db.prepare(`PRAGMA table_info(${table})`).all() as unknown as ColumnInfo[];
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

  it('applies on a fresh database and creates the jira_connections table', () => {
    copyMigrations(MIGRATIONS);
    const db = openDatabase(':memory:');
    expect(runMigrations(db, dir)).toEqual(MIGRATIONS);

    const columns = tableColumns(db, 'jira_connections').map((c) => c.name);
    expect(columns).toEqual([
      'id',
      'tenant_id',
      'user_id',
      'site_url',
      'email',
      'account_id',
      'encrypted_token',
      'created_at',
      'updated_at',
    ]);
    db.close();
  });

  it('upgrades an existing M3 schema by applying only migration 003', () => {
    // Start from the M3 schema (migrations 001 + 002 only).
    copyMigrations(['001_initial_schema.sql', '002_authentication.sql']);
    const db = openDatabase(':memory:');
    expect(runMigrations(db, dir)).toEqual([
      '001_initial_schema.sql',
      '002_authentication.sql',
    ]);

    // Now make 003 available and re-run; only the new migration is applied.
    copyMigrations(['003_jira_connections.sql']);
    expect(runMigrations(db, dir)).toEqual(['003_jira_connections.sql']);
    db.close();
  });

  it('is idempotent: a second run applies nothing', () => {
    copyMigrations(MIGRATIONS);
    const db = openDatabase(':memory:');
    runMigrations(db, dir);
    expect(runMigrations(db, dir)).toEqual([]);
    db.close();
  });

  it('enforces one connection per (tenant_id, user_id)', () => {
    copyMigrations(MIGRATIONS);
    const db = openDatabase(':memory:');
    runMigrations(db, dir);

    db.exec(`
      INSERT INTO tenants (id, name, created_at) VALUES ('t1', 'T1', '2026-01-01T00:00:00.000Z');
      INSERT INTO users (id, tenant_id, email, display_name, created_at)
        VALUES ('u1', 't1', 'u1@example.com', 'U1', '2026-01-01T00:00:00.000Z');
    `);

    const insert = db.prepare(
      `INSERT INTO jira_connections
         (id, tenant_id, user_id, site_url, email, account_id, encrypted_token, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insert.run('c1', 't1', 'u1', 'https://x.atlassian.net', 'u1@example.com', 'acc', 'enc', 'now', 'now');

    expect(() =>
      insert.run('c2', 't1', 'u1', 'https://y.atlassian.net', 'u1@example.com', 'acc', 'enc', 'now', 'now'),
    ).toThrow();
    db.close();
  });

  it('rejects a connection whose (tenant_id, user_id) does not match a user', () => {
    copyMigrations(MIGRATIONS);
    const db = openDatabase(':memory:');
    runMigrations(db, dir);

    db.exec(`
      INSERT INTO tenants (id, name, created_at) VALUES ('t1', 'T1', '2026-01-01T00:00:00.000Z');
      INSERT INTO users (id, tenant_id, email, display_name, created_at)
        VALUES ('u1', 't1', 'u1@example.com', 'U1', '2026-01-01T00:00:00.000Z');
    `);

    const insert = db.prepare(
      `INSERT INTO jira_connections
         (id, tenant_id, user_id, site_url, email, account_id, encrypted_token, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    // user 'u1' belongs to tenant 't1', not 't2': composite FK must reject it.
    expect(() =>
      insert.run('c1', 't2', 'u1', 'https://x.atlassian.net', 'u1@example.com', 'acc', 'enc', 'now', 'now'),
    ).toThrow();
    db.close();
  });
});
