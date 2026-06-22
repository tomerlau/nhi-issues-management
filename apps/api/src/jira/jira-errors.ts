import type { ApiError } from '../auth/errors.js';

/**
 * Sanitized error envelopes for the Jira connection endpoints. They reuse the
 * shared `ApiError` shape and intentionally never carry raw Jira response
 * bodies, tokens, authorization headers, or internal exception messages.
 */
function apiError(code: string, message: string): ApiError {
  return { error: { code, message } };
}

/** The encryption key is not configured, so credentials cannot be stored. */
export function jiraNotConfiguredError(): ApiError {
  return apiError('jira_not_configured', 'Jira integration is not configured.');
}

/** Jira rejected the submitted email/API-token pair. */
export function jiraCredentialsRejectedError(): ApiError {
  return apiError('jira_credentials_rejected', 'Jira rejected the provided credentials.');
}

/** Jira rejected the stored connection's credentials during a later operation. */
export function jiraStoredCredentialsRejectedError(): ApiError {
  return apiError(
    'jira_credentials_rejected',
    'The stored Jira credentials were rejected. Reconnect Jira and try again.',
  );
}

/** Jira was unreachable, returned an invalid response, or failed unexpectedly. */
export function jiraUnreachableError(): ApiError {
  return apiError('jira_unreachable', 'Jira could not be reached. Please try again.');
}

/** The Jira request exceeded the verifier timeout. */
export function jiraTimeoutError(): ApiError {
  return apiError('jira_timeout', 'The Jira request timed out. Please try again.');
}

/** The tenant has no Jira connection, so a ticket cannot be created. */
export function jiraNotConnectedError(): ApiError {
  return apiError('jira_not_connected', 'No Jira connection is configured for this tenant.');
}

/** The requested project is not accessible to the tenant's Jira connection. */
export function jiraProjectInaccessibleError(): ApiError {
  return apiError(
    'jira_project_inaccessible',
    'The requested Jira project is not accessible.',
  );
}

/** The requested project does not support the fixed Task issue type. */
export function jiraTaskUnsupportedError(): ApiError {
  return apiError(
    'jira_task_unsupported',
    'The requested Jira project does not support the Task issue type.',
  );
}
