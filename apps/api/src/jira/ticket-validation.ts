import type { TicketCreationInput } from './jira-integration-service.js';

const MAX_PROJECT_KEY_LENGTH = 10;
const MAX_TITLE_LENGTH = 255;
const MAX_DESCRIPTION_LENGTH = 5000;

// Conservative Jira project-key syntax: an uppercase letter followed by one or
// more uppercase letters or digits (2-10 characters after normalization).
const PROJECT_KEY_PATTERN = /^[A-Z][A-Z0-9]+$/;

export type Validated<T> = { ok: true; value: T } | { ok: false; message: string };

/**
 * Validate the ticket request body fully before any Jira network request. Only
 * the three domain inputs are read; any client-supplied tenantId, userId,
 * connectionId, siteUrl, issueType, or ownership field is ignored.
 */
export function validateTicketBody(body: unknown): Validated<TicketCreationInput> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, message: 'Request body must be a JSON object.' };
  }
  const { projectKey, title, description } = body as Record<string, unknown>;

  if (
    typeof projectKey !== 'string' ||
    typeof title !== 'string' ||
    typeof description !== 'string'
  ) {
    return { ok: false, message: 'projectKey, title and description are required string fields.' };
  }

  const normalizedProjectKey = projectKey.trim().toUpperCase();
  if (normalizedProjectKey.length === 0) {
    return { ok: false, message: 'projectKey must not be empty.' };
  }
  if (
    normalizedProjectKey.length > MAX_PROJECT_KEY_LENGTH ||
    !PROJECT_KEY_PATTERN.test(normalizedProjectKey)
  ) {
    return { ok: false, message: 'projectKey is not a valid Jira project key.' };
  }

  const trimmedTitle = title.trim();
  if (trimmedTitle.length === 0) {
    return { ok: false, message: 'title must not be empty.' };
  }
  if (trimmedTitle.length > MAX_TITLE_LENGTH) {
    return { ok: false, message: 'title exceeds the allowed length.' };
  }

  // trim() removes surrounding whitespace (including leading/trailing newlines)
  // while preserving meaningful internal line breaks.
  const trimmedDescription = description.trim();
  if (trimmedDescription.length === 0) {
    return { ok: false, message: 'description must not be empty.' };
  }
  if (trimmedDescription.length > MAX_DESCRIPTION_LENGTH) {
    return { ok: false, message: 'description exceeds the allowed length.' };
  }

  return {
    ok: true,
    value: {
      projectKey: normalizedProjectKey,
      title: trimmedTitle,
      description: trimmedDescription,
    },
  };
}
