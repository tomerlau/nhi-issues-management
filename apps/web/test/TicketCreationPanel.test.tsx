import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TicketCreationPanel from '../src/components/TicketCreationPanel';
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

function fillForm(overrides: { projectKey?: string; title?: string; description?: string } = {}) {
  fill(/project key/i, overrides.projectKey ?? 'SCRUM');
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
  it('renders the project key, title, and description inputs with a create button', () => {
    render(<TicketCreationPanel />);

    expect(screen.getByLabelText(/project key/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/title/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/description/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^create ticket$/i })).toBeInTheDocument();
  });
});

describe('client validation', () => {
  it('rejects empty fields without calling the backend', async () => {
    render(<TicketCreationPanel />);

    submit();

    expect(await screen.findByRole('alert')).toHaveTextContent(/enter a jira project key/i);
    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it('rejects a syntactically invalid project key without calling the backend', async () => {
    render(<TicketCreationPanel />);

    fillForm({ projectKey: '1AB' });
    submit();

    expect(await screen.findByRole('alert')).toHaveTextContent(/valid jira project key/i);
    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it('rejects a too-short project key without calling the backend', async () => {
    render(<TicketCreationPanel />);

    fillForm({ projectKey: 'A' });
    submit();

    expect(await screen.findByRole('alert')).toHaveTextContent(/valid jira project key/i);
    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it('rejects a missing title without calling the backend', async () => {
    render(<TicketCreationPanel />);

    fillForm({ title: '   ' });
    submit();

    expect(await screen.findByRole('alert')).toHaveTextContent(/enter a title/i);
    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it('rejects an over-long title without calling the backend', async () => {
    render(<TicketCreationPanel />);

    fillForm({ title: 'x'.repeat(256) });
    submit();

    expect(await screen.findByRole('alert')).toHaveTextContent(/title must be 255 characters/i);
    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it('rejects a missing description without calling the backend', async () => {
    render(<TicketCreationPanel />);

    fillForm({ description: '   ' });
    submit();

    expect(await screen.findByRole('alert')).toHaveTextContent(/enter a description/i);
    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it('rejects an over-long description without calling the backend', async () => {
    render(<TicketCreationPanel />);

    fillForm({ description: 'x'.repeat(5001) });
    submit();

    expect(await screen.findByRole('alert')).toHaveTextContent(/description must be 5000 characters/i);
    expect(mockedCreate).not.toHaveBeenCalled();
  });
});

describe('request payload', () => {
  it('normalizes the project key to uppercase and sends the trimmed payload', async () => {
    render(<TicketCreationPanel />);
    mockedCreate.mockResolvedValue(created);

    fill(/project key/i, 'scrum');
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

  it('shows the normalized uppercase project key in the input as the user types', () => {
    render(<TicketCreationPanel />);

    fill(/project key/i, 'scrum');

    expect((screen.getByLabelText(/project key/i) as HTMLInputElement).value).toBe('SCRUM');
  });
});

describe('loading and duplicate submission', () => {
  it('disables the controls while the request is pending', async () => {
    render(<TicketCreationPanel />);
    mockedCreate.mockReturnValue(new Promise<CreatedTicket>(() => {}));

    fillForm();
    submit();

    expect(screen.getByRole('button', { name: /creating/i })).toBeDisabled();
    expect(screen.getByLabelText(/project key/i)).toBeDisabled();
    expect(screen.getByLabelText(/title/i)).toBeDisabled();
    expect(screen.getByLabelText(/description/i)).toBeDisabled();
  });

  it('prevents duplicate submissions while a request is in flight', async () => {
    render(<TicketCreationPanel />);
    let resolveCreate: (value: CreatedTicket) => void = () => {};
    mockedCreate.mockReturnValue(
      new Promise<CreatedTicket>((resolve) => {
        resolveCreate = resolve;
      }),
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
  it('shows the returned issue key and clears title and description but keeps the project key', async () => {
    render(<TicketCreationPanel />);
    mockedCreate.mockResolvedValue(created);

    fillForm();
    submit();

    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent(/SCRUM-6/);
    expect((screen.getByLabelText(/project key/i) as HTMLInputElement).value).toBe('SCRUM');
    expect((screen.getByLabelText(/title/i) as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText(/description/i) as HTMLTextAreaElement).value).toBe('');
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
    render(<TicketCreationPanel />);
    expect(await submitFailingWith('not_connected')).toHaveTextContent(/no longer connected to jira/i);
  });

  it('shows project-inaccessible copy', async () => {
    render(<TicketCreationPanel />);
    expect(await submitFailingWith('project_inaccessible')).toHaveTextContent(/could not be found or is not accessible/i);
  });

  it('shows task-unsupported copy', async () => {
    render(<TicketCreationPanel />);
    expect(await submitFailingWith('task_unsupported')).toHaveTextContent(/does not support the task issue type/i);
  });

  it('shows credentials-rejected copy', async () => {
    render(<TicketCreationPanel />);
    expect(await submitFailingWith('credentials_rejected')).toHaveTextContent(/stored jira credentials were rejected/i);
  });

  it('shows not-configured copy', async () => {
    render(<TicketCreationPanel />);
    expect(await submitFailingWith('not_configured')).toHaveTextContent(/not configured on the server/i);
  });

  it('shows authentication copy', async () => {
    render(<TicketCreationPanel />);
    expect(await submitFailingWith('authentication')).toHaveTextContent(/session is no longer valid/i);
  });

  it('shows network copy', async () => {
    render(<TicketCreationPanel />);
    expect(await submitFailingWith('network')).toHaveTextContent(/unable to reach the server/i);
  });

  it('shows generic server copy and never the raw message', async () => {
    render(<TicketCreationPanel />);
    const alert = await submitFailingWith('server');
    expect(alert).toHaveTextContent(/something went wrong/i);
    expect(alert).not.toHaveTextContent(/ignored raw text/);
  });

  it('falls back to generic server copy for an unexpected error type', async () => {
    render(<TicketCreationPanel />);
    mockedCreate.mockRejectedValue(new Error('boom'));

    fillForm();
    submit();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/something went wrong/i);
    expect(alert).not.toHaveTextContent(/boom/);
  });
});

describe('uncertain outcomes warn about possible duplicates', () => {
  it('warns to check Jira before retrying on a timeout', async () => {
    render(<TicketCreationPanel />);
    mockedCreate.mockRejectedValue(new TicketApiError('timeout', 'ignored'));

    fillForm();
    submit();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/check jira/i);
    expect(alert).toHaveTextContent(/duplicate/i);
  });

  it('warns to check Jira before retrying on a generic upstream failure', async () => {
    render(<TicketCreationPanel />);
    mockedCreate.mockRejectedValue(new TicketApiError('unreachable', 'ignored'));

    fillForm();
    submit();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/check jira/i);
    expect(alert).toHaveTextContent(/duplicate/i);
  });
});

describe('accessibility', () => {
  it('announces validation errors through an alert region', async () => {
    render(<TicketCreationPanel />);

    submit();

    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });

  it('announces a successful creation through a status region', async () => {
    render(<TicketCreationPanel />);
    mockedCreate.mockResolvedValue(created);

    fillForm();
    submit();

    expect(await screen.findByRole('status')).toBeInTheDocument();
  });
});
