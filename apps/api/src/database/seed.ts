import { resolveDatabasePath } from '../config/database.js';
import { initializeDatabase } from './lifecycle.js';
import { seedDemoData } from './seed-data.js';

const databasePath = resolveDatabasePath();
const db = initializeDatabase(databasePath);
try {
  const result = seedDemoData(db);
  console.log(
    `[seed] ${databasePath}: created ${result.tenantsCreated} tenant(s) and ` +
      `${result.usersCreated} user(s); existing records left unchanged`,
  );
} finally {
  db.close();
}
