/**
 * Local provisioning command: create an API key for an existing application user.
 *
 * Usage:
 *   npm run api-key:create --workspace apps/api -- --email alice@example.com
 *
 * The command resolves the user by globally unique email, derives tenant_id and
 * user_id from the stored user record, generates a cryptographically random key,
 * persists only the hash and metadata, and prints the full plaintext key exactly
 * once. The key cannot be retrieved again.
 *
 * The caller never supplies tenant_id or user_id; ownership is always derived
 * from the stored user record.
 */

import { resolveDatabasePath } from '../config/database.js';
import { openDatabase } from '../database/connection.js';
import { runMigrations } from '../database/migrator.js';
import { UserRepository } from '../repositories/user-repository.js';
import { ApiKeyService } from '../auth/api-key-service.js';
import { normalizeEmail } from '../auth/auth-context.js';

function parseArgs(argv: string[]): { email: string | null; error: string | null } {
  const idx = argv.indexOf('--email');
  if (idx === -1 || idx + 1 >= argv.length) {
    return { email: null, error: 'Missing required --email argument.' };
  }
  const email = argv[idx + 1].trim();
  if (!email) {
    return { email: null, error: '--email must not be empty.' };
  }
  return { email, error: null };
}

async function main(): Promise<void> {
  const { email, error } = parseArgs(process.argv.slice(2));
  if (error || !email) {
    console.error(`Error: ${error ?? 'Missing --email.'}`);
    console.error('Usage: npm run api-key:create --workspace apps/api -- --email <email>');
    process.exit(1);
  }

  const dbPath = resolveDatabasePath();
  const db = openDatabase(dbPath);
  try {
    runMigrations(db);

    const users = new UserRepository(db);
    const normalized = normalizeEmail(email);
    const user = users.findByEmailForAuthentication(normalized);
    if (!user) {
      console.error(`Error: No user found with email "${email}".`);
      process.exit(1);
    }

    const apiKeyService = new ApiKeyService(db);
    const created = apiKeyService.create(user.tenantId, user.id);

    console.log('');
    console.log('API key created successfully.');
    console.log('');
    console.log(`  User:      ${user.displayName} <${user.email}>`);
    console.log(`  Tenant:    ${user.tenantId}`);
    console.log(`  Key ID:    ${created.keyId}`);
    console.log('');
    console.log('  Full API key (shown ONCE — cannot be retrieved again):');
    console.log('');
    console.log(`  ${created.fullKey}`);
    console.log('');
    console.log('  Store this key securely. Use it as: Authorization: Bearer <key>');
    console.log('  To revoke: npm run api-key:revoke --workspace apps/api -- --key-id ' + created.keyId);
    console.log('');
  } finally {
    db.close();
  }
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`Fatal: ${message}`);
  process.exit(1);
});
