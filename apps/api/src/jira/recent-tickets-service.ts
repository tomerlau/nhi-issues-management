import type { DatabaseSync } from 'node:sqlite';
import type { AuthContext } from '../auth/auth-context.js';
import {
  TicketProvenanceRepository,
  type RecentTicketCandidate,
  type RecentTicketCandidateCursor,
} from '../repositories/ticket-provenance-repository.js';
import { JiraConnectionRepository } from '../repositories/jira-connection-repository.js';
import { loadTenantConnection } from './jira-connection-loader.js';
import type { HydratedJiraIssue, FetchLike, JiraClient } from './jira-client.js';

/** Fixed internal batch size for loading local provenance candidates. */
const INTERNAL_BATCH_SIZE = 25;

/** Maximum number of valid tickets returned to the client. */
const MAX_RESULTS = 10;

/**
 * One returned recent ticket. Membership and order come from local provenance,
 * but every displayed value (current key, title, Jira creation time) comes from
 * the live Jira hydration, and the URL is built only from the validated current
 * Jira origin.
 */
export interface RecentTicketItem {
  issueId: string;
  issueKey: string;
  title: string;
  createdAt: string;
  url: string;
}

/**
 * Sanitized outcome of a recent-tickets read. On success it carries at most ten
 * tickets in stable local provenance order. Every failure mirrors the existing
 * sanitized Jira outcomes; no variant carries the plaintext token, raw Jira
 * content, or internal error detail.
 */
export type RecentTicketsOutcome =
  | { status: 'ok'; tickets: RecentTicketItem[] }
  | { status: 'not_connected' }
  | { status: 'credentials_rejected' }
  | { status: 'timeout' }
  | { status: 'unavailable' }
  | { status: 'configuration_error' };

/** Already-normalized recent-tickets query input. */
export interface RecentTicketsInput {
  /** Normalized (trimmed, uppercased) Jira project key. */
  projectKey: string;
}

export interface RecentTicketsServiceOptions {
  db: DatabaseSync;
  encryptionKey: Buffer;
  fetch: FetchLike;
  timeoutMs?: number;
}

/**
 * Reads the ten most recent tickets created through this application for a single
 * tenant, the currently connected Jira site, and a selected project.
 *
 * Trust boundaries:
 * - Local provenance determines membership and stable order (created_at DESC,
 *   id DESC). Only rows for the authenticated tenant, the current connected site
 *   URL, and the normalized project key are considered.
 * - Jira determines the current title, issue key, project, and creation time.
 * - The connection is loaded exactly once; a single client and origin snapshot is
 *   reused for every batch, so one request never mixes two Jira sites.
 * - Local candidates are loaded internally in fixed batches and hydrated with one
 *   bulk fetch per batch; deleted, moved, and inaccessible issues are skipped and
 *   later batches are loaded until ten valid tickets are found or candidates run
 *   out. Pagination is internal and never user-controlled.
 */
export class RecentTicketsService {
  private readonly provenance: TicketProvenanceRepository;
  private readonly connections: JiraConnectionRepository;
  private readonly encryptionKey: Buffer;
  private readonly fetch: FetchLike;
  private readonly timeoutMs?: number;

  constructor(options: RecentTicketsServiceOptions) {
    this.provenance = new TicketProvenanceRepository(options.db);
    this.connections = new JiraConnectionRepository(options.db);
    this.encryptionKey = options.encryptionKey;
    this.fetch = options.fetch;
    this.timeoutMs = options.timeoutMs;
  }

  async listRecentTickets(
    context: AuthContext,
    input: RecentTicketsInput,
  ): Promise<RecentTicketsOutcome> {
    // Load the shared connection exactly once and reuse this client/origin for
    // every batch; the connection is never reloaded mid-request.
    const loaded = loadTenantConnection(
      {
        repository: this.connections,
        encryptionKey: this.encryptionKey,
        fetch: this.fetch,
        timeoutMs: this.timeoutMs,
      },
      context,
    );
    if (!loaded.ok) {
      return { status: loaded.status };
    }
    const { client, origin, siteUrl } = loaded.connection;

    const tickets: RecentTicketItem[] = [];
    let cursor: RecentTicketCandidateCursor | undefined;

    while (tickets.length < MAX_RESULTS) {
      const candidates = this.provenance.listRecentCandidates({
        tenantId: context.tenantId,
        jiraSiteUrl: siteUrl,
        jiraProjectKey: input.projectKey,
        limit: INTERNAL_BATCH_SIZE,
        cursor,
      });
      if (candidates.length === 0) {
        break;
      }

      const hydration = await this.hydrateBatch(client, candidates, input.projectKey, origin);
      if (!hydration.ok) {
        return { status: hydration.status };
      }
      for (const item of hydration.items) {
        if (tickets.length >= MAX_RESULTS) {
          break;
        }
        tickets.push(item);
      }

      // Advance the internal cursor to the last loaded candidate.
      const last = candidates[candidates.length - 1];
      cursor = { createdAt: last.createdAt, id: last.id };

      // A short batch means local candidates are exhausted.
      if (candidates.length < INTERNAL_BATCH_SIZE) {
        break;
      }
    }

    return { status: 'ok', tickets };
  }

  /**
   * Hydrate one batch with a single bulk fetch, then rebuild the result in local
   * provenance order. A complete bulk failure fails the whole request. Within a
   * successful response, a candidate whose issue Jira omitted (deleted, moved
   * away, or inaccessible) is skipped, and an issue whose current project differs
   * from the selected project (a moved issue) is skipped.
   */
  private async hydrateBatch(
    client: JiraClient,
    candidates: RecentTicketCandidate[],
    projectKey: string,
    origin: string,
  ): Promise<
    | { ok: true; items: RecentTicketItem[] }
    | { ok: false; status: 'credentials_rejected' | 'timeout' | 'unavailable' }
  > {
    const result = await client.bulkFetchIssues(candidates.map((candidate) => candidate.jiraIssueId));
    if (!result.ok) {
      return { ok: false, status: result.reason };
    }

    // Map validated issues by immutable id; Jira may return any order.
    const byId = new Map<string, HydratedJiraIssue>();
    for (const issue of result.issues) {
      byId.set(issue.id, issue);
    }

    // Rebuild in local provenance order, applying skip rules.
    const items: RecentTicketItem[] = [];
    for (const candidate of candidates) {
      const issue = byId.get(candidate.jiraIssueId);
      if (!issue) {
        continue;
      }
      // Skip an issue that currently belongs to another project (it moved).
      if (issue.projectKey !== projectKey) {
        continue;
      }
      items.push({
        issueId: issue.id,
        issueKey: issue.key,
        title: issue.summary,
        createdAt: issue.created,
        url: `${origin}/browse/${encodeURIComponent(issue.key)}`,
      });
    }
    return { ok: true, items };
  }
}
