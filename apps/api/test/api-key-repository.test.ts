import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { createMigratedMemoryDb } from './helpers.js';
import { ApiKeyRepository } from '../src/repositories/api-key-repository.js';

describe('ApiKeyRepository', () => {
  let db: DatabaseSync;
  let repo: ApiKeyRepository;

  beforeEach(() => {
    db = createMigratedMemoryDb();
    // Seed a tenant and two users.
    db.exec(`
      INSERT INTO tenants (id, name, created_at) VALUES
        ('t-acme', 'Acme', '2026-01-01T00:00:00.000Z'),
        ('t-globex', 'Globex', '2026-01-01T00:00:00.000Z');
      INSERT INTO users (id, tenant_id, email, display_name, created_at) VALUES
        ('u-alice', 't-acme', 'alice@test.com', 'Alice', '2026-01-01T00:00:00.000Z'),
        ('u-globex', 't-globex', 'globex@test.com', 'Globex Alice', '2026-01-01T00:00:00.000Z');
    `);
    repo = new ApiKeyRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  describe('create', () => {
    it('creates and returns the api key record', () => {
      const key = repo.create({
        id: 'key-1',
        tenantId: 't-acme',
        userId: 'u-alice',
        secretHash: 'hash-abc',
      });
      expect(key.id).toBe('key-1');
      expect(key.tenantId).toBe('t-acme');
      expect(key.userId).toBe('u-alice');
      expect(key.secretHash).toBe('hash-abc');
      expect(key.createdAt).toBeTruthy();
    });

    it('stores the hash, never the plaintext secret', () => {
      repo.create({ id: 'key-2', tenantId: 't-acme', userId: 'u-alice', secretHash: 'stored-hash' });
      const row = db.prepare('SELECT * FROM api_keys WHERE id = ?').get('key-2') as Record<string, string>;
      expect(Object.keys(row)).not.toContain('secret');
      expect(Object.keys(row)).not.toContain('plaintext');
      expect(row['secret_hash']).toBe('stored-hash');
    });

    it('rejects a key for a non-existent tenant/user pair', () => {
      expect(() =>
        repo.create({ id: 'bad-key', tenantId: 't-acme', userId: 'u-nobody', secretHash: 'h' }),
      ).toThrow();
    });

    it('rejects a duplicate key ID', () => {
      repo.create({ id: 'dup', tenantId: 't-acme', userId: 'u-alice', secretHash: 'h1' });
      expect(() =>
        repo.create({ id: 'dup', tenantId: 't-acme', userId: 'u-alice', secretHash: 'h2' }),
      ).toThrow();
    });

    it('allows two keys for the same user', () => {
      repo.create({ id: 'k1', tenantId: 't-acme', userId: 'u-alice', secretHash: 'h1' });
      repo.create({ id: 'k2', tenantId: 't-acme', userId: 'u-alice', secretHash: 'h2' });
      const count = db.prepare('SELECT count(*) as n FROM api_keys').get() as { n: number };
      expect(count.n).toBe(2);
    });
  });

  describe('findById', () => {
    it('returns the key when it exists', () => {
      repo.create({ id: 'key-x', tenantId: 't-acme', userId: 'u-alice', secretHash: 'hx' });
      const found = repo.findById('key-x');
      expect(found).not.toBeNull();
      expect(found?.tenantId).toBe('t-acme');
      expect(found?.userId).toBe('u-alice');
      expect(found?.secretHash).toBe('hx');
    });

    it('returns null for an unknown key ID', () => {
      expect(repo.findById('does-not-exist')).toBeNull();
    });

    it('correctly resolves keys belonging to different tenants', () => {
      repo.create({ id: 'k-acme', tenantId: 't-acme', userId: 'u-alice', secretHash: 'h1' });
      repo.create({ id: 'k-globex', tenantId: 't-globex', userId: 'u-globex', secretHash: 'h2' });
      expect(repo.findById('k-acme')?.tenantId).toBe('t-acme');
      expect(repo.findById('k-globex')?.tenantId).toBe('t-globex');
    });
  });

  describe('deleteById', () => {
    it('deletes the row and returns true', () => {
      repo.create({ id: 'to-delete', tenantId: 't-acme', userId: 'u-alice', secretHash: 'h' });
      expect(repo.deleteById('to-delete')).toBe(true);
      expect(repo.findById('to-delete')).toBeNull();
    });

    it('returns false for an already-absent key (idempotent)', () => {
      expect(repo.deleteById('never-existed')).toBe(false);
    });

    it('deleting one key does not affect another', () => {
      repo.create({ id: 'ka', tenantId: 't-acme', userId: 'u-alice', secretHash: 'h1' });
      repo.create({ id: 'kb', tenantId: 't-acme', userId: 'u-alice', secretHash: 'h2' });
      repo.deleteById('ka');
      expect(repo.findById('kb')).not.toBeNull();
    });
  });
});
