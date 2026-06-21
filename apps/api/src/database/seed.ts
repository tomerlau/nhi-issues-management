import { resolveDatabasePath } from '../config/database.js';
import { initializeDatabase } from './lifecycle.js';
import { seedDemoData } from './seed-data.js';

const databasePath = resolveDatabasePath();
const db = initializeDatabase(databasePath);
try {
  const result = await seedDemoData(db);
  console.log(
    `[seed] ${databasePath}: created ${result.tenantsCreated} tenant(s), ` +
      `${result.usersCreated} user(s), and ${result.credentialsCreated} credential(s); ` +
      'existing records left unchanged',
  );
} finally {
  db.close();
}
