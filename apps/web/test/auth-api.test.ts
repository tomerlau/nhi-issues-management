import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthError, login, logout, restoreSession, type SafeUser } from '../src/api/auth';

const demoUser: SafeUser = {
  id: 'user-acme-alice',
  tenantId: 'tenant-acme',
  email: 'alice@example.com',
  displayName: 'Alice Anderson',
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

describe('restoreSession', () => {
  it('requests GET /api/auth/session and returns the user on 200', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ user: demoUser }));

    const user = await restoreSession();

    expect(user).toEqual(demoUser);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/auth/session');
    expect(init?.method).toBe('GET');
    expect(init?.credentials).toBe('same-origin');
  });

  it('returns null for the unauthenticated 401 state', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: { code: 'unauthenticated' } }, 401));

    await expect(restoreSession()).resolves.toBeNull();
  });

  it('throws a network AuthError when fetch rejects', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

    await expect(restoreSession()).rejects.toMatchObject({ kind: 'network' });
  });

  it('throws a server AuthError on an unexpected status', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, 500));

    await expect(restoreSession()).rejects.toMatchObject({ kind: 'server' });
  });

  it('throws a server AuthError when a 200 body is not a SafeUser', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ user: { id: 1 } }));

    await expect(restoreSession()).rejects.toMatchObject({ kind: 'server' });
  });

  it('re-throws AbortError without wrapping it', async () => {
    fetchMock.mockRejectedValue(new DOMException('aborted', 'AbortError'));

    await expect(restoreSession()).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('login', () => {
  it('posts email and password as JSON and returns the user on 200', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ user: demoUser }));

    const user = await login('alice@example.com', 'acme-alice-demo');

    expect(user).toEqual(demoUser);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/auth/login');
    expect(init?.method).toBe('POST');
    expect(init?.credentials).toBe('same-origin');
    expect(init?.body).toBe(
      JSON.stringify({ email: 'alice@example.com', password: 'acme-alice-demo' }),
    );
  });

  it('maps 401 to a generic invalid_credentials error', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: { code: 'invalid_credentials' } }, 401));

    const error = await login('alice@example.com', 'wrong').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AuthError);
    expect((error as AuthError).kind).toBe('invalid_credentials');
    expect((error as AuthError).message).toBe('Invalid email or password.');
  });

  it('maps 400 to invalid_request', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: { code: 'invalid_request' } }, 400));

    await expect(login('', '')).rejects.toMatchObject({ kind: 'invalid_request' });
  });

  it('throws a network AuthError when fetch rejects', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

    await expect(login('a@b.com', 'pw')).rejects.toMatchObject({ kind: 'network' });
  });

  it('honours a structured invalid_credentials code on an unexpected status', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: { code: 'invalid_credentials' } }, 422));

    await expect(login('a@b.com', 'pw')).rejects.toMatchObject({ kind: 'invalid_credentials' });
  });

  it('falls back to a server AuthError for an unexpected status and code', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, 500));

    await expect(login('a@b.com', 'pw')).rejects.toMatchObject({ kind: 'server' });
  });

  it('safely handles a non-JSON error body', async () => {
    fetchMock.mockResolvedValue(new Response('<html>boom</html>', { status: 503 }));

    await expect(login('a@b.com', 'pw')).rejects.toMatchObject({ kind: 'server' });
  });
});

describe('logout', () => {
  it('posts to /api/auth/logout and resolves on 200', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ status: 'ok' }));

    await expect(logout()).resolves.toBeUndefined();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/auth/logout');
    expect(init?.method).toBe('POST');
    expect(init?.credentials).toBe('same-origin');
  });

  it('throws a network AuthError when fetch rejects', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

    await expect(logout()).rejects.toMatchObject({ kind: 'network' });
  });

  it('throws a server AuthError on an unexpected status', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, 500));

    await expect(logout()).rejects.toMatchObject({ kind: 'server' });
  });
});
