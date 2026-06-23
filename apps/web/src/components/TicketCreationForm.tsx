import { useId, useState, type FormEvent } from 'react';
import {
  createTicket,
  isUncertainTicketOutcome,
  messageForTicketError,
  TicketApiError,
} from '../api/tickets';

const MAX_TITLE_LENGTH = 255;
const MAX_DESCRIPTION_LENGTH = 5000;

type SubmitFeedback = { message: string; uncertain: boolean };

interface TicketCreationFormProps {
  /** Normalized, valid project key — never includes a project-key input itself. */
  projectKey: string;
  onSuccess?: (issueKey: string) => void;
  /**
   * Called with `true` immediately before the network request starts and with
   * `false` after every resolved or rejected request. The parent modal uses
   * this to disable close controls while a request is in flight.
   */
  onSubmittingChange?: (submitting: boolean) => void;
}

function validate(
  title: string,
  description: string,
): { ok: true; value: { title: string; description: string } } | { ok: false; message: string } {
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

  return { ok: true, value: { title: trimmedTitle, description: trimmedDescription } };
}

/**
 * Reusable ticket creation form — title and description only, no project-key
 * input. The caller supplies the valid, normalized `projectKey` used for both
 * the read-only project context display and the API request. This component is
 * used both inside the first-ticket inline panel (Mode B) and inside the
 * creation modal (Mode A).
 */
export default function TicketCreationForm({ projectKey, onSuccess, onSubmittingChange }: TicketCreationFormProps) {
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
    if (submitting) return;

    const result = validate(title, description);
    if (!result.ok) {
      setCreatedIssueKey(null);
      setFeedback({ message: result.message, uncertain: false });
      return;
    }

    setSubmitting(true);
    onSubmittingChange?.(true);
    setFeedback(null);
    setCreatedIssueKey(null);

    createTicket({ projectKey, title: result.value.title, description: result.value.description })
      .then((ticket) => {
        setTitle('');
        setDescription('');
        setCreatedIssueKey(ticket.issueKey);
        setSubmitting(false);
        onSubmittingChange?.(false);
        onSuccess?.(ticket.issueKey);
      })
      .catch((error: unknown) => {
        const kind = error instanceof TicketApiError ? error.kind : 'server';
        setFeedback({
          message: messageForTicketError(kind),
          uncertain: isUncertainTicketOutcome(kind),
        });
        setSubmitting(false);
        onSubmittingChange?.(false);
      });
  };

  return (
    <form className="ticket-form" onSubmit={handleSubmit} noValidate>
      <p className="ticket-project-context">
        Creating in project <strong>{projectKey}</strong>
      </p>

      {createdIssueKey && (
        <p className="form-success" role="status">
          Created Jira issue <strong>{createdIssueKey}</strong>. The title and
          description were cleared so you can create another ticket.
        </p>
      )}

      <div className="field">
        <label htmlFor={titleId}>Title</label>
        <input
          id={titleId}
          name="title"
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
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
          onChange={(e) => setDescription(e.target.value)}
          disabled={submitting}
          required
          maxLength={MAX_DESCRIPTION_LENGTH}
          aria-invalid={feedback !== null && !feedback.uncertain}
          aria-describedby={feedback ? `${descriptionHintId} ${errorId}` : descriptionHintId}
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
  );
}
