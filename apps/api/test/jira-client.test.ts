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

/** A normal project response with a non-subtask issue type named exactly "Task". */
function projectBody(overrides?: { issueTypes?: unknown }): Record<string, unknown> {
  return {
    id: '10001',
    key: 'ABC',
    issueTypes: overrides?.issueTypes ?? [
      { id: '1', name: 'Bug', subtask: false },
      { id: '2', name: 'Task', subtask: false },
      { id: '3', name: 'Sub-task', subtask: true },
    ],
  };
}

describe('JiraClient', () => {
  describe('request construction', () => {
    it('builds the expected Basic Authorization header, Accept, and redirect: manual', async () => {
      const fetchMock = vi.fn(async () => jsonResponse({ accountId: 'acc-1' }));
      await client(fetchMock as unknown as FetchLike).loadAccountIdentity();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe('https://example.atlassian.net/rest/api/3/myself');
      const headers = init.headers as Record<string, string>;
      expect(headers.Authorization).toBe(`Basic ${Buffer.from(`${email}:${apiToken}`).toString('base64')}`);
      expect(headers.Accept).toBe('application/json');
      expect(init.redirect).toBe('manual');
    });

    it('constructs and percent-encodes the project URL from the validated origin', async () => {
      const fetchMock = vi.fn(async () => jsonResponse(projectBody()));
      await client(fetchMock as unknown as FetchLike).validateProject('A B/C');

      const [url] = fetchMock.mock.calls[0] as unknown as [string];
      expect(url).toBe('https://example.atlassian.net/rest/api/3/project/A%20B%2FC?expand=issueTypes');
      // The raw, un-encoded identifier never appears in the path.
      expect(url).not.toContain('A B/C');
    });

    it('does not use an arbitrary response URL for the request target', async () => {
      // The response advertises a different URL; the client must ignore it and
      // only ever request the origin-built URL.
      const fetchMock = vi.fn(async () => {
        const res = jsonResponse(projectBody());
        Object.defineProperty(res, 'url', { value: 'https://attacker.example/evil' });
        return res;
      });
      await client(fetchMock as unknown as FetchLike).validateProject('ABC');
      const [url] = fetchMock.mock.calls[0] as unknown as [string];
      expect(url.startsWith(origin)).toBe(true);
    });
  });

  describe('loadAccountIdentity', () => {
    it('returns the account id for a valid response', async () => {
      const fetchMock = vi.fn(async () => jsonResponse({ accountId: 'acc-123' })) as FetchLike;
      expect(await client(fetchMock).loadAccountIdentity()).toEqual({ ok: true, accountId: 'acc-123' });
    });

    it('maps 401 to credentials_rejected', async () => {
      const fetchMock = vi.fn(async () => new Response('', { status: 401 })) as FetchLike;
      expect(await client(fetchMock).loadAccountIdentity()).toEqual({
        ok: false,
        reason: 'credentials_rejected',
      });
    });

    it('maps 403 to credentials_rejected (credential verification treats it as rejected)', async () => {
      const fetchMock = vi.fn(async () => new Response('', { status: 403 })) as FetchLike;
      expect(await client(fetchMock).loadAccountIdentity()).toEqual({
        ok: false,
        reason: 'credentials_rejected',
      });
    });

    it('maps a missing accountId shape to unavailable', async () => {
      const fetchMock = vi.fn(async () => jsonResponse({ displayName: 'Alice' })) as FetchLike;
      expect(await client(fetchMock).loadAccountIdentity()).toEqual({ ok: false, reason: 'unavailable' });
    });
  });

  describe('validateProject success', () => {
    it('returns the project id, canonical key, and Task issue-type id', async () => {
      const fetchMock = vi.fn(async () => jsonResponse(projectBody())) as FetchLike;
      expect(await client(fetchMock).validateProject('ABC')).toEqual({
        ok: true,
        projectId: '10001',
        projectKey: 'ABC',
        taskIssueTypeId: '2',
      });
    });

    it('rejects a project without a Task issue type as task_unsupported', async () => {
      const fetchMock = vi.fn(async () =>
        jsonResponse(projectBody({ issueTypes: [{ id: '1', name: 'Bug', subtask: false }] })),
      ) as FetchLike;
      expect(await client(fetchMock).validateProject('ABC')).toEqual({
        ok: false,
        reason: 'task_unsupported',
      });
    });

    it('rejects a subtask-only "Task" as task_unsupported (not a normal Task)', async () => {
      const fetchMock = vi.fn(async () =>
        jsonResponse(projectBody({ issueTypes: [{ id: '9', name: 'Task', subtask: true }] })),
      ) as FetchLike;
      expect(await client(fetchMock).validateProject('ABC')).toEqual({
        ok: false,
        reason: 'task_unsupported',
      });
    });
  });

  describe('validateProject failure mapping', () => {
    it('maps 404 to project_inaccessible', async () => {
      const fetchMock = vi.fn(async () => new Response('', { status: 404 })) as FetchLike;
      expect(await client(fetchMock).validateProject('NOPE')).toEqual({
        ok: false,
        reason: 'project_inaccessible',
      });
    });

    it('maps 401 to credentials_rejected', async () => {
      const fetchMock = vi.fn(async () => new Response('', { status: 401 })) as FetchLike;
      expect(await client(fetchMock).validateProject('ABC')).toEqual({
        ok: false,
        reason: 'credentials_rejected',
      });
    });

    it('maps 403 to project_inaccessible (account cannot access the project, not bad credentials)', async () => {
      const fetchMock = vi.fn(async () => new Response('', { status: 403 })) as FetchLike;
      expect(await client(fetchMock).validateProject('ABC')).toEqual({
        ok: false,
        reason: 'project_inaccessible',
      });
    });

    it('maps a 3xx redirect (not followed) to unavailable', async () => {
      const fetchMock = vi.fn(
        async () => new Response('', { status: 302, headers: { Location: 'https://evil.example' } }),
      ) as FetchLike;
      expect(await client(fetchMock).validateProject('ABC')).toEqual({ ok: false, reason: 'unavailable' });
    });

    it('maps 429 rate limiting to unavailable', async () => {
      const fetchMock = vi.fn(async () => new Response('', { status: 429 })) as FetchLike;
      expect(await client(fetchMock).validateProject('ABC')).toEqual({ ok: false, reason: 'unavailable' });
    });

    it('maps a Jira 5xx to unavailable', async () => {
      const fetchMock = vi.fn(async () => new Response('', { status: 503 })) as FetchLike;
      expect(await client(fetchMock).validateProject('ABC')).toEqual({ ok: false, reason: 'unavailable' });
    });

    it('maps a network failure to unavailable', async () => {
      const fetchMock = vi.fn(async () => {
        throw new Error('ECONNREFUSED secret-internal-detail');
      }) as FetchLike;
      expect(await client(fetchMock).validateProject('ABC')).toEqual({ ok: false, reason: 'unavailable' });
    });

    it('maps malformed JSON to unavailable', async () => {
      const fetchMock = vi.fn(
        async () => new Response('<html>not json</html>', { status: 200 }),
      ) as FetchLike;
      expect(await client(fetchMock).validateProject('ABC')).toEqual({ ok: false, reason: 'unavailable' });
    });

    it('maps a malformed success shape (issueTypes not an array) to unavailable', async () => {
      const fetchMock = vi.fn(async () =>
        jsonResponse({ id: '1', key: 'ABC', issueTypes: 'nope' }),
      ) as FetchLike;
      expect(await client(fetchMock).validateProject('ABC')).toEqual({ ok: false, reason: 'unavailable' });
    });

    it('maps an abort during fetch to timeout', async () => {
      const fetchMock = vi.fn(async () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        throw error;
      }) as FetchLike;
      expect(await client(fetchMock).validateProject('ABC')).toEqual({ ok: false, reason: 'timeout' });
    });

    it('maps a timeout during the body read to timeout', async () => {
      // Headers resolve promptly, but the body read hangs until the timeout fires.
      const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
        const signal = init?.signal;
        const json = () =>
          new Promise((_resolve, reject) => {
            signal?.addEventListener('abort', () => reject(new Error('body read aborted')));
          });
        return { status: 200, json } as unknown as Response;
      }) as unknown as FetchLike;
      expect(await client(fetchMock, 5).validateProject('ABC')).toEqual({ ok: false, reason: 'timeout' });
    });
  });
});
