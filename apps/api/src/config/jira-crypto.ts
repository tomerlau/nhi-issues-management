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

// Canonical standard base64 (not base64url): the alphabet plus optional `=`
// padding, with no embedded whitespace. `Buffer.from(_, 'base64')` is far too
// permissive — it silently ignores invalid characters, stray whitespace, and
// trailing garbage — so the raw value is screened against this pattern first.
const STANDARD_BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

export class JiraKeyConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JiraKeyConfigurationError';
  }
}

/**
 * Strictly decode a canonical standard-base64 string, or return `null` when the
 * value is not canonical. Canonical means: only the standard base64 alphabet and
 * padding, a length that is a multiple of four, and a value that re-encodes back
 * to exactly the input (which rejects malformed padding and non-canonical
 * trailing bits). The decoded value itself is never surfaced to the caller's
 * error path.
 */
function decodeCanonicalBase64(raw: string): Buffer | null {
  if (!STANDARD_BASE64.test(raw) || raw.length % 4 !== 0) {
    return null;
  }
  const decoded = Buffer.from(raw, 'base64');
  if (decoded.toString('base64') !== raw) {
    return null;
  }
  return decoded;
}

/**
 * Returns the decoded 32-byte key, or `null` when the variable is unset/empty.
 * Throws `JiraKeyConfigurationError` when a value is present but invalid.
 */
export function resolveJiraEncryptionKey(env: NodeJS.ProcessEnv = process.env): Buffer | null {
  // Only surrounding whitespace from the env value is trimmed; whitespace
  // embedded inside the encoded value is treated as malformed.
  const raw = env[JIRA_ENCRYPTION_KEY_ENV]?.trim();
  if (!raw) {
    return null;
  }

  const decoded = decodeCanonicalBase64(raw);
  if (decoded === null) {
    throw new JiraKeyConfigurationError(
      `${JIRA_ENCRYPTION_KEY_ENV} must be canonical standard base64 decoding to exactly ${REQUIRED_KEY_BYTES} bytes.`,
    );
  }

  if (decoded.length !== REQUIRED_KEY_BYTES) {
    throw new JiraKeyConfigurationError(
      `${JIRA_ENCRYPTION_KEY_ENV} must decode to exactly ${REQUIRED_KEY_BYTES} bytes.`,
    );
  }

  return decoded;
}
