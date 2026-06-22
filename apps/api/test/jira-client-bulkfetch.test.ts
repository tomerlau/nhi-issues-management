import { describe, expect, it, vi } from 'vitest';
import { JiraClient, type FetchLike } from '../src/jira/jira-client.js';

const origin = 'https://example.atlassian.net';
const email = 'a@example.com';
const apiToken = 'secret-token';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function client(fetch: FetchLike, timeoutMs?: number): JiraClient {
  return new JiraClient({ origin, email, apiToken, fetch, timeoutMs });
}

/** A fully-formed hydrated issue payload as Jira returns it in a bulk fetch. */
function issuePayload(
  id: string,
  key: string,
  summary: string,
  created: string,
  projectKey: string,
): Record<string, unknown> {
  return { id, key, fields: { summary, created, project: { key: projectKey } } };
}

describe('JiraClient.bulkFetchIssues', () => {
  describe('request construction', () => {
    it('POSTs to the bulkfetch path with the immutable ids and minimal fields', async () => {
      const fetchMock = vi.fn(async () => jsonResponse({ issues: [] }));
      await client(fetchMock as unknown as FetchLike).bulkFetchIssues(['10001', '10002']);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe('https://example.atlassian.net/rest/api/3/issue/bulkfetch');
      expect(init.method).toBe('POST');
      expect(init.redirect).toBe('manual');
      const headers = init.headers as Record<string, string>;
      expect(headers.Authorization).toBe(
        `Basic ${Buffer.from(`${email}:${apiToken}`).toString('base64')}`,
      );
      expect(JSON.parse(init.body as string)).toEqual({
        issueIdsOrKeys: ['10001', '10002'],
        fields: ['summary', 'created', 'project'],
      });
    });
  });

  describe('successful hydration', () => {
    it('returns validated issues mapped by their immutable id', async () => {
      const fetchMock = vi.fn(async () =>
        jsonResponse({
          issues: [
            issuePayload('10001', 'ABC-1', 'First', '2026-01-01T00:00:00.000Z', 'ABC'),
            issuePayload('10002', 'ABC-2', 'Second', '2026-01-02T00:00:00.000Z', 'ABC'),
          ],
        }),
      ) as unknown as FetchLike;
      const result = await client(fetchMock).bulkFetchIssues(['10001', '10002']);
      expect(result).toEqual({
        ok: true,
        issues: [
          { id: '10001', key: 'ABC-1', summary: 'First', created: '2026-01-01T00:00:00.000Z', projectKey: 'ABC' },
          { id: '10002', key: 'ABC-2', summary: 'Second', created: '2026-01-02T00:00:00.000Z', projectKey: 'ABC' },
        ],
      });
    });

    it('preserves whatever order Jira returns (the caller reorders)', async () => {
      const fetchMock = vi.fn(async () =>
        jsonResponse({
          issues: [
            issuePayload('10002', 'ABC-2', 'Second', '2026-01-02T00:00:00.000Z', 'ABC'),
            issuePayload('10001', 'ABC-1', 'First', '2026-01-01T00:00:00.000Z', 'ABC'),
          ],
        }),
      ) as unknown as FetchLike;
      const result = await client(fetchMock).bulkFetchIssues(['10001', '10002']);
      expect(result.ok && result.issues.map((i) => i.id)).toEqual(['10002', '10001']);
    });

    it('omits requested issues Jira did not return and ignores issueErrors', async () => {
      const fetchMock = vi.fn(async () =>
        jsonResponse({
          issues: [issuePayload('10001', 'ABC-1', 'First', '2026-01-01T00:00:00.000Z', 'ABC')],
          issueErrors: [{ issueId: '10002', errorMessages: ['secret internal detail'] }],
        }),
      ) as unknown as FetchLike;
      const result = await client(fetchMock).bulkFetchIssues(['10001', '10002']);
      expect(result).toEqual({
        ok: true,
        issues: [
          { id: '10001', key: 'ABC-1', summary: 'First', created: '2026-01-01T00:00:00.000Z', projectKey: 'ABC' },
        ],
      });
      expect(JSON.stringify(result)).not.toContain('secret internal detail');
    });
  });

  describe('malformed success responses collapse to unavailable', () => {
    it('rejects a response missing the top-level issues array', async () => {
      const fetchMock = vi.fn(async () => jsonResponse({ values: [] })) as unknown as FetchLike;
      expect(await client(fetchMock).bulkFetchIssues(['10001'])).toEqual({
        ok: false,
        reason: 'unavailable',
      });
    });

    it('rejects the whole response when a single issue is malformed', async () => {
      const fetchMock = vi.fn(async () =>
        jsonResponse({
          issues: [
            issuePayload('10001', 'ABC-1', 'First', '2026-01-01T00:00:00.000Z', 'ABC'),
            { id: '10002', key: 'ABC-2', fields: { created: '2026-01-02T00:00:00.000Z', project: { key: 'ABC' } } },
          ],
        }),
      ) as unknown as FetchLike;
      expect(await client(fetchMock).bulkFetchIssues(['10001', '10002'])).toEqual({
        ok: false,
        reason: 'unavailable',
      });
    });

    it.each([
      ['missing summary', { id: '1', key: 'A-1', fields: { created: 'c', project: { key: 'A' } } }],
      ['missing created', { id: '1', key: 'A-1', fields: { summary: 's', project: { key: 'A' } } }],
      ['missing project key', { id: '1', key: 'A-1', fields: { summary: 's', created: 'c', project: {} } }],
      ['missing fields', { id: '1', key: 'A-1' }],
      ['empty id', { id: '', key: 'A-1', fields: { summary: 's', created: 'c', project: { key: 'A' } } }],
      ['empty key', { id: '1', key: '', fields: { summary: 's', created: 'c', project: { key: 'A' } } }],
    ])('rejects an issue with %s', async (_label, payload) => {
      const fetchMock = vi.fn(async () => jsonResponse({ issues: [payload] })) as unknown as FetchLike;
      expect(await client(fetchMock).bulkFetchIssues(['1'])).toEqual({
        ok: false,
        reason: 'unavailable',
      });
    });

    it('rejects a non-empty but unparseable created timestamp without leaking it', async () => {
      const fetchMock = vi.fn(async () =>
        jsonResponse({
          issues: [issuePayload('10001', 'ABC-1', 'Valid summary', 'not-a-date', 'ABC')],
        }),
      ) as unknown as FetchLike;
      const result = await client(fetchMock).bulkFetchIssues(['10001']);
      expect(result).toEqual({ ok: false, reason: 'unavailable' });
      expect(JSON.stringify(result)).not.toContain('not-a-date');
    });

    it('rejects invalid JSON without leaking the body', async () => {
      const fetchMock = vi.fn(
        async () =>
          new Response('not json secret-body', { status: 200, headers: { 'Content-Type': 'application/json' } }),
      ) as unknown as FetchLike;
      const result = await client(fetchMock).bulkFetchIssues(['1']);
      expect(result).toEqual({ ok: false, reason: 'unavailable' });
      expect(JSON.stringify(result)).not.toContain('secret-body');
    });
  });

  describe('sanitized transport failures', () => {
    it('maps 401 to credentials_rejected', async () => {
      const fetchMock = vi.fn(async () => new Response('', { status: 401 })) as unknown as FetchLike;
      expect(await client(fetchMock).bulkFetchIssues(['1'])).toEqual({
        ok: false,
        reason: 'credentials_rejected',
      });
    });

    it.each([403, 404, 429, 500, 503])('maps %s to unavailable', async (status) => {
      const fetchMock = vi.fn(
        async () => new Response('upstream internal trace', { status }),
      ) as unknown as FetchLike;
      const result = await client(fetchMock).bulkFetchIssues(['1']);
      expect(result).toEqual({ ok: false, reason: 'unavailable' });
      expect(JSON.stringify(result)).not.toContain('upstream internal trace');
    });

    it('maps a redirect (manual) to unavailable and never follows the location', async () => {
      const fetchMock = vi.fn(
        async () => new Response('', { status: 302, headers: { Location: 'https://attacker.example/evil' } }),
      ) as unknown as FetchLike;
      const result = await client(fetchMock).bulkFetchIssues(['1']);
      expect(result).toEqual({ ok: false, reason: 'unavailable' });
      expect(JSON.stringify(result)).not.toContain('attacker.example');
    });

    it('maps a network error to unavailable without leaking the cause', async () => {
      const fetchMock = vi.fn(async () => {
        throw new Error('ECONNREFUSED secret-internal-detail');
      }) as unknown as FetchLike;
      const result = await client(fetchMock).bulkFetchIssues(['1']);
      expect(result).toEqual({ ok: false, reason: 'unavailable' });
      expect(JSON.stringify(result)).not.toContain('ECONNREFUSED');
    });

    it('maps an abort to timeout', async () => {
      const fetchMock = vi.fn(async () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        throw error;
      }) as unknown as FetchLike;
      expect(await client(fetchMock).bulkFetchIssues(['1'])).toEqual({ ok: false, reason: 'timeout' });
    });
  });
});
