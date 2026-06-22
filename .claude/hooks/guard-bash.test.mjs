import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK = fileURLToPath(new URL('./guard-bash.mjs', import.meta.url));

function gitEnv() {
  return {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
  };
}

function makeRepo(branch) {
  const root = mkdtempSync(join(tmpdir(), 'nhi-guard-bash-'));
  const env = gitEnv();
  spawnSync('git', ['init', '-b', 'main'], { cwd: root, env });
  writeFileSync(join(root, 'f.txt'), 'base\n');
  spawnSync('git', ['add', 'f.txt'], { cwd: root, env });
  spawnSync('git', ['commit', '-m', 'base'], { cwd: root, env });
  if (branch && branch !== 'main') {
    spawnSync('git', ['switch', '-c', branch], { cwd: root, env });
  }
  return root;
}

// Run the hook with raw stdin in a given cwd; returns the exit code.
function runHook(stdin, cwd) {
  const res = spawnSync('node', [HOOK], { cwd, input: stdin, encoding: 'utf8' });
  return res.status;
}

function bashInput(command) {
  return JSON.stringify({ tool_name: 'Bash', tool_input: { command } });
}

test('malformed hook input is blocked', () => {
  const repo = makeRepo('main');
  try {
    assert.equal(runHook('', repo), 2, 'empty stdin');
    assert.equal(runHook('not json', repo), 2, 'invalid JSON');
    assert.equal(runHook(JSON.stringify({ tool_name: 'Bash' }), repo), 2, 'missing tool_input');
    assert.equal(runHook(JSON.stringify({ tool_input: {} }), repo), 2, 'missing command');
    assert.equal(runHook(JSON.stringify({ tool_input: { command: 123 } }), repo), 2, 'non-string command');
    assert.equal(runHook(JSON.stringify({ tool_input: { command: '   ' } }), repo), 2, 'blank command');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('on main, the hook blocks modifying commands and allows safe inspection', () => {
  const repo = makeRepo('main');
  try {
    assert.equal(runHook(bashInput('npm install'), repo), 2);
    assert.equal(runHook(bashInput('node --test'), repo), 2);
    assert.equal(runHook(bashInput('git status > out.txt'), repo), 2);
    assert.equal(runHook(bashInput('git status'), repo), 0);
    assert.equal(runHook(bashInput('git worktree list --porcelain'), repo), 0);
    assert.equal(runHook(bashInput('git fetch origin'), repo), 0);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('on a milestone branch, the hook allows normal development commands', () => {
  const repo = makeRepo('milestone/4-foo');
  try {
    assert.equal(runHook(bashInput('npm install'), repo), 0);
    assert.equal(runHook(bashInput('node --test'), repo), 0);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
