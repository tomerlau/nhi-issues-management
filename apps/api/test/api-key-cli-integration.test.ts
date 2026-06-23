/**
 * Integration tests that run the actual CLI scripts as child processes.
 *
 * Each test group gets its own temporary SQLite file, prepared in-process with
 * the real migration and seed flow, then handed to the subprocess via
 * DATABASE_PATH. The developer's normal local database is never touched.
 *
 * Subprocess strategy: `node --import tsx/esm <script>.ts` — no shell, no .cmd
 * wrapper. tsx is resolved from the root node_modules (hoisted from apps/api).
 */
import { afterAll, beforeAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/database/connection.js';
import { runMigrations } from '../src/database/migrator.js';
import { seedDemoData } from '../src/database/seed-data.js';
import { ApiKeyService } from '../src/auth/api-key-service.js';

// ---------------------------------------------------------------------------
// Path constants
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const testDir = resolve(__filename, '..');          // apps/api/test/
const apiRoot = resolve(testDir, '..');             // apps/api/
const repoRoot = resolve(apiRoot, '..', '..');      // repo root (nhi-m12/)
const scriptCreate = resolve(apiRoot, 'src/scripts/api-key-create.ts');
const scriptRevoke = resolve(apiRoot, 'src/scripts/api-key-revoke.ts');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEMO_ACME_ALICE_EMAIL = 'alice@example.com';
const API_KEY_RE = /nhi_([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})/;
const API_KEY_FORMAT_RE = /^nhi_[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/;
const SUBPROCESS_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function prepareSeedDb(dir: string): Promise<string> {
  const dbPath = join(dir, 'test.db');
  const db = openDatabase(dbPath);
  try {
    runMigrations(db);
    await seedDemoData(db);
  } finally {
    db.close();
  }
  return dbPath;
}

function runCreateCli(args: string[], dbPath: string) {
  return spawnSync(process.execPath, ['--import', 'tsx/esm', scriptCreate, ...args], {
    cwd: repoRoot,
    env: { ...process.env, DATABASE_PATH: dbPath },
    encoding: 'utf8',
    timeout: SUBPROCESS_TIMEOUT_MS,
  });
}

function runRevokeCli(args: string[], dbPath: string) {
  return spawnSync(process.execPath, ['--import', 'tsx/esm', scriptRevoke, ...args], {
    cwd: repoRoot,
    env: { ...process.env, DATABASE_PATH: dbPath },
    encoding: 'utf8',
    timeout: SUBPROCESS_TIMEOUT_MS,
  });
}

/** Extract the full API key from CLI stdout. Returns empty string if not found. */
function extractKey(stdout: string): string {
  return stdout.match(API_KEY_RE)?.[0] ?? '';
}

/** Extract the key ID portion of a full API key (after 'nhi_', before '.'). */
function extractKeyId(fullKey: string): string {
  const m = fullKey.match(API_KEY_RE);
  return m?.[1] ?? '';
}

// ---------------------------------------------------------------------------
// CLI create: failure exit codes
// ---------------------------------------------------------------------------

describe('CLI create subprocess: failure exit codes', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'nhi-cli-create-fail-'));
    dbPath = await prepareSeedDb(tmpDir);
  }, SUBPROCESS_TIMEOUT_MS);

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('missing --email exits with a non-zero code', () => {
    const { status } = runCreateCli([], dbPath);
    expect(status).not.toBe(0);
  });

  it('missing --email writes the error to stderr', () => {
    const { stderr } = runCreateCli([], dbPath);
    expect(stderr).toContain('Missing required --email argument.');
  });

  it('malformed email (no @) exits with a non-zero code', () => {
    const { status } = runCreateCli(['--email', 'notanemail'], dbPath);
    expect(status).not.toBe(0);
  });

  it('malformed email writes a clear validation error to stderr', () => {
    const { stderr } = runCreateCli(['--email', 'notanemail'], dbPath);
    expect(stderr).toContain('is not a valid email address');
  });

  it('multiple-@ email exits with a non-zero code', () => {
    const { status } = runCreateCli(['--email', 'a@b@c.com'], dbPath);
    expect(status).not.toBe(0);
  });

  it('multiple-@ email writes a validation error (not a user-not-found error)', () => {
    const { stderr } = runCreateCli(['--email', 'a@b@c.com'], dbPath);
    expect(stderr).toContain('is not a valid email address');
    expect(stderr).not.toContain('No user found');
  });

  it('unknown but structurally valid email exits with a non-zero code', () => {
    const { status } = runCreateCli(['--email', 'nobody@example.com'], dbPath);
    expect(status).not.toBe(0);
  });

  it('unknown email writes a distinct user-not-found error to stderr', () => {
    const { stderr } = runCreateCli(['--email', 'nobody@example.com'], dbPath);
    expect(stderr).toContain('No user found');
    expect(stderr).not.toContain('is not a valid email address');
  });

  it('failure stderr never contains a plaintext API key', () => {
    const cases = [
      runCreateCli([], dbPath),
      runCreateCli(['--email', 'notanemail'], dbPath),
      runCreateCli(['--email', 'a@b@c.com'], dbPath),
      runCreateCli(['--email', 'nobody@example.com'], dbPath),
    ];
    for (const { stderr } of cases) {
      expect(stderr).not.toMatch(API_KEY_RE);
    }
  });
});

// ---------------------------------------------------------------------------
// CLI create: successful execution (single subprocess, multiple assertions)
// ---------------------------------------------------------------------------

describe('CLI create subprocess: successful execution', () => {
  let tmpDir: string;
  let dbPath: string;
  let stdout: string;
  let stderr: string;
  let status: number | null;
  let fullKey: string;
  let keyId: string;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'nhi-cli-create-ok-'));
    dbPath = await prepareSeedDb(tmpDir);
    const result = runCreateCli(['--email', DEMO_ACME_ALICE_EMAIL], dbPath);
    stdout = result.stdout;
    stderr = result.stderr;
    status = result.status;
    fullKey = extractKey(stdout);
    keyId = extractKeyId(fullKey);
  }, SUBPROCESS_TIMEOUT_MS);

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('exits with code 0', () => {
    expect(status).toBe(0);
  });

  it('stdout contains a full API key matching the exact format', () => {
    expect(fullKey).toMatch(API_KEY_FORMAT_RE);
  });

  it('stdout contains the public key ID', () => {
    expect(keyId).toBeTruthy();
    // The key ID must appear in stdout (separate from the full key line).
    expect(stdout).toContain(keyId);
  });

  it('stdout states the key cannot be retrieved again', () => {
    expect(stdout.toLowerCase()).toContain('cannot be retrieved again');
  });

  it('the full plaintext key appears exactly once across stdout and stderr', () => {
    const combined = stdout + stderr;
    const matches = combined.match(new RegExp(API_KEY_RE.source, 'g')) ?? [];
    expect(matches).toHaveLength(1);
  });

  it('stderr contains no plaintext API key on success', () => {
    expect(stderr).not.toMatch(API_KEY_RE);
  });

  it('exactly one api_keys row is created in the database', () => {
    const db = openDatabase(dbPath);
    try {
      const rows = db.prepare('SELECT * FROM api_keys').all();
      expect(rows).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it('the stored row has the correct tenant and user for the email', () => {
    const db = openDatabase(dbPath);
    try {
      const row = db
        .prepare('SELECT tenant_id, user_id FROM api_keys WHERE id = ?')
        .get(keyId) as { tenant_id: string; user_id: string } | undefined;
      expect(row?.tenant_id).toBe('tenant-acme');
      expect(row?.user_id).toBe('user-acme-alice');
    } finally {
      db.close();
    }
  });

  it('the plaintext full key is absent from the stored database row', () => {
    const db = openDatabase(dbPath);
    try {
      const row = db
        .prepare('SELECT * FROM api_keys WHERE id = ?')
        .get(keyId) as Record<string, string>;
      const rowValues = Object.values(row).join('|');
      expect(rowValues).not.toContain(fullKey);
      const secret = fullKey.slice(fullKey.indexOf('.') + 1);
      expect(rowValues).not.toContain(secret);
    } finally {
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// CLI revoke: failure exit codes
// ---------------------------------------------------------------------------

describe('CLI revoke subprocess: failure exit codes', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'nhi-cli-revoke-fail-'));
    dbPath = await prepareSeedDb(tmpDir);
  }, SUBPROCESS_TIMEOUT_MS);

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('missing --key-id exits with a non-zero code', () => {
    const { status } = runRevokeCli([], dbPath);
    expect(status).not.toBe(0);
  });

  it('missing --key-id writes the error to stderr', () => {
    const { stderr } = runRevokeCli([], dbPath);
    expect(stderr).toContain('Missing required --key-id argument.');
  });
});

// ---------------------------------------------------------------------------
// CLI revoke: successful execution
// ---------------------------------------------------------------------------

describe('CLI revoke subprocess: revoking an existing key', () => {
  let tmpDir: string;
  let dbPath: string;
  let keyId: string;
  let fullKey: string;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'nhi-cli-revoke-ok-'));
    dbPath = await prepareSeedDb(tmpDir);
    // Create a key in-process so the revoke subprocess has something to delete.
    const db = openDatabase(dbPath);
    try {
      const svc = new ApiKeyService(db);
      ({ keyId, fullKey } = svc.create('tenant-acme', 'user-acme-alice'));
    } finally {
      db.close();
    }
  }, SUBPROCESS_TIMEOUT_MS);

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('exits with code 0', () => {
    const { status } = runRevokeCli(['--key-id', keyId], dbPath);
    expect(status).toBe(0);
  });

  it('physically deletes the database row', () => {
    runRevokeCli(['--key-id', keyId], dbPath);
    const db = openDatabase(dbPath);
    try {
      const row = db.prepare('SELECT * FROM api_keys WHERE id = ?').get(keyId);
      expect(row).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it('the deleted key can no longer authenticate', () => {
    runRevokeCli(['--key-id', keyId], dbPath);
    const db = openDatabase(dbPath);
    try {
      const svc = new ApiKeyService(db);
      expect(svc.authenticate(fullKey)).toBeNull();
    } finally {
      db.close();
    }
  });

  it('a second revoke call for the same key exits safely (idempotent)', () => {
    runRevokeCli(['--key-id', keyId], dbPath);
    const { status } = runRevokeCli(['--key-id', keyId], dbPath);
    expect(status).toBe(0);
  });

  it('no tombstone remains after revocation', () => {
    runRevokeCli(['--key-id', keyId], dbPath);
    const db = openDatabase(dbPath);
    try {
      // There should be no row at all — no tombstone, no revoked_at flag.
      const row = db.prepare('SELECT * FROM api_keys WHERE id = ?').get(keyId);
      expect(row).toBeUndefined();
      const totalRows = db.prepare('SELECT COUNT(*) as n FROM api_keys').get() as { n: number };
      expect(totalRows.n).toBe(0);
    } finally {
      db.close();
    }
  });
});

describe('CLI revoke subprocess: already-absent key', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'nhi-cli-revoke-absent-'));
    dbPath = await prepareSeedDb(tmpDir);
  }, SUBPROCESS_TIMEOUT_MS);

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('exits with code 0 for a key ID that was never created', () => {
    const { status } = runRevokeCli(['--key-id', 'never-existed-key-id'], dbPath);
    expect(status).toBe(0);
  });

  it('reports absence in stdout without an error code', () => {
    const { stdout, status } = runRevokeCli(['--key-id', 'never-existed-key-id'], dbPath);
    expect(status).toBe(0);
    // The output should acknowledge the key was not found, not treat it as a fatal error.
    expect(stdout.toLowerCase()).toMatch(/not found|already|absent|revoked/);
  });
});
