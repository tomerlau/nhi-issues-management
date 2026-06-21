import { resolveDatabasePath } from '../config/database.js';
import { openDatabase } from './connection.js';
import { runMigrations } from './migrator.js';

const databasePath = resolveDatabasePath();
const db = openDatabase(databasePath);
try {
  const applied = runMigrations(db);
  if (applied.length === 0) {
    console.log(`[migrate] database already up to date (${databasePath})`);
  } else {
    console.log(`[migrate] applied ${applied.length} migration(s) to ${databasePath}:`);
    for (const id of applied) {
      console.log(`[migrate]   ${id}`);
    }
  }
} finally {
  db.close();
}
