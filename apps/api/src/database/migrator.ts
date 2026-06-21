import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

/**
 * Directory holding numbered `*.sql` migration files. Resolved relative to this
 * module so it is identical when running from `src` (tsx) or `dist` (built).
 */
export const MIGRATIONS_DIR = path.resolve(import.meta.dirname, '..', '..', 'migrations');

const MIGRATION_FILE = /^(\d+)_.+\.sql$/;

function migrationNumber(file: string): number {
  return Number.parseInt(MIGRATION_FILE.exec(file)![1], 10);
}

function loadMigrationFiles(dir: string): string[] {
  return fs
    .readdirSync(dir)
    .filter((file) => MIGRATION_FILE.test(file))
    .sort((a, b) => migrationNumber(a) - migrationNumber(b) || a.localeCompare(b, 'en'));
}

/**
 * Apply pending migrations in deterministic numeric order. Each migration runs
 * inside its own transaction and is recorded in `schema_migrations` only on
 * success; a failing migration is rolled back and left unrecorded so the next
 * run retries it. Already-applied migrations are skipped, making re-runs safe.
 *
 * Returns the identifiers applied during this call (empty when up to date).
 */
export function runMigrations(db: DatabaseSync, migrationsDir: string = MIGRATIONS_DIR): string[] {
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       id TEXT PRIMARY KEY,
       applied_at TEXT NOT NULL
     ) STRICT`,
  );

  const appliedRows = db.prepare('SELECT id FROM schema_migrations').all() as { id: string }[];
  const applied = new Set(appliedRows.map((row) => row.id));

  const recordMigration = db.prepare(
    'INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)',
  );

  const newlyApplied: string[] = [];
  for (const file of loadMigrationFiles(migrationsDir)) {
    if (applied.has(file)) {
      continue;
    }

    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    db.exec('BEGIN');
    try {
      db.exec(sql);
      recordMigration.run(file, new Date().toISOString());
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    newlyApplied.push(file);
  }

  return newlyApplied;
}
