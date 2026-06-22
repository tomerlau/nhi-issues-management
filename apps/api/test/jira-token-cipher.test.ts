import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  decryptToken,
  encryptToken,
  type CredentialContext,
} from '../src/jira/token-cipher.js';

const key = randomBytes(32);
const tenant: CredentialContext = { tenantId: 'tenant-acme' };
const plaintext = 'super-secret-jira-api-token';

describe('jira token cipher (v2, tenant-only)', () => {
  it('round-trips a token with the same key and tenant context', () => {
    const serialized = encryptToken(plaintext, key, tenant);
    expect(serialized).toMatch(/^v2\./);
    expect(decryptToken(serialized, key, tenant)).toBe(plaintext);
  });

  it('produces different ciphertext for the same plaintext (random nonce)', () => {
    const a = encryptToken(plaintext, key, tenant);
    const b = encryptToken(plaintext, key, tenant);
    expect(a).not.toBe(b);
    expect(decryptToken(a, key, tenant)).toBe(plaintext);
    expect(decryptToken(b, key, tenant)).toBe(plaintext);
  });

  it('decrypts successfully for the same tenant', () => {
    const serialized = encryptToken(plaintext, key, { tenantId: 'tenant-acme' });
    expect(decryptToken(serialized, key, { tenantId: 'tenant-acme' })).toBe(plaintext);
  });

  it('fails to decrypt under a different tenant (AAD mismatch)', () => {
    const serialized = encryptToken(plaintext, key, tenant);
    expect(() => decryptToken(serialized, key, { tenantId: 'tenant-globex' })).toThrow();
  });

  it('fails to decrypt with the wrong key', () => {
    const serialized = encryptToken(plaintext, key, tenant);
    expect(() => decryptToken(serialized, randomBytes(32), tenant)).toThrow();
  });

  it('rejects a malformed ciphertext', () => {
    expect(() => decryptToken('not-a-valid-payload', key, tenant)).toThrow();
    expect(() => decryptToken('v2.only.three', key, tenant)).toThrow();
  });

  it('rejects a tampered ciphertext body', () => {
    const serialized = encryptToken(plaintext, key, tenant);
    const parts = serialized.split('.');
    const ct = parts[2];
    parts[2] = ct.slice(0, -1) + (ct.endsWith('A') ? 'B' : 'A');
    expect(() => decryptToken(parts.join('.'), key, tenant)).toThrow();
  });

  it('rejects an unsupported ciphertext version', () => {
    const serialized = encryptToken(plaintext, key, tenant);
    const tampered = serialized.replace(/^v2\./, 'v3.');
    expect(() => decryptToken(tampered, key, tenant)).toThrow(/version/i);
  });

  it('rejects v1 ciphertext as an unsupported version', () => {
    // A v1-shaped payload (the removed legacy format) must not decrypt under v2.
    const serialized = encryptToken(plaintext, key, tenant);
    const asV1 = serialized.replace(/^v2\./, 'v1.');
    expect(() => decryptToken(asV1, key, tenant)).toThrow(/version/i);
  });

  it('binds the AAD to the tenant unambiguously even when ids contain delimiters', () => {
    // A field value that contains JSON or delimiter characters must not be able
    // to forge the tenant boundary; distinct tenant ids stay distinct.
    const first: CredentialContext = { tenantId: 'a","b' };
    const second: CredentialContext = { tenantId: 'a' };
    const serialized = encryptToken(plaintext, key, first);
    expect(decryptToken(serialized, key, first)).toBe(plaintext);
    expect(() => decryptToken(serialized, key, second)).toThrow();
  });

  it('does not contain the plaintext in the serialized output', () => {
    const serialized = encryptToken(plaintext, key, tenant);
    expect(serialized).not.toContain(plaintext);
  });

  it('rejects a key that is not 32 bytes', () => {
    expect(() => encryptToken(plaintext, randomBytes(16), tenant)).toThrow();
  });

  it('does not accept or require configuredByUserId in the cipher API', () => {
    // The credential context is tenant-only. A configuredByUserId field on the
    // context object is ignored: decryption depends solely on tenantId.
    const serialized = encryptToken(plaintext, key, { tenantId: 'tenant-acme' });
    const withStrayUserField = {
      tenantId: 'tenant-acme',
      configuredByUserId: 'user-acme-bob',
    } as unknown as CredentialContext;
    expect(decryptToken(serialized, key, withStrayUserField)).toBe(plaintext);
  });
});
