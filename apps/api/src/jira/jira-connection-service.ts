import type { DatabaseSync } from 'node:sqlite';
import {
  JiraConnectionRepository,
  type JiraConnection,
} from '../repositories/jira-connection-repository.js';
import type { AuthContext } from '../auth/auth-context.js';
import { encryptToken } from './token-cipher.js';
import { verifyJiraCredentials, type FetchLike } from './jira-verifier.js';

/** Safe connection status returned to clients. Never includes credentials. */
export type ConnectionStatus =
  | { connected: false }
  | { connected: true; siteUrl: string; email: string };

export type ConnectOutcome =
  | { status: 'connected'; siteUrl: string; email: string }
  | { status: 'credentials_rejected' }
  | { status: 'timeout' }
  | { status: 'unavailable' };

export interface ConnectInput {
  /** Already-validated, normalized HTTPS origin. */
  origin: string;
  /** Already-normalized Atlassian account email. */
  email: string;
  apiToken: string;
}

export interface JiraConnectionServiceOptions {
  db: DatabaseSync;
  encryptionKey: Buffer;
  fetch: FetchLike;
  timeoutMs?: number;
}

function toStatus(connection: JiraConnection | null): ConnectionStatus {
  if (!connection) {
    return { connected: false };
  }
  return { connected: true, siteUrl: connection.siteUrl, email: connection.email };
}

/**
 * Orchestrates the tenant-wide Jira connection flow: verify the submitted
 * credentials against Jira, and only on success encrypt the token and
 * store/replace the tenant's shared connection. tenantId and the acting userId
 * come solely from the authenticated session. A failed verification never
 * touches the stored row, so an existing valid connection survives a failed
 * replacement.
 */
export class JiraConnectionService {
  private readonly repository: JiraConnectionRepository;
  private readonly encryptionKey: Buffer;
  private readonly fetch: FetchLike;
  private readonly timeoutMs?: number;

  constructor(options: JiraConnectionServiceOptions) {
    this.repository = new JiraConnectionRepository(options.db);
    this.encryptionKey = options.encryptionKey;
    this.fetch = options.fetch;
    this.timeoutMs = options.timeoutMs;
  }

  getStatus(context: AuthContext): ConnectionStatus {
    return toStatus(this.repository.findByTenant(context.tenantId));
  }

  async connect(context: AuthContext, input: ConnectInput): Promise<ConnectOutcome> {
    const verification = await verifyJiraCredentials(
      input.origin,
      input.email,
      input.apiToken,
      { fetch: this.fetch, timeoutMs: this.timeoutMs },
    );

    if (!verification.ok) {
      return { status: verification.reason };
    }

    const encryptedToken = encryptToken(input.apiToken, this.encryptionKey, {
      tenantId: context.tenantId,
      configuredByUserId: context.userId,
    });

    this.repository.upsert(context.tenantId, {
      configuredByUserId: context.userId,
      siteUrl: input.origin,
      email: input.email,
      accountId: verification.accountId,
      encryptedToken,
    });

    return { status: 'connected', siteUrl: input.origin, email: input.email };
  }
}
