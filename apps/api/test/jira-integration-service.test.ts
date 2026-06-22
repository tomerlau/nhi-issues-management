import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JiraIntegrationService } from '../src/jira/jira-integration-service.js';
import { JiraConnectionRepository } from '../src/repositories/jira-connection-repository.js';
import { encryptToken } from '../src/jira/token-cipher.js';
import type { FetchLike } from '../src/jira/jira-client.js';
import type { AuthContext } from '../src/auth/auth-context.js';
import { createSeededMemoryDb } from './helpers.js';

const PLAINTEXT_TOKEN = 'super-secret-jira-api-token';

const acmeAlice: AuthContext = { userId: 'user-acme-alice', tenantId: 'tenant-acme' };
const acmeBob: AuthContext = { userId: 'user-acme-bob', tenantId: 'tenant-acme' };
const globexAlice: AuthContext = { userId: 'user-globex-alice', tenantId: 'tenant-globex' };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function validProjectFetch(): FetchLike {
  return vi.fn(async () =>
    jsonResponse({
      id: '10001',
      key: 'ABC',
      issueTypes: [
        { id: '1', name: 'Bug', subtask: false },
        { id: '2', name: 'Task', subtask: false },
      ],
    }),
  ) as unknown as FetchLike;
}

describe('JiraIntegrationService', () => {
  let db: DatabaseSync;
  const key = randomBytes(32);

  beforeEach(async () => {
    db = await createSeededMemoryDb();
  });

  afterEach(() => {
    db.close();
  });

  /** Insert a tenant connection storing a v2 token bound to the tenant. */
  function storeConnection(
    context: AuthContext,
    options: { token?: string; encryptedToken?: string; siteUrl?: string } = {},
  ): void {
    const repository = new JiraConnectionRepository(db);
    repository.upsert(context.tenantId, {
      configuredByUserId: context.userId,
      siteUrl: options.siteUrl ?? 'https://acme.atlassian.net',
      email: 'configurer@example.com',
      accountId: 'acc-1',
      encryptedToken:
        options.encryptedToken ??
        encryptToken(options.token ?? PLAINTEXT_TOKEN, key, { tenantId: context.tenantId }),
    });
  }

  function service(fetch: FetchLike, encryptionKey: Buffer = key): JiraIntegrationService {
    return new JiraIntegrationService({ db, encryptionKey, fetch });
  }

  it('returns not_connected when the tenant has no connection', async () => {
    const fetch = vi.fn() as unknown as FetchLike;
    const result = await service(fetch).validateProject(acmeAlice, 'ABC');
    expect(result).toEqual({ status: 'not_connected' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('loads the shared connection by tenant for any tenant user (not the requester)', async () => {
    // Alice configures the connection; Bob (same tenant) validates a project.
    storeConnection(acmeAlice);
    const fetch = validProjectFetch();
    const result = await service(fetch).validateProject(acmeBob, 'ABC');
    expect(result).toEqual({
      status: 'valid',
      projectId: '10001',
      projectKey: 'ABC',
      taskIssueTypeId: '2',
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('decrypts successfully regardless of which tenant user configured it', async () => {
    // Configured by Alice, used by Bob: decryption is tenant-bound, not user-bound.
    storeConnection(acmeAlice);
    const result = await service(validProjectFetch()).validateProject(acmeBob, 'ABC');
    expect(result.status).toBe('valid');
  });

  it('keeps tenants isolated: another tenant cannot access or use the connection', async () => {
    storeConnection(acmeAlice);
    const fetch = vi.fn() as unknown as FetchLike;
    // Globex has no connection of its own and cannot reach Acme's.
    const result = await service(fetch).validateProject(globexAlice, 'ABC');
    expect(result).toEqual({ status: 'not_connected' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('maps a wrong encryption key to a sanitized configuration_error without a network call', async () => {
    storeConnection(acmeAlice); // encrypted with `key`
    const fetch = vi.fn() as unknown as FetchLike;
    const result = await service(fetch, randomBytes(32)).validateProject(acmeAlice, 'ABC');
    expect(result).toEqual({ status: 'configuration_error' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('maps corrupted ciphertext to configuration_error', async () => {
    const good = encryptToken(PLAINTEXT_TOKEN, key, { tenantId: acmeAlice.tenantId });
    const parts = good.split('.');
    parts[2] = parts[2].slice(0, -1) + (parts[2].endsWith('A') ? 'B' : 'A');
    storeConnection(acmeAlice, { encryptedToken: parts.join('.') });
    const fetch = vi.fn() as unknown as FetchLike;
    const result = await service(fetch).validateProject(acmeAlice, 'ABC');
    expect(result).toEqual({ status: 'configuration_error' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('maps unsupported (v1) ciphertext to configuration_error', async () => {
    const v2 = encryptToken(PLAINTEXT_TOKEN, key, { tenantId: acmeAlice.tenantId });
    storeConnection(acmeAlice, { encryptedToken: v2.replace(/^v2\./, 'v1.') });
    const fetch = vi.fn() as unknown as FetchLike;
    const result = await service(fetch).validateProject(acmeAlice, 'ABC');
    expect(result).toEqual({ status: 'configuration_error' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('makes no outbound request when the stored site URL is invalid', async () => {
    storeConnection(acmeAlice, { siteUrl: 'http://not-atlassian.example' });
    const fetch = vi.fn() as unknown as FetchLike;
    const result = await service(fetch).validateProject(acmeAlice, 'ABC');
    expect(result).toEqual({ status: 'configuration_error' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('maps an inaccessible project distinctly from an unsupported Task type', async () => {
    storeConnection(acmeAlice);
    const notFound = vi.fn(async () => new Response('', { status: 404 })) as unknown as FetchLike;
    expect((await service(notFound).validateProject(acmeAlice, 'NOPE')).status).toBe(
      'project_inaccessible',
    );

    const noTask = vi.fn(async () =>
      jsonResponse({ id: '1', key: 'ABC', issueTypes: [{ id: '1', name: 'Bug', subtask: false }] }),
    ) as unknown as FetchLike;
    expect((await service(noTask).validateProject(acmeAlice, 'ABC')).status).toBe('task_unsupported');
  });

  it('never returns the plaintext token in any result', async () => {
    storeConnection(acmeAlice);
    const valid = await service(validProjectFetch()).validateProject(acmeAlice, 'ABC');
    expect(JSON.stringify(valid)).not.toContain(PLAINTEXT_TOKEN);

    storeConnection(acmeBob, { siteUrl: 'http://bad.example' });
    const configError = await service(vi.fn() as unknown as FetchLike).validateProject(acmeBob, 'ABC');
    expect(JSON.stringify(configError)).not.toContain(PLAINTEXT_TOKEN);
  });
});
