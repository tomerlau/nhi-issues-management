import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../src/auth/password.js';

describe('password hashing', () => {
  it('verifies a correct password', async () => {
    const stored = await hashPassword('correct horse battery staple');
    expect(await verifyPassword('correct horse battery staple', stored)).toBe(true);
  });

  it('rejects an incorrect password', async () => {
    const stored = await hashPassword('correct horse battery staple');
    expect(await verifyPassword('wrong password', stored)).toBe(false);
  });

  it('produces an Argon2id PHC hash', async () => {
    const stored = await hashPassword('whatever');
    expect(stored.startsWith('$argon2id$')).toBe(true);
  });

  it('produces a different stored hash each time (random salt)', async () => {
    const first = await hashPassword('same-password');
    const second = await hashPassword('same-password');
    expect(first).not.toBe(second);
    expect(await verifyPassword('same-password', first)).toBe(true);
    expect(await verifyPassword('same-password', second)).toBe(true);
  });

  it('returns false for a malformed stored hash without throwing', async () => {
    for (const bad of ['', 'not-a-hash', '$argon2id$garbage', '$unknown$v=19$m=1$x$y']) {
      expect(await verifyPassword('anything', bad)).toBe(false);
    }
  });
});
