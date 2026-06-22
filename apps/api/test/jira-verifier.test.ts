import { describe, expect, it, vi } from 'vitest';
import { verifyJiraCredentials, type FetchLike } from '../src/jira/jira-verifier.js';

const origin = 'https://example.atlassian.net';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('jira credential verifier', () => {
  it('returns the account id for valid credentials', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ accountId: 'acc-123' })) as FetchLike;
    const result = await verifyJiraCredentials(origin, 'a@example.com', 'token', {
      fetch: fetchMock,
    });
    expect(result).toEqual({ ok: true, accountId: 'acc-123' });
  });

  it('calls the /myself endpoint with Basic auth built from email and token', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ accountId: 'acc-123' }));
    await verifyJiraCredentials(origin, 'a@example.com', 'token', {
      fetch: fetchMock as unknown as FetchLike,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://example.atlassian.net/rest/api/3/myself');
    const expectedAuth = `Basic ${Buffer.from('a@example.com:token').toString('base64')}`;
    expect((init.headers as Record<string, string>).Authorization).toBe(expectedAuth);
    expect(init.redirect).toBe('manual');
  });

  it('maps 401 to rejected credentials', async () => {
    const fetchMock = vi.fn(async () => new Response('', { status: 401 })) as FetchLike;
    const result = await verifyJiraCredentials(origin, 'a@example.com', 'bad', { fetch: fetchMock });
    expect(result).toEqual({ ok: false, reason: 'credentials_rejected' });
  });

  it('maps 403 to rejected credentials', async () => {
    const fetchMock = vi.fn(async () => new Response('', { status: 403 })) as FetchLike;
    const result = await verifyJiraCredentials(origin, 'a@example.com', 'bad', { fetch: fetchMock });
    expect(result).toEqual({ ok: false, reason: 'credentials_rejected' });
  });

  it('maps an abort/timeout to timeout', async () => {
    const fetchMock = vi.fn(async () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      throw error;
    }) as FetchLike;
    const result = await verifyJiraCredentials(origin, 'a@example.com', 'token', {
      fetch: fetchMock,
    });
    expect(result).toEqual({ ok: false, reason: 'timeout' });
  });

  it('maps a network failure to unavailable', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as FetchLike;
    const result = await verifyJiraCredentials(origin, 'a@example.com', 'token', {
      fetch: fetchMock,
    });
    expect(result).toEqual({ ok: false, reason: 'unavailable' });
  });

  it('maps a non-JSON response to unavailable', async () => {
    const fetchMock = vi.fn(
      async () => new Response('<html>not json</html>', { status: 200 }),
    ) as FetchLike;
    const result = await verifyJiraCredentials(origin, 'a@example.com', 'token', {
      fetch: fetchMock,
    });
    expect(result).toEqual({ ok: false, reason: 'unavailable' });
  });

  it('maps an invalid JSON shape (missing accountId) to unavailable', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ displayName: 'Alice' })) as FetchLike;
    const result = await verifyJiraCredentials(origin, 'a@example.com', 'token', {
      fetch: fetchMock,
    });
    expect(result).toEqual({ ok: false, reason: 'unavailable' });
  });

  it('does not follow redirects (3xx maps to unavailable)', async () => {
    const fetchMock = vi.fn(
      async () => new Response('', { status: 302, headers: { Location: 'https://evil.example' } }),
    ) as FetchLike;
    const result = await verifyJiraCredentials(origin, 'a@example.com', 'token', {
      fetch: fetchMock,
    });
    expect(result).toEqual({ ok: false, reason: 'unavailable' });
  });

  it('maps an unexpected 5xx to unavailable', async () => {
    const fetchMock = vi.fn(async () => new Response('', { status: 500 })) as FetchLike;
    const result = await verifyJiraCredentials(origin, 'a@example.com', 'token', {
      fetch: fetchMock,
    });
    expect(result).toEqual({ ok: false, reason: 'unavailable' });
  });

  it('maps a timeout during the body read to timeout (lifecycle is covered)', async () => {
    // The transport resolves headers (status 200) promptly, but reading the body
    // hangs until the request times out. Because the timeout covers the entire
    // response lifecycle, the abort fires while `.json()` is pending and the
    // outcome must be `timeout`, not `unavailable`.
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const signal = init?.signal;
      const json = () =>
        new Promise((_resolve, reject) => {
          if (signal) {
            signal.addEventListener('abort', () => reject(new Error('body read aborted')));
          }
        });
      return { status: 200, json } as unknown as Response;
    }) as unknown as FetchLike;

    const result = await verifyJiraCredentials(origin, 'a@example.com', 'token', {
      fetch: fetchMock,
      timeoutMs: 5,
    });
    expect(result).toEqual({ ok: false, reason: 'timeout' });
  });
});
