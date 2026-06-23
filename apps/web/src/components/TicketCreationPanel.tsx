import { useId, useState, type FormEvent } from 'react';
import {
  createTicket,
  isUncertainTicketOutcome,
  messageForTicketError,
  TicketApiError,
} from '../api/tickets';
import { normalizeProjectKey, isValidProjectKey } from '../utils/project-key';

const MAX_TITLE_LENGTH = 255;
const MAX_DESCRIPTION_LENGTH = 5000;

type SubmitFeedback = { message: string; uncertain: boolean };

/**
 * Validate the form locally, returning a single message for the first problem or
 * the normalized payload to send. The project key is normalized using the shared
 * helper; title and description are trimmed (internal line breaks in the
 * description survive because `trim` only removes surrounding whitespace).
 */
function validate(
  projectKey: string,
  title: string,
  description: string,
): { ok: true; value: { projectKey: string; title: string; description: string } } | {
  ok: false;
  message: string;
} {
  const normalizedKey = normalizeProjectKey(projectKey);
  if (normalizedKey.length === 0) {
    return { ok: false, message: 'Enter a Jira project key.' };
  }
  if (!isValidProjectKey(normalizedKey)) {
    return {
      ok: false,
      message:
        'Enter a valid Jira project key: 2–10 characters, starting with a letter and using only uppercase letters and digits.',
    };
  }

  const trimmedTitle = title.trim();
  if (trimmedTitle.length === 0) {
    return { ok: false, message: 'Enter a title for the ticket.' };
  }
  if (trimmedTitle.length > MAX_TITLE_LENGTH) {
    return { ok: false, message: `Title must be ${MAX_TITLE_LENGTH} characters or fewer.` };
  }

  const trimmedDescription = description.trim();
  if (trimmedDescription.length === 0) {
    return { ok: false, message: 'Enter a description for the ticket.' };
  }
  if (trimmedDescription.length > MAX_DESCRIPTION_LENGTH) {
    return {
      ok: false,
      message: `Description must be ${MAX_DESCRIPTION_LENGTH} characters or fewer.`,
    };
  }

  return {
    ok: true,
    value: { projectKey: normalizedKey, title: trimmedTitle, description: trimmedDescription },
  };
}

interface TicketCreationPanelProps {
  projectKey: string;
  onProjectKeyChange: (key: string) => void;
  onTicketCreated?: () => void;
}

/**
 * Create an NHI finding ticket against the tenant's shared Jira connection. The
 * shell renders this panel only once the tenant connection has loaded as
 * connected, so it assumes a connection exists and reacts safely if the backend
 * later reports otherwise.
 *
 * The project key is shared state owned by the parent shell; this panel consumes
 * it and reports changes up via `onProjectKeyChange`. On successful creation it
 * calls `onTicketCreated` so the parent can refresh the recent-tickets list.
 *
 * The issue type is always the project's `Task` type, chosen by the backend; this
 * form sends only the project key, title, and description. Submissions are guarded
 * against duplicates and are never retried automatically: because creation is not
 * idempotent, any uncertain outcome (timeout, unreachable, network, or an
 * unexpected server failure) warns the user to check Jira before retrying.
 */
export default function TicketCreationPanel({
  projectKey,
  onProjectKeyChange,
  onTicketCreated,
}: TicketCreationPanelProps) {
  const headingId = useId();
  const projectKeyId = useId();
  const projectKeyHintId = useId();
  const titleId = useId();
  const descriptionId = useId();
  const descriptionHintId = useId();
  const errorId = useId();

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<SubmitFeedback | null>(null);
  const [createdIssueKey, setCreatedIssueKey] = useState<string | null>(null);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting) {
      return;
    }

    const result = validate(projectKey, title, description);
    if (!result.ok) {
      setCreatedIssueKey(null);
      setFeedback({ message: result.message, uncertain: false });
      return;
    }

    setSubmitting(true);
    setFeedback(null);
    setCreatedIssueKey(null);

    createTicket(result.value)
      .then((ticket) => {
        // Report the normalized key back to the parent so the shared state stays
        // canonical; clear only the per-ticket fields.
        onProjectKeyChange(result.value.projectKey);
        setTitle('');
        setDescription('');
        setCreatedIssueKey(ticket.issueKey);
        setSubmitting(false);
        onTicketCreated?.();
      })
      .catch((error: unknown) => {
        const kind = error instanceof TicketApiError ? error.kind : 'server';
        setFeedback({
          message: messageForTicketError(kind),
          uncertain: isUncertainTicketOutcome(kind),
        });
        setSubmitting(false);
      });
  };

  return (
    <section className="ticket-panel" aria-labelledby={headingId}>
      <h2 id={headingId}>Create a Jira ticket</h2>
      <p className="ticket-intro">
        Create an NHI finding ticket in your tenant&apos;s connected Jira project. It
        is created as a Jira <strong>Task</strong>.
      </p>

      {createdIssueKey && (
        <p className="form-success" role="status">
          Created Jira issue <strong>{createdIssueKey}</strong>. The title and
          description were cleared so you can create another ticket in the same
          project.
        </p>
      )}

      <form className="ticket-form" onSubmit={handleSubmit} noValidate>
        <div className="field">
          <label htmlFor={projectKeyId}>Project key</label>
          <input
            id={projectKeyId}
            name="projectKey"
            type="text"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            value={projectKey}
            onChange={(event) => onProjectKeyChange(event.target.value)}
            disabled={submitting}
            required
            aria-invalid={feedback !== null && !feedback.uncertain}
            aria-describedby={
              feedback ? `${projectKeyHintId} ${errorId}` : projectKeyHintId
            }
          />
          <p id={projectKeyHintId} className="field-hint">
            The Jira project key, for example scrum. Project keys are
            case-insensitive and are normalized to uppercase when submitted.
          </p>
        </div>

        <div className="field">
          <label htmlFor={titleId}>Title</label>
          <input
            id={titleId}
            name="title"
            type="text"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            disabled={submitting}
            required
            maxLength={MAX_TITLE_LENGTH}
            aria-invalid={feedback !== null && !feedback.uncertain}
            aria-describedby={feedback ? errorId : undefined}
          />
        </div>

        <div className="field">
          <label htmlFor={descriptionId}>Description</label>
          <textarea
            id={descriptionId}
            name="description"
            rows={6}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            disabled={submitting}
            required
            maxLength={MAX_DESCRIPTION_LENGTH}
            aria-invalid={feedback !== null && !feedback.uncertain}
            aria-describedby={
              feedback ? `${descriptionHintId} ${errorId}` : descriptionHintId
            }
          />
          <p id={descriptionHintId} className="field-hint">
            Describe the finding. Line breaks are preserved in the Jira issue.
          </p>
        </div>

        {feedback && (
          <p
            id={errorId}
            className={feedback.uncertain ? 'form-warning' : 'form-error'}
            role="alert"
          >
            {feedback.message}
          </p>
        )}

        <div className="ticket-form-actions">
          <button type="submit" disabled={submitting}>
            {submitting ? 'Creating…' : 'Create ticket'}
          </button>
        </div>
      </form>
    </section>
  );
}
