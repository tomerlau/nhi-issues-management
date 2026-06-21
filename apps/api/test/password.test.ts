import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../src/auth/password.js';

describe('password hashing', () => {
  it('verifies a correct password', () => {
    const stored = hashPassword('correct horse battery staple');
    expect(verifyPassword('correct horse battery staple', stored)).toBe(true);
  });

  it('rejects an incorrect password', () => {
    const stored = hashPassword('correct horse battery staple');
    expect(verifyPassword('wrong password', stored)).toBe(false);
  });

  it('produces a versioned, self-describing scrypt format', () => {
    const stored = hashPassword('whatever');
    const parts = stored.split('$');
    expect(parts).toHaveLength(5);
    expect(parts[0]).toBe('scrypt');
    expect(parts[1]).toBe('1');
    expect(parts[2]).toMatch(/^n=\d+,r=\d+,p=\d+$/);
  });

  it('uses a distinct random salt per hash', () => {
    const first = hashPassword('same-password');
    const second = hashPassword('same-password');
    expect(first).not.toBe(second);
    // The salt segment differs, yet both verify the same plaintext.
    expect(first.split('$')[3]).not.toBe(second.split('$')[3]);
    expect(verifyPassword('same-password', first)).toBe(true);
    expect(verifyPassword('same-password', second)).toBe(true);
  });

  it('fails safely on malformed stored hashes', () => {
    for (const bad of [
      '',
      'not-a-hash',
      'scrypt$1$bad-params$c2FsdA==$a2V5',
      'scrypt$2$n=16384,r=8,p=1$c2FsdA==$a2V5',
      'bcrypt$1$n=16384,r=8,p=1$c2FsdA==$a2V5',
      'scrypt$1$n=16384,r=8,p=1$$',
    ]) {
      expect(verifyPassword('anything', bad)).toBe(false);
    }
  });
});
