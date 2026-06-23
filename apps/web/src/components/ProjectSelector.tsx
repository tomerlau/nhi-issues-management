import { useId } from 'react';
import { isValidProjectKey, normalizeProjectKey } from '../utils/project-key';

interface ProjectSelectorProps {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}

export default function ProjectSelector({ value, onChange, disabled }: ProjectSelectorProps) {
  const inputId = useId();
  const hintId = useId();
  const errorId = useId();

  const normalized = normalizeProjectKey(value);
  const showError = value.length > 0 && !isValidProjectKey(normalized);

  return (
    <div className="project-selector">
      <div className="field">
        <label htmlFor={inputId}>Jira project</label>
        <input
          id={inputId}
          name="projectKey"
          type="text"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          aria-invalid={showError}
          aria-describedby={showError ? `${hintId} ${errorId}` : hintId}
        />
        <p id={hintId} className="field-hint">
          Used for recent tickets and new ticket creation.
        </p>
        {showError && (
          <p id={errorId} className="form-error" role="alert">
            Enter a valid Jira project key: 2–10 letters or digits, starting with a
            letter. Lowercase letters are converted to uppercase.
          </p>
        )}
      </div>
    </div>
  );
}
