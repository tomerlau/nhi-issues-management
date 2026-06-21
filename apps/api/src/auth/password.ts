import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/**
 * Password hashing for the local POC using Node's built-in scrypt.
 *
 * The stored value is versioned and self-describing so the parameters used to
 * derive a hash always travel with it:
 *
 *   scrypt$1$n=<N>,r=<r>,p=<p>$<saltBase64>$<keyBase64>
 *
 * Field 0 is the algorithm, field 1 the storage-format version, field 2 the
 * scrypt cost parameters, then the random salt and the derived key. Verification
 * recomputes the key with the stored parameters and compares in constant time.
 */

const ALGORITHM = 'scrypt';
const FORMAT_VERSION = '1';
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 } as const;
const SALT_BYTES = 16;
const KEY_BYTES = 64;

export function hashPassword(password: string): string {
  const salt = randomBytes(SALT_BYTES);
  const key = scryptSync(password, salt, KEY_BYTES, SCRYPT_PARAMS);
  const params = `n=${SCRYPT_PARAMS.N},r=${SCRYPT_PARAMS.r},p=${SCRYPT_PARAMS.p}`;
  return [
    ALGORITHM,
    FORMAT_VERSION,
    params,
    salt.toString('base64'),
    key.toString('base64'),
  ].join('$');
}

interface ParsedHash {
  N: number;
  r: number;
  p: number;
  salt: Buffer;
  key: Buffer;
}

function parseStoredHash(stored: string): ParsedHash | null {
  const parts = stored.split('$');
  if (parts.length !== 5) {
    return null;
  }
  const [algorithm, version, params, saltB64, keyB64] = parts;
  if (algorithm !== ALGORITHM || version !== FORMAT_VERSION) {
    return null;
  }

  const match = /^n=(\d+),r=(\d+),p=(\d+)$/.exec(params);
  if (!match) {
    return null;
  }
  const N = Number.parseInt(match[1], 10);
  const r = Number.parseInt(match[2], 10);
  const p = Number.parseInt(match[3], 10);

  let salt: Buffer;
  let key: Buffer;
  try {
    salt = Buffer.from(saltB64, 'base64');
    key = Buffer.from(keyB64, 'base64');
  } catch {
    return null;
  }
  if (salt.length === 0 || key.length === 0) {
    return null;
  }

  return { N, r, p, salt, key };
}

export function verifyPassword(password: string, stored: string): boolean {
  const parsed = parseStoredHash(stored);
  if (!parsed) {
    return false;
  }

  let candidate: Buffer;
  try {
    candidate = scryptSync(password, parsed.salt, parsed.key.length, {
      N: parsed.N,
      r: parsed.r,
      p: parsed.p,
    });
  } catch {
    return false;
  }

  if (candidate.length !== parsed.key.length) {
    return false;
  }
  return timingSafeEqual(candidate, parsed.key);
}
