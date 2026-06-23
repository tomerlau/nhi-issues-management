import { useEffect, useId, useRef, type KeyboardEvent } from 'react';
import TicketCreationForm from './TicketCreationForm';

interface TicketCreationModalProps {
  projectKey: string;
  open: boolean;
  onClose: () => void;
  onTicketCreated: () => void;
  triggerRef?: React.RefObject<HTMLButtonElement | null>;
}

/**
 * Modal dialog for ticket creation in Mode A (project has existing tickets).
 * Wraps TicketCreationForm in an accessible dialog. Escape closes the modal
 * when no request is pending; the close/cancel button closes it explicitly.
 * Focus returns to the trigger after close.
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
}: TicketCreationModalProps) {
  const headingId = useId();
  const modalRef = useRef<HTMLDivElement>(null);

  // Track whether a form submission is in flight so Escape is blocked.
  // TicketCreationForm owns this state internally; we detect it via an
  // aria-busy attribute on the form to avoid prop-drilling.
  const isSubmitting = () => {
    const form = modalRef.current?.querySelector('form');
    return form?.querySelector('button[disabled]') !== null;
  };

  useEffect(() => {
    if (open) {
      // Focus the modal container when it opens so keyboard users can navigate it.
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
    if (e.key === 'Escape' && !isSubmitting()) {
      onClose();
    }
  };

  const handleSuccess = (issueKey: string) => {
    // issueKey confirmed — close modal then refresh the list.
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
            disabled={isSubmitting()}
          >
            ✕
          </button>
        </div>
        <div className="modal-body">
          <TicketCreationForm projectKey={projectKey} onSuccess={handleSuccess} />
        </div>
      </div>
    </div>
  );
}
