import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const IN_MEMORY = ':memory:';

/**
 * Open a SQLite connection with foreign-key enforcement enabled and verified.
 *
 * Foreign keys are a per-connection PRAGMA in SQLite, so every connection the
 * application creates must pass through this factory. The verification step
 * fails fast if enforcement could not be turned on, rather than silently
 * running without referential integrity.
 */
export function openDatabase(location: string): DatabaseSync {
  if (location !== IN_MEMORY) {
    fs.mkdirSync(path.dirname(location), { recursive: true });
  }

  const db = new DatabaseSync(location);
  db.exec('PRAGMA foreign_keys = ON');

  const row = db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number } | undefined;
  if (row?.foreign_keys !== 1) {
    db.close();
    throw new Error('SQLite foreign key enforcement could not be enabled');
  }

  return db;
}
