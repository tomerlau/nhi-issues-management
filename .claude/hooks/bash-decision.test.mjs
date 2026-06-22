import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyProtectedCommand, decideBashCommand } from './bash-decision.mjs';

const allowedOnMain = (cmd) => decideBashCommand(cmd, 'main').allowed;
const blockedOnMain = (cmd) => !decideBashCommand(cmd, 'main').allowed;

test('safe exact inspection commands are allowed on main', () => {
  for (const cmd of [
    'git status',
    'git status --short',
    'git status --porcelain',
    'git diff',
    'git diff --check',
    'git diff --staged',
    'git diff --stat',
    'git branch --show-current',
    'git branch --list milestone/4-foo',
    'git rev-parse HEAD',
    'git rev-parse --abbrev-ref HEAD',
    'git rev-parse --absolute-git-dir',
    'git rev-parse --path-format=absolute --git-common-dir',
    'git ls-remote --heads origin milestone/4-foo',
    'git worktree list',
    'git worktree list --porcelain',
  ]) {
    assert.equal(allowedOnMain(cmd), true, `expected allowed: ${cmd}`);
  }
});

test('unknown commands are blocked on main', () => {
  for (const cmd of ['ls -la', 'cat file.txt', 'echo hello', 'cp a b', 'rm -rf dist']) {
    assert.equal(blockedOnMain(cmd), true, `expected blocked: ${cmd}`);
  }
});

test('arbitrary node and node --test are blocked on main', () => {
  assert.equal(blockedOnMain('node script.js'), true);
  assert.equal(blockedOnMain('node --test'), true);
  assert.equal(blockedOnMain('node --test --test-reporter-destination=/tmp/out.txt'), true);
});

test('package-manager commands are blocked on main', () => {
  assert.equal(blockedOnMain('npm install'), true);
  assert.equal(blockedOnMain('npm ci'), true);
  assert.equal(blockedOnMain('npm run build'), true);
  assert.equal(blockedOnMain('npm run test:workflow'), true);
  assert.equal(blockedOnMain('pnpm install'), true);
  assert.equal(blockedOnMain('yarn'), true);
});

test('output redirection is blocked on main', () => {
  assert.equal(blockedOnMain('git status > out.txt'), true);
  assert.equal(blockedOnMain('git status >> out.txt'), true);
  assert.equal(blockedOnMain('git diff 2> err.txt'), true);
  assert.equal(blockedOnMain('git diff &> all.txt'), true);
});

test('pipelines and compound commands are blocked on main', () => {
  assert.equal(blockedOnMain('git status | cat'), true);
  assert.equal(blockedOnMain('git status && npm install'), true);
  assert.equal(blockedOnMain('git fetch origin; git status'), true);
});

test('command substitution is blocked on main', () => {
  assert.equal(blockedOnMain('echo $(rm -rf x)'), true);
  assert.equal(blockedOnMain('git checkout -b milestone/4-$(whoami)'), true);
  assert.equal(blockedOnMain('git log `whoami`'), true);
});

test('git output-destination and external-diff flags are blocked on main', () => {
  assert.equal(blockedOnMain('git diff --output=/tmp/x'), true);
  assert.equal(blockedOnMain('git diff --output /tmp/x'), true);
  assert.equal(blockedOnMain('git log --output=/tmp/x'), true);
  assert.equal(blockedOnMain('git show --output=/tmp/x'), true);
  assert.equal(blockedOnMain('git diff --ext-diff'), true);
});

test('unsupported git flags and subcommands are blocked on main', () => {
  assert.equal(blockedOnMain('git status --weird'), true);
  assert.equal(blockedOnMain('git status --short --porcelain'), true);
  assert.equal(blockedOnMain('git log --oneline'), true);
  assert.equal(blockedOnMain('git show HEAD'), true);
  assert.equal(blockedOnMain('git branch --list a b'), true);
});

test('exact approved preparation commands are allowed on main', () => {
  for (const cmd of [
    'git fetch origin',
    'git pull --ff-only origin main',
    'git switch main',
    'git checkout main',
    'git switch -c milestone/4-foo',
    'git checkout -b milestone/5-bar-baz',
    'git worktree add -b milestone/4-foo /tmp/wt-4 0123abc',
    'git worktree add -b milestone/4-foo /tmp/wt-4 0123456789abcdef0123456789abcdef01234567',
  ]) {
    assert.equal(allowedOnMain(cmd), true, `expected allowed: ${cmd}`);
  }
});

test('quoted arguments in approved forms are allowed on main', () => {
  for (const cmd of [
    'git switch -c "milestone/4-foo"',
    "git checkout -b 'milestone/5-bar-baz'",
    'git worktree add -b "milestone/4-foo" "/tmp/wt-4" "0123abc"',
    'git branch --list "milestone/4-foo"',
    'git ls-remote --heads origin "milestone/4-foo"',
  ]) {
    assert.equal(allowedOnMain(cmd), true, `expected allowed: ${cmd}`);
  }
});

test('mismatched or partial quotes do not match approved forms on main', () => {
  // A token that still contains a quote after stripping one matched layer must
  // not satisfy the exact milestone/SHA regexes.
  assert.equal(blockedOnMain('git switch -c "milestone/4-foo'), true);
  assert.equal(blockedOnMain("git switch -c 'milestone/4-foo\""), true);
});

test('malformed preparation commands are blocked on main', () => {
  assert.equal(blockedOnMain('git pull'), true);
  assert.equal(blockedOnMain('git pull origin main'), true);
  assert.equal(blockedOnMain('git fetch'), true);
  assert.equal(blockedOnMain('git switch -c main'), true);
  assert.equal(blockedOnMain('git switch -c master'), true);
  assert.equal(blockedOnMain('git switch -c milestone/0-foo'), true);
  assert.equal(blockedOnMain('git switch -c milestone/4-Foo'), true);
  assert.equal(blockedOnMain('git switch -c feature/x'), true);
  assert.equal(blockedOnMain('git worktree add /tmp/x'), true);
  assert.equal(blockedOnMain('git worktree add -b milestone/4-foo /tmp/wt notahex'), true);
  assert.equal(blockedOnMain('git worktree add -b milestone/4-foo --force /tmp/wt 0123abc'), true);
});

test('destructive worktree commands are blocked on main', () => {
  assert.equal(blockedOnMain('git worktree remove /tmp/wt'), true);
  assert.equal(blockedOnMain('git worktree prune'), true);
  assert.equal(blockedOnMain('git worktree move a b'), true);
});

test('detached HEAD and unknown branch use the same fail-closed allowlist', () => {
  assert.equal(decideBashCommand('npm install', '').allowed, false);
  assert.equal(decideBashCommand('git status', '').allowed, true);
  assert.equal(decideBashCommand('npm install', null).allowed, false);
  assert.equal(decideBashCommand('git status', null).allowed, true);
  assert.equal(decideBashCommand('node --test', 'HEAD').allowed, false);
});

test('a normal milestone branch allows normal development commands', () => {
  for (const cmd of ['npm install', 'npm run build', 'node --test', 'rm -rf node_modules', 'anything goes']) {
    assert.equal(decideBashCommand(cmd, 'milestone/4-foo').allowed, true, `expected allowed: ${cmd}`);
  }
});

test('classifyProtectedCommand reports the category', () => {
  assert.equal(classifyProtectedCommand('git status').category, 'inspection');
  assert.equal(classifyProtectedCommand('git fetch origin').category, 'preparation');
  assert.equal(classifyProtectedCommand('npm install').category, 'blocked');
  assert.equal(classifyProtectedCommand('').category, 'blocked');
});
