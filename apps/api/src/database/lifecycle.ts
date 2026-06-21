import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from './connection.js';
import { runMigrations } from './migrator.js';

/**
 * Open a connection (with verified foreign-key enforcement) and bring it up to
 * the latest schema. Used by process startup and the migrate/seed scripts so
 * they all initialize the database the same way.
 */
export function initializeDatabase(location: string): DatabaseSync {
  const db = openDatabase(location);
  runMigrations(db);
  return db;
}
