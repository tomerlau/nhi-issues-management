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

function headSha(cwd) {
  return spawnSync('git', ['rev-parse', 'HEAD'], { cwd, env: gitEnv(), encoding: 'utf8' }).stdout.trim();
}

function porcelainStatus(cwd) {
  return spawnSync('git', ['status', '--porcelain'], { cwd, env: gitEnv(), encoding: 'utf8' }).stdout.trim();
}

function currentBranchOf(cwd) {
  return spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, env: gitEnv(), encoding: 'utf8' }).stdout.trim();
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

test('a worktree add targeting inside the primary checkout is blocked before git runs', () => {
  const repo = makeRepo('main');
  try {
    const sha = headSha(repo);
    const inside = join(repo, 'child');
    assert.equal(runHook(bashInput(`git worktree add -b milestone/4-foo ${inside} ${sha}`), repo), 2);
    // The hook blocks the tool call, so git never runs and main stays clean.
    assert.equal(porcelainStatus(repo), '');
    assert.equal(currentBranchOf(repo), 'main');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('a worktree add to an absolute sibling path with the exact HEAD SHA is accepted by the guard', () => {
  const repo = makeRepo('main');
  const sibling = mkdtempSync(join(tmpdir(), 'nhi-guard-sibling-'));
  try {
    const sha = headSha(repo);
    const target = join(sibling, 'wt-4');
    assert.equal(runHook(bashInput(`git worktree add -b milestone/4-foo ${target} ${sha}`), repo), 0);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(sibling, { recursive: true, force: true });
  }
});

test('a worktree add with an abbreviated or wrong SHA is blocked on primary main', () => {
  const repo = makeRepo('main');
  const sibling = mkdtempSync(join(tmpdir(), 'nhi-guard-sha-'));
  try {
    const sha = headSha(repo);
    const target = join(sibling, 'wt-4');
    assert.equal(runHook(bashInput(`git worktree add -b milestone/4-foo ${target} ${sha.slice(0, 10)}`), repo), 2);
    assert.equal(runHook(bashInput(`git worktree add -b milestone/4-foo ${target} ${'b'.repeat(40)}`), repo), 2);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(sibling, { recursive: true, force: true });
  }
});

test('the same sibling worktree add is blocked when run from a linked worktree', () => {
  const repo = makeRepo('main');
  const linkedParent = mkdtempSync(join(tmpdir(), 'nhi-guard-linked-'));
  const siblingParent = mkdtempSync(join(tmpdir(), 'nhi-guard-sib2-'));
  const linked = join(linkedParent, 'tree');
  try {
    const sha = headSha(repo);
    spawnSync('git', ['worktree', 'add', '-b', 'milestone/9-existing', linked, sha], { cwd: repo, env: gitEnv() });

    const target = join(siblingParent, 'wt-4');
    // From the linked worktree (which is on main only because we re-checkout),
    // the command must be blocked because it is not the primary checkout.
    assert.equal(runHook(bashInput(`git worktree add -b milestone/4-foo ${target} ${sha}`), linked), 2);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(linkedParent, { recursive: true, force: true });
    rmSync(siblingParent, { recursive: true, force: true });
  }
});
