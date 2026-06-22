import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Authenticated encryption for the Jira API token before it is written to
 * SQLite. AES-256-GCM with a fresh random nonce per encryption and additional
 * authenticated data (AAD) that binds the ciphertext to the credential type, the
 * credential format version, and the owning tenant. Because the AAD is
 * authenticated, a ciphertext encrypted for one tenant cannot be decrypted under
 * a different tenant, and tampering with the serialized value fails the
 * authentication tag.
 *
 * The Jira connection belongs to the tenant, not to any individual user, so the
 * credential context is the tenant alone. `configured_by_user_id` is audit
 * metadata recorded on the connection row and intentionally does not participate
 * in encryption or decryption: any user in the tenant uses the same shared
 * connection regardless of who configured it.
 *
 * Serialized format (versioned, dot-separated base64 fields):
 *   v2.<nonce>.<ciphertext>.<authTag>
 */

const VERSION = 'v2';
const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const AUTH_TAG_BYTES = 16;

/** Identifies what kind of credential this ciphertext holds, bound into the AAD. */
const CREDENTIAL_TYPE = 'jira-api-token';
/** The credential format version, bound into the AAD alongside the serialized version prefix. */
const CREDENTIAL_FORMAT_VERSION = '2';

/** The credential context an encrypted credential is bound to. */
export interface CredentialContext {
  tenantId: string;
}

/**
 * Build the additional authenticated data. The fields are encoded as a JSON
 * array with a fixed element order so the boundaries between them are
 * unambiguous. A delimiter-joined string (e.g. `a:b:c`) is ambiguous because a
 * field value may itself contain the delimiter; JSON string encoding escapes the
 * contents so no field value can ever forge a boundary.
 *
 * The fixed byte layout is [credential type, credential format version,
 * tenantId]. There is intentionally no user component: the connection is
 * tenant-bound.
 */
function buildAad(context: CredentialContext): Buffer {
  return Buffer.from(
    JSON.stringify([CREDENTIAL_TYPE, CREDENTIAL_FORMAT_VERSION, context.tenantId]),
    'utf8',
  );
}

function assertKey(key: Buffer): void {
  if (key.length !== KEY_BYTES) {
    throw new Error('Jira credential encryption key must be exactly 32 bytes.');
  }
}

/**
 * Encrypt a plaintext token. The same plaintext yields different ciphertext on
 * each call because the nonce is freshly random.
 */
export function encryptToken(
  plaintext: string,
  key: Buffer,
  context: CredentialContext,
): string {
  assertKey(key);
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, nonce, { authTagLength: AUTH_TAG_BYTES });
  cipher.setAAD(buildAad(context));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [
    VERSION,
    nonce.toString('base64'),
    ciphertext.toString('base64'),
    authTag.toString('base64'),
  ].join('.');
}

/**
 * Decrypt a serialized token. Throws for an unsupported version (including the
 * removed v1 format), a malformed payload, a wrong key, a tampered ciphertext, or
 * a mismatched tenant context (the AAD fails to authenticate). Errors are
 * intentionally generic and never include key or token material.
 */
export function decryptToken(
  serialized: string,
  key: Buffer,
  context: CredentialContext,
): string {
  assertKey(key);
  const parts = serialized.split('.');
  if (parts.length !== 4) {
    throw new Error('Malformed Jira credential ciphertext.');
  }
  const [version, nonceB64, ciphertextB64, authTagB64] = parts;
  if (version !== VERSION) {
    throw new Error('Unsupported Jira credential ciphertext version.');
  }

  const nonce = Buffer.from(nonceB64, 'base64');
  const ciphertext = Buffer.from(ciphertextB64, 'base64');
  const authTag = Buffer.from(authTagB64, 'base64');
  if (nonce.length !== NONCE_BYTES || authTag.length !== AUTH_TAG_BYTES) {
    throw new Error('Malformed Jira credential ciphertext.');
  }

  const decipher = createDecipheriv(ALGORITHM, key, nonce, { authTagLength: AUTH_TAG_BYTES });
  decipher.setAAD(buildAad(context));
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
