import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import TicketCreationForm from './TicketCreationForm';

interface TicketCreationModalProps {
  projectKey: string;
  open: boolean;
  onClose: () => void;
  onTicketCreated: () => void;
  triggerRef?: React.RefObject<HTMLButtonElement>;
  onSubmittingChange?: (submitting: boolean) => void;
}

/**
 * Modal dialog for ticket creation in Mode A (project has existing tickets).
 * Wraps TicketCreationForm in an accessible dialog. The close (✕) button and
 * Escape are disabled while a request is in flight; submission state is
 * propagated explicitly via TicketCreationForm's onSubmittingChange callback
 * rather than inferred from the DOM. Focus returns to the trigger after close.
 *
 * The form never includes a project-key input — the projectKey comes from the
 * page-level selector and is shown as read-only context inside the form.
 */
export default function TicketCreationModal({
  projectKey,
  open,
  onClose,
  onTicketCreated,
  triggerRef,
  onSubmittingChange,
}: TicketCreationModalProps) {
  const headingId = useId();
  const modalRef = useRef<HTMLDivElement>(null);
  const [isFormSubmitting, setIsFormSubmitting] = useState(false);

  const handleSubmittingChange = (submitting: boolean) => {
    setIsFormSubmitting(submitting);
    onSubmittingChange?.(submitting);
  };

  useEffect(() => {
    if (open) {
      requestAnimationFrame(() => {
        modalRef.current?.focus();
      });
    } else if (triggerRef?.current) {
      requestAnimationFrame(() => {
        triggerRef.current?.focus();
      });
    }
  }, [open, triggerRef]);

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape' && !isFormSubmitting) {
      onClose();
    }
  };

  const handleSuccess = (issueKey: string) => {
    void issueKey;
    onClose();
    onTicketCreated();
  };

  if (!open) return null;

  return (
    <div className="modal-backdrop">
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        tabIndex={-1}
        ref={modalRef}
        onKeyDown={handleKeyDown}
      >
        <div className="modal-header">
          <h2 id={headingId} className="modal-title">
            Create ticket
          </h2>
          <button
            type="button"
            className="modal-close"
            aria-label="Close"
            onClick={onClose}
            disabled={isFormSubmitting}
          >
            ✕
          </button>
        </div>
        <div className="modal-body">
          <TicketCreationForm
            projectKey={projectKey}
            onSuccess={handleSuccess}
            onSubmittingChange={handleSubmittingChange}
          />
        </div>
      </div>
    </div>
  );
}
