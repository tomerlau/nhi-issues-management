import { useCallback, useEffect, useId, useRef, useState } from 'react';
import {
  listRecentTickets,
  messageForReadError,
  RecentTicketsApiError,
  type RecentTicket,
  type RecentTicketsErrorKind,
} from '../api/tickets';
import { isValidProjectKey, normalizeProjectKey } from '../utils/project-key';

type ListState =
  | { type: 'prompt' }
  | { type: 'loading' }
  | { type: 'success'; tickets: RecentTicket[] }
  | { type: 'error'; kind: RecentTicketsErrorKind };

interface RecentTicketsPanelProps {
  /** Raw project key from the shared input (may be empty or mixed-case). */
  projectKey: string;
  /**
   * Incremented by the parent after a ticket is successfully created. A non-zero
   * value triggers an immediate refresh, bypassing the normal debounce.
   */
  refreshKey: number;
}

const DEBOUNCE_MS = 400;

/**
 * Display the ten most recent tickets created through this application for the
 * currently selected Jira project.
 *
 * The component debounces project-key changes to avoid issuing a request on every
 * keystroke, but bypasses the debounce when `refreshKey` increments (which happens
 * immediately after a successful ticket creation). An AbortController cancels any
 * in-flight request when the project key changes or when a refresh supersedes a
 * pending debounce, so a stale response can never replace the current project's
 * state.
 */
export default function RecentTicketsPanel({ projectKey, refreshKey }: RecentTicketsPanelProps) {
  const headingId = useId();
  const [listState, setListState] = useState<ListState>({ type: 'prompt' });

  const abortRef = useRef<AbortController | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Kept in a ref so the refreshKey effect can read the latest projectKey without
  // being a reactive dependency (which would re-run the effect on key changes).
  const projectKeyRef = useRef(projectKey);
  projectKeyRef.current = projectKey;

  const doFetch = useCallback((normalizedKey: string) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setListState({ type: 'loading' });

    listRecentTickets(normalizedKey, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        setListState({ type: 'success', tickets: result.tickets });
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        if (err instanceof RecentTicketsApiError) {
          setListState({ type: 'error', kind: err.kind });
        } else {
          setListState({ type: 'error', kind: 'server' });
        }
      });
  }, []);

  // React to project-key changes with a debounce. Switching to an invalid key
  // cancels any pending request and resets to the prompt state immediately.
  useEffect(() => {
    const normalized = normalizeProjectKey(projectKey);

    if (debounceRef.current !== null) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }

    if (!isValidProjectKey(normalized)) {
      abortRef.current?.abort();
      abortRef.current = null;
      setListState({ type: 'prompt' });
      return;
    }

    // Show loading immediately so the previous project's results are not visible
    // while the debounce is pending.
    setListState({ type: 'loading' });

    debounceRef.current = setTimeout(() => {
      debounceRef.current = null;
      doFetch(normalized);
    }, DEBOUNCE_MS);

    return () => {
      if (debounceRef.current !== null) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
    };
  }, [projectKey, doFetch]);

  // React to refresh signals (successful ticket creation) with no debounce.
  useEffect(() => {
    if (refreshKey === 0) return;
    const normalized = normalizeProjectKey(projectKeyRef.current);
    if (!isValidProjectKey(normalized)) return;

    if (debounceRef.current !== null) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }

    doFetch(normalized);
  }, [refreshKey, doFetch]);

  function handleRetry() {
    const normalized = normalizeProjectKey(projectKey);
    if (isValidProjectKey(normalized)) {
      doFetch(normalized);
    }
  }

  return (
    <section className="recent-tickets-panel" aria-labelledby={headingId}>
      <h2 id={headingId}>Recent tickets</h2>

      {listState.type === 'prompt' && (
        <p className="recent-tickets-prompt">
          Enter a Jira project key above to view recent tickets created through
          this application.
        </p>
      )}

      {listState.type === 'loading' && (
        <p className="recent-tickets-loading" aria-live="polite" aria-busy="true">
          Loading tickets…
        </p>
      )}

      {listState.type === 'success' && listState.tickets.length === 0 && (
        <p className="recent-tickets-empty">
          No tickets created through this application were found for this project.
        </p>
      )}

      {listState.type === 'success' && listState.tickets.length > 0 && (
        <ol className="recent-tickets-list" aria-label="Recent tickets">
          {listState.tickets.map((ticket) => (
            <li key={ticket.issueId} className="recent-ticket-item">
              <a
                href={ticket.url}
                target="_blank"
                rel="noopener noreferrer"
                className="ticket-link"
              >
                {ticket.title}
              </a>
              <span className="ticket-key">{ticket.issueKey}</span>
              <time className="ticket-time" dateTime={ticket.createdAt}>
                {new Date(ticket.createdAt).toLocaleString()}
              </time>
            </li>
          ))}
        </ol>
      )}

      {listState.type === 'error' && (
        <div role="alert" className="recent-tickets-error">
          <p>{messageForReadError(listState.kind)}</p>
          <button type="button" onClick={handleRetry}>
            Retry
          </button>
        </div>
      )}
    </section>
  );
}
