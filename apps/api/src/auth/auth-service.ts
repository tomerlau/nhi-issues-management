import type { DatabaseSync } from 'node:sqlite';
import { SessionRepository } from '../repositories/session-repository.js';
import { UserCredentialRepository } from '../repositories/user-credential-repository.js';
import { UserRepository, type User } from '../repositories/user-repository.js';
import type { AuthContext, SafeUser } from './auth-context.js';
import { normalizeEmail } from './auth-context.js';
import { verifyPassword } from './password.js';
import { generateSessionToken, hashSessionToken } from './session-token.js';
import { SESSION_TTL_MS } from './cookies.js';

function toSafeUser(user: User): SafeUser {
  return {
    id: user.id,
    tenantId: user.tenantId,
    email: user.email,
    displayName: user.displayName,
  };
}

export interface LoginSuccess {
  token: string;
  expiresAt: Date;
  user: SafeUser;
}

export interface ResolvedSession {
  context: AuthContext;
  user: SafeUser;
}

/**
 * Orchestrates authentication over the user, credential, and session
 * repositories. The trust boundary lives here: email and password are accepted
 * only at login; afterwards the tenant and user are derived from the stored
 * session, never from request input.
 */
export class AuthService {
  private readonly users: UserRepository;
  private readonly credentials: UserCredentialRepository;
  private readonly sessions: SessionRepository;

  constructor(db: DatabaseSync) {
    this.users = new UserRepository(db);
    this.credentials = new UserCredentialRepository(db);
    this.sessions = new SessionRepository(db);
  }

  /**
   * Verify credentials and, on success, create a persistent session. Returns
   * null for every invalid-credential case (unknown email, missing credential
   * record, wrong password) so callers cannot distinguish them.
   */
  async login(email: string, password: string): Promise<LoginSuccess | null> {
    const user = this.users.findByEmailForAuthentication(normalizeEmail(email));
    if (!user) {
      return null;
    }

    const credential = this.credentials.findByUserId(user.tenantId, user.id);
    if (!credential) {
      return null;
    }

    if (!(await verifyPassword(password, credential.passwordHash))) {
      return null;
    }

    const token = generateSessionToken();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
    this.sessions.create({
      tokenHash: hashSessionToken(token),
      tenantId: user.tenantId,
      userId: user.id,
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
    });

    return { token, expiresAt, user: toSafeUser(user) };
  }

  /**
   * Resolve an authenticated principal from a raw session token. Returns null
   * when the session is missing, expired, revoked, or its user no longer exists.
   * The user is loaded within the session's own tenant scope.
   */
  resolveSession(rawToken: string): ResolvedSession | null {
    const session = this.sessions.findActiveByTokenHash(
      hashSessionToken(rawToken),
      new Date().toISOString(),
    );
    if (!session) {
      return null;
    }

    const user = this.users.findById(session.tenantId, session.userId);
    if (!user) {
      return null;
    }

    return {
      context: { userId: user.id, tenantId: user.tenantId },
      user: toSafeUser(user),
    };
  }

  /** Revoke a single session by its raw token. A no-op when none matches. */
  logout(rawToken: string): void {
    this.sessions.deleteByTokenHash(hashSessionToken(rawToken));
  }
}
