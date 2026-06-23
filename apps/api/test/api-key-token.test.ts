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

describe('API key token: strict format enforcement', () => {
  it('returns null when keyId is too short (< 22 chars)', () => {
    // 21-char keyId, valid 43-char secret.
    expect(parseApiKey('nhi_' + 'a'.repeat(21) + '.' + 'b'.repeat(43))).toBeNull();
  });

  it('returns null when keyId is too long (> 22 chars)', () => {
    expect(parseApiKey('nhi_' + 'a'.repeat(23) + '.' + 'b'.repeat(43))).toBeNull();
  });

  it('returns null when secret is too short (< 43 chars)', () => {
    expect(parseApiKey('nhi_' + 'a'.repeat(22) + '.' + 'b'.repeat(42))).toBeNull();
  });

  it('returns null when secret is too long (> 43 chars)', () => {
    expect(parseApiKey('nhi_' + 'a'.repeat(22) + '.' + 'b'.repeat(44))).toBeNull();
  });

  it('returns null when keyId contains an invalid character (+)', () => {
    const validSecret = 'b'.repeat(43);
    // Replace one char in the 22-char keyId with '+'.
    const badKeyId = 'a'.repeat(21) + '+';
    expect(parseApiKey('nhi_' + badKeyId + '.' + validSecret)).toBeNull();
  });

  it('returns null when keyId contains an invalid character (/)', () => {
    const badKeyId = 'a'.repeat(21) + '/';
    expect(parseApiKey('nhi_' + badKeyId + '.' + 'b'.repeat(43))).toBeNull();
  });

  it('returns null when secret contains an invalid character (+)', () => {
    const badSecret = 'b'.repeat(42) + '+';
    expect(parseApiKey('nhi_' + 'a'.repeat(22) + '.' + badSecret)).toBeNull();
  });

  it('returns null when keyId contains base64 padding (=)', () => {
    const paddedKeyId = 'a'.repeat(20) + '==';
    expect(parseApiKey('nhi_' + paddedKeyId + '.' + 'b'.repeat(43))).toBeNull();
  });

  it('returns null when secret contains base64 padding (=)', () => {
    const paddedSecret = 'b'.repeat(41) + '==';
    expect(parseApiKey('nhi_' + 'a'.repeat(22) + '.' + paddedSecret)).toBeNull();
  });

  it('returns null when keyId contains whitespace', () => {
    const spaceKeyId = 'a'.repeat(21) + ' ';
    expect(parseApiKey('nhi_' + spaceKeyId + '.' + 'b'.repeat(43))).toBeNull();
  });

  it('accepts exactly 22-char keyId and 43-char secret with valid charset', () => {
    // Construct a key that matches the required format but is not in the DB.
    const validKey = 'nhi_' + 'a'.repeat(22) + '.' + 'b'.repeat(43);
    const parsed = parseApiKey(validKey);
    expect(parsed).not.toBeNull();
    expect(parsed?.keyId).toHaveLength(22);
    expect(parsed?.secret).toHaveLength(43);
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
