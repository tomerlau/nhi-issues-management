import type { CookieOptions, Request, Response } from 'express';

/**
 * Application-specific session cookie. The raw session token is carried only
 * here, never in JSON responses or client-side storage.
 */
export const SESSION_COOKIE_NAME = 'nhi_session';

/** Absolute session lifetime: eight hours, in milliseconds. */
export const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

/**
 * Cookie attributes for the session token. `secure` is enabled in production and
 * disabled for local HTTP development. The base options (without max-age) are
 * reused when clearing the cookie so the browser matches and removes it.
 */
function baseCookieOptions(secure: boolean): CookieOptions {
  return {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure,
  };
}

export function setSessionCookie(response: Response, token: string, secure: boolean): void {
  response.cookie(SESSION_COOKIE_NAME, token, {
    ...baseCookieOptions(secure),
    maxAge: SESSION_TTL_MS,
  });
}

export function clearSessionCookie(response: Response, secure: boolean): void {
  response.clearCookie(SESSION_COOKIE_NAME, baseCookieOptions(secure));
}

/**
 * Minimal Cookie header parser: read a single cookie value by name without
 * pulling in a cookie-parsing dependency. Returns null when the header or the
 * named cookie is absent.
 */
export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.cookie;
  if (!header) {
    return null;
  }
  for (const pair of header.split(';')) {
    const index = pair.indexOf('=');
    if (index === -1) {
      continue;
    }
    const key = pair.slice(0, index).trim();
    if (key === name) {
      return decodeURIComponent(pair.slice(index + 1).trim());
    }
  }
  return null;
}

export function readSessionToken(request: Request): string | null {
  return readCookie(request, SESSION_COOKIE_NAME);
}
