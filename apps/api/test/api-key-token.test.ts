import { describe, expect, it } from 'vitest';
import {
  generateApiKeyComponents,
  parseApiKey,
  hashApiKeySecret,
  verifyApiKeySecret,
} from '../src/auth/api-key-token.js';

describe('API key token: generation', () => {
  it('generates a key starting with nhi_ followed by keyId.secret', () => {
    const { fullKey } = generateApiKeyComponents();
    // Format: nhi_<base64url-keyId>.<base64url-secret>
    expect(fullKey).toMatch(/^nhi_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(fullKey.startsWith('nhi_')).toBe(true);
  });

  it('generated keyId and secret are base64url-safe (no +, /)', () => {
    for (let i = 0; i < 20; i++) {
      const { keyId, secret } = generateApiKeyComponents();
      expect(keyId).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(secret).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it('secret carries at least 256 bits of entropy (32+ bytes in base64url)', () => {
    // 32 random bytes → 43 base64url chars (no padding).
    const { secret } = generateApiKeyComponents();
    const decoded = Buffer.from(secret, 'base64url');
    expect(decoded.length).toBeGreaterThanOrEqual(32);
  });

  it('two provisioning operations produce different keys', () => {
    const first = generateApiKeyComponents();
    const second = generateApiKeyComponents();
    expect(first.keyId).not.toBe(second.keyId);
    expect(first.secret).not.toBe(second.secret);
    expect(first.fullKey).not.toBe(second.fullKey);
  });

  it('generates 20 unique full keys', () => {
    const keys = new Set(Array.from({ length: 20 }, () => generateApiKeyComponents().fullKey));
    expect(keys.size).toBe(20);
  });
});

describe('API key token: parsing', () => {
  it('parses a valid key into keyId and secret', () => {
    const { keyId, secret, fullKey } = generateApiKeyComponents();
    const parsed = parseApiKey(fullKey);
    expect(parsed).not.toBeNull();
    expect(parsed?.keyId).toBe(keyId);
    expect(parsed?.secret).toBe(secret);
  });

  it('returns null for a missing prefix', () => {
    expect(parseApiKey('wrongprefix_abc.def')).toBeNull();
  });

  it('returns null for a key with no dot separator', () => {
    expect(parseApiKey('nhi_abcdef')).toBeNull();
  });

  it('returns null for a key with an empty keyId (dot immediately after prefix)', () => {
    expect(parseApiKey('nhi_.secret')).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(parseApiKey('')).toBeNull();
  });

  it('returns null for a Bearer-prefixed string (header not stripped)', () => {
    const { fullKey } = generateApiKeyComponents();
    expect(parseApiKey(`Bearer ${fullKey}`)).toBeNull();
  });

  it('returns null for a key with an empty secret', () => {
    expect(parseApiKey('nhi_keyid.')).toBeNull();
  });

  it('returns null for a key with multiple dots in the body', () => {
    // A second "." in the secret would indicate a malformed key.
    expect(parseApiKey('nhi_keyid.part1.part2')).toBeNull();
  });
});

describe('API key token: hashing and verification', () => {
  it('hashApiKeySecret returns a 64-char hex string (SHA-256)', () => {
    const hash = hashApiKeySecret('some-secret');
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[0-9a-f]+$/);
  });

  it('verifyApiKeySecret returns true for a matching secret', () => {
    const secret = 'test-secret-value';
    const hash = hashApiKeySecret(secret);
    expect(verifyApiKeySecret(secret, hash)).toBe(true);
  });

  it('verifyApiKeySecret returns false for a wrong secret', () => {
    const hash = hashApiKeySecret('correct-secret');
    expect(verifyApiKeySecret('wrong-secret', hash)).toBe(false);
  });

  it('verifyApiKeySecret returns false for an empty string vs a real hash', () => {
    const hash = hashApiKeySecret('nonempty');
    expect(verifyApiKeySecret('', hash)).toBe(false);
  });

  it('verifyApiKeySecret returns false for a corrupted/malformed hash', () => {
    // A non-hex stored value decodes to wrong length bytes.
    expect(verifyApiKeySecret('any-secret', 'not-a-hex-hash')).toBe(false);
  });

  it('plaintext secret does not appear in the stored hash', () => {
    const secret = 'super-secret-value';
    const hash = hashApiKeySecret(secret);
    expect(hash).not.toContain(secret);
    expect(hash).not.toContain('super');
  });
});
