/**
 * Tests for the refactored JiraConnectionPanel — compact status bar +
 * connected-only management modal.
 *
 * Disconnected state: red indicator + "Jira not connected" text — no button.
 * Connected state: green indicator + "Jira connected" + gear button
 *   (aria-label="Manage Jira connection") that opens the "Manage Jira
 *   connection" modal for replacement.
 *
 * The initial connection form lives in JiraInlineConnectForm (tested in
 * App.test.tsx). This file covers the status bar, the connected manage modal,
 * token secret handling, autofill mitigation, and change-reporting callbacks.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
  await screen.findByText(/jira not connected/i);
}

async function renderConnected() {
  mockedGet.mockResolvedValue(connected);
  render(<JiraConnectionPanel />);
  await screen.findByRole('button', { name: /manage jira connection/i });
}

async function openConnectedModal() {
  await renderConnected();
  fireEvent.click(screen.getByRole('button', { name: /manage jira connection/i }));
  await screen.findByRole('dialog');
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// Compact status bar states
// ---------------------------------------------------------------------------

describe('compact status bar', () => {
  it('shows a loading state while the status request is pending', () => {
    mockedGet.mockReturnValue(new Promise(() => {}));

    render(<JiraConnectionPanel />);

    expect(screen.getByText(/loading jira connection/i)).toBeInTheDocument();
  });

  it('shows "Jira not connected" with no button when disconnected', async () => {
    await renderDisconnected();

    expect(screen.getByText(/jira not connected/i)).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('shows the disconnected indicator with the disconnected class', async () => {
    await renderDisconnected();

    expect(document.querySelector('.jira-indicator-disconnected')).toBeInTheDocument();
    expect(document.querySelector('.jira-indicator-connected')).not.toBeInTheDocument();
  });

  it('shows "Jira connected" and a gear trigger button when connected', async () => {
    await renderConnected();

    expect(screen.getByText(/jira connected/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /manage jira connection/i })).toBeInTheDocument();
  });

  it('does NOT show a visible "Manage" text label on the gear button', async () => {
    await renderConnected();

    expect(screen.queryByRole('button', { name: /^manage$/i })).not.toBeInTheDocument();
  });

  it('does NOT show site URL or email on the page (only inside the modal)', async () => {
    await renderConnected();

    expect(screen.queryByText('https://acme.atlassian.net')).not.toBeInTheDocument();
    expect(screen.queryByText('alice@example.com')).not.toBeInTheDocument();
  });

  it('does NOT show the sharing disclaimer on the page when disconnected', async () => {
    await renderDisconnected();

    expect(screen.queryByText(/shared by everyone in your tenant/i)).not.toBeInTheDocument();
  });

  it('does NOT open a dialog in the disconnected state', async () => {
    await renderDisconnected();

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('shows a retryable error in the bar when status load fails', async () => {
    mockedGet.mockRejectedValueOnce(new JiraApiError('network', 'x'));
    mockedGet.mockResolvedValueOnce({ connected: false });

    render(<JiraConnectionPanel />);

    fireEvent.click(await screen.findByRole('button', { name: /try again/i }));

    await screen.findByText(/jira not connected/i);
    expect(screen.queryByRole('button', { name: /try again/i })).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Load-error category copy
// ---------------------------------------------------------------------------

describe('status-load failures keep distinct, safe categories', () => {
  it('shows configuration copy for not_configured (retryable)', async () => {
    mockedGet.mockRejectedValue(new JiraApiError('not_configured', 'RAW server detail'));

    render(<JiraConnectionPanel />);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/not configured/i);
    expect(alert).not.toHaveTextContent(/RAW server detail/);
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });

  it('shows a sign-in/refresh message and no retry for authentication failure', async () => {
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

  it('falls back to generic server copy for an unknown error (retryable)', async () => {
    mockedGet.mockRejectedValue(new Error('boom'));

    render(<JiraConnectionPanel />);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/something went wrong/i);
    expect(alert).not.toHaveTextContent(/boom/);
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Modal open / close (connected state only)
// ---------------------------------------------------------------------------

describe('modal open and close', () => {
  it('opens a dialog when the gear button is clicked (connected)', async () => {
    await openConnectedModal();

    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('closes the dialog when the close button is clicked', async () => {
    await openConnectedModal();

    fireEvent.click(screen.getByRole('button', { name: /^close$/i }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('closes the dialog when the Cancel button is clicked', async () => {
    await openConnectedModal();

    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('closes the dialog on Escape key when not submitting', async () => {
    await openConnectedModal();

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('keeps the dialog open while a save is in flight (Escape blocked)', async () => {
    await openConnectedModal();
    mockedSave.mockReturnValue(new Promise<JiraConnected>(() => {}));

    fillForm();
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /^replace connection$/i }));

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });

    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Modal content
// ---------------------------------------------------------------------------

describe('modal content', () => {
  it('shows site URL and email inside the modal (connected/manage)', async () => {
    await openConnectedModal();

    expect(screen.getByText('https://acme.atlassian.net')).toBeInTheDocument();
    expect(screen.getByText('alice@example.com')).toBeInTheDocument();
  });

  it('shows the replacement form fields inside the modal', async () => {
    await openConnectedModal();

    expect(screen.getByLabelText(/site url/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/account email/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/api token/i)).toBeInTheDocument();
  });

  it('shows the tenant-sharing disclaimer inside the modal', async () => {
    await openConnectedModal();

    expect(within(screen.getByRole('dialog')).getByText(/shared by everyone in your tenant/i)).toBeInTheDocument();
  });

  it('modal title is "Manage Jira connection"', async () => {
    await openConnectedModal();

    expect(screen.getByRole('heading', { name: /manage jira connection/i })).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Successful submissions
// ---------------------------------------------------------------------------

describe('successful submissions', () => {
  it('replaces an existing connection and closes the modal', async () => {
    await openConnectedModal();
    const replacement: JiraConnected = {
      connected: true,
      siteUrl: 'https://acme-new.atlassian.net',
      email: 'bob@example.com',
    };
    mockedSave.mockResolvedValue(replacement);

    fillField(/site url/i, 'https://acme-new.atlassian.net');
    fillField(/account email/i, 'bob@example.com');
    fireEvent.change(tokenInput(), { target: { value: TOKEN } });
    fireEvent.click(screen.getByRole('button', { name: /^replace connection$/i }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    expect(screen.getByText(/jira connected/i)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Failed submissions keep modal open
// ---------------------------------------------------------------------------

describe('failed submissions keep modal open', () => {
  it('keeps the modal open after a failed connection replacement', async () => {
    await openConnectedModal();
    mockedSave.mockRejectedValue(new JiraApiError('credentials_rejected', 'ignored'));

    fillForm();
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /^replace connection$/i }));

    await screen.findByRole('alert');

    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('keeps the existing connection unchanged after a failed replacement', async () => {
    await openConnectedModal();
    mockedSave.mockRejectedValue(new JiraApiError('credentials_rejected', 'ignored'));

    fillField(/site url/i, 'https://acme-new.atlassian.net');
    fillField(/account email/i, 'bob@example.com');
    fireEvent.change(tokenInput(), { target: { value: TOKEN } });
    fireEvent.click(screen.getByRole('button', { name: /^replace connection$/i }));

    await screen.findByRole('alert');

    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));

    expect(screen.getByText(/jira connected/i)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Client validation and duplicate submission
// ---------------------------------------------------------------------------

describe('client validation and duplicate submission', () => {
  it('rejects empty fields inside the modal without calling the backend', async () => {
    await openConnectedModal();

    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /^replace connection$/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/enter the jira site url/i);
    expect(mockedSave).not.toHaveBeenCalled();
  });

  it('prevents duplicate submissions while a save is in flight', async () => {
    await openConnectedModal();
    let resolveSave: (value: JiraConnected) => void = () => {};
    mockedSave.mockReturnValue(
      new Promise<JiraConnected>((resolve) => { resolveSave = resolve; }),
    );

    fillForm();
    const dialog = screen.getByRole('dialog');
    const submit = within(dialog).getByRole('button', { name: /^replace connection$/i });
    fireEvent.click(submit);
    fireEvent.click(submit);

    expect(mockedSave).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: /connecting/i })).toBeDisabled();

    resolveSave(connected);
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

describe('error mapping inside modal', () => {
  async function submitFailingWith(kind: ConstructorParameters<typeof JiraApiError>[0]) {
    await openConnectedModal();
    mockedSave.mockRejectedValue(new JiraApiError(kind, 'ignored'));
    fillForm();
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /^replace connection$/i }));
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

// ---------------------------------------------------------------------------
// onConnectionSaved callback
// ---------------------------------------------------------------------------

describe('onConnectionSaved callback', () => {
  it('calls onConnectionSaved after a successful connection replacement', async () => {
    mockedGet.mockResolvedValue(connected);
    const onSaved = vi.fn();
    render(<JiraConnectionPanel onConnectionSaved={onSaved} />);
    await screen.findByRole('button', { name: /manage jira connection/i });

    fireEvent.click(screen.getByRole('button', { name: /manage jira connection/i }));
    await screen.findByRole('dialog');

    const replacement: JiraConnected = {
      connected: true,
      siteUrl: 'https://new.atlassian.net',
      email: 'bob@example.com',
    };
    mockedSave.mockResolvedValue(replacement);

    fillField(/site url/i, 'https://new.atlassian.net');
    fillField(/account email/i, 'bob@example.com');
    fireEvent.change(tokenInput(), { target: { value: TOKEN } });
    fireEvent.click(screen.getByRole('button', { name: /^replace connection$/i }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it('does not call onConnectionSaved after a failed save', async () => {
    mockedGet.mockResolvedValue(connected);
    const onSaved = vi.fn();
    render(<JiraConnectionPanel onConnectionSaved={onSaved} />);
    await screen.findByRole('button', { name: /manage jira connection/i });

    fireEvent.click(screen.getByRole('button', { name: /manage jira connection/i }));
    await screen.findByRole('dialog');

    mockedSave.mockRejectedValue(new JiraApiError('credentials_rejected', 'ignored'));
    fillForm();
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /^replace connection$/i }));

    await screen.findByRole('alert');
    expect(onSaved).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// API token secret handling
// ---------------------------------------------------------------------------

describe('API token secret handling', () => {
  it('uses a password input for the token', async () => {
    await openConnectedModal();

    expect(tokenInput()).toHaveAttribute('type', 'password');
  });

  it('keeps the token uncontrolled (value survives unrelated re-renders)', async () => {
    await openConnectedModal();

    fireEvent.change(tokenInput(), { target: { value: TOKEN } });
    fillField(/account email/i, 'alice@example.com');

    expect(tokenInput().value).toBe(TOKEN);
  });

  it('clears the token field immediately when submission starts', async () => {
    await openConnectedModal();
    mockedSave.mockReturnValue(new Promise<JiraConnected>(() => {}));

    fillForm();
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /^replace connection$/i }));

    expect(tokenInput().value).toBe('');
    expect(screen.getByRole('button', { name: /connecting/i })).toBeDisabled();
  });

  it('leaves the token cleared after a failed submission', async () => {
    await openConnectedModal();
    mockedSave.mockRejectedValue(new JiraApiError('credentials_rejected', 'ignored'));

    fillForm();
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /^replace connection$/i }));

    await screen.findByRole('alert');
    expect(tokenInput().value).toBe('');
  });

  it('never renders the token in status or error output', async () => {
    await openConnectedModal();
    mockedSave.mockRejectedValue(new JiraApiError('credentials_rejected', 'ignored'));

    fillForm();
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /^replace connection$/i }));

    await screen.findByRole('alert');
    expect(document.body.textContent).not.toContain(TOKEN);
  });
});

// ---------------------------------------------------------------------------
// Autofill mitigation
// ---------------------------------------------------------------------------

describe('autofill mitigation: Jira fields are independent of the login form', () => {
  it('marks the form with autocomplete="off"', async () => {
    await openConnectedModal();

    expect(tokenInput().closest('form')).toHaveAttribute('autocomplete', 'off');
  });

  it('starts every Jira field empty', async () => {
    await openConnectedModal();

    expect((screen.getByLabelText(/site url/i) as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText(/account email/i) as HTMLInputElement).value).toBe('');
    expect(tokenInput().value).toBe('');
  });

  it('gives the site URL field a Jira-specific name', async () => {
    await openConnectedModal();

    expect(screen.getByLabelText(/site url/i)).toHaveAttribute('name', 'jiraSiteUrl');
  });

  it('uses a Jira-specific name and autofill-resistant attributes on the email field', async () => {
    await openConnectedModal();

    const emailField = screen.getByLabelText(/account email/i);
    expect(emailField).toHaveAttribute('name', 'jiraAccountEmail');
    expect(emailField).toHaveAttribute('type', 'text');
    expect(emailField).toHaveAttribute('inputmode', 'email');
    expect(emailField).toHaveAttribute('autocomplete', 'off');
    expect(emailField).toHaveAttribute('autocapitalize', 'none');
    expect(emailField).toHaveAttribute('spellcheck', 'false');
  });

  it('uses a password token field with new-password autocomplete', async () => {
    await openConnectedModal();

    expect(tokenInput()).toHaveAttribute('type', 'password');
    expect(tokenInput()).toHaveAttribute('name', 'jiraApiToken');
    expect(tokenInput()).toHaveAttribute('autocomplete', 'new-password');
  });
});

// ---------------------------------------------------------------------------
// onStatusChange reporting
// ---------------------------------------------------------------------------

describe('onStatusChange reporting', () => {
  it('reports { status: "loading" } while the status request is pending', () => {
    mockedGet.mockReturnValue(new Promise(() => {}));
    const onStatus = vi.fn();
    render(<JiraConnectionPanel onStatusChange={onStatus} />);

    expect(onStatus).toHaveBeenCalledWith({ status: 'loading' });
  });

  it('reports { status: "disconnected" } when GET returns disconnected', async () => {
    mockedGet.mockResolvedValue({ connected: false });
    const onStatus = vi.fn();
    render(<JiraConnectionPanel onStatusChange={onStatus} />);
    await screen.findByText(/jira not connected/i);

    expect(onStatus).toHaveBeenLastCalledWith({ status: 'disconnected' });
  });

  it('reports { status: "connected", connection } when GET returns connected', async () => {
    mockedGet.mockResolvedValue(connected);
    const onStatus = vi.fn();
    render(<JiraConnectionPanel onStatusChange={onStatus} />);
    await screen.findByRole('button', { name: /manage jira connection/i });

    expect(onStatus).toHaveBeenLastCalledWith({ status: 'connected', connection: connected });
  });

  it('reports { status: "error" } when the GET fails', async () => {
    mockedGet.mockRejectedValue(new JiraApiError('network', 'x'));
    const onStatus = vi.fn();
    render(<JiraConnectionPanel onStatusChange={onStatus} />);
    await screen.findByRole('alert');

    expect(onStatus).toHaveBeenLastCalledWith({ status: 'error' });
  });
});
