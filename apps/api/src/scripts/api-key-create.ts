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

import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { resolveDatabasePath } from '../config/database.js';
import { openDatabase } from '../database/connection.js';
import { runMigrations } from '../database/migrator.js';
import { UserRepository } from '../repositories/user-repository.js';
import { ApiKeyService } from '../auth/api-key-service.js';
import { normalizeEmail } from '../auth/auth-context.js';

export interface CreateResult {
  keyId: string;
  fullKey: string;
  userId: string;
  tenantId: string;
  userEmail: string;
  displayName: string;
}

function parseArgs(argv: string[]): { email: string | null; error: string | null } {
  const idx = argv.indexOf('--email');
  if (idx === -1 || idx + 1 >= argv.length) {
    return { email: null, error: 'Missing required --email argument.' };
  }
  return { email: argv[idx + 1], error: null };
}

/**
 * Validate and normalize a raw email string. Throws with a user-facing message
 * on format errors. Returns the lowercased, trimmed email on success.
 */
export function validateEmail(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error('--email must not be empty.');
  }
  if (trimmed.length > 254) {
    throw new Error('Email address must not exceed 254 characters.');
  }
  if (/\s/.test(trimmed)) {
    throw new Error(`"${trimmed}" is not a valid email address.`);
  }
  const atIndex = trimmed.indexOf('@');
  if (atIndex <= 0) {
    throw new Error(`"${trimmed}" is not a valid email address.`);
  }
  const domain = trimmed.slice(atIndex + 1);
  if (!domain || !domain.includes('.') || domain.startsWith('.') || domain.endsWith('.')) {
    throw new Error(`"${trimmed}" is not a valid email address.`);
  }
  return normalizeEmail(trimmed);
}

/**
 * Core create logic. Accepts parsed argv and an open database. Throws on any
 * validation or lookup failure. Returns key details on success.
 */
export function runCreate(argv: string[], db: DatabaseSync): CreateResult {
  const { email: rawEmail, error: argError } = parseArgs(argv);
  if (argError !== null || rawEmail === null) {
    throw new Error(argError ?? 'Missing --email.');
  }

  const normalized = validateEmail(rawEmail);

  const users = new UserRepository(db);
  const user = users.findByEmailForAuthentication(normalized);
  if (!user) {
    throw new Error(`No user found with email "${rawEmail.trim()}".`);
  }

  const apiKeyService = new ApiKeyService(db);
  const created = apiKeyService.create(user.tenantId, user.id);

  return {
    keyId: created.keyId,
    fullKey: created.fullKey,
    userId: user.id,
    tenantId: user.tenantId,
    userEmail: user.email,
    displayName: user.displayName,
  };
}

async function main(): Promise<void> {
  const dbPath = resolveDatabasePath();
  const db = openDatabase(dbPath);
  try {
    runMigrations(db);
    let result: CreateResult;
    try {
      result = runCreate(process.argv.slice(2), db);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Error: ${message}`);
      if (message === 'Missing required --email argument.') {
        console.error('Usage: npm run api-key:create --workspace apps/api -- --email <email>');
      }
      process.exit(1);
    }

    console.log('');
    console.log('API key created successfully.');
    console.log('');
    console.log(`  User:      ${result.displayName} <${result.userEmail}>`);
    console.log(`  Tenant:    ${result.tenantId}`);
    console.log(`  Key ID:    ${result.keyId}`);
    console.log('');
    console.log('  Full API key (shown ONCE — cannot be retrieved again):');
    console.log('');
    console.log(`  ${result.fullKey}`);
    console.log('');
    console.log('  Store this key securely. Use it as: Authorization: Bearer <key>');
    console.log('  To revoke: npm run api-key:revoke --workspace apps/api -- --key-id ' + result.keyId);
    console.log('');
  } finally {
    db.close();
  }
}

// Only run when this file is the direct entry point, not when imported in tests.
if (resolve(process.argv[1] ?? '') === resolve(fileURLToPath(import.meta.url))) {
  main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Fatal: ${message}`);
    process.exit(1);
  });
}
