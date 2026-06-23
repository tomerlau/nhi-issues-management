/**
 * Browser-local persistence for the last valid Jira project key.
 *
 * The preference is scoped by both `tenantId` and `userId` of the
 * authenticated {@link SafeUser}, so a different user in the same tenant — or
 * a user in a different tenant — never inherits the previous user's project.
 *
 * Trust boundary:
 *  - Only a normalized, client-valid Jira project key is stored. Invalid or
 *    partial input is never persisted.
 *  - No Jira credential, token, site URL, session value, ticket data, or
 *    other user-profile data is stored here.
 *  - Storage access is wrapped so a missing, blocked, or throwing
 *    `localStorage` collapses safely to an empty preference; the caller falls
 *    back to an empty selector instead of crashing.
 *  - This module performs no logging.
 *
 * This is a frontend-only UX preference; the backend is not involved. See
 * `docs/architecture.md` and `docs/assumptions.md` for the design notes.
 */

import type { SafeUser } from '../api/auth';
import { isValidProjectKey, normalizeProjectKey } from './project-key';

const STORAGE_PREFIX = 'nhi:last-project';

interface UserScope {
  tenantId: string;
  id: string;
}

/**
 * Build the user-and-tenant-scoped storage key. Exported so tests can assert
 * the key shape and so the shell uses the same construction the loader uses.
 */
export function getProjectPreferenceStorageKey(user: UserScope): string {
  return `${STORAGE_PREFIX}:${user.tenantId}:${user.id}`;
}

/**
 * Return the local `Storage` object when it is available and usable, or
 * `null` when access throws (e.g. disabled cookies/storage, sandboxed
 * iframe, restricted browser context, server-side rendering, or any
 * unexpected environment). Probing protects callers from ever throwing.
 */
function safeStorage(): Storage | null {
  try {
    if (typeof window === 'undefined') return null;
    const storage = window.localStorage;
    // Some browsers expose `localStorage` but throw on access in private mode.
    // A no-op probe surfaces that case here.
    const probeKey = `${STORAGE_PREFIX}:__probe`;
    storage.setItem(probeKey, '');
    storage.removeItem(probeKey);
    return storage;
  } catch {
    return null;
  }
}

/**
 * Read the saved project for the given user. Returns the normalized,
 * validated value, or an empty string when no valid value is available.
 *
 * Safe under all storage failure modes:
 *  - storage missing or blocked → empty string
 *  - missing entry → empty string
 *  - malformed value (non-string / wrong shape / invalid project key) → empty
 *    string; the stored value is left as-is so a future cleanup or write may
 *    overwrite it.
 */
export function loadLastProject(user: UserScope): string {
  const storage = safeStorage();
  if (storage === null) return '';

  let raw: string | null;
  try {
    raw = storage.getItem(getProjectPreferenceStorageKey(user));
  } catch {
    return '';
  }
  if (typeof raw !== 'string' || raw.length === 0) return '';

  const normalized = normalizeProjectKey(raw);
  return isValidProjectKey(normalized) ? normalized : '';
}

/**
 * Persist a project key for the given user. The value is normalized first;
 * only a client-valid project key is written. Anything else — empty,
 * partial, invalid — is a no-op, so clearing the input or typing two
 * characters never overwrites the previously saved valid project.
 *
 * A storage write that throws is silently ignored: the application keeps
 * functioning, and the prior stored value (if any) is left intact.
 */
export function saveLastProject(user: UserScope, projectKey: string): void {
  const normalized = normalizeProjectKey(projectKey);
  if (!isValidProjectKey(normalized)) return;

  const storage = safeStorage();
  if (storage === null) return;

  try {
    storage.setItem(getProjectPreferenceStorageKey(user), normalized);
  } catch {
    // No-op. Persistence is best-effort; UX must not be affected.
  }
}

// Re-export the SafeUser-compatible scope shape for callers and tests.
export type { UserScope, SafeUser };
