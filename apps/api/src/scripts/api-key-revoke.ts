/**
 * Local revocation command: revoke (physically delete) an API key by its public
 * key ID.
 *
 * Usage:
 *   npm run api-key:revoke --workspace apps/api -- --key-id <key-id>
 *
 * Revocation physically deletes the database row. No tombstone, revoked_at value,
 * secret hash, or audit history is retained. After revocation the key ID is
 * permanently indistinguishable from an unknown key, and any further authentication
 * attempts with it return the same generic 401 as an unknown key.
 *
 * The command is idempotent: revoking a key that was already revoked (or was
 * never created) reports a clear non-sensitive result rather than failing.
 */

import { resolveDatabasePath } from '../config/database.js';
import { openDatabase } from '../database/connection.js';
import { runMigrations } from '../database/migrator.js';
import { ApiKeyService } from '../auth/api-key-service.js';

function parseArgs(argv: string[]): { keyId: string | null; error: string | null } {
  const idx = argv.indexOf('--key-id');
  if (idx === -1 || idx + 1 >= argv.length) {
    return { keyId: null, error: 'Missing required --key-id argument.' };
  }
  const keyId = argv[idx + 1].trim();
  if (!keyId) {
    return { keyId: null, error: '--key-id must not be empty.' };
  }
  return { keyId, error: null };
}

async function main(): Promise<void> {
  const { keyId, error } = parseArgs(process.argv.slice(2));
  if (error || !keyId) {
    console.error(`Error: ${error ?? 'Missing --key-id.'}`);
    console.error('Usage: npm run api-key:revoke --workspace apps/api -- --key-id <key-id>');
    process.exit(1);
  }

  const dbPath = resolveDatabasePath();
  const db = openDatabase(dbPath);
  try {
    runMigrations(db);

    const apiKeyService = new ApiKeyService(db);
    const deleted = apiKeyService.revoke(keyId);

    if (deleted) {
      console.log('');
      console.log(`API key revoked.`);
      console.log(`  Key ID: ${keyId}`);
      console.log('  The row has been permanently deleted. Any further authentication');
      console.log('  attempts with this key will return a generic 401.');
      console.log('');
    } else {
      console.log('');
      console.log(`API key not found.`);
      console.log(`  Key ID: ${keyId}`);
      console.log('  No row matched this key ID. It may have already been revoked or');
      console.log('  was never created.');
      console.log('');
    }
  } finally {
    db.close();
  }
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`Fatal: ${message}`);
  process.exit(1);
});
