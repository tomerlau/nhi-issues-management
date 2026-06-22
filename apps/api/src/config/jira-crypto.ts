/**
 * Resolve the Jira credential encryption key from the environment.
 *
 * The key is provided base64-encoded in `JIRA_CREDENTIAL_ENCRYPTION_KEY` and
 * must decode to exactly 32 bytes (AES-256). The distinction between "missing"
 * and "malformed" is deliberate:
 *
 * - Missing/empty: the rest of the application still starts; Jira connection
 *   endpoints return HTTP 503 `jira_not_configured`. Returns `null`.
 * - Configured but malformed: throws, so process startup fails with a clear,
 *   sanitized configuration error.
 *
 * The key value itself is never included in any thrown error or log line.
 */

export const JIRA_ENCRYPTION_KEY_ENV = 'JIRA_CREDENTIAL_ENCRYPTION_KEY';

const REQUIRED_KEY_BYTES = 32;

export class JiraKeyConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JiraKeyConfigurationError';
  }
}

/**
 * Returns the decoded 32-byte key, or `null` when the variable is unset/empty.
 * Throws `JiraKeyConfigurationError` when a value is present but invalid.
 */
export function resolveJiraEncryptionKey(env: NodeJS.ProcessEnv = process.env): Buffer | null {
  const raw = env[JIRA_ENCRYPTION_KEY_ENV]?.trim();
  if (!raw) {
    return null;
  }

  let decoded: Buffer;
  try {
    decoded = Buffer.from(raw, 'base64');
  } catch {
    throw new JiraKeyConfigurationError(
      `${JIRA_ENCRYPTION_KEY_ENV} must be valid base64 decoding to 32 bytes.`,
    );
  }

  if (decoded.length !== REQUIRED_KEY_BYTES) {
    throw new JiraKeyConfigurationError(
      `${JIRA_ENCRYPTION_KEY_ENV} must decode to exactly ${REQUIRED_KEY_BYTES} bytes.`,
    );
  }

  return decoded;
}
