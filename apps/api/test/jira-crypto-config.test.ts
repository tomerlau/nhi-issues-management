import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  JIRA_ENCRYPTION_KEY_ENV,
  JiraKeyConfigurationError,
  resolveJiraEncryptionKey,
} from '../src/config/jira-crypto.js';

describe('resolveJiraEncryptionKey', () => {
  it('returns null when the variable is unset', () => {
    expect(resolveJiraEncryptionKey({})).toBeNull();
  });

  it('returns null when the variable is empty or whitespace', () => {
    expect(resolveJiraEncryptionKey({ [JIRA_ENCRYPTION_KEY_ENV]: '   ' })).toBeNull();
  });

  it('decodes a valid 32-byte base64 key', () => {
    const raw = randomBytes(32).toString('base64');
    const key = resolveJiraEncryptionKey({ [JIRA_ENCRYPTION_KEY_ENV]: raw });
    expect(key).not.toBeNull();
    expect(key!.length).toBe(32);
  });

  it('throws for a key that decodes to the wrong length', () => {
    const raw = randomBytes(16).toString('base64');
    expect(() => resolveJiraEncryptionKey({ [JIRA_ENCRYPTION_KEY_ENV]: raw })).toThrow(
      JiraKeyConfigurationError,
    );
  });

  it('throws for an invalid base64 character', () => {
    // A correct-length canonical key with one character replaced by '-', which
    // is not part of the standard base64 alphabet.
    const valid = randomBytes(32).toString('base64');
    const invalid = `${valid.slice(0, -2)}-=`;
    expect(() => resolveJiraEncryptionKey({ [JIRA_ENCRYPTION_KEY_ENV]: invalid })).toThrow(
      JiraKeyConfigurationError,
    );
  });

  it('throws for trailing garbage after valid base64', () => {
    const raw = `${randomBytes(32).toString('base64')}garbage`;
    expect(() => resolveJiraEncryptionKey({ [JIRA_ENCRYPTION_KEY_ENV]: raw })).toThrow(
      JiraKeyConfigurationError,
    );
  });

  it('throws for whitespace embedded inside the encoded value', () => {
    const valid = randomBytes(32).toString('base64');
    const withSpace = `${valid.slice(0, 8)} ${valid.slice(8)}`;
    expect(() => resolveJiraEncryptionKey({ [JIRA_ENCRYPTION_KEY_ENV]: withSpace })).toThrow(
      JiraKeyConfigurationError,
    );
  });

  it('throws for malformed padding', () => {
    // Extra padding that does not correspond to a canonical encoding.
    const raw = `${randomBytes(32).toString('base64')}=`;
    expect(() => resolveJiraEncryptionKey({ [JIRA_ENCRYPTION_KEY_ENV]: raw })).toThrow(
      JiraKeyConfigurationError,
    );
  });

  it('trims surrounding whitespace around an otherwise valid key', () => {
    const raw = randomBytes(32).toString('base64');
    const key = resolveJiraEncryptionKey({ [JIRA_ENCRYPTION_KEY_ENV]: `  ${raw}\n` });
    expect(key).not.toBeNull();
    expect(key!.length).toBe(32);
  });

  it('does not include the key value in the thrown error', () => {
    const raw = randomBytes(8).toString('base64');
    try {
      resolveJiraEncryptionKey({ [JIRA_ENCRYPTION_KEY_ENV]: raw });
      expect.unreachable('expected a configuration error');
    } catch (error) {
      expect((error as Error).message).not.toContain(raw);
    }
  });
});
