/**
 * Tests for TicketCreationForm — the reusable ticket creation form that
 * contains Title and Description inputs (no Project key input). The project
 * key is supplied by the caller as a prop and shown as read-only context.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TicketCreationForm from '../src/components/TicketCreationForm';
import { createTicket, TicketApiError, type CreatedTicket } from '../src/api/tickets';

vi.mock('../src/api/tickets', async () => {
  const actual = await vi.importActual<typeof import('../src/api/tickets')>('../src/api/tickets');
  return {
    ...actual,
    createTicket: vi.fn(),
  };
});

const mockedCreate = vi.mocked(createTicket);

const created: CreatedTicket = { issueId: '10005', issueKey: 'SCRUM-6' };

function fill(label: RegExp, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

function fillForm(overrides: { title?: string; description?: string } = {}) {
  fill(/title/i, overrides.title ?? 'Stale Service Account');
  fill(/description/i, overrides.description ?? 'Finding details');
}

function submit() {
  fireEvent.click(screen.getByRole('button', { name: /^create ticket$/i }));
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

describe('rendering', () => {
  it('renders title and description inputs and a create button — no project key input', () => {
    render(<TicketCreationForm projectKey="SCRUM" />);

    expect(screen.getByLabelText(/title/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/description/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^create ticket$/i })).toBeInTheDocument();
    // The form must NOT contain a project-key input.
    expect(screen.queryByLabelText(/project key/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/jira project/i)).not.toBeInTheDocument();
  });

  it('shows the project key as read-only context', () => {
    render(<TicketCreationForm projectKey="SCRUM" />);

    expect(screen.getByText(/creating in project/i)).toBeInTheDocument();
    expect(screen.getByText('SCRUM')).toBeInTheDocument();
  });
});

describe('client validation', () => {
  it('rejects an empty title without calling the backend', async () => {
    render(<TicketCreationForm projectKey="SCRUM" />);

    fill(/title/i, '   ');
    fill(/description/i, 'some description');
    submit();

    expect(await screen.findByRole('alert')).toHaveTextContent(/enter a title/i);
    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it('rejects an over-long title without calling the backend', async () => {
    render(<TicketCreationForm projectKey="SCRUM" />);

    fillForm({ title: 'x'.repeat(256) });
    submit();

    expect(await screen.findByRole('alert')).toHaveTextContent(/title must be 255 characters/i);
    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it('rejects an empty description without calling the backend', async () => {
    render(<TicketCreationForm projectKey="SCRUM" />);

    fill(/title/i, 'Some title');
    fill(/description/i, '   ');
    submit();

    expect(await screen.findByRole('alert')).toHaveTextContent(/enter a description/i);
    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it('rejects an over-long description without calling the backend', async () => {
    render(<TicketCreationForm projectKey="SCRUM" />);

    fillForm({ description: 'x'.repeat(5001) });
    submit();

    expect(await screen.findByRole('alert')).toHaveTextContent(/description must be 5000 characters/i);
    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it('rejects empty fields without calling the backend', async () => {
    render(<TicketCreationForm projectKey="SCRUM" />);

    submit();

    expect(await screen.findByRole('alert')).toHaveTextContent(/enter a title/i);
    expect(mockedCreate).not.toHaveBeenCalled();
  });
});

describe('request payload', () => {
  it('sends the trimmed title and description with the supplied project key', async () => {
    render(<TicketCreationForm projectKey="SCRUM" />);
    mockedCreate.mockResolvedValue(created);

    fill(/title/i, '  Leaked key  ');
    fill(/description/i, '  Line one\nLine two  ');
    submit();

    await screen.findByRole('status');
    expect(mockedCreate).toHaveBeenCalledWith({
      projectKey: 'SCRUM',
      title: 'Leaked key',
      description: 'Line one\nLine two',
    });
  });
});

describe('loading and duplicate submission', () => {
  it('disables the controls while the request is pending', async () => {
    render(<TicketCreationForm projectKey="SCRUM" />);
    mockedCreate.mockReturnValue(new Promise<CreatedTicket>(() => {}));

    fillForm();
    submit();

    expect(screen.getByRole('button', { name: /creating/i })).toBeDisabled();
    expect(screen.getByLabelText(/title/i)).toBeDisabled();
    expect(screen.getByLabelText(/description/i)).toBeDisabled();
  });

  it('prevents duplicate submissions while a request is in flight', async () => {
    render(<TicketCreationForm projectKey="SCRUM" />);
    let resolveCreate: (value: CreatedTicket) => void = () => {};
    mockedCreate.mockReturnValue(
      new Promise<CreatedTicket>((resolve) => { resolveCreate = resolve; }),
    );

    fillForm();
    const button = screen.getByRole('button', { name: /^create ticket$/i });
    fireEvent.click(button);
    fireEvent.click(button);

    expect(mockedCreate).toHaveBeenCalledTimes(1);

    resolveCreate(created);
    await screen.findByRole('status');
    expect(mockedCreate).toHaveBeenCalledTimes(1);
  });
});

describe('success behavior', () => {
  it('shows the returned issue key and clears title and description', async () => {
    render(<TicketCreationForm projectKey="SCRUM" />);
    mockedCreate.mockResolvedValue(created);

    fillForm();
    submit();

    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent(/SCRUM-6/);
    expect((screen.getByLabelText(/title/i) as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText(/description/i) as HTMLTextAreaElement).value).toBe('');
  });

  it('calls onSuccess after a successful creation', async () => {
    const onSuccess = vi.fn();
    render(<TicketCreationForm projectKey="SCRUM" onSuccess={onSuccess} />);
    mockedCreate.mockResolvedValue(created);

    fillForm();
    submit();

    await screen.findByRole('status');
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(onSuccess).toHaveBeenCalledWith('SCRUM-6');
  });

  it('does not call onSuccess after a failed creation', async () => {
    const onSuccess = vi.fn();
    render(<TicketCreationForm projectKey="SCRUM" onSuccess={onSuccess} />);
    mockedCreate.mockRejectedValue(new TicketApiError('unreachable', 'x'));

    fillForm();
    submit();

    await screen.findByRole('alert');
    expect(onSuccess).not.toHaveBeenCalled();
  });
});

describe('error categories', () => {
  async function submitFailingWith(kind: ConstructorParameters<typeof TicketApiError>[0]) {
    mockedCreate.mockRejectedValue(new TicketApiError(kind, 'ignored raw text'));
    fillForm();
    submit();
    return screen.findByRole('alert');
  }

  it('shows not-connected copy', async () => {
    render(<TicketCreationForm projectKey="SCRUM" />);
    expect(await submitFailingWith('not_connected')).toHaveTextContent(/no longer connected to jira/i);
  });

  it('shows project-inaccessible copy', async () => {
    render(<TicketCreationForm projectKey="SCRUM" />);
    expect(await submitFailingWith('project_inaccessible')).toHaveTextContent(/could not be found or is not accessible/i);
  });

  it('shows task-unsupported copy', async () => {
    render(<TicketCreationForm projectKey="SCRUM" />);
    expect(await submitFailingWith('task_unsupported')).toHaveTextContent(/does not support the task issue type/i);
  });

  it('shows credentials-rejected copy', async () => {
    render(<TicketCreationForm projectKey="SCRUM" />);
    expect(await submitFailingWith('credentials_rejected')).toHaveTextContent(/stored jira credentials were rejected/i);
  });

  it('shows not-configured copy', async () => {
    render(<TicketCreationForm projectKey="SCRUM" />);
    expect(await submitFailingWith('not_configured')).toHaveTextContent(/not configured on the server/i);
  });

  it('shows authentication copy', async () => {
    render(<TicketCreationForm projectKey="SCRUM" />);
    expect(await submitFailingWith('authentication')).toHaveTextContent(/session is no longer valid/i);
  });

  it('warns about a possible duplicate on a network failure', async () => {
    render(<TicketCreationForm projectKey="SCRUM" />);
    const alert = await submitFailingWith('network');
    expect(alert).toHaveTextContent(/check jira/i);
    expect(alert).toHaveTextContent(/duplicate/i);
  });

  it('warns about a possible duplicate on a server failure and never shows raw message', async () => {
    render(<TicketCreationForm projectKey="SCRUM" />);
    const alert = await submitFailingWith('server');
    expect(alert).toHaveTextContent(/check jira/i);
    expect(alert).toHaveTextContent(/duplicate/i);
    expect(alert).not.toHaveTextContent(/ignored raw text/);
  });

  it('treats an unexpected error type as an uncertain server outcome', async () => {
    render(<TicketCreationForm projectKey="SCRUM" />);
    mockedCreate.mockRejectedValue(new Error('boom'));

    fillForm();
    submit();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/check jira/i);
    expect(alert).toHaveTextContent(/duplicate/i);
    expect(alert).not.toHaveTextContent(/boom/);
  });
});

describe('uncertain outcomes warn about possible duplicates', () => {
  it('warns to check Jira before retrying on a timeout', async () => {
    render(<TicketCreationForm projectKey="SCRUM" />);
    mockedCreate.mockRejectedValue(new TicketApiError('timeout', 'ignored'));

    fillForm();
    submit();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/check jira/i);
    expect(alert).toHaveTextContent(/duplicate/i);
  });

  it('warns to check Jira before retrying on a generic upstream failure', async () => {
    render(<TicketCreationForm projectKey="SCRUM" />);
    mockedCreate.mockRejectedValue(new TicketApiError('unreachable', 'ignored'));

    fillForm();
    submit();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/check jira/i);
    expect(alert).toHaveTextContent(/duplicate/i);
  });
});

describe('onSubmittingChange callback', () => {
  it('calls onSubmittingChange(true) immediately when submission starts', async () => {
    const onSubmittingChange = vi.fn();
    render(<TicketCreationForm projectKey="SCRUM" onSubmittingChange={onSubmittingChange} />);
    mockedCreate.mockReturnValue(new Promise<CreatedTicket>(() => {}));

    fillForm();
    submit();

    expect(onSubmittingChange).toHaveBeenCalledWith(true);
    expect(onSubmittingChange).not.toHaveBeenCalledWith(false);
  });

  it('calls onSubmittingChange(false) after successful creation', async () => {
    const onSubmittingChange = vi.fn();
    render(<TicketCreationForm projectKey="SCRUM" onSubmittingChange={onSubmittingChange} />);
    mockedCreate.mockResolvedValue(created);

    fillForm();
    submit();

    await screen.findByRole('status');
    expect(onSubmittingChange).toHaveBeenCalledWith(false);
  });

  it('calls onSubmittingChange(false) after a failed creation', async () => {
    const onSubmittingChange = vi.fn();
    render(<TicketCreationForm projectKey="SCRUM" onSubmittingChange={onSubmittingChange} />);
    mockedCreate.mockRejectedValue(new TicketApiError('unreachable', 'x'));

    fillForm();
    submit();

    await screen.findByRole('alert');
    expect(onSubmittingChange).toHaveBeenCalledWith(true);
    expect(onSubmittingChange).toHaveBeenCalledWith(false);
  });
});

describe('accessibility', () => {
  it('announces validation errors through an alert region', async () => {
    render(<TicketCreationForm projectKey="SCRUM" />);

    submit();

    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });

  it('announces a successful creation through a status region', async () => {
    render(<TicketCreationForm projectKey="SCRUM" />);
    mockedCreate.mockResolvedValue(created);

    fillForm();
    submit();

    expect(await screen.findByRole('status')).toBeInTheDocument();
  });
});
