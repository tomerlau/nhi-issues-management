import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { createMigratedMemoryDb } from './helpers.js';
import { ApiKeyService } from '../src/auth/api-key-service.js';

const TENANT_ID = 't-acme';
const USER_ID = 'u-alice';

describe('ApiKeyService', () => {
  let db: DatabaseSync;
  let service: ApiKeyService;

  beforeEach(() => {
    db = createMigratedMemoryDb();
    db.exec(`
      INSERT INTO tenants (id, name, created_at) VALUES
        ('t-acme', 'Acme', '2026-01-01T00:00:00.000Z'),
        ('t-globex', 'Globex', '2026-01-01T00:00:00.000Z');
      INSERT INTO users (id, tenant_id, email, display_name, created_at) VALUES
        ('u-alice', 't-acme', 'alice@test.com', 'Alice', '2026-01-01T00:00:00.000Z'),
        ('u-globex', 't-globex', 'globex@test.com', 'Globex User', '2026-01-01T00:00:00.000Z');
    `);
    service = new ApiKeyService(db);
  });

  afterEach(() => {
    db.close();
  });

  describe('create', () => {
    it('returns keyId, fullKey, tenantId, userId', () => {
      const result = service.create(TENANT_ID, USER_ID);
      expect(result.keyId).toBeTruthy();
      expect(result.fullKey).toMatch(/^nhi_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
      expect(result.tenantId).toBe(TENANT_ID);
      expect(result.userId).toBe(USER_ID);
    });

    it('two calls produce different full keys', () => {
      const a = service.create(TENANT_ID, USER_ID);
      const b = service.create(TENANT_ID, USER_ID);
      expect(a.fullKey).not.toBe(b.fullKey);
      expect(a.keyId).not.toBe(b.keyId);
    });

    it('does not persist a plaintext secret in the database', () => {
      const { keyId, fullKey } = service.create(TENANT_ID, USER_ID);
      const row = db.prepare('SELECT * FROM api_keys WHERE id = ?').get(keyId) as Record<string, string>;
      // The full key and the secret part must never appear in the stored row.
      const rowValues = Object.values(row).join('|');
      expect(rowValues).not.toContain(fullKey);
      // The secret is everything after the dot separator.
      const dotIndex = fullKey.indexOf('.');
      const secret = fullKey.slice(dotIndex + 1);
      expect(rowValues).not.toContain(secret);
    });
  });

  describe('authenticate', () => {
    it('authenticates a valid key and returns the correct AuthContext', () => {
      const { fullKey } = service.create(TENANT_ID, USER_ID);
      const ctx = service.authenticate(fullKey);
      expect(ctx).not.toBeNull();
      expect(ctx?.userId).toBe(USER_ID);
      expect(ctx?.tenantId).toBe(TENANT_ID);
    });

    it('resolves keys belonging to different tenants independently', () => {
      const acmeKey = service.create('t-acme', 'u-alice');
      const globexKey = service.create('t-globex', 'u-globex');

      const acmeCtx = service.authenticate(acmeKey.fullKey);
      const globexCtx = service.authenticate(globexKey.fullKey);

      expect(acmeCtx?.tenantId).toBe('t-acme');
      expect(acmeCtx?.userId).toBe('u-alice');
      expect(globexCtx?.tenantId).toBe('t-globex');
      expect(globexCtx?.userId).toBe('u-globex');
    });

    it('returns null for an unknown key ID', () => {
      expect(service.authenticate('nhi_unknownid.' + 'a'.repeat(43))).toBeNull();
    });

    it('returns null for a missing Authorization prefix (malformed format)', () => {
      expect(service.authenticate('')).toBeNull();
    });

    it('returns null for a key with a wrong scheme (no nhi_ prefix)', () => {
      expect(service.authenticate('sk_abc_def')).toBeNull();
    });

    it('returns null for a malformed key (too few segments)', () => {
      expect(service.authenticate('nhi_onlyone')).toBeNull();
    });

    it('returns null for a correct key ID with a wrong secret', () => {
      const { keyId } = service.create(TENANT_ID, USER_ID);
      const wrongSecret = 'a'.repeat(43);
      expect(service.authenticate(`nhi_${keyId}.${wrongSecret}`)).toBeNull();
    });

    it('returns null for a deleted key', () => {
      const { fullKey, keyId } = service.create(TENANT_ID, USER_ID);
      service.revoke(keyId);
      expect(service.authenticate(fullKey)).toBeNull();
    });

    it('ownership from stored record cannot be overridden by request input', () => {
      // This test demonstrates that authenticate() derives identity entirely from
      // the stored record. The key always resolves to its stored tenant/user regardless
      // of what the caller submits elsewhere in the request.
      const { fullKey } = service.create(TENANT_ID, USER_ID);
      const ctx = service.authenticate(fullKey);
      expect(ctx?.tenantId).toBe(TENANT_ID);
      expect(ctx?.userId).toBe(USER_ID);
      // A globex key cannot resolve as an acme user.
      const globexKey = service.create('t-globex', 'u-globex');
      const globexCtx = service.authenticate(globexKey.fullKey);
      expect(globexCtx?.tenantId).not.toBe('t-acme');
    });
  });

  describe('revoke', () => {
    it('returns true and prevents further authentication', () => {
      const { fullKey, keyId } = service.create(TENANT_ID, USER_ID);
      expect(service.authenticate(fullKey)).not.toBeNull();

      const deleted = service.revoke(keyId);
      expect(deleted).toBe(true);
      expect(service.authenticate(fullKey)).toBeNull();
    });

    it('returns false for an already-absent key ID (idempotent)', () => {
      expect(service.revoke('never-existed')).toBe(false);
    });

    it('revoked key returns null, same as an unknown key', () => {
      const { fullKey, keyId } = service.create(TENANT_ID, USER_ID);
      service.revoke(keyId);
      // Both a deleted key and a never-existed key return null.
      expect(service.authenticate(fullKey)).toBeNull();
      expect(service.authenticate('nhi_doesnotexist.' + 'b'.repeat(43))).toBeNull();
    });

    it('deletes the row from the database permanently', () => {
      const { keyId } = service.create(TENANT_ID, USER_ID);
      service.revoke(keyId);
      const row = db.prepare('SELECT * FROM api_keys WHERE id = ?').get(keyId);
      expect(row).toBeUndefined();
    });
  });
});
