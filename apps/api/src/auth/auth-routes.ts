import { Router } from 'express';
import './express-request.js';
import type { AuthService } from './auth-service.js';
import { createRequireAuth } from './auth-middleware.js';
import { clearSessionCookie, readSessionToken, setSessionCookie } from './cookies.js';
import { invalidCredentialsError, invalidRequestError } from './errors.js';

const MAX_EMAIL_LENGTH = 254;
const MAX_PASSWORD_LENGTH = 200;

interface LoginCredentials {
  email: string;
  password: string;
}

type Validated<T> = { ok: true; value: T } | { ok: false; message: string };

function validateLoginBody(body: unknown): Validated<LoginCredentials> {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, message: 'Request body must be a JSON object.' };
  }
  const { email, password } = body as Record<string, unknown>;

  if (typeof email !== 'string' || typeof password !== 'string') {
    return { ok: false, message: 'email and password are required string fields.' };
  }
  if (email.trim().length === 0 || password.length === 0) {
    return { ok: false, message: 'email and password must not be empty.' };
  }
  if (email.length > MAX_EMAIL_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
    return { ok: false, message: 'email or password exceeds the allowed length.' };
  }

  return { ok: true, value: { email, password } };
}

export interface AuthRouterOptions {
  cookieSecure: boolean;
}

export function createAuthRouter(
  authService: AuthService,
  options: AuthRouterOptions,
): Router {
  const router = Router();
  const requireAuth = createRequireAuth(authService);

  // Authentication responses must never be cached by browsers or proxies.
  router.use((_request, response, next) => {
    response.setHeader('Cache-Control', 'no-store');
    next();
  });

  router.post('/login', (request, response, next) => {
    const validated = validateLoginBody(request.body);
    if (!validated.ok) {
      response.status(400).json(invalidRequestError(validated.message));
      return;
    }

    authService
      .login(validated.value.email, validated.value.password)
      .then((result) => {
        if (!result) {
          response.status(401).json(invalidCredentialsError());
          return;
        }
        setSessionCookie(response, result.token, options.cookieSecure);
        response.status(200).json({ user: result.user });
      })
      .catch(next);
  });

  router.get('/session', requireAuth, (request, response) => {
    response.status(200).json({ user: request.auth!.user });
  });

  router.post('/logout', (request, response) => {
    const token = readSessionToken(request);
    if (token) {
      authService.logout(token);
    }
    clearSessionCookie(response, options.cookieSecure);
    response.status(200).json({ status: 'ok' });
  });

  return router;
}
