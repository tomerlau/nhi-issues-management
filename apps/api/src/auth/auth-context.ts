/**
 * The authenticated principal for a request. userId and tenantId are derived
 * from a server-side authority — a session record or an API key record — and
 * never from request input (body, headers, query parameters, or path segments).
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
