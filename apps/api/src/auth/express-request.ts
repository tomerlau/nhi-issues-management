import 'express';
import type { AuthContext, SafeUser } from './auth-context.js';

/**
 * The state an authentication middleware attaches to a request once a principal
 * has been resolved. Routes behind the middleware can rely on `context` being
 * present. `user` is populated by session authentication (for user-facing
 * endpoints) and absent when using API-key authentication.
 */
export interface AuthenticatedState {
  context: AuthContext;
  user?: SafeUser;
}

declare module 'express-serve-static-core' {
  interface Request {
    auth?: AuthenticatedState;
  }
}
