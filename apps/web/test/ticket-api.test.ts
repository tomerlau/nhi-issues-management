import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createTicket,
  isUncertainTicketOutcome,
  messageForTicketError,
  TicketApiError,
  type TicketErrorKind,
} from '../src/api/tickets';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const fetchMock = vi.fn<typeof fetch>();

const input = {
  projectKey: 'SCRUM',
  title: 'Stale Service Account: svc-deploy-prod',
  description: 'Finding details\nwith a second line',
};

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

describe('request shape', () => {
  it('posts the exact path, method, headers, credentials, and body', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ issueId: '10005', issueKey: 'SCRUM-6' }, 201));

    await createTicket(input);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/tickets');
    expect(init?.method).toBe('POST');
    expect(init?.credentials).toBe('same-origin');
    expect(init?.headers).toMatchObject({
      'Content-Type': 'application/json',
      Accept: 'application/json',
    });
    expect(init?.body).toBe(
      JSON.stringify({
        projectKey: 'SCRUM',
        title: 'Stale Service Account: svc-deploy-prod',
        description: 'Finding details\nwith a second line',
      }),
    );
  });

  it('sends only the three domain fields, never ownership fields', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ issueId: '1', issueKey: 'A-1' }, 201));

    await createTicket(input);

    const body = JSON.parse(fetchMock.mock.calls[0][1]?.body as string) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['description', 'projectKey', 'title']);
  });
});

describe('success parsing', () => {
  it('parses a 201 created response', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ issueId: '10005', issueKey: 'SCRUM-6' }, 201));

    await expect(createTicket(input)).resolves.toEqual({ issueId: '10005', issueKey: 'SCRUM-6' });
  });

  it('ignores unexpected extra fields in the success body', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ issueId: '10005', issueKey: 'SCRUM-6', self: 'https://x', secret: 'y' }, 201),
    );

    const ticket = await createTicket(input);

    expect(ticket).toEqual({ issueId: '10005', issueKey: 'SCRUM-6' });
    expect(ticket).not.toHaveProperty('self');
    expect(ticket).not.toHaveProperty('secret');
  });

  it('rejects a success body missing issueKey as a server error', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ issueId: '10005' }, 201));

    await expect(createTicket(input)).rejects.toMatchObject({ kind: 'server' });
  });

  it('rejects a success body with a non-string issueId as a server error', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ issueId: 10005, issueKey: 'SCRUM-6' }, 201));

    await expect(createTicket(input)).rejects.toMatchObject({ kind: 'server' });
  });

  it('rejects an empty issueKey as a server error', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ issueId: '10005', issueKey: '' }, 201));

    await expect(createTicket(input)).rejects.toMatchObject({ kind: 'server' });
  });

  it('rejects a non-JSON success body as a server error', async () => {
    fetchMock.mockResolvedValue(new Response('not json', { status: 201 }));

    await expect(createTicket(input)).rejects.toMatchObject({ kind: 'server' });
  });
});

describe('backend error-code mapping', () => {
  const cases: Array<[string, number, TicketErrorKind]> = [
    ['invalid_request', 400, 'invalid_request'],
    ['unauthenticated', 401, 'authentication'],
    ['jira_not_connected', 409, 'not_connected'],
    ['jira_project_inaccessible', 422, 'project_inaccessible'],
    ['jira_task_unsupported', 422, 'task_unsupported'],
    ['jira_credentials_rejected', 502, 'credentials_rejected'],
    ['jira_unreachable', 502, 'unreachable'],
    ['jira_timeout', 504, 'timeout'],
    ['jira_not_configured', 503, 'not_configured'],
    ['internal_error', 500, 'server'],
  ];

  for (const [code, status, kind] of cases) {
    it(`maps ${code} (${status}) to ${kind}`, async () => {
      fetchMock.mockResolvedValue(jsonResponse({ error: { code } }, status));

      await expect(createTicket(input)).rejects.toMatchObject({ kind });
    });
  }
});

describe('fallback behavior', () => {
  it('maps a 401 without a recognized code to an authentication error', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, 401));

    await expect(createTicket(input)).rejects.toMatchObject({ kind: 'authentication' });
  });

  it('maps an unknown status to a server error', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, 418));

    await expect(createTicket(input)).rejects.toMatchObject({ kind: 'server' });
  });

  it('maps an unknown error code to a server error', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: { code: 'some_new_code' } }, 400));

    await expect(createTicket(input)).rejects.toMatchObject({ kind: 'server' });
  });

  it('throws a network error when fetch rejects', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

    await expect(createTicket(input)).rejects.toMatchObject({ kind: 'network' });
  });
});

describe('safety guarantees', () => {
  it('never surfaces the raw backend error message', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        { error: { code: 'jira_unreachable', message: 'RAW JIRA 503: secret upstream detail' } },
        502,
      ),
    );

    const error = await createTicket(input).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TicketApiError);
    expect((error as TicketApiError).message).not.toContain('RAW JIRA');
    expect((error as TicketApiError).message).not.toContain('secret upstream detail');
  });

  it('does not retry automatically on failure', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: { code: 'jira_timeout' } }, 504));

    await createTicket(input).catch(() => undefined);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('flags every post-request failure as uncertain because creation is not idempotent', () => {
    expect(isUncertainTicketOutcome('timeout')).toBe(true);
    expect(isUncertainTicketOutcome('unreachable')).toBe(true);
    expect(isUncertainTicketOutcome('network')).toBe(true);
    expect(isUncertainTicketOutcome('server')).toBe(true);
  });

  it('flags pre-creation and definitive failures as certain', () => {
    const certain: TicketErrorKind[] = [
      'invalid_request',
      'authentication',
      'not_connected',
      'project_inaccessible',
      'task_unsupported',
      'credentials_rejected',
      'not_configured',
    ];
    for (const kind of certain) {
      expect(isUncertainTicketOutcome(kind)).toBe(false);
    }
  });

  it('warns about a possible duplicate in every uncertain message', () => {
    const uncertain: TicketErrorKind[] = ['timeout', 'unreachable', 'network', 'server'];
    for (const kind of uncertain) {
      const message = messageForTicketError(kind);
      expect(message).toMatch(/check jira/i);
      expect(message).toMatch(/duplicate/i);
    }
  });

  it('treats internal_error as an uncertain outcome through its server mapping', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: { code: 'internal_error' } }, 500));

    const error = await createTicket(input).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TicketApiError);
    expect(isUncertainTicketOutcome((error as TicketApiError).kind)).toBe(true);
    expect((error as TicketApiError).message).toMatch(/duplicate/i);
  });
});
