/**
 * Pure environment-file logic for the local setup command.
 *
 * Responsibilities:
 *  - Validate a JIRA_CREDENTIAL_ENCRYPTION_KEY value using the same canonical
 *    standard base64 / 32-byte rule the API enforces at startup.
 *  - Generate a cryptographically random key when one is missing or empty.
 *  - Edit apps/api/.env in place, preserving other lines, comments, and EOL
 *    style as far as reasonably possible.
 *  - Refuse to touch the file when an existing non-empty value is invalid.
 *  - Never write the key to anywhere except the .env file.
 *
 * This module performs no logging and no spawning. The CLI wrapper is in
 * setup.mjs; tests exercise this module directly.
 */

import { randomBytes } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';

export const KEY_NAME = 'JIRA_CREDENTIAL_ENCRYPTION_KEY';

const REQUIRED_KEY_BYTES = 32;
const STANDARD_BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

// Capture the value up to (but not including) the line terminator. `.*` in JS
// regex does not match `\n`, but it does match `\r`, so use an explicit
// character class to avoid swallowing `\r` from a CRLF file.
const KEY_LINE = new RegExp(`^${KEY_NAME}=([^\\r\\n]*)`, 'm');

/**
 * True only for a canonical standard base64 string that decodes to exactly the
 * required number of bytes. Mirrors apps/api/src/config/jira-crypto.ts; the
 * two checks are kept in step so the setup script accepts exactly what the API
 * accepts at startup.
 */
export function isValidEncryptionKey(value) {
  if (typeof value !== 'string' || value.length === 0) {
    return false;
  }
  if (!STANDARD_BASE64.test(value) || value.length % 4 !== 0) {
    return false;
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value) {
    return false;
  }
  return decoded.length === REQUIRED_KEY_BYTES;
}

/** Generate a fresh 32-byte key encoded as canonical standard base64. */
export function generateEncryptionKey() {
  return randomBytes(REQUIRED_KEY_BYTES).toString('base64');
}

/** Atomic write: write to a sibling temp file, then rename onto the target. */
function writeAtomic(targetPath, content) {
  const tmp = `${targetPath}.tmp`;
  writeFileSync(tmp, content, { encoding: 'utf8' });
  try {
    renameSync(tmp, targetPath);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // Ignore cleanup failures; surface the original error.
    }
    throw err;
  }
}

/**
 * Ensure the .env file at envPath has a valid JIRA_CREDENTIAL_ENCRYPTION_KEY.
 *
 * Behavior:
 *  - Missing .env: copies examplePath to envPath, then continues below.
 *  - Missing KEY line: appends one with a fresh key.
 *  - Empty value: rewrites that single line with a fresh key.
 *  - Valid value: leaves the file completely unchanged.
 *  - Invalid non-empty value: throws; the file is not modified.
 *
 * Returns `{ created, keyStatus }`:
 *  - `created` is true when the .env file did not exist and was created from
 *    the example.
 *  - `keyStatus` is `'generated'` (a new key was written) or `'preserved'`
 *    (an existing valid key was kept).
 *
 * The generated key value is returned only inside the file; it is never
 * surfaced through stdout, logs, or the return value.
 */
export function ensureEncryptionKey({ envPath, examplePath }) {
  if (typeof envPath !== 'string' || envPath.length === 0) {
    throw new Error('envPath is required.');
  }
  if (typeof examplePath !== 'string' || examplePath.length === 0) {
    throw new Error('examplePath is required.');
  }

  let created = false;
  if (!existsSync(envPath)) {
    if (!existsSync(examplePath)) {
      throw new Error(`Cannot create ${envPath}: ${examplePath} is missing.`);
    }
    copyFileSync(examplePath, envPath);
    created = true;
  }

  const original = readFileSync(envPath, 'utf8');
  const match = original.match(KEY_LINE);

  if (match && isValidEncryptionKey(match[1].trim())) {
    return { created, keyStatus: 'preserved' };
  }

  if (match && match[1].trim().length > 0) {
    throw new Error(
      `${KEY_NAME} in ${envPath} is set but is not canonical standard base64 ` +
        `decoding to ${REQUIRED_KEY_BYTES} bytes. The file was not modified. ` +
        `Remove or correct the value and re-run.`,
    );
  }

  const newKey = generateEncryptionKey();
  const next = match
    ? original.replace(KEY_LINE, `${KEY_NAME}=${newKey}`)
    : appendKeyLine(original, newKey);
  writeAtomic(envPath, next);
  return { created, keyStatus: 'generated' };
}

function appendKeyLine(original, newKey) {
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  const needsSeparator = original.length > 0 && !original.endsWith(eol);
  const separator = needsSeparator ? eol : '';
  const trailing = original.length === 0 || original.endsWith(eol) ? eol : eol;
  return `${original}${separator}${KEY_NAME}=${newKey}${trailing}`;
}
