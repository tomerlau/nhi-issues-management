/**
 * Frontend authentication API.
 *
 * Talks only to the relative `/api/auth/*` endpoints over the Vite dev proxy and
 * relies exclusively on the backend's HttpOnly session cookie. No session token,
 * password, or authorization header is ever stored, returned, or logged here.
 */

/** User fields the backend is safe to expose. No credential material. */
export interface SafeUser {
  id: string;
  tenantId: string;
  email: string;
  displayName: string;
}

/**
 * The distinct authentication API failures the UI must react to differently.
 * The normal logged-out state is not represented here: `restoreSession` returns
 * `null` for an HTTP 401 rather than throwing. `network` and `server` are genuine
 * failures that must not be mistaken for being logged out.
 */
export type AuthErrorKind =
  | 'invalid_credentials'
  | 'invalid_request'
  | 'network'
  | 'server';

/** A typed authentication failure carrying only UI-safe, generic information. */
export class AuthError extends Error {
  readonly kind: AuthErrorKind;

  constructor(kind: AuthErrorKind, message: string) {
    super(message);
    this.name = 'AuthError';
    this.kind = kind;
  }
}

const JSON_HEADERS = { 'Content-Type': 'application/json', Accept: 'application/json' };

/**
 * Read the structured `{ error: { code } }` envelope without trusting its shape.
 * Returns the backend error code when present, otherwise `undefined`. The backend
 * message is intentionally ignored so raw server text never reaches the user.
 */
async function readErrorCode(response: Response): Promise<string | undefined> {
  try {
    const body: unknown = await response.json();
    if (
      typeof body === 'object' &&
      body !== null &&
      'error' in body &&
      typeof (body as { error: unknown }).error === 'object' &&
      (body as { error: unknown }).error !== null
    ) {
      const code = (body as { error: { code?: unknown } }).error.code;
      if (typeof code === 'string') {
        return code;
      }
    }
  } catch {
    // A missing or non-JSON body is treated as an unknown error code.
  }
  return undefined;
}

/** Parse the `{ user }` success envelope, rejecting anything that is not a SafeUser. */
async function readUser(response: Response): Promise<SafeUser> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new AuthError('server', 'The server returned an unexpected response.');
  }
  if (
    typeof body === 'object' &&
    body !== null &&
    'user' in body &&
    isSafeUser((body as { user: unknown }).user)
  ) {
    return (body as { user: SafeUser }).user;
  }
  throw new AuthError('server', 'The server returned an unexpected response.');
}

function isSafeUser(value: unknown): value is SafeUser {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as SafeUser).id === 'string' &&
    typeof (value as SafeUser).tenantId === 'string' &&
    typeof (value as SafeUser).email === 'string' &&
    typeof (value as SafeUser).displayName === 'string'
  );
}

/**
 * Restore the current session on application load.
 *
 * Resolves to the authenticated user (HTTP 200), or `null` for the normal
 * unauthenticated state (HTTP 401 `unauthenticated`). A network failure or any
 * unexpected server response rejects with an {@link AuthError}, so the caller can
 * tell "logged out" apart from "could not check".
 */
export async function restoreSession(signal?: AbortSignal): Promise<SafeUser | null> {
  let response: Response;
  try {
    response = await fetch('/api/auth/session', {
      method: 'GET',
      headers: { Accept: 'application/json' },
      credentials: 'same-origin',
      signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw error;
    }
    throw new AuthError('network', 'Unable to reach the server.');
  }

  if (response.ok) {
    return readUser(response);
  }
  if (response.status === 401) {
    return null;
  }
  throw new AuthError('server', 'The server returned an unexpected response.');
}

/**
 * Log in with email and password. On success the backend sets the session cookie
 * and returns the authenticated user. Invalid credentials and invalid input map
 * to distinct {@link AuthError} kinds; transport and unexpected server problems
 * map to `network`/`server`.
 */
export async function login(email: string, password: string): Promise<SafeUser> {
  let response: Response;
  try {
    response = await fetch('/api/auth/login', {
      method: 'POST',
      headers: JSON_HEADERS,
      credentials: 'same-origin',
      body: JSON.stringify({ email, password }),
    });
  } catch {
    throw new AuthError('network', 'Unable to reach the server.');
  }

  if (response.ok) {
    return readUser(response);
  }
  if (response.status === 401) {
    throw new AuthError('invalid_credentials', 'Invalid email or password.');
  }
  if (response.status === 400) {
    throw new AuthError('invalid_request', 'Please enter a valid email and password.');
  }
  // Defensive: honour a structured code if a future status still carries one.
  const code = await readErrorCode(response);
  if (code === 'invalid_credentials') {
    throw new AuthError('invalid_credentials', 'Invalid email or password.');
  }
  throw new AuthError('server', 'The server returned an unexpected response.');
}

/**
 * Log out the current session. Resolves only when the backend proves logout
 * completed: an HTTP success status carrying exactly `{ status: "ok" }`. Network
 * failure, a non-success status, or a success response whose body is malformed,
 * non-JSON, or not `{ status: "ok" }` all reject with an {@link AuthError} so the
 * UI keeps the user authenticated rather than pretending the session was revoked.
 */
export async function logout(): Promise<void> {
  let response: Response;
  try {
    response = await fetch('/api/auth/logout', {
      method: 'POST',
      headers: { Accept: 'application/json' },
      credentials: 'same-origin',
    });
  } catch {
    throw new AuthError('network', 'Unable to reach the server.');
  }

  if (!response.ok) {
    throw new AuthError('server', 'The server returned an unexpected response.');
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new AuthError('server', 'The server returned an unexpected response.');
  }
  if (
    typeof body !== 'object' ||
    body === null ||
    (body as { status?: unknown }).status !== 'ok'
  ) {
    throw new AuthError('server', 'The server returned an unexpected response.');
  }
}
