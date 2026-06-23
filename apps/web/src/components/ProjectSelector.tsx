import { useId, useState } from 'react';
import { isValidProjectKey, normalizeProjectKey } from '../utils/project-key';

interface ProjectSelectorProps {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}

export default function ProjectSelector({ value, onChange, disabled }: ProjectSelectorProps) {
  const inputId = useId();
  const errorId = useId();
  const tooltipId = useId();
  const [tooltipVisible, setTooltipVisible] = useState(false);

  const normalized = normalizeProjectKey(value);
  const showError = value.length > 0 && !isValidProjectKey(normalized);

  return (
    <div className="project-selector">
      <div className="field">
        <div className="field-label-row">
          <label htmlFor={inputId}>Jira project</label>
          <span className="tooltip-anchor">
            <button
              type="button"
              className="info-icon"
              aria-label="About the project key"
              aria-describedby={tooltipId}
              onMouseEnter={() => setTooltipVisible(true)}
              onMouseLeave={() => setTooltipVisible(false)}
              onFocus={() => setTooltipVisible(true)}
              onBlur={() => setTooltipVisible(false)}
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 16 16"
                width="14"
                height="14"
                aria-hidden="true"
                focusable="false"
              >
                <circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" strokeWidth="1.5" />
                <path d="M8 7v5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                <circle cx="8" cy="5" r="0.75" fill="currentColor" />
              </svg>
            </button>
            {tooltipVisible && (
              <span role="tooltip" id={tooltipId} className="tooltip-text">
                Enter a Jira project key to view or create tickets.
              </span>
            )}
          </span>
        </div>
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
          aria-describedby={showError ? errorId : undefined}
        />
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
