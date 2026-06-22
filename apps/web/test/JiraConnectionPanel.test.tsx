import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import JiraConnectionPanel from '../src/components/JiraConnectionPanel';
import {
  getJiraConnection,
  saveJiraConnection,
  JiraApiError,
  type JiraConnected,
} from '../src/api/jira';

vi.mock('../src/api/jira', async () => {
  const actual = await vi.importActual<typeof import('../src/api/jira')>('../src/api/jira');
  return {
    ...actual,
    getJiraConnection: vi.fn(),
    saveJiraConnection: vi.fn(),
  };
});

const mockedGet = vi.mocked(getJiraConnection);
const mockedSave = vi.mocked(saveJiraConnection);

const connected: JiraConnected = {
  connected: true,
  siteUrl: 'https://acme.atlassian.net',
  email: 'alice@example.com',
};

const TOKEN = 'plain-text-secret-token';

function fillField(label: RegExp, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

function tokenInput(): HTMLInputElement {
  return screen.getByLabelText(/api token/i) as HTMLInputElement;
}

function fillForm(token = TOKEN) {
  fillField(/site url/i, 'https://acme.atlassian.net');
  fillField(/account email/i, 'alice@example.com');
  fireEvent.change(tokenInput(), { target: { value: token } });
}

async function renderDisconnected() {
  mockedGet.mockResolvedValue({ connected: false });
  render(<JiraConnectionPanel />);
  return screen.findByRole('button', { name: /^connect jira$/i });
}

async function renderConnected() {
  mockedGet.mockResolvedValue(connected);
  render(<JiraConnectionPanel />);
  await screen.findByText('https://acme.atlassian.net');
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

describe('initial states', () => {
  it('shows a loading state while the status request is pending', () => {
    mockedGet.mockReturnValue(new Promise(() => {}));

    render(<JiraConnectionPanel />);

    expect(screen.getByText(/loading the jira connection/i)).toBeInTheDocument();
  });

  it('renders the disconnected state with the connection form', async () => {
    await renderDisconnected();

    expect(screen.getByText(/not connected to jira yet/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/site url/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/account email/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/api token/i)).toBeInTheDocument();
    expect(screen.getByText(/atlassian\.net/i)).toBeInTheDocument();
  });

  it('renders the connected state with only safe site URL and email', async () => {
    await renderConnected();

    expect(screen.getByText('https://acme.atlassian.net')).toBeInTheDocument();
    expect(screen.getByText('alice@example.com')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /replace connection/i })).toBeInTheDocument();
  });

  it('explains that the connection is shared by the whole tenant', async () => {
    await renderDisconnected();

    expect(screen.getByText(/shared by everyone in your tenant/i)).toBeInTheDocument();
  });

  it('shows a retryable error and recovers when the status load fails', async () => {
    mockedGet.mockRejectedValueOnce(new JiraApiError('network', 'x'));
    mockedGet.mockResolvedValueOnce({ connected: false });

    render(<JiraConnectionPanel />);

    fireEvent.click(await screen.findByRole('button', { name: /try again/i }));

    expect(await screen.findByRole('button', { name: /^connect jira$/i })).toBeInTheDocument();
  });
});

describe('status-load failures keep distinct, safe categories', () => {
  it('shows configuration copy for not_configured (retryable)', async () => {
    mockedGet.mockRejectedValue(new JiraApiError('not_configured', 'RAW server detail'));

    render(<JiraConnectionPanel />);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/not configured/i);
    expect(alert).not.toHaveTextContent(/RAW server detail/);
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });

  it('shows a sign-in/refresh message and no retry for an authentication failure', async () => {
    mockedGet.mockRejectedValue(new JiraApiError('authentication', 'RAW auth detail'));

    render(<JiraConnectionPanel />);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/session is no longer valid/i);
    expect(alert).toHaveTextContent(/refresh|sign in/i);
    expect(alert).not.toHaveTextContent(/RAW auth detail/);
    expect(screen.queryByRole('button', { name: /try again/i })).not.toBeInTheDocument();
  });

  it('shows network copy for a network failure (retryable)', async () => {
    mockedGet.mockRejectedValue(new JiraApiError('network', 'x'));

    render(<JiraConnectionPanel />);

    expect(await screen.findByRole('alert')).toHaveTextContent(/unable to reach the server/i);
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });

  it('shows unreachable copy for a Jira availability failure (retryable)', async () => {
    mockedGet.mockRejectedValue(new JiraApiError('unreachable', 'x'));

    render(<JiraConnectionPanel />);

    expect(await screen.findByRole('alert')).toHaveTextContent(/could not be reached/i);
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });

  it('shows timeout copy for a Jira timeout failure (retryable)', async () => {
    mockedGet.mockRejectedValue(new JiraApiError('timeout', 'x'));

    render(<JiraConnectionPanel />);

    expect(await screen.findByRole('alert')).toHaveTextContent(/did not respond in time/i);
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });

  it('falls back to generic server copy for an unknown error (retryable)', async () => {
    mockedGet.mockRejectedValue(new Error('boom'));

    render(<JiraConnectionPanel />);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/something went wrong/i);
    expect(alert).not.toHaveTextContent(/boom/);
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });

  it('recovers through Try again after a typed load failure', async () => {
    mockedGet.mockRejectedValueOnce(new JiraApiError('unreachable', 'x'));
    mockedGet.mockResolvedValueOnce({ connected: false });

    render(<JiraConnectionPanel />);

    fireEvent.click(await screen.findByRole('button', { name: /try again/i }));

    expect(await screen.findByRole('button', { name: /^connect jira$/i })).toBeInTheDocument();
  });
});

describe('successful submissions', () => {
  it('connects from the disconnected state and shows created feedback', async () => {
    await renderDisconnected();
    mockedSave.mockResolvedValue(connected);

    fillForm();
    fireEvent.click(screen.getByRole('button', { name: /^connect jira$/i }));

    expect(await screen.findByRole('status')).toHaveTextContent(/connection created/i);
    expect(screen.getByText('https://acme.atlassian.net')).toBeInTheDocument();
    expect(mockedSave).toHaveBeenCalledWith({
      siteUrl: 'https://acme.atlassian.net',
      email: 'alice@example.com',
      apiToken: TOKEN,
    });
  });

  it('replaces an existing connection and shows replaced feedback', async () => {
    await renderConnected();
    const replacement: JiraConnected = {
      connected: true,
      siteUrl: 'https://acme-new.atlassian.net',
      email: 'bob@example.com',
    };
    mockedSave.mockResolvedValue(replacement);

    fireEvent.click(screen.getByRole('button', { name: /replace connection/i }));
    fillField(/site url/i, 'https://acme-new.atlassian.net');
    fillField(/account email/i, 'bob@example.com');
    fireEvent.change(tokenInput(), { target: { value: TOKEN } });
    fireEvent.click(screen.getByRole('button', { name: /^replace connection$/i }));

    expect(await screen.findByRole('status')).toHaveTextContent(/connection replaced/i);
    expect(screen.getByText('https://acme-new.atlassian.net')).toBeInTheDocument();
  });
});

describe('client validation and duplicate submission', () => {
  it('rejects empty fields without calling the backend', async () => {
    await renderDisconnected();

    fireEvent.click(screen.getByRole('button', { name: /^connect jira$/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/enter the jira site url/i);
    expect(mockedSave).not.toHaveBeenCalled();
  });

  it('prevents duplicate submissions while a save is in flight', async () => {
    await renderDisconnected();
    let resolveSave: (value: JiraConnected) => void = () => {};
    mockedSave.mockReturnValue(
      new Promise<JiraConnected>((resolve) => {
        resolveSave = resolve;
      }),
    );

    fillForm();
    const submit = screen.getByRole('button', { name: /^connect jira$/i });
    fireEvent.click(submit);
    fireEvent.click(submit);

    expect(mockedSave).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: /connecting/i })).toBeDisabled();

    resolveSave(connected);
    expect(await screen.findByRole('status')).toBeInTheDocument();
  });
});

describe('error mapping', () => {
  async function submitFailingWith(kind: ConstructorParameters<typeof JiraApiError>[0]) {
    await renderDisconnected();
    mockedSave.mockRejectedValue(new JiraApiError(kind, 'ignored'));
    fillForm();
    fireEvent.click(screen.getByRole('button', { name: /^connect jira$/i }));
    return screen.findByRole('alert');
  }

  it('shows credential-rejection copy', async () => {
    expect(await submitFailingWith('credentials_rejected')).toHaveTextContent(/jira rejected/i);
  });

  it('shows configuration-error copy', async () => {
    expect(await submitFailingWith('not_configured')).toHaveTextContent(/not configured/i);
  });

  it('shows timeout copy', async () => {
    expect(await submitFailingWith('timeout')).toHaveTextContent(/did not respond in time/i);
  });

  it('shows unreachable copy', async () => {
    expect(await submitFailingWith('unreachable')).toHaveTextContent(/could not be reached/i);
  });

  it('shows network/server-failure copy', async () => {
    expect(await submitFailingWith('network')).toHaveTextContent(/unable to reach the server/i);
  });
});

describe('failed replacement keeps the existing connection', () => {
  it('keeps the previous connection visible and active after a failed replace', async () => {
    await renderConnected();
    mockedSave.mockRejectedValue(new JiraApiError('credentials_rejected', 'ignored'));

    fireEvent.click(screen.getByRole('button', { name: /replace connection/i }));
    fillField(/site url/i, 'https://acme-new.atlassian.net');
    fillField(/account email/i, 'bob@example.com');
    fireEvent.change(tokenInput(), { target: { value: TOKEN } });
    fireEvent.click(screen.getByRole('button', { name: /^replace connection$/i }));

    await screen.findByRole('alert');
    // The original connection details are still shown and labelled connected.
    expect(screen.getByText('https://acme.atlassian.net')).toBeInTheDocument();
    expect(screen.getByText('Connected')).toBeInTheDocument();
  });
});

describe('API token secret handling', () => {
  it('uses a password input for the token', async () => {
    await renderDisconnected();

    expect(tokenInput()).toHaveAttribute('type', 'password');
  });

  it('keeps the token uncontrolled (value survives unrelated re-renders)', async () => {
    await renderDisconnected();

    fireEvent.change(tokenInput(), { target: { value: TOKEN } });
    // An unrelated controlled-state update re-renders the component.
    fillField(/account email/i, 'alice@example.com');

    // A controlled input bound to state would have been reset; an uncontrolled one keeps its value.
    expect(tokenInput().value).toBe(TOKEN);
  });

  it('clears the token field immediately when submission starts', async () => {
    await renderDisconnected();
    mockedSave.mockReturnValue(new Promise<JiraConnected>(() => {}));

    fillForm();
    fireEvent.click(screen.getByRole('button', { name: /^connect jira$/i }));

    // Cleared before the request resolves (the save promise is still pending).
    expect(tokenInput().value).toBe('');
    expect(screen.getByRole('button', { name: /connecting/i })).toBeDisabled();
  });

  it('leaves the token cleared after a successful submission', async () => {
    await renderConnected();
    mockedSave.mockResolvedValue(connected);

    fireEvent.click(screen.getByRole('button', { name: /replace connection/i }));
    fillField(/site url/i, 'https://acme.atlassian.net');
    fillField(/account email/i, 'alice@example.com');
    fireEvent.change(tokenInput(), { target: { value: TOKEN } });
    fireEvent.click(screen.getByRole('button', { name: /^replace connection$/i }));

    await screen.findByRole('status');
    // Reopen the replace form; the token field starts empty.
    fireEvent.click(screen.getByRole('button', { name: /replace connection/i }));
    expect(tokenInput().value).toBe('');
  });

  it('leaves the token cleared after a failed submission', async () => {
    await renderDisconnected();
    mockedSave.mockRejectedValue(new JiraApiError('credentials_rejected', 'ignored'));

    fillForm();
    fireEvent.click(screen.getByRole('button', { name: /^connect jira$/i }));

    await screen.findByRole('alert');
    expect(tokenInput().value).toBe('');
  });

  it('requires a newly entered token for a second attempt', async () => {
    await renderDisconnected();
    mockedSave.mockRejectedValue(new JiraApiError('credentials_rejected', 'ignored'));

    fillForm();
    fireEvent.click(screen.getByRole('button', { name: /^connect jira$/i }));
    await screen.findByRole('alert');
    expect(mockedSave).toHaveBeenCalledTimes(1);

    // Submitting again without re-entering the token is blocked by client validation.
    fireEvent.click(screen.getByRole('button', { name: /^connect jira$/i }));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(/enter the jira site url/i),
    );
    expect(mockedSave).toHaveBeenCalledTimes(1);
  });

  it('never renders the token in status or error output', async () => {
    await renderDisconnected();
    mockedSave.mockRejectedValue(new JiraApiError('credentials_rejected', 'ignored'));

    fillForm();
    const { container } = { container: document.body };
    fireEvent.click(screen.getByRole('button', { name: /^connect jira$/i }));

    await screen.findByRole('alert');
    expect(container.textContent).not.toContain(TOKEN);
  });
});
