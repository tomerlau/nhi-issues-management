import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getJiraConnection, saveJiraConnection, JiraApiError } from '../src/api/jira';

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

describe('getJiraConnection', () => {
  it('requests GET /api/jira/connection with same-origin credentials', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ connected: false }));

    await getJiraConnection();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/jira/connection');
    expect(init?.method).toBe('GET');
    expect(init?.credentials).toBe('same-origin');
  });

  it('parses the disconnected status', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ connected: false }));

    await expect(getJiraConnection()).resolves.toEqual({ connected: false });
  });

  it('parses the connected status with safe fields only', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        connected: true,
        siteUrl: 'https://acme.atlassian.net',
        email: 'alice@example.com',
        // Unexpected credential-shaped fields must be ignored, not surfaced.
        apiToken: 'super-secret',
        encryptedToken: 'v1.aaa.bbb.ccc',
        accountId: 'acc-123',
      }),
    );

    const status = await getJiraConnection();

    expect(status).toEqual({
      connected: true,
      siteUrl: 'https://acme.atlassian.net',
      email: 'alice@example.com',
    });
    expect(status).not.toHaveProperty('apiToken');
    expect(status).not.toHaveProperty('encryptedToken');
    expect(status).not.toHaveProperty('accountId');
  });

  it('rejects a malformed connected body as a server error', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ connected: true, siteUrl: 42 }));

    await expect(getJiraConnection()).rejects.toMatchObject({ kind: 'server' });
  });

  it('rejects a non-JSON body as a server error', async () => {
    fetchMock.mockResolvedValue(new Response('not json', { status: 200 }));

    await expect(getJiraConnection()).rejects.toMatchObject({ kind: 'server' });
  });

  it('maps a 401 to an authentication error', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: { code: 'unauthenticated' } }, 401));

    await expect(getJiraConnection()).rejects.toMatchObject({ kind: 'authentication' });
  });

  it('maps jira_not_configured to not_configured', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: { code: 'jira_not_configured' } }, 503));

    await expect(getJiraConnection()).rejects.toMatchObject({ kind: 'not_configured' });
  });

  it('throws a network error when fetch rejects', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

    await expect(getJiraConnection()).rejects.toMatchObject({ kind: 'network' });
  });

  it('re-throws AbortError without wrapping it', async () => {
    fetchMock.mockRejectedValue(new DOMException('aborted', 'AbortError'));

    await expect(getJiraConnection()).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('saveJiraConnection', () => {
  const input = {
    siteUrl: 'https://acme.atlassian.net',
    email: 'alice@example.com',
    apiToken: 'plain-text-token',
  };

  it('posts the exact path, method, JSON body, headers, and credentials', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        connected: true,
        siteUrl: 'https://acme.atlassian.net',
        email: 'alice@example.com',
      }),
    );

    await saveJiraConnection(input);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/jira/connection');
    expect(init?.method).toBe('POST');
    expect(init?.credentials).toBe('same-origin');
    expect(init?.headers).toMatchObject({ 'Content-Type': 'application/json' });
    expect(init?.body).toBe(
      JSON.stringify({
        siteUrl: 'https://acme.atlassian.net',
        email: 'alice@example.com',
        apiToken: 'plain-text-token',
      }),
    );
  });

  it('parses a successful connection/replacement response', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        connected: true,
        siteUrl: 'https://acme.atlassian.net',
        email: 'alice@example.com',
      }),
    );

    await expect(saveJiraConnection(input)).resolves.toEqual({
      connected: true,
      siteUrl: 'https://acme.atlassian.net',
      email: 'alice@example.com',
    });
  });

  it('rejects a malformed success body as a server error', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ connected: true }));

    await expect(saveJiraConnection(input)).rejects.toMatchObject({ kind: 'server' });
  });

  it('rejects a 200 connected:false body as a server error', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ connected: false }));

    await expect(saveJiraConnection(input)).rejects.toMatchObject({ kind: 'server' });
  });

  it('maps invalid_request to invalid_request', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: { code: 'invalid_request' } }, 400));

    await expect(saveJiraConnection(input)).rejects.toMatchObject({ kind: 'invalid_request' });
  });

  it('maps jira_credentials_rejected to credentials_rejected', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ error: { code: 'jira_credentials_rejected' } }, 422),
    );

    await expect(saveJiraConnection(input)).rejects.toMatchObject({ kind: 'credentials_rejected' });
  });

  it('maps jira_not_configured to not_configured', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: { code: 'jira_not_configured' } }, 503));

    await expect(saveJiraConnection(input)).rejects.toMatchObject({ kind: 'not_configured' });
  });

  it('maps jira_timeout to timeout', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: { code: 'jira_timeout' } }, 504));

    await expect(saveJiraConnection(input)).rejects.toMatchObject({ kind: 'timeout' });
  });

  it('maps jira_unreachable to unreachable', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: { code: 'jira_unreachable' } }, 502));

    await expect(saveJiraConnection(input)).rejects.toMatchObject({ kind: 'unreachable' });
  });

  it('maps a 401 to an authentication error', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: { code: 'unauthenticated' } }, 401));

    await expect(saveJiraConnection(input)).rejects.toMatchObject({ kind: 'authentication' });
  });

  it('maps an unexpected status to a server error', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, 500));

    await expect(saveJiraConnection(input)).rejects.toMatchObject({ kind: 'server' });
  });

  it('throws a network error when fetch rejects', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

    await expect(saveJiraConnection(input)).rejects.toMatchObject({ kind: 'network' });
  });

  it('never surfaces the raw backend error message', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        { error: { code: 'jira_credentials_rejected', message: 'RAW JIRA 401: secret detail' } },
        422,
      ),
    );

    const error = await saveJiraConnection(input).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(JiraApiError);
    expect((error as JiraApiError).message).not.toContain('RAW JIRA');
    expect((error as JiraApiError).message).not.toContain('secret detail');
  });
});
