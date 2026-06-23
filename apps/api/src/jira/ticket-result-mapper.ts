import type { Response } from 'express';
import { internalError } from '../auth/errors.js';
import type { CreateTicketResult } from './ticket-service.js';
import {
  jiraNotConfiguredError,
  jiraNotConnectedError,
  jiraProjectInaccessibleError,
  jiraStoredCredentialsRejectedError,
  jiraTaskUnsupportedError,
  jiraTimeoutError,
  jiraUnreachableError,
} from './jira-errors.js';

/**
 * Map a CreateTicketResult to the appropriate HTTP response. Shared between the
 * session-authenticated and API-key-authenticated ticket creation routes so both
 * paths return identical status codes and error envelopes.
 */
export function sendCreateTicketResponse(response: Response, outcome: CreateTicketResult): void {
  switch (outcome.status) {
    case 'created':
      response.status(201).json({ issueId: outcome.issueId, issueKey: outcome.issueKey });
      return;
    case 'not_connected':
      response.status(409).json(jiraNotConnectedError());
      return;
    case 'project_inaccessible':
      response.status(422).json(jiraProjectInaccessibleError());
      return;
    case 'task_unsupported':
      response.status(422).json(jiraTaskUnsupportedError());
      return;
    case 'credentials_rejected':
      response.status(502).json(jiraStoredCredentialsRejectedError());
      return;
    case 'unavailable':
      response.status(502).json(jiraUnreachableError());
      return;
    case 'timeout':
      response.status(504).json(jiraTimeoutError());
      return;
    case 'configuration_error':
      response.status(503).json(jiraNotConfiguredError());
      return;
    case 'persistence_failed':
      response.status(500).json(internalError());
      return;
  }
}
