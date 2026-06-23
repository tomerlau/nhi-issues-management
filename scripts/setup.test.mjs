/**
 * Tests for the local setup command. Exercises the pure env logic
 * (setup-env.mjs) and the CLI wrapper's runSetup entry (setup.mjs) against
 * temporary directories.
 *
 * Uses the built-in node:test runner; no extra dependency. Platform-
 * independent: temp dirs come from os.tmpdir(), and atomic writes are
 * exercised on whichever filesystem hosts the OS temp directory.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  KEY_NAME,
  ensureEncryptionKey,
  generateEncryptionKey,
  isValidEncryptionKey,
} from './setup-env.mjs';
import { runSetup } from './setup.mjs';

const EXAMPLE_CONTENT =
  '# Example environment configuration for the API.\n' +
  `${KEY_NAME}=\n`;

function createTempPaths() {
  const dir = mkdtempSync(join(tmpdir(), 'nhi-setup-'));
  return {
    dir,
    envPath: join(dir, '.env'),
    examplePath: join(dir, '.env.example'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function readKeyValue(envPath) {
  const content = readFileSync(envPath, 'utf8');
  const match = content.match(new RegExp(`^${KEY_NAME}=(.*)$`, 'm'));
  return match ? match[1].trim() : null;
}

test('isValidEncryptionKey accepts canonical 32-byte base64 only', () => {
  assert.equal(isValidEncryptionKey(randomBytes(32).toString('base64')), true);
  assert.equal(isValidEncryptionKey(''), false);
  assert.equal(isValidEncryptionKey('not-base64!'), false);
  assert.equal(isValidEncryptionKey(randomBytes(31).toString('base64')), false);
  assert.equal(isValidEncryptionKey(randomBytes(33).toString('base64')), false);
  // base64url is not standard base64.
  assert.equal(isValidEncryptionKey(randomBytes(32).toString('base64url')), false);
});

test('generateEncryptionKey returns a valid 32-byte canonical base64 key', () => {
  for (let i = 0; i < 8; i += 1) {
    const key = generateEncryptionKey();
    assert.equal(isValidEncryptionKey(key), true);
    assert.equal(Buffer.from(key, 'base64').length, 32);
  }
});

test('creates .env from .env.example when .env is missing', () => {
  const { envPath, examplePath, cleanup } = createTempPaths();
  try {
    writeFileSync(examplePath, EXAMPLE_CONTENT);

    const result = ensureEncryptionKey({ envPath, examplePath });

    assert.equal(result.created, true);
    assert.equal(result.keyStatus, 'generated');
    assert.equal(existsSync(envPath), true);
    const written = readFileSync(envPath, 'utf8');
    assert.match(written, /# Example environment configuration/);
    assert.equal(isValidEncryptionKey(readKeyValue(envPath)), true);
  } finally {
    cleanup();
  }
});

test('fills a missing KEY line by appending it', () => {
  const { envPath, examplePath, cleanup } = createTempPaths();
  try {
    writeFileSync(examplePath, EXAMPLE_CONTENT);
    writeFileSync(envPath, 'OTHER_VAR=value\n');

    const result = ensureEncryptionKey({ envPath, examplePath });

    assert.equal(result.created, false);
    assert.equal(result.keyStatus, 'generated');
    const written = readFileSync(envPath, 'utf8');
    assert.match(written, /^OTHER_VAR=value$/m);
    assert.equal(isValidEncryptionKey(readKeyValue(envPath)), true);
  } finally {
    cleanup();
  }
});

test('fills an empty KEY value', () => {
  const { envPath, examplePath, cleanup } = createTempPaths();
  try {
    writeFileSync(examplePath, EXAMPLE_CONTENT);
    writeFileSync(envPath, `${KEY_NAME}=\n`);

    const result = ensureEncryptionKey({ envPath, examplePath });

    assert.equal(result.keyStatus, 'generated');
    assert.equal(isValidEncryptionKey(readKeyValue(envPath)), true);
  } finally {
    cleanup();
  }
});

test('preserves an existing valid key unchanged', () => {
  const { envPath, examplePath, cleanup } = createTempPaths();
  try {
    writeFileSync(examplePath, EXAMPLE_CONTENT);
    const validKey = generateEncryptionKey();
    const before =
      '# preserved comment\n' +
      `${KEY_NAME}=${validKey}\n` +
      'OTHER_VAR=keep-me\n';
    writeFileSync(envPath, before);

    const result = ensureEncryptionKey({ envPath, examplePath });

    assert.equal(result.keyStatus, 'preserved');
    assert.equal(readFileSync(envPath, 'utf8'), before);
  } finally {
    cleanup();
  }
});

test('rejects an existing non-empty invalid key and does not modify the file', () => {
  const { envPath, examplePath, cleanup } = createTempPaths();
  try {
    writeFileSync(examplePath, EXAMPLE_CONTENT);
    const before =
      '# important comment\n' +
      `${KEY_NAME}=not-a-real-key\n` +
      'OTHER_VAR=keep-me\n';
    writeFileSync(envPath, before);

    assert.throws(() => ensureEncryptionKey({ envPath, examplePath }), /not canonical standard base64/);

    assert.equal(readFileSync(envPath, 'utf8'), before);
  } finally {
    cleanup();
  }
});

test('preserves unrelated entries, comments, and CRLF endings', () => {
  const { envPath, examplePath, cleanup } = createTempPaths();
  try {
    writeFileSync(examplePath, EXAMPLE_CONTENT);
    const before =
      '# first comment\r\n' +
      'OTHER_VAR=keep-me\r\n' +
      '\r\n' +
      `${KEY_NAME}=\r\n` +
      'TRAILING_VAR=also-keep\r\n';
    writeFileSync(envPath, before);

    ensureEncryptionKey({ envPath, examplePath });

    const after = readFileSync(envPath, 'utf8');
    assert.match(after, /^# first comment\r?$/m);
    assert.match(after, /^OTHER_VAR=keep-me\r?$/m);
    assert.match(after, /^TRAILING_VAR=also-keep\r?$/m);
    assert.equal(isValidEncryptionKey(readKeyValue(envPath)), true);
  } finally {
    cleanup();
  }
});

test('runSetup does not print the generated key', () => {
  const { envPath, examplePath, cleanup } = createTempPaths();
  try {
    writeFileSync(examplePath, EXAMPLE_CONTENT);
    const logs = [];
    const record = (message) => logs.push(String(message));

    const result = runSetup({
      envPath,
      examplePath,
      runSeed: false,
      log: record,
      logError: record,
    });

    assert.equal(result.keyStatus, 'generated');
    const generatedKey = readKeyValue(envPath);
    assert.equal(isValidEncryptionKey(generatedKey), true);
    assert.ok(logs.length > 0, 'expected some status output');
    for (const line of logs) {
      assert.ok(!line.includes(generatedKey), `log line leaked the key: ${line}`);
    }
  } finally {
    cleanup();
  }
});

test('runSetup is idempotent: a second run preserves the same key', () => {
  const { envPath, examplePath, cleanup } = createTempPaths();
  try {
    writeFileSync(examplePath, EXAMPLE_CONTENT);
    const silent = () => {};

    const first = runSetup({ envPath, examplePath, runSeed: false, log: silent, logError: silent });
    const keyAfterFirst = readKeyValue(envPath);
    const fileAfterFirst = readFileSync(envPath, 'utf8');

    const second = runSetup({ envPath, examplePath, runSeed: false, log: silent, logError: silent });

    assert.equal(first.keyStatus, 'generated');
    assert.equal(second.keyStatus, 'preserved');
    assert.equal(readKeyValue(envPath), keyAfterFirst);
    assert.equal(readFileSync(envPath, 'utf8'), fileAfterFirst);
  } finally {
    cleanup();
  }
});
