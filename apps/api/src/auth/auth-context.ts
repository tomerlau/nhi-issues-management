/**
 * The authenticated principal, derived entirely from the server-side session.
 * userId and tenantId always come from the stored session record, never from
 * request input.
 */
export interface AuthContext {
  userId: string;
  tenantId: string;
}

/** User fields that are safe to return to a client. No credential material. */
export interface SafeUser {
  id: string;
  tenantId: string;
  email: string;
  displayName: string;
}

/**
 * Normalize an email for storage and lookup so the same address always matches
 * regardless of surrounding whitespace or letter case.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
