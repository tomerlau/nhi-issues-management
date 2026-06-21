/** Structured error envelope returned by the authentication endpoints. */
export interface ApiError {
  error: {
    code: string;
    message: string;
  };
}

function apiError(code: string, message: string): ApiError {
  return { error: { code, message } };
}

export function invalidRequestError(message: string): ApiError {
  return apiError('invalid_request', message);
}

/**
 * A single generic error for every invalid-credential case, so a client cannot
 * tell whether an email exists or only the password was wrong.
 */
export function invalidCredentialsError(): ApiError {
  return apiError('invalid_credentials', 'Invalid email or password.');
}

export function unauthenticatedError(): ApiError {
  return apiError('unauthenticated', 'Authentication required.');
}
