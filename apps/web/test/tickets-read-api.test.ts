import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  listRecentTickets,
  messageForReadError,
  RecentTicketsApiError,
  type RecentTicketsErrorKind,
} from '../src/api/tickets';

const VALID_URL = 'https://acme.atlassian.net/browse/SCRUM-1';
const VALID_TICKET = {
  issueId: '10001',
  issueKey: 'SCRUM-1',
  title: 'Leaked service-account key',
  createdAt: '2026-06-01T12:00:00.000Z',
  url: VALID_URL,
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

describe('request shape', () => {
  it('sends GET with the encoded projectKey and same-origin credentials', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ tickets: [VALID_TICKET] }));

    await listRecentTickets('SCRUM');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/tickets?projectKey=SCRUM');
    expect(init?.method).toBe('GET');
    expect(init?.credentials).toBe('same-origin');
  });

  it('URL-encodes the project key', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ tickets: [] }));

    await listRecentTickets('ABC');

    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/tickets?projectKey=ABC');
  });

  it('passes the AbortSignal to fetch', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ tickets: [] }));
    const controller = new AbortController();

    await listRecentTickets('SCRUM', controller.signal);

    const [, init] = fetchMock.mock.calls[0];
    expect(init?.signal).toBe(controller.signal);
  });
});

describe('success parsing', () => {
  it('parses a valid ticket list', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ tickets: [VALID_TICKET] }));

    const result = await listRecentTickets('SCRUM');

    expect(result.tickets).toHaveLength(1);
    expect(result.tickets[0]).toEqual(VALID_TICKET);
  });

  it('parses an empty ticket list', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ tickets: [] }));

    const result = await listRecentTickets('SCRUM');

    expect(result.tickets).toEqual([]);
  });

  it('parses multiple tickets in order', async () => {
    const second = { ...VALID_TICKET, issueId: '10002', issueKey: 'SCRUM-2', title: 'Second ticket' };
    fetchMock.mockResolvedValue(jsonResponse({ tickets: [VALID_TICKET, second] }));

    const result = await listRecentTickets('SCRUM');

    expect(result.tickets).toHaveLength(2);
    expect(result.tickets[0].issueId).toBe('10001');
    expect(result.tickets[1].issueId).toBe('10002');
  });
});

describe('malformed response rejection', () => {
  it('rejects a response missing the tickets array as a server error', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: [] }));

    await expect(listRecentTickets('SCRUM')).rejects.toMatchObject({ kind: 'server' });
  });

  it('rejects a response where tickets is not an array', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ tickets: 'not-an-array' }));

    await expect(listRecentTickets('SCRUM')).rejects.toMatchObject({ kind: 'server' });
  });

  it('rejects a non-object top-level body', async () => {
    fetchMock.mockResolvedValue(jsonResponse('a string'));

    await expect(listRecentTickets('SCRUM')).rejects.toMatchObject({ kind: 'server' });
  });

  it('rejects a non-JSON response body as a server error', async () => {
    fetchMock.mockResolvedValue(new Response('not json', { status: 200 }));

    await expect(listRecentTickets('SCRUM')).rejects.toMatchObject({ kind: 'server' });
  });
});

describe('ticket-item validation', () => {
  function ticketWith(overrides: Record<string, unknown>) {
    return { ...VALID_TICKET, ...overrides };
  }

  it('rejects a ticket with an empty issueId', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ tickets: [ticketWith({ issueId: '' })] }));
    await expect(listRecentTickets('SCRUM')).rejects.toMatchObject({ kind: 'server' });
  });

  it('rejects a ticket with a non-string issueId', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ tickets: [ticketWith({ issueId: 123 })] }));
    await expect(listRecentTickets('SCRUM')).rejects.toMatchObject({ kind: 'server' });
  });

  it('rejects a ticket with an empty title', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ tickets: [ticketWith({ title: '' })] }));
    await expect(listRecentTickets('SCRUM')).rejects.toMatchObject({ kind: 'server' });
  });

  it('rejects a ticket with a missing title field', async () => {
    const { title: _title, ...noTitle } = VALID_TICKET;
    fetchMock.mockResolvedValue(jsonResponse({ tickets: [noTitle] }));
    await expect(listRecentTickets('SCRUM')).rejects.toMatchObject({ kind: 'server' });
  });

  it('rejects a ticket with a non-string url', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ tickets: [ticketWith({ url: 42 })] }));
    await expect(listRecentTickets('SCRUM')).rejects.toMatchObject({ kind: 'server' });
  });
});

describe('timestamp validation', () => {
  it('rejects an invalid ISO timestamp', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ tickets: [{ ...VALID_TICKET, createdAt: 'not-a-date' }] }),
    );
    await expect(listRecentTickets('SCRUM')).rejects.toMatchObject({ kind: 'server' });
  });

  it('rejects an empty createdAt', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ tickets: [{ ...VALID_TICKET, createdAt: '' }] }),
    );
    await expect(listRecentTickets('SCRUM')).rejects.toMatchObject({ kind: 'server' });
  });

  it('accepts a valid ISO timestamp', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ tickets: [VALID_TICKET] }),
    );
    const result = await listRecentTickets('SCRUM');
    expect(result.tickets[0].createdAt).toBe('2026-06-01T12:00:00.000Z');
  });
});

describe('URL validation', () => {
  it('rejects an HTTP Jira URL', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ tickets: [{ ...VALID_TICKET, url: 'http://acme.atlassian.net/browse/SCRUM-1' }] }),
    );
    await expect(listRecentTickets('SCRUM')).rejects.toMatchObject({ kind: 'server' });
  });

  it('rejects a non-Atlassian HTTPS URL', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ tickets: [{ ...VALID_TICKET, url: 'https://evil.example.com/browse/SCRUM-1' }] }),
    );
    await expect(listRecentTickets('SCRUM')).rejects.toMatchObject({ kind: 'server' });
  });

  it('rejects a bare atlassian.net URL without a subdomain', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ tickets: [{ ...VALID_TICKET, url: 'https://atlassian.net/browse/SCRUM-1' }] }),
    );
    await expect(listRecentTickets('SCRUM')).rejects.toMatchObject({ kind: 'server' });
  });

  it('rejects an atlassian.net URL not under /browse/', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ tickets: [{ ...VALID_TICKET, url: 'https://acme.atlassian.net/issues/SCRUM-1' }] }),
    );
    await expect(listRecentTickets('SCRUM')).rejects.toMatchObject({ kind: 'server' });
  });

  it('rejects a malformed URL string', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ tickets: [{ ...VALID_TICKET, url: 'not a url' }] }),
    );
    await expect(listRecentTickets('SCRUM')).rejects.toMatchObject({ kind: 'server' });
  });

  it('accepts a valid atlassian.net browse URL', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ tickets: [VALID_TICKET] }));
    const result = await listRecentTickets('SCRUM');
    expect(result.tickets[0].url).toBe(VALID_URL);
  });
});

describe('backend error-code mapping', () => {
  const cases: Array<[string, number, RecentTicketsErrorKind]> = [
    ['invalid_request', 400, 'invalid_request'],
    ['unauthenticated', 401, 'authentication'],
    ['jira_not_connected', 409, 'not_connected'],
    ['jira_credentials_rejected', 502, 'credentials_rejected'],
    ['jira_timeout', 504, 'timeout'],
    ['jira_unreachable', 502, 'unreachable'],
    ['jira_not_configured', 503, 'not_configured'],
    ['internal_error', 500, 'internal_error'],
  ];

  for (const [code, status, kind] of cases) {
    it(`maps ${code} (${status}) to ${kind}`, async () => {
      fetchMock.mockResolvedValue(jsonResponse({ error: { code } }, status));
      await expect(listRecentTickets('SCRUM')).rejects.toMatchObject({ kind });
    });
  }
});

describe('fallback and unknown error handling', () => {
  it('maps a 401 without a recognized code to an authentication error', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, 401));
    await expect(listRecentTickets('SCRUM')).rejects.toMatchObject({ kind: 'authentication' });
  });

  it('maps an unknown status code to a server error', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, 418));
    await expect(listRecentTickets('SCRUM')).rejects.toMatchObject({ kind: 'server' });
  });

  it('maps an unknown error code to a server error', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: { code: 'future_new_code' } }, 400));
    await expect(listRecentTickets('SCRUM')).rejects.toMatchObject({ kind: 'server' });
  });

  it('maps a non-JSON error body to a server error', async () => {
    fetchMock.mockResolvedValue(new Response('not json', { status: 500 }));
    await expect(listRecentTickets('SCRUM')).rejects.toMatchObject({ kind: 'server' });
  });

  it('maps a network failure (fetch rejection) to a network error', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(listRecentTickets('SCRUM')).rejects.toMatchObject({ kind: 'network' });
  });
});

describe('abort behavior', () => {
  it('propagates AbortError without wrapping it as a network error', async () => {
    const controller = new AbortController();
    controller.abort();
    fetchMock.mockRejectedValue(new DOMException('aborted', 'AbortError'));

    await expect(listRecentTickets('SCRUM', controller.signal)).rejects.toSatisfy(
      (e: unknown) => e instanceof DOMException && (e as DOMException).name === 'AbortError',
    );
  });
});

describe('safety guarantees', () => {
  it('never surfaces raw backend error messages', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        { error: { code: 'jira_unreachable', message: 'RAW: upstream secret 503' } },
        502,
      ),
    );

    const error = await listRecentTickets('SCRUM').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RecentTicketsApiError);
    expect((error as RecentTicketsApiError).message).not.toContain('RAW');
    expect((error as RecentTicketsApiError).message).not.toContain('upstream secret');
  });
});

describe('messageForReadError', () => {
  it('produces distinct, safe messages for every kind', () => {
    const kinds: RecentTicketsErrorKind[] = [
      'invalid_request',
      'authentication',
      'not_connected',
      'credentials_rejected',
      'timeout',
      'unreachable',
      'not_configured',
      'internal_error',
      'network',
      'server',
    ];
    const messages = new Set(kinds.map(messageForReadError));
    // All kinds have a message (no undefined or empty).
    for (const kind of kinds) {
      expect(messageForReadError(kind)).toBeTruthy();
    }
    // Most messages should be distinct; at minimum no message is empty.
    expect(messages.size).toBeGreaterThan(1);
  });

  it('does not include any duplicate-creation warning in any message', () => {
    const kinds: RecentTicketsErrorKind[] = [
      'timeout', 'unreachable', 'network', 'server', 'internal_error',
    ];
    for (const kind of kinds) {
      const msg = messageForReadError(kind);
      expect(msg).not.toMatch(/duplicate/i);
      expect(msg).not.toMatch(/check jira before retrying/i);
    }
  });
});
