import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  decryptToken,
  encryptToken,
  type CredentialContext,
} from '../src/jira/token-cipher.js';

const key = randomBytes(32);
const owner: CredentialContext = { tenantId: 'tenant-acme', userId: 'user-acme-alice' };
const plaintext = 'super-secret-jira-api-token';

describe('jira token cipher', () => {
  it('round-trips a token with the same key and ownership context', () => {
    const serialized = encryptToken(plaintext, key, owner);
    expect(decryptToken(serialized, key, owner)).toBe(plaintext);
  });

  it('produces different ciphertext for the same plaintext (random nonce)', () => {
    const a = encryptToken(plaintext, key, owner);
    const b = encryptToken(plaintext, key, owner);
    expect(a).not.toBe(b);
    // Both still decrypt back to the same plaintext.
    expect(decryptToken(a, key, owner)).toBe(plaintext);
    expect(decryptToken(b, key, owner)).toBe(plaintext);
  });

  it('fails to decrypt with the wrong key', () => {
    const serialized = encryptToken(plaintext, key, owner);
    expect(() => decryptToken(serialized, randomBytes(32), owner)).toThrow();
  });

  it('fails to decrypt under a different ownership context (AAD mismatch)', () => {
    const serialized = encryptToken(plaintext, key, owner);
    const otherUser: CredentialContext = { tenantId: 'tenant-acme', userId: 'user-acme-bob' };
    const otherTenant: CredentialContext = { tenantId: 'tenant-globex', userId: 'user-acme-alice' };
    expect(() => decryptToken(serialized, key, otherUser)).toThrow();
    expect(() => decryptToken(serialized, key, otherTenant)).toThrow();
  });

  it('cannot move a ciphertext to another user and decrypt it', () => {
    // Encrypt for alice, attempt to read it as bob with the same key.
    const serialized = encryptToken(plaintext, key, owner);
    const bob: CredentialContext = { tenantId: 'tenant-acme', userId: 'user-acme-bob' };
    expect(() => decryptToken(serialized, key, bob)).toThrow();
  });

  it('rejects a malformed ciphertext', () => {
    expect(() => decryptToken('not-a-valid-payload', key, owner)).toThrow();
    expect(() => decryptToken('v1.only.three', key, owner)).toThrow();
  });

  it('rejects an unsupported ciphertext version', () => {
    const serialized = encryptToken(plaintext, key, owner);
    const tampered = serialized.replace(/^v1\./, 'v2.');
    expect(() => decryptToken(tampered, key, owner)).toThrow(/version/i);
  });

  it('rejects a tampered ciphertext body', () => {
    const serialized = encryptToken(plaintext, key, owner);
    const parts = serialized.split('.');
    // Flip a character in the ciphertext segment.
    const ct = parts[2];
    parts[2] = ct.slice(0, -1) + (ct.endsWith('A') ? 'B' : 'A');
    expect(() => decryptToken(parts.join('.'), key, owner)).toThrow();
  });

  it('does not contain the plaintext in the serialized output', () => {
    const serialized = encryptToken(plaintext, key, owner);
    expect(serialized).not.toContain(plaintext);
  });

  it('rejects a key that is not 32 bytes', () => {
    expect(() => encryptToken(plaintext, randomBytes(16), owner)).toThrow();
  });
});
