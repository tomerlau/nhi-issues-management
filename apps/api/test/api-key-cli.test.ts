/**
 * Tests for CLI provisioning behavior, exercising runCreate and runRevoke
 * (the exported entry points of the CLI scripts) directly with isolated
 * in-memory databases.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { createMigratedMemoryDb, createSeededMemoryDb, DEMO_CREDENTIALS } from './helpers.js';
import { runCreate, validateEmail } from '../src/scripts/api-key-create.js';
import { runRevoke } from '../src/scripts/api-key-revoke.js';
import { ApiKeyService } from '../src/auth/api-key-service.js';

// ---------------------------------------------------------------------------
// CLI create: argument parsing
// ---------------------------------------------------------------------------

describe('CLI create: argument validation', () => {
  let db: DatabaseSync;

  beforeEach(async () => {
    db = await createSeededMemoryDb();
  });

  afterEach(() => {
    db.close();
  });

  it('throws for a missing --email argument', () => {
    expect(() => runCreate([], db)).toThrow('Missing required --email argument.');
  });

  it('throws for --email flag with no following value', () => {
    expect(() => runCreate(['--email'], db)).toThrow('Missing required --email argument.');
  });
});

// ---------------------------------------------------------------------------
// CLI create: email format validation
// ---------------------------------------------------------------------------

describe('CLI create: email format validation', () => {
  let db: DatabaseSync;

  beforeEach(async () => {
    db = await createSeededMemoryDb();
  });

  afterEach(() => {
    db.close();
  });

  it('throws for an email that is blank after trimming', () => {
    expect(() => runCreate(['--email', '   '], db)).toThrow('--email must not be empty.');
  });

  it('throws for an email that exceeds 254 characters', () => {
    const longEmail = 'a'.repeat(250) + '@b.com';
    expect(() => runCreate(['--email', longEmail], db)).toThrow(
      'Email address must not exceed 254 characters.',
    );
  });

  it('throws for a string with no @ character', () => {
    expect(() => runCreate(['--email', 'notanemail'], db)).toThrow('is not a valid email address');
  });

  it('throws for a string with @ at the very start', () => {
    expect(() => runCreate(['--email', '@nodomain.com'], db)).toThrow('is not a valid email address');
  });

  it('throws for a domain with no dot (localhost-style)', () => {
    expect(() => runCreate(['--email', 'user@localhost'], db)).toThrow('is not a valid email address');
  });

  it('throws for a domain with a trailing dot', () => {
    expect(() => runCreate(['--email', 'user@domain.'], db)).toThrow('is not a valid email address');
  });

  it('throws for multiple @ characters (a@b@c.com)', () => {
    expect(() => runCreate(['--email', 'a@b@c.com'], db)).toThrow('is not a valid email address');
  });

  it('throws for a missing domain (user@ with nothing after)', () => {
    expect(() => runCreate(['--email', 'user@'], db)).toThrow('is not a valid email address');
  });

  it('throws for a domain starting with a dot (user@.domain.com)', () => {
    expect(() => runCreate(['--email', 'user@.domain.com'], db)).toThrow('is not a valid email address');
  });

  it('email validation error is distinct from the "user not found" error', () => {
    let formatMsg = '';
    let notFoundMsg = '';
    try {
      runCreate(['--email', 'notvalid'], db);
    } catch (e) {
      formatMsg = (e as Error).message;
    }
    try {
      runCreate(['--email', 'nobody@example.com'], db);
    } catch (e) {
      notFoundMsg = (e as Error).message;
    }
    expect(formatMsg).not.toBe('');
    expect(notFoundMsg).not.toBe('');
    expect(formatMsg).not.toBe(notFoundMsg);
    expect(notFoundMsg).toContain('No user found');
    expect(formatMsg).not.toContain('No user found');
  });
});

// ---------------------------------------------------------------------------
// validateEmail unit tests
// ---------------------------------------------------------------------------

describe('CLI create: validateEmail', () => {
  it('trims whitespace and lowercases valid input', () => {
    expect(validateEmail('  Alice@Example.com  ')).toBe('alice@example.com');
  });

  it('rejects an empty string', () => {
    expect(() => validateEmail('')).toThrow('--email must not be empty.');
  });

  it('rejects whitespace-only input', () => {
    expect(() => validateEmail('   ')).toThrow('--email must not be empty.');
  });

  it('rejects input over 254 characters', () => {
    expect(() => validateEmail('a'.repeat(250) + '@b.com')).toThrow(
      'Email address must not exceed 254 characters.',
    );
  });

  it('rejects a string with embedded whitespace', () => {
    expect(() => validateEmail('alice @example.com')).toThrow('is not a valid email address');
  });

  it('rejects a string with no @ sign', () => {
    expect(() => validateEmail('notanemail')).toThrow('is not a valid email address');
  });

  it('rejects @ at position 0 (empty local part)', () => {
    expect(() => validateEmail('@domain.com')).toThrow('is not a valid email address');
  });

  it('rejects a domain with no dot', () => {
    expect(() => validateEmail('user@localhost')).toThrow('is not a valid email address');
  });

  it('rejects multiple @ characters', () => {
    expect(() => validateEmail('a@b@c.com')).toThrow('is not a valid email address');
  });

  it('rejects a missing domain (user@ with nothing after)', () => {
    expect(() => validateEmail('user@')).toThrow('is not a valid email address');
  });

  it('rejects a domain starting with a dot', () => {
    expect(() => validateEmail('user@.domain.com')).toThrow('is not a valid email address');
  });

  it('rejects a domain ending with a dot', () => {
    expect(() => validateEmail('user@domain.')).toThrow('is not a valid email address');
  });
});

// ---------------------------------------------------------------------------
// CLI create: unknown email
// ---------------------------------------------------------------------------

describe('CLI create: unknown email', () => {
  let db: DatabaseSync;

  beforeEach(async () => {
    db = await createSeededMemoryDb();
  });

  afterEach(() => {
    db.close();
  });

  it('throws with a user-facing "not found" message for an unknown email', () => {
    expect(() => runCreate(['--email', 'nobody@example.com'], db)).toThrow(
      'No user found with email "nobody@example.com".',
    );
  });
});

// ---------------------------------------------------------------------------
// CLI create: successful provisioning
// ---------------------------------------------------------------------------

describe('CLI create: successful provisioning', () => {
  let db: DatabaseSync;

  beforeEach(async () => {
    db = await createSeededMemoryDb();
  });

  afterEach(() => {
    db.close();
  });

  it('creates exactly one row in api_keys', () => {
    runCreate(['--email', DEMO_CREDENTIALS.acmeAlice.email], db);
    const rows = db.prepare('SELECT * FROM api_keys').all();
    expect(rows).toHaveLength(1);
  });

  it('the created row belongs to the correct tenant and user', () => {
    const result = runCreate(['--email', DEMO_CREDENTIALS.acmeAlice.email], db);
    const row = db
      .prepare('SELECT tenant_id, user_id FROM api_keys WHERE id = ?')
      .get(result.keyId) as { tenant_id: string; user_id: string } | undefined;
    expect(row?.tenant_id).toBe('tenant-acme');
    expect(row?.user_id).toBe('user-acme-alice');
  });

  it('returns the key ID and a full key matching the expected format', () => {
    const result = runCreate(['--email', DEMO_CREDENTIALS.acmeAlice.email], db);
    expect(result.keyId).toBeTruthy();
    expect(result.fullKey).toMatch(/^nhi_[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/);
  });

  it('the key ID is embedded in the full key', () => {
    const result = runCreate(['--email', DEMO_CREDENTIALS.acmeAlice.email], db);
    expect(result.fullKey).toContain(result.keyId);
  });

  it('the plaintext full key is absent from the stored database row', () => {
    const result = runCreate(['--email', DEMO_CREDENTIALS.acmeAlice.email], db);
    const row = db
      .prepare('SELECT * FROM api_keys WHERE id = ?')
      .get(result.keyId) as Record<string, string>;
    const rowValues = Object.values(row).join('|');
    expect(rowValues).not.toContain(result.fullKey);
    const dotIndex = result.fullKey.indexOf('.');
    const secret = result.fullKey.slice(dotIndex + 1);
    expect(rowValues).not.toContain(secret);
  });

  it('the provisioned key authenticates as the correct user', () => {
    const result = runCreate(['--email', DEMO_CREDENTIALS.acmeAlice.email], db);
    const apiKeyService = new ApiKeyService(db);
    const ctx = apiKeyService.authenticate(result.fullKey);
    expect(ctx?.userId).toBe('user-acme-alice');
    expect(ctx?.tenantId).toBe('tenant-acme');
  });

  it('accepts mixed-case and whitespace-padded email (normalizes before lookup)', () => {
    const result = runCreate(['--email', '  ALICE@EXAMPLE.COM  '], db);
    expect(result.userId).toBe('user-acme-alice');
    expect(result.tenantId).toBe('tenant-acme');
  });

  it('two successive creates produce different key IDs and full keys', () => {
    const a = runCreate(['--email', DEMO_CREDENTIALS.acmeAlice.email], db);
    const b = runCreate(['--email', DEMO_CREDENTIALS.acmeAlice.email], db);
    expect(a.keyId).not.toBe(b.keyId);
    expect(a.fullKey).not.toBe(b.fullKey);
  });
});

// ---------------------------------------------------------------------------
// CLI revoke: argument validation
// ---------------------------------------------------------------------------

describe('CLI revoke: argument validation', () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = createMigratedMemoryDb();
  });

  afterEach(() => {
    db.close();
  });

  it('throws for a missing --key-id argument', () => {
    expect(() => runRevoke([], db)).toThrow('Missing required --key-id argument.');
  });

  it('throws for --key-id flag with no following value', () => {
    expect(() => runRevoke(['--key-id'], db)).toThrow('Missing required --key-id argument.');
  });
});

// ---------------------------------------------------------------------------
// CLI revoke: revocation behavior
// ---------------------------------------------------------------------------

describe('CLI revoke: revocation behavior', () => {
  let db: DatabaseSync;

  beforeEach(async () => {
    db = await createSeededMemoryDb();
  });

  afterEach(() => {
    db.close();
  });

  it('deletes the row permanently', () => {
    const apiKeyService = new ApiKeyService(db);
    const { keyId } = apiKeyService.create('tenant-acme', 'user-acme-alice');

    runRevoke(['--key-id', keyId], db);

    const row = db.prepare('SELECT * FROM api_keys WHERE id = ?').get(keyId);
    expect(row).toBeUndefined();
  });

  it('returns deleted: true for an existing key', () => {
    const apiKeyService = new ApiKeyService(db);
    const { keyId } = apiKeyService.create('tenant-acme', 'user-acme-alice');

    const result = runRevoke(['--key-id', keyId], db);
    expect(result.deleted).toBe(true);
    expect(result.keyId).toBe(keyId);
  });

  it('is idempotent: returns deleted: false for an already-absent key', () => {
    const result = runRevoke(['--key-id', 'never-existed'], db);
    expect(result.deleted).toBe(false);
  });

  it('a second revoke call on the same key also returns deleted: false', () => {
    const apiKeyService = new ApiKeyService(db);
    const { keyId } = apiKeyService.create('tenant-acme', 'user-acme-alice');

    runRevoke(['--key-id', keyId], db);
    const second = runRevoke(['--key-id', keyId], db);
    expect(second.deleted).toBe(false);
  });

  it('revoked key cannot authenticate', () => {
    const apiKeyService = new ApiKeyService(db);
    const { keyId, fullKey } = apiKeyService.create('tenant-acme', 'user-acme-alice');

    runRevoke(['--key-id', keyId], db);

    expect(apiKeyService.authenticate(fullKey)).toBeNull();
  });

  it('no tombstone: revoked key is indistinguishable from an unknown key', () => {
    const apiKeyService = new ApiKeyService(db);
    const { keyId, fullKey } = apiKeyService.create('tenant-acme', 'user-acme-alice');
    runRevoke(['--key-id', keyId], db);

    // Both a revoked key and a completely unknown key return null.
    const unknownKey = 'nhi_' + 'x'.repeat(22) + '.' + 'a'.repeat(43);
    expect(apiKeyService.authenticate(fullKey)).toBeNull();
    expect(apiKeyService.authenticate(unknownKey)).toBeNull();
  });
});
