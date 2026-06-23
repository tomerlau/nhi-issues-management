import type { DatabaseSync } from 'node:sqlite';
import type { AuthContext } from './auth-context.js';
import { ApiKeyRepository } from '../repositories/api-key-repository.js';
import {
  generateApiKeyComponents,
  hashApiKeySecret,
  parseApiKey,
  verifyApiKeySecret,
} from './api-key-token.js';

export interface CreatedApiKey {
  keyId: string;
  /** The full plaintext key: nhi_<keyId>_<secret>. Shown exactly once. */
  fullKey: string;
  tenantId: string;
  userId: string;
}

/**
 * Orchestrates API key creation, authentication, and revocation.
 *
 * Trust boundary: ownership (tenantId, userId) is derived exclusively from the
 * stored key record. Request input cannot influence which principal a key
 * resolves to.
 */
export class ApiKeyService {
  private readonly apiKeys: ApiKeyRepository;

  constructor(db: DatabaseSync) {
    this.apiKeys = new ApiKeyRepository(db);
  }

  /**
   * Generate a new API key for the given tenant and user, persist only the hash
   * and metadata, and return the full plaintext key. The plaintext is never stored
   * and cannot be recovered after this call.
   */
  create(tenantId: string, userId: string): CreatedApiKey {
    const { keyId, secret, fullKey } = generateApiKeyComponents();
    const secretHash = hashApiKeySecret(secret);
    this.apiKeys.create({ id: keyId, tenantId, userId, secretHash });
    return { keyId, fullKey, tenantId, userId };
  }

  /**
   * Authenticate a raw API key string. Returns the AuthContext derived from the
   * stored record on success, or null for any failure (missing, malformed,
   * unknown key ID, or wrong secret). All failure cases are deliberately
   * indistinguishable to the caller.
   */
  authenticate(rawKey: string): AuthContext | null {
    const parsed = parseApiKey(rawKey);
    if (!parsed) {
      return null;
    }

    const record = this.apiKeys.findById(parsed.keyId);
    if (!record) {
      return null;
    }

    if (!verifyApiKeySecret(parsed.secret, record.secretHash)) {
      return null;
    }

    // Ownership comes entirely from the stored record, never from the request.
    return { userId: record.userId, tenantId: record.tenantId };
  }

  /**
   * Physically delete the key row identified by keyId. Returns true when
   * deleted, false when already absent (idempotent).
   */
  revoke(keyId: string): boolean {
    return this.apiKeys.deleteById(keyId);
  }
}
