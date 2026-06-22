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
