import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ProjectSelector from '../src/components/ProjectSelector';

afterEach(() => {
  cleanup();
});

describe('rendering', () => {
  it('renders a "Jira project" label and input', () => {
    render(<ProjectSelector value="" onChange={vi.fn()} />);

    expect(screen.getByLabelText(/jira project/i)).toBeInTheDocument();
  });

  it('renders the "Used for recent tickets" helper text', () => {
    render(<ProjectSelector value="" onChange={vi.fn()} />);

    expect(screen.getByText(/used for recent tickets and new ticket creation/i)).toBeInTheDocument();
  });

  it('reflects the current value', () => {
    render(<ProjectSelector value="SCRUM" onChange={vi.fn()} />);

    expect((screen.getByLabelText(/jira project/i) as HTMLInputElement).value).toBe('SCRUM');
  });

  it('is outside any ticket-creation form', () => {
    render(<ProjectSelector value="" onChange={vi.fn()} />);

    const input = screen.getByLabelText(/jira project/i);
    expect(input.closest('form')).toBeNull();
  });
});

describe('onChange', () => {
  it('calls onChange when the user types', () => {
    const onChange = vi.fn();
    render(<ProjectSelector value="" onChange={onChange} />);

    fireEvent.change(screen.getByLabelText(/jira project/i), { target: { value: 'SCRUM' } });

    expect(onChange).toHaveBeenCalledWith('SCRUM');
  });
});

describe('validation error display', () => {
  it('shows no error for an empty value', () => {
    render(<ProjectSelector value="" onChange={vi.fn()} />);

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows no error for a valid project key', () => {
    render(<ProjectSelector value="SCRUM" onChange={vi.fn()} />);

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows a validation error for a non-empty invalid key (starts with digit)', () => {
    render(<ProjectSelector value="1AB" onChange={vi.fn()} />);

    expect(screen.getByRole('alert')).toHaveTextContent(/valid jira project key/i);
  });

  it('shows a validation error for a single-character key (too short)', () => {
    render(<ProjectSelector value="A" onChange={vi.fn()} />);

    expect(screen.getByRole('alert')).toHaveTextContent(/valid jira project key/i);
  });

  it('shows a validation error for a key that is too long', () => {
    render(<ProjectSelector value="TOOLONGKEY1" onChange={vi.fn()} />);

    expect(screen.getByRole('alert')).toHaveTextContent(/valid jira project key/i);
  });

  it('mentions lowercase normalisation in the validation error copy', () => {
    render(<ProjectSelector value="1AB" onChange={vi.fn()} />);

    expect(screen.getByRole('alert')).toHaveTextContent(/lowercase letters are converted to uppercase/i);
  });

  it('shows no error for a lowercase key (normalised to a valid key)', () => {
    render(<ProjectSelector value="scrum" onChange={vi.fn()} />);

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('disabled state', () => {
  it('disables the input when disabled prop is true', () => {
    render(<ProjectSelector value="SCRUM" onChange={vi.fn()} disabled />);

    expect(screen.getByLabelText(/jira project/i)).toBeDisabled();
  });
});
