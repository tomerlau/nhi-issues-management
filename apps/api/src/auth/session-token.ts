import { createHash, randomBytes } from 'node:crypto';

/**
 * Opaque session tokens. A token is 32 random bytes (256 bits of entropy)
 * encoded as URL-safe base64. The raw token is sent only in the session cookie;
 * the database stores nothing but its SHA-256 hash, so a leaked database row
 * cannot be replayed as a session.
 */

const TOKEN_BYTES = 32;

export function generateSessionToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
