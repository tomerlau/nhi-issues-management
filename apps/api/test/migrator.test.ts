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
    expect(names).toContain('schema_migrations');
    db.close();
  });

  it('marks tenants and users as STRICT tables', () => {
    const db = openDatabase(':memory:');
    runMigrations(db);

    for (const table of ['tenants', 'users']) {
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
    expect(firstRun).toEqual(['001_initial_schema.sql']);

    const secondRun = runMigrations(db);
    expect(secondRun).toEqual([]);

    const recorded = (
      db.prepare('SELECT id FROM schema_migrations ORDER BY id').all() as { id: string }[]
    ).map((row) => row.id);
    expect(recorded).toEqual(['001_initial_schema.sql']);
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
