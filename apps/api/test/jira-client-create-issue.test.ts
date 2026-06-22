import { describe, expect, it, vi } from 'vitest';
import { JiraClient, type FetchLike } from '../src/jira/jira-client.js';

const origin = 'https://example.atlassian.net';
const email = 'a@example.com';
const apiToken = 'super-secret-token';

const baseInput = {
  projectId: '10001',
  issueTypeId: '2',
  summary: 'NHI finding: leaked service-account key',
  description: 'A single line description.',
};

function createdResponse(body: unknown, status = 201): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function client(fetch: FetchLike, timeoutMs?: number): JiraClient {
  return new JiraClient({ origin, email, apiToken, fetch, timeoutMs });
}

describe('JiraClient.createIssue', () => {
  describe('request construction', () => {
    it('POSTs to the issue endpoint with Basic auth, Accept, and JSON content type', async () => {
      const fetchMock = vi.fn(async () => createdResponse({ id: '500', key: 'ABC-1' }));
      await client(fetchMock as unknown as FetchLike).createIssue(baseInput);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe('https://example.atlassian.net/rest/api/3/issue');
      expect(init.method).toBe('POST');
      expect(init.redirect).toBe('manual');
      const headers = init.headers as Record<string, string>;
      expect(headers.Authorization).toBe(`Basic ${Buffer.from(`${email}:${apiToken}`).toString('base64')}`);
      expect(headers.Accept).toBe('application/json');
      expect(headers['Content-Type']).toBe('application/json');
    });

    it('sends the fixed project id, Task issue-type id, summary, and ADF description', async () => {
      const fetchMock = vi.fn(async () => createdResponse({ id: '500', key: 'ABC-1' }));
      await client(fetchMock as unknown as FetchLike).createIssue({
        projectId: '10001',
        issueTypeId: '2',
        summary: 'a summary',
        description: 'just one line',
      });

      const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      const body = JSON.parse(init.body as string);
      expect(body).toEqual({
        fields: {
          project: { id: '10001' },
          issuetype: { id: '2' },
          summary: 'a summary',
          description: {
            type: 'doc',
            version: 1,
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'just one line' }] }],
          },
        },
      });
    });

    it('preserves internal line breaks with deterministic ADF hardBreak nodes', async () => {
      const fetchMock = vi.fn(async () => createdResponse({ id: '1', key: 'K-1' }));
      await client(fetchMock as unknown as FetchLike).createIssue({
        ...baseInput,
        description: 'line1\nline2\n\nline4',
      });

      const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      const body = JSON.parse(init.body as string);
      expect(body.fields.description.content[0].content).toEqual([
        { type: 'text', text: 'line1' },
        { type: 'hardBreak' },
        { type: 'text', text: 'line2' },
        { type: 'hardBreak' },
        { type: 'hardBreak' },
        { type: 'text', text: 'line4' },
      ]);
    });

    it('never selects an issue type from caller-controlled fields beyond the resolved id', async () => {
      const fetchMock = vi.fn(async () => createdResponse({ id: '1', key: 'K-1' }));
      await client(fetchMock as unknown as FetchLike).createIssue(baseInput);
      const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      const body = JSON.parse(init.body as string);
      // The issue type is supplied only as the resolved id; no name/type selection.
      expect(body.fields.issuetype).toEqual({ id: '2' });
    });
  });

  describe('success', () => {
    it('returns the issue id and key from a valid response', async () => {
      const fetchMock = vi.fn(async () => createdResponse({ id: '10500', key: 'ABC-42' })) as FetchLike;
      expect(await client(fetchMock).createIssue(baseInput)).toEqual({
        ok: true,
        issueId: '10500',
        issueKey: 'ABC-42',
      });
    });
  });

  describe('runtime response validation', () => {
    it('rejects a missing issue id as unavailable', async () => {
      const fetchMock = vi.fn(async () => createdResponse({ key: 'ABC-1' })) as FetchLike;
      expect(await client(fetchMock).createIssue(baseInput)).toEqual({ ok: false, reason: 'unavailable' });
    });

    it('rejects a missing issue key as unavailable', async () => {
      const fetchMock = vi.fn(async () => createdResponse({ id: '500' })) as FetchLike;
      expect(await client(fetchMock).createIssue(baseInput)).toEqual({ ok: false, reason: 'unavailable' });
    });

    it('rejects empty id/key strings as unavailable', async () => {
      const fetchMock = vi.fn(async () => createdResponse({ id: '', key: '' })) as FetchLike;
      expect(await client(fetchMock).createIssue(baseInput)).toEqual({ ok: false, reason: 'unavailable' });
    });

    it('rejects malformed JSON as unavailable', async () => {
      const fetchMock = vi.fn(
        async () => new Response('<html>not json</html>', { status: 201 }),
      ) as FetchLike;
      expect(await client(fetchMock).createIssue(baseInput)).toEqual({ ok: false, reason: 'unavailable' });
    });
  });

  describe('status mapping', () => {
    it('maps 401 to credentials_rejected', async () => {
      const fetchMock = vi.fn(async () => new Response('', { status: 401 })) as FetchLike;
      expect(await client(fetchMock).createIssue(baseInput)).toEqual({
        ok: false,
        reason: 'credentials_rejected',
      });
    });

    it('maps 403 to unavailable (creation rejected, not a credential problem here)', async () => {
      const fetchMock = vi.fn(async () => new Response('', { status: 403 })) as FetchLike;
      expect(await client(fetchMock).createIssue(baseInput)).toEqual({ ok: false, reason: 'unavailable' });
    });

    it('maps 404 to unavailable', async () => {
      const fetchMock = vi.fn(async () => new Response('', { status: 404 })) as FetchLike;
      expect(await client(fetchMock).createIssue(baseInput)).toEqual({ ok: false, reason: 'unavailable' });
    });

    it('maps a 400 issue-creation rejection to unavailable', async () => {
      const fetchMock = vi.fn(
        async () => new Response(JSON.stringify({ errors: { summary: 'required' } }), { status: 400 }),
      ) as FetchLike;
      expect(await client(fetchMock).createIssue(baseInput)).toEqual({ ok: false, reason: 'unavailable' });
    });

    it('maps 429 rate limiting to unavailable', async () => {
      const fetchMock = vi.fn(async () => new Response('', { status: 429 })) as FetchLike;
      expect(await client(fetchMock).createIssue(baseInput)).toEqual({ ok: false, reason: 'unavailable' });
    });

    it('maps a 5xx to unavailable', async () => {
      const fetchMock = vi.fn(async () => new Response('', { status: 503 })) as FetchLike;
      expect(await client(fetchMock).createIssue(baseInput)).toEqual({ ok: false, reason: 'unavailable' });
    });

    it('maps a 3xx redirect (not followed) to unavailable', async () => {
      const fetchMock = vi.fn(
        async () => new Response('', { status: 302, headers: { Location: 'https://evil.example' } }),
      ) as FetchLike;
      expect(await client(fetchMock).createIssue(baseInput)).toEqual({ ok: false, reason: 'unavailable' });
    });

    it('maps a network failure to unavailable', async () => {
      const fetchMock = vi.fn(async () => {
        throw new Error('ECONNREFUSED secret-internal-detail');
      }) as FetchLike;
      expect(await client(fetchMock).createIssue(baseInput)).toEqual({ ok: false, reason: 'unavailable' });
    });
  });

  describe('timeout handling', () => {
    it('maps an abort during fetch to timeout', async () => {
      const fetchMock = vi.fn(async () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        throw error;
      }) as FetchLike;
      expect(await client(fetchMock).createIssue(baseInput)).toEqual({ ok: false, reason: 'timeout' });
    });

    it('maps a timeout during the body read to timeout', async () => {
      const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
        const signal = init?.signal;
        const json = () =>
          new Promise((_resolve, reject) => {
            signal?.addEventListener('abort', () => reject(new Error('body read aborted')));
          });
        return { status: 201, json } as unknown as Response;
      }) as unknown as FetchLike;
      expect(await client(fetchMock, 5).createIssue(baseInput)).toEqual({ ok: false, reason: 'timeout' });
    });

    it('maps an invalid response during body reading (non-timeout error) to unavailable', async () => {
      const fetchMock = vi.fn(async () => {
        return {
          status: 201,
          json: async () => {
            throw new Error('parse failure secret-detail');
          },
        } as unknown as Response;
      }) as unknown as FetchLike;
      expect(await client(fetchMock).createIssue(baseInput)).toEqual({ ok: false, reason: 'unavailable' });
    });
  });

  describe('no upstream content leaks', () => {
    it('never includes raw upstream errors or credentials in outcomes', async () => {
      const fetchMock = vi.fn(async () => {
        throw new Error('connect ECONNREFUSED 10.0.0.1:443 leak-detail');
      }) as FetchLike;
      const result = await client(fetchMock).createIssue(baseInput);
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain('ECONNREFUSED');
      expect(serialized).not.toContain('leak-detail');
      expect(serialized).not.toContain(apiToken);
    });
  });
});
