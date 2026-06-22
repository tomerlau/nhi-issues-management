import { loadLocalEnv } from './dist/config/env.js';
import { resolveDatabasePath } from './dist/config/database.js';
import { resolveJiraEncryptionKey } from './dist/config/jira-crypto.js';
import { openDatabase } from './dist/database/connection.js';
import { JiraIntegrationService } from './dist/jira/jira-integration-service.js';

loadLocalEnv('apps/api/.env');

const encryptionKey = resolveJiraEncryptionKey();
if (!encryptionKey) {
  throw new Error('JIRA_CREDENTIAL_ENCRYPTION_KEY is required.');
}

const db = openDatabase(resolveDatabasePath());

try {
  const service = new JiraIntegrationService({
    db,
    encryptionKey,
    fetch,
  });

  const result = await service.validateProject(
    { userId: 'user-acme-alice', tenantId: 'tenant-acme' },
    'THIS_PROJECT_MUST_NOT_EXIST',
  );

  console.log(result);
} finally {
  db.close();
}
