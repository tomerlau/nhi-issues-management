import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
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

  it('does not render the persistent helper text', () => {
    render(<ProjectSelector value="" onChange={vi.fn()} />);

    expect(screen.queryByText(/used for recent tickets and new ticket creation/i)).not.toBeInTheDocument();
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

describe('info icon and tooltip', () => {
  it('renders an info icon button next to the "Jira project" label', () => {
    render(<ProjectSelector value="" onChange={vi.fn()} />);

    expect(screen.getByRole('button', { name: /about the project key/i })).toBeInTheDocument();
  });

  it('info icon has an accessible name', () => {
    render(<ProjectSelector value="" onChange={vi.fn()} />);

    const icon = screen.getByRole('button', { name: /about the project key/i });
    expect(icon).toHaveAccessibleName();
  });

  it('info icon is keyboard focusable', () => {
    render(<ProjectSelector value="" onChange={vi.fn()} />);

    const icon = screen.getByRole('button', { name: /about the project key/i });
    expect(icon).not.toBeDisabled();
    icon.focus();
    expect(document.activeElement).toBe(icon);
  });

  it('tooltip is not visible initially', () => {
    render(<ProjectSelector value="" onChange={vi.fn()} />);

    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('tooltip appears on mouse hover', async () => {
    render(<ProjectSelector value="" onChange={vi.fn()} />);

    const icon = screen.getByRole('button', { name: /about the project key/i });
    await act(async () => { fireEvent.mouseEnter(icon); });

    expect(screen.getByRole('tooltip')).toBeInTheDocument();
  });

  it('tooltip appears on keyboard focus', async () => {
    render(<ProjectSelector value="" onChange={vi.fn()} />);

    const icon = screen.getByRole('button', { name: /about the project key/i });
    await act(async () => { fireEvent.focus(icon); });

    expect(screen.getByRole('tooltip')).toBeInTheDocument();
  });

  it('tooltip contains the exact approved text', async () => {
    render(<ProjectSelector value="" onChange={vi.fn()} />);

    const icon = screen.getByRole('button', { name: /about the project key/i });
    await act(async () => { fireEvent.mouseEnter(icon); });

    expect(screen.getByRole('tooltip')).toHaveTextContent(
      'Enter a Jira project key to view or create tickets.',
    );
  });

  it('tooltip hides after mouse leave', async () => {
    render(<ProjectSelector value="" onChange={vi.fn()} />);

    const icon = screen.getByRole('button', { name: /about the project key/i });
    await act(async () => { fireEvent.mouseEnter(icon); });
    expect(screen.getByRole('tooltip')).toBeInTheDocument();

    await act(async () => { fireEvent.mouseLeave(icon); });
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('tooltip hides after blur', async () => {
    render(<ProjectSelector value="" onChange={vi.fn()} />);

    const icon = screen.getByRole('button', { name: /about the project key/i });
    await act(async () => { fireEvent.focus(icon); });
    expect(screen.getByRole('tooltip')).toBeInTheDocument();

    await act(async () => { fireEvent.blur(icon); });
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('tooltip carries the readable-width tooltip-text class', async () => {
    render(<ProjectSelector value="" onChange={vi.fn()} />);

    const icon = screen.getByRole('button', { name: /about the project key/i });
    await act(async () => { fireEvent.focus(icon); });

    // The shared .tooltip-text class owns the readable width, sentence
    // wrapping, and viewport-bounded sizing.
    expect(screen.getByRole('tooltip')).toHaveClass('tooltip-text');
  });

  it('does not render a separate standalone no-project paragraph', () => {
    render(<ProjectSelector value="" onChange={vi.fn()} />);

    // The previous milestone removed the persistent helper sentence in favour
    // of the icon + tooltip — confirm no replacement standalone paragraph
    // was reintroduced.
    expect(
      screen.queryByText(/enter a jira project key to view or create tickets\./i),
    ).not.toBeInTheDocument();
  });
});
