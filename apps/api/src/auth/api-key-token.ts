import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * API key format: nhi_<keyId>.<secret>
 *
 * keyId:  16 random bytes (128 bits) as base64url — the public selector stored
 *         in the database, used to locate the key record without exposing the
 *         secret.
 * secret: 32 random bytes (256 bits) as base64url — the high-entropy secret
 *         that is never stored in plaintext. Only its SHA-256 hash is persisted.
 *
 * The separator between keyId and secret is "." which is NOT in the base64url
 * alphabet ([A-Za-z0-9\-_]), making the format unambiguously parseable even
 * when the keyId or secret contain underscores or hyphens.
 *
 * The full key is shown exactly once during provisioning and cannot be
 * recovered from the stored hash.
 */
const KEY_PREFIX = 'nhi_';
const KEY_ID_BYTES = 16;
const SECRET_BYTES = 32;
// 16 raw bytes → 22 base64url chars (no padding); 32 raw bytes → 43 base64url chars.
const KEY_ID_BASE64URL_LEN = 22;
const SECRET_BASE64URL_LEN = 43;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

export interface ParsedApiKey {
  keyId: string;
  secret: string;
}

/** Generate a new key pair and the full formatted key string. */
export function generateApiKeyComponents(): { keyId: string; secret: string; fullKey: string } {
  const keyId = randomBytes(KEY_ID_BYTES).toString('base64url');
  const secret = randomBytes(SECRET_BYTES).toString('base64url');
  // "." is not in the base64url alphabet, so it is an unambiguous separator.
  const fullKey = `${KEY_PREFIX}${keyId}.${secret}`;
  return { keyId, secret, fullKey };
}

/**
 * Parse a raw key string into its public keyId and secret. Returns null for
 * any input that does not match the nhi_<keyId>.<secret> structure.
 *
 * "." is not in the base64url alphabet, so it appears exactly once as the
 * separator between keyId and secret regardless of their content.
 */
export function parseApiKey(rawKey: string): ParsedApiKey | null {
  if (!rawKey.startsWith(KEY_PREFIX)) {
    return null;
  }
  const body = rawKey.slice(KEY_PREFIX.length);
  const dotIndex = body.indexOf('.');
  // The dot separator must appear at exactly the expected keyId length position.
  if (dotIndex !== KEY_ID_BASE64URL_LEN) {
    return null;
  }
  const keyId = body.slice(0, dotIndex);
  const secret = body.slice(dotIndex + 1);
  if (secret.length !== SECRET_BASE64URL_LEN) {
    return null;
  }
  if (!BASE64URL_RE.test(keyId) || !BASE64URL_RE.test(secret)) {
    return null;
  }
  return { keyId, secret };
}

/** Compute the SHA-256 hash of a secret for storage. Never log or return the input. */
export function hashApiKeySecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

/**
 * Timing-safe comparison of a presented secret against a stored SHA-256 hex hash.
 * Both buffers are always 32 bytes (SHA-256 output), so the length check is a
 * defensive guard against a corrupted stored value.
 */
export function verifyApiKeySecret(secret: string, storedHash: string): boolean {
  const computed = createHash('sha256').update(secret).digest();
  const expected = Buffer.from(storedHash, 'hex');
  if (computed.length !== expected.length) {
    return false;
  }
  return timingSafeEqual(computed, expected);
}
