import { describe, expect, it } from 'vitest';
import { generateSessionToken, hashSessionToken } from '../src/auth/session-token.js';

describe('session tokens', () => {
  it('generates unique tokens with at least 256 bits of entropy', () => {
    const token = generateSessionToken();
    // 32 bytes encoded as URL-safe base64 (no padding) is 43 characters.
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    expect(generateSessionToken()).not.toBe(token);
  });

  it('hashes tokens deterministically as SHA-256 hex, distinct from the raw token', () => {
    const token = generateSessionToken();
    const hash = hashSessionToken(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(hashSessionToken(token));
    expect(hash).not.toBe(token);
  });
});
