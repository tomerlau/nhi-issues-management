import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../src/database/connection.js';
import { runMigrations } from '../src/database/migrator.js';

/** Open an isolated in-memory database with the full schema applied. */
export function createMigratedMemoryDb(): DatabaseSync {
  const db = openDatabase(':memory:');
  runMigrations(db);
  return db;
}
