import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/database/connection.js';
import { runMigrations } from '../src/database/migrator.js';

interface TableListRow {
  name: string;
  strict: number;
}

describe('migration runner', () => {
  it('creates the expected tables', () => {
    const db = openDatabase(':memory:');
    runMigrations(db);

    const names = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all() as { name: string }[]
    ).map((row) => row.name);

    expect(names).toContain('tenants');
    expect(names).toContain('users');
    expect(names).toContain('user_credentials');
    expect(names).toContain('sessions');
    expect(names).toContain('schema_migrations');
    db.close();
  });

  it('marks tenants and users as STRICT tables', () => {
    const db = openDatabase(':memory:');
    runMigrations(db);

    for (const table of ['tenants', 'users', 'user_credentials', 'sessions']) {
      const row = db
        .prepare('SELECT name, strict FROM pragma_table_list WHERE name = ?')
        .get(table) as TableListRow | undefined;
      expect(row?.strict).toBe(1);
    }
    db.close();
  });

  it('records applied migrations and is idempotent on re-run', () => {
    const db = openDatabase(':memory:');
    const firstRun = runMigrations(db);
    expect(firstRun).toEqual([
      '001_initial_schema.sql',
      '002_authentication.sql',
      '003_jira_connections.sql',
      '004_jira_connection_tenant_wide.sql',
      '005_jira_connection_v2_credentials.sql',
      '006_jira_ticket_provenance.sql',
      '007_jira_ticket_provenance_recent_index.sql',
      '008_api_keys.sql',
    ]);

    const secondRun = runMigrations(db);
    expect(secondRun).toEqual([]);

    const recorded = (
      db.prepare('SELECT id FROM schema_migrations ORDER BY id').all() as { id: string }[]
    ).map((row) => row.id);
    expect(recorded).toEqual([
      '001_initial_schema.sql',
      '002_authentication.sql',
      '003_jira_connections.sql',
      '004_jira_connection_tenant_wide.sql',
      '005_jira_connection_v2_credentials.sql',
      '006_jira_ticket_provenance.sql',
      '007_jira_ticket_provenance_recent_index.sql',
      '008_api_keys.sql',
    ]);
    db.close();
  });
});

describe('migration runner failure handling', () => {
  let migrationsDir: string;

  beforeEach(() => {
    migrationsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nhi-migrations-'));
  });

  afterEach(() => {
    fs.rmSync(migrationsDir, { recursive: true, force: true });
  });

  it('rolls back a failed migration and does not record it', () => {
    fs.writeFileSync(
      path.join(migrationsDir, '001_good.sql'),
      'CREATE TABLE alpha (id TEXT PRIMARY KEY) STRICT;',
    );
    fs.writeFileSync(
      path.join(migrationsDir, '002_bad.sql'),
      'CREATE TABLE beta (id TEXT PRIMARY KEY) STRICT;\nTHIS IS NOT VALID SQL;',
    );

    const db = openDatabase(':memory:');
    expect(() => runMigrations(db, migrationsDir)).toThrow();

    const recorded = (
      db.prepare('SELECT id FROM schema_migrations ORDER BY id').all() as { id: string }[]
    ).map((row) => row.id);
    expect(recorded).toEqual(['001_good.sql']);

    const tables = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as { name: string }[]
    ).map((row) => row.name);
    expect(tables).toContain('alpha');
    expect(tables).not.toContain('beta');
    db.close();
  });
});

describe('migration runner ordering', () => {
  let migrationsDir: string;

  beforeEach(() => {
    migrationsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nhi-migrations-'));
  });

  afterEach(() => {
    fs.rmSync(migrationsDir, { recursive: true, force: true });
  });

  it('applies migrations by numeric identifier, not lexicographically', () => {
    // Lexicographically '10_tenth.sql' sorts before '2_second.sql', so the old
    // string sort would run the tenth migration first. It inserts into a table
    // created by the second migration, so wrong ordering fails structurally.
    fs.writeFileSync(
      path.join(migrationsDir, '2_second.sql'),
      'CREATE TABLE ordered_marker (id TEXT PRIMARY KEY) STRICT;',
    );
    fs.writeFileSync(
      path.join(migrationsDir, '10_tenth.sql'),
      "INSERT INTO ordered_marker (id) VALUES ('tenth');",
    );

    const db = openDatabase(':memory:');
    const applied = runMigrations(db, migrationsDir);

    expect(applied).toEqual(['2_second.sql', '10_tenth.sql']);
    const row = db.prepare('SELECT id FROM ordered_marker').get() as { id: string };
    expect(row.id).toBe('tenth');
    db.close();
  });
});
