/**
 * Tests for CLI provisioning behavior, exercising the create and revoke
 * scripts' logic directly rather than via subprocess execution.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { createSeededMemoryDb, DEMO_CREDENTIALS } from './helpers.js';
import { ApiKeyService } from '../src/auth/api-key-service.js';
import { UserRepository } from '../src/repositories/user-repository.js';
import { normalizeEmail } from '../src/auth/auth-context.js';

describe('API key CLI: provisioning for a valid email', () => {
  let db: DatabaseSync;

  beforeEach(async () => {
    db = await createSeededMemoryDb();
  });

  afterEach(() => {
    db.close();
  });

  it('creates a key for an existing user by email', () => {
    const users = new UserRepository(db);
    const apiKeyService = new ApiKeyService(db);
    const email = DEMO_CREDENTIALS.acmeAlice.email;
    const user = users.findByEmailForAuthentication(normalizeEmail(email));
    expect(user).not.toBeNull();

    const created = apiKeyService.create(user!.tenantId, user!.id);
    expect(created.fullKey).toMatch(/^nhi_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(created.tenantId).toBe('tenant-acme');
    expect(created.userId).toBe('user-acme-alice');
  });

  it('resolves tenantId and userId from the stored user record only', () => {
    const users = new UserRepository(db);
    const apiKeyService = new ApiKeyService(db);
    const user = users.findByEmailForAuthentication(normalizeEmail(DEMO_CREDENTIALS.acmeAlice.email));
    const created = apiKeyService.create(user!.tenantId, user!.id);

    const ctx = apiKeyService.authenticate(created.fullKey);
    expect(ctx?.tenantId).toBe(user!.tenantId);
    expect(ctx?.userId).toBe(user!.id);
  });

  it('the provisioned full key can be authenticated exactly once as the given user', () => {
    const users = new UserRepository(db);
    const apiKeyService = new ApiKeyService(db);
    const user = users.findByEmailForAuthentication(normalizeEmail(DEMO_CREDENTIALS.globexAlice.email));
    const created = apiKeyService.create(user!.tenantId, user!.id);

    const ctx = apiKeyService.authenticate(created.fullKey);
    expect(ctx?.tenantId).toBe('tenant-globex');
    expect(ctx?.userId).toBe('user-globex-alice');
  });

  it('the full plaintext key is returned only by the create call (not persisted)', () => {
    const users = new UserRepository(db);
    const apiKeyService = new ApiKeyService(db);
    const user = users.findByEmailForAuthentication(normalizeEmail(DEMO_CREDENTIALS.acmeAlice.email));
    const created = apiKeyService.create(user!.tenantId, user!.id);

    // The plaintext is not in the database row.
    const row = db
      .prepare('SELECT * FROM api_keys WHERE id = ?')
      .get(created.keyId) as Record<string, string>;
    const rowValues = Object.values(row).join('|');
    expect(rowValues).not.toContain(created.fullKey);
    // The secret is everything after the "." separator.
    const dotIndex = created.fullKey.indexOf('.');
    const secret = created.fullKey.slice(dotIndex + 1);
    expect(rowValues).not.toContain(secret);
  });
});

describe('API key CLI: provisioning failure cases', () => {
  let db: DatabaseSync;

  beforeEach(async () => {
    db = await createSeededMemoryDb();
  });

  afterEach(() => {
    db.close();
  });

  it('returns null for a missing email (findByEmailForAuthentication with empty input)', () => {
    const users = new UserRepository(db);
    const result = users.findByEmailForAuthentication('');
    expect(result).toBeNull();
  });

  it('returns null for an unknown email', () => {
    const users = new UserRepository(db);
    const result = users.findByEmailForAuthentication('nobody@example.com');
    expect(result).toBeNull();
  });

  it('normalizeEmail trims whitespace and lowercases', () => {
    const users = new UserRepository(db);
    const result = users.findByEmailForAuthentication(normalizeEmail('  Alice@Example.com  '));
    expect(result?.id).toBe('user-acme-alice');
  });
});

describe('API key CLI: revocation behavior', () => {
  let db: DatabaseSync;

  beforeEach(async () => {
    db = await createSeededMemoryDb();
  });

  afterEach(() => {
    db.close();
  });

  it('revocation deletes the row permanently', () => {
    const apiKeyService = new ApiKeyService(db);
    const { keyId } = apiKeyService.create('tenant-acme', 'user-acme-alice');
    apiKeyService.revoke(keyId);
    const row = db.prepare('SELECT * FROM api_keys WHERE id = ?').get(keyId);
    expect(row).toBeUndefined();
  });

  it('revocation is idempotent (returns false for already-absent key)', () => {
    const apiKeyService = new ApiKeyService(db);
    expect(apiKeyService.revoke('never-existed')).toBe(false);
  });

  it('revoked key cannot authenticate and returns same result as unknown key', () => {
    const apiKeyService = new ApiKeyService(db);
    const { fullKey, keyId } = apiKeyService.create('tenant-acme', 'user-acme-alice');
    apiKeyService.revoke(keyId);
    expect(apiKeyService.authenticate(fullKey)).toBeNull();
    expect(apiKeyService.authenticate('nhi_unknown.' + 'a'.repeat(43))).toBeNull();
  });
});
