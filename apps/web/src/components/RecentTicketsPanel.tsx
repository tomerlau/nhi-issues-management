import { useCallback, useEffect, useId, useRef, useState } from 'react';
import {
  listRecentTickets,
  messageForReadError,
  RecentTicketsApiError,
  type RecentTicket,
  type RecentTicketsErrorKind,
} from '../api/tickets';
import { isValidProjectKey, normalizeProjectKey } from '../utils/project-key';
import TicketCreationForm from './TicketCreationForm';

type ListState =
  | { type: 'prompt' }
  | { type: 'loading' }
  | { type: 'success'; tickets: RecentTicket[] }
  | { type: 'error'; kind: RecentTicketsErrorKind };

interface RecentTicketsPanelProps {
  /** Raw project key from the shared input (may be empty or mixed-case). */
  projectKey: string;
  /**
   * Incremented by the parent after a ticket is successfully created or after a
   * successful Jira connection creation or replacement. Triggers an immediate
   * refresh bypassing debounce.
   */
  refreshKey: number;
  /** Called when the user clicks "Create ticket" in Mode A to open the modal. */
  onOpenCreationModal?: () => void;
  /** Called after successful inline ticket creation in Mode B. */
  onTicketCreated?: () => void;
}

const DEBOUNCE_MS = 400;

/**
 * Displays the ten most recent tickets for the selected Jira project.
 *
 * Mode A (tickets exist): shows the "Recent tickets" heading, the ticket list,
 * and a "Create ticket" button that opens the creation modal via
 * `onOpenCreationModal`.
 *
 * Mode B (zero tickets): shows an inline "Create your first Jira ticket!" panel
 * with a TicketCreationForm. No "Recent tickets" heading, list, or empty-state
 * text is ever shown in Mode B.
 *
 * All debounce, immediate-refresh, abort, and stale-response behaviors from
 * the previous milestone are preserved.
 */
export default function RecentTicketsPanel({
  projectKey,
  refreshKey,
  onOpenCreationModal,
  onTicketCreated,
}: RecentTicketsPanelProps) {
  const headingId = useId();
  const [listState, setListState] = useState<ListState>({ type: 'prompt' });

  const abortRef = useRef<AbortController | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  // Abort and clear debounce on unmount.
  useEffect(() => {
    return () => {
      if (debounceRef.current !== null) clearTimeout(debounceRef.current);
      abortRef.current?.abort();
    };
  }, []);

  // React to project-key changes with debounce.
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

    abortRef.current?.abort();
    abortRef.current = null;
    setListState({ type: 'loading' });

    debounceRef.current = setTimeout(() => {
      debounceRef.current = null;
      doFetch(normalized);
    }, DEBOUNCE_MS);
  }, [projectKey, doFetch]);

  // React to refresh signals immediately (bypasses debounce).
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
    if (isValidProjectKey(normalized)) doFetch(normalized);
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  if (listState.type === 'prompt') {
    return null;
  }

  if (listState.type === 'loading') {
    return (
      <div className="recent-tickets-panel">
        <p className="recent-tickets-loading" aria-live="polite" aria-busy="true">
          Loading tickets…
        </p>
      </div>
    );
  }

  if (listState.type === 'error') {
    return (
      <div className="recent-tickets-panel">
        <div role="alert" className="recent-tickets-error">
          <p>{messageForReadError(listState.kind)}</p>
          <button type="button" onClick={handleRetry}>
            Retry
          </button>
        </div>
      </div>
    );
  }

  // Success state: Mode A (tickets exist) or Mode B (zero tickets).
  const { tickets } = listState;

  if (tickets.length === 0) {
    // Mode B — first ticket inline creation.
    const normalizedKey = normalizeProjectKey(projectKey);
    return (
      <div className="recent-tickets-panel first-ticket-panel">
        <h2>Create your first Jira ticket!</h2>
        <p className="first-ticket-intro">
          Create the first ticket for project <strong>{normalizedKey}</strong>{' '}
          through this application.
        </p>
        <TicketCreationForm
          projectKey={normalizedKey}
          onSuccess={() => onTicketCreated?.()}
        />
      </div>
    );
  }

  // Mode A — existing tickets.
  return (
    <section className="recent-tickets-panel" aria-labelledby={headingId}>
      <div className="recent-tickets-header">
        <h2 id={headingId}>Recent tickets</h2>
        <button
          type="button"
          onClick={onOpenCreationModal}
        >
          Create ticket
        </button>
      </div>

      <ol className="recent-tickets-list" aria-label="Recent tickets">
        {tickets.map((ticket) => (
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
    </section>
  );
}
