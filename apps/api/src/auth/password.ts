import argon2 from 'argon2';

/**
 * Password hashing for the local POC, wrapping the maintained `argon2` package
 * with Argon2id. The library generates a random salt per hash and returns a
 * self-describing PHC string (`$argon2id$v=19$m=...,t=...,p=...$salt$hash`),
 * which is stored verbatim. This wrapper is the only place that touches the
 * `argon2` package; the rest of the application depends solely on these two
 * functions.
 */

export function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, { type: argon2.argon2id });
}

export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  try {
    return await argon2.verify(storedHash, password);
  } catch {
    // A malformed or unsupported stored hash makes verification throw; treat it
    // as a failed verification rather than surfacing an error.
    return false;
  }
}
