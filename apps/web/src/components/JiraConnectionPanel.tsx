import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import {
  getJiraConnection,
  saveJiraConnection,
  JiraApiError,
  messageForKind,
  type JiraConnectionStatus,
  type JiraErrorKind,
} from '../api/jira';

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; kind: JiraErrorKind }
  | { status: 'ready'; connection: JiraConnectionStatus };

interface JiraConnectionPanelProps {
  onConnectionChange?: (connected: boolean) => void;
  onConnectionSaved?: () => void;
  /** Called with `true` while fetching status, `false` when ready or errored. */
  onLoadingChange?: (loading: boolean) => void;
  /** Increment to trigger an immediate re-fetch of the connection status. */
  externalRefreshSignal?: number;
}

/**
 * Compact Jira connection status bar.
 *
 * Disconnected: red dot + "Jira not connected" text — no trigger button.
 * Connected: green dot + "Jira connected" + gear-icon button that opens the
 * "Manage Jira connection" modal for replacement.
 *
 * The initial connection form lives in the main content area (JiraInlineConnectForm),
 * not inside this component.
 */
export default function JiraConnectionPanel({
  onConnectionChange,
  onConnectionSaved,
  onLoadingChange,
  externalRefreshSignal,
}: JiraConnectionPanelProps) {
  const modalHeadingId = useId();
  const siteUrlId = useId();
  const siteUrlHintId = useId();
  const emailId = useId();
  const tokenId = useId();
  const tokenHintId = useId();
  const errorId = useId();

  const [load, setLoad] = useState<LoadState>({ status: 'loading' });
  const [modalOpen, setModalOpen] = useState(false);
  const [siteUrl, setSiteUrl] = useState('');
  const [email, setEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const tokenRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback((signal?: AbortSignal) => {
    setLoad({ status: 'loading' });
    getJiraConnection(signal)
      .then((connection) => {
        setLoad({ status: 'ready', connection });
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        const kind = error instanceof JiraApiError ? error.kind : 'server';
        setLoad({ status: 'error', kind });
      });
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    refresh(controller.signal);
    return () => controller.abort();
  }, [refresh]);

  const connectedNow = load.status === 'ready' && load.connection.connected;
  useEffect(() => {
    onConnectionChange?.(connectedNow);
  }, [connectedNow, onConnectionChange]);

  const isLoading = load.status === 'loading';
  useEffect(() => {
    onLoadingChange?.(isLoading);
  }, [isLoading, onLoadingChange]);

  useEffect(() => {
    if (!externalRefreshSignal) return;
    refresh();
  }, [externalRefreshSignal, refresh]);

  const openModal = () => {
    setFormError(null);
    setSiteUrl('');
    setEmail('');
    setModalOpen(true);
    requestAnimationFrame(() => {
      modalRef.current?.focus();
    });
  };

  const closeModal = () => {
    setModalOpen(false);
    setSiteUrl('');
    setEmail('');
    setFormError(null);
    requestAnimationFrame(() => {
      triggerRef.current?.focus();
    });
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape' && !submitting) {
      closeModal();
    }
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting || load.status !== 'ready') return;

    const tokenInput = tokenRef.current;
    const apiToken = tokenInput?.value ?? '';

    if (siteUrl.trim().length === 0 || email.trim().length === 0 || apiToken.length === 0) {
      setFormError('Enter the Jira site URL, Atlassian email, and API token.');
      return;
    }

    setSubmitting(true);
    setFormError(null);

    if (tokenInput) {
      tokenInput.value = '';
    }

    saveJiraConnection({ siteUrl, email, apiToken })
      .then((connection) => {
        setLoad({ status: 'ready', connection });
        setSubmitting(false);
        setModalOpen(false);
        setSiteUrl('');
        setEmail('');
        onConnectionSaved?.();
        requestAnimationFrame(() => {
          triggerRef.current?.focus();
        });
      })
      .catch((error: unknown) => {
        const kind = error instanceof JiraApiError ? error.kind : 'server';
        setFormError(messageForKind(kind));
        setSubmitting(false);
      });
  };

  // -------------------------------------------------------------------------
  // Compact status bar rendering
  // -------------------------------------------------------------------------

  const renderStatus = () => {
    if (load.status === 'loading') {
      return (
        <p className="jira-status-compact" aria-live="polite">
          Loading Jira connection…
        </p>
      );
    }

    if (load.status === 'error') {
      const authFailure = load.kind === 'authentication';
      return (
        <div className="jira-status-compact jira-status-error">
          <p className="form-error" role="alert">
            {authFailure
              ? 'Your session is no longer valid. Please refresh the page or sign in again.'
              : messageForKind(load.kind)}
          </p>
          {!authFailure && (
            <button type="button" onClick={() => refresh()}>
              Try again
            </button>
          )}
        </div>
      );
    }

    const { connection } = load;
    if (connection.connected) {
      return (
        <div className="jira-status-compact">
          <span className="jira-indicator-connected" aria-hidden="true" />
          <span className="jira-label-connected">Jira connected</span>
          <button
            ref={triggerRef}
            type="button"
            className="jira-gear-button"
            aria-label="Manage Jira connection"
            onClick={openModal}
          >
            <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 15.5A3.5 3.5 0 0 1 8.5 12 3.5 3.5 0 0 1 12 8.5a3.5 3.5 0 0 1 3.5 3.5 3.5 3.5 0 0 1-3.5 3.5m7.43-2.92c.04-.33.07-.67.07-1.08s-.03-.74-.07-1.08l2.33-1.82c.21-.16.27-.45.12-.68l-2.21-3.83c-.16-.22-.45-.3-.67-.22l-2.74 1.11c-.59-.45-1.22-.82-1.92-1.11l-.41-2.91C14.43 2.18 14.22 2 14 2h-4c-.22 0-.43.18-.46.42l-.41 2.91a9.32 9.32 0 0 0-1.93 1.11L4.46 5.33c-.22-.08-.51 0-.67.22L1.58 9.38c-.15.23-.09.52.12.68l2.33 1.82C4.03 12.26 4 12.6 4 13s.03.74.07 1.08L1.7 15.9c-.21.16-.27.45-.12.68l2.21 3.83c.16.22.45.3.67.22l2.74-1.11c.59.45 1.22.82 1.92 1.11l.41 2.91c.03.24.24.42.46.42h4c.22 0 .43-.18.46-.42l.41-2.91a9.32 9.32 0 0 0 1.93-1.11l2.74 1.11c.22.08.51 0 .67-.22l2.21-3.83c.15-.23.09-.52-.12-.68l-2.33-1.82z"/>
            </svg>
          </button>
        </div>
      );
    }

    return (
      <div className="jira-status-compact">
        <span className="jira-indicator-disconnected" aria-hidden="true" />
        <span className="jira-label-disconnected">Jira not connected</span>
      </div>
    );
  };

  // -------------------------------------------------------------------------
  // Manage modal (connected state only)
  // -------------------------------------------------------------------------

  const renderModal = () => {
    if (!modalOpen || !connectedNow || load.status !== 'ready') return null;

    const { connection } = load;
    if (!connection.connected) return null;

    return (
      <div className="modal-backdrop">
        <div
          className="modal"
          role="dialog"
          aria-modal="true"
          aria-labelledby={modalHeadingId}
          tabIndex={-1}
          ref={modalRef}
          onKeyDown={handleKeyDown}
        >
          <div className="modal-header">
            <h2 id={modalHeadingId} className="modal-title">
              Manage Jira connection
            </h2>
            <button
              type="button"
              className="modal-close"
              aria-label="Close"
              onClick={closeModal}
              disabled={submitting}
            >
              ✕
            </button>
          </div>

          <div className="modal-body">
            <dl className="jira-details">
              <div>
                <dt>Site URL</dt>
                <dd>{connection.siteUrl}</dd>
              </div>
              <div>
                <dt>Atlassian email</dt>
                <dd>{connection.email}</dd>
              </div>
            </dl>

            <form className="jira-form" onSubmit={handleSubmit} noValidate autoComplete="off">
              <h3>Replace the shared connection</h3>

              <div className="field">
                <label htmlFor={siteUrlId}>Jira Cloud site URL</label>
                <input
                  id={siteUrlId}
                  name="jiraSiteUrl"
                  type="url"
                  inputMode="url"
                  autoComplete="off"
                  placeholder="https://your-site.atlassian.net"
                  value={siteUrl}
                  onChange={(e) => setSiteUrl(e.target.value)}
                  disabled={submitting}
                  required
                  aria-invalid={formError !== null}
                  aria-describedby={formError ? `${siteUrlHintId} ${errorId}` : siteUrlHintId}
                />
                <p id={siteUrlHintId} className="field-hint">
                  Use the format https://&lt;site&gt;.atlassian.net
                </p>
              </div>

              <div className="field">
                <label htmlFor={emailId}>Atlassian account email</label>
                <input
                  id={emailId}
                  name="jiraAccountEmail"
                  type="text"
                  inputMode="email"
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  disabled={submitting}
                  required
                  aria-invalid={formError !== null}
                  aria-describedby={formError ? errorId : undefined}
                />
              </div>

              <div className="field">
                <label htmlFor={tokenId}>Atlassian API token</label>
                <input
                  id={tokenId}
                  name="jiraApiToken"
                  type="password"
                  autoComplete="new-password"
                  ref={tokenRef}
                  disabled={submitting}
                  required
                  aria-invalid={formError !== null}
                  aria-describedby={formError ? `${tokenHintId} ${errorId}` : tokenHintId}
                />
                <p id={tokenHintId} className="field-hint">
                  Use an unscoped Atlassian API token. The token is sent to the
                  backend only for this request, is not stored in your browser, and is
                  never shown again.
                </p>
              </div>

              {formError && (
                <p id={errorId} className="form-error" role="alert">
                  {formError}
                </p>
              )}

              <div className="jira-form-actions">
                <button type="submit" disabled={submitting}>
                  {submitting ? 'Connecting…' : 'Replace connection'}
                </button>
                <button
                  type="button"
                  className="secondary"
                  onClick={closeModal}
                  disabled={submitting}
                >
                  Cancel
                </button>
              </div>
            </form>

            <p className="jira-shared-note">
              The Jira connection is shared by everyone in your tenant. Connecting or
              replacing it changes the integration for all users in your organization.
            </p>
          </div>
        </div>
      </div>
    );
  };

  return (
    <>
      <div className="jira-connection-bar">
        {renderStatus()}
      </div>
      {renderModal()}
    </>
  );
}
