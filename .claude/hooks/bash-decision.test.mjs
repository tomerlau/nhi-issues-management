import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyBashCommand, decideBashCommand } from './bash-decision.mjs';

test('npm install is classified as modifying', () => {
  assert.equal(classifyBashCommand('npm install').kind, 'modifying');
  assert.equal(classifyBashCommand('npm ci').kind, 'modifying');
  assert.equal(classifyBashCommand('npm run build').kind, 'modifying');
});

test('other package managers are modifying', () => {
  assert.equal(classifyBashCommand('pnpm install').kind, 'modifying');
  assert.equal(classifyBashCommand('yarn add left-pad').kind, 'modifying');
  assert.equal(classifyBashCommand('npx tsc').kind, 'modifying');
});

test('file mutators are modifying', () => {
  assert.equal(classifyBashCommand('rm -rf dist').kind, 'modifying');
  assert.equal(classifyBashCommand('mv a b').kind, 'modifying');
  assert.equal(classifyBashCommand('sed -i s/a/b/ file').kind, 'modifying');
});

test('read-only git and shell commands are not modifying', () => {
  assert.equal(classifyBashCommand('git status').kind, 'read-only');
  assert.equal(classifyBashCommand('git diff --stat').kind, 'read-only');
  assert.equal(classifyBashCommand('ls -la').kind, 'read-only');
  assert.equal(classifyBashCommand('git worktree list --porcelain').kind, 'read-only');
});

test('preparation git commands are classified as preparation', () => {
  assert.equal(classifyBashCommand('git fetch origin').kind, 'preparation');
  assert.equal(classifyBashCommand('git pull --ff-only origin main').kind, 'preparation');
  assert.equal(classifyBashCommand('git switch -c milestone/4-foo').kind, 'preparation');
  assert.equal(classifyBashCommand('git checkout -b milestone/4-foo').kind, 'preparation');
  assert.equal(
    classifyBashCommand('git worktree add -b milestone/4-foo /tmp/wt HEAD').kind,
    'preparation',
  );
});

test('a modifying segment taints a compound command', () => {
  assert.equal(classifyBashCommand('git status && npm install').kind, 'modifying');
  assert.equal(classifyBashCommand('git fetch origin; npm ci').kind, 'modifying');
});

test('leading env assignments are skipped', () => {
  assert.equal(classifyBashCommand('CI=1 npm ci').kind, 'modifying');
  assert.equal(classifyBashCommand('env FOO=bar git status').kind, 'read-only');
});

test('a milestone branch allows everything, including modifying commands', () => {
  assert.equal(decideBashCommand('npm install', 'milestone/4-foo').allowed, true);
  assert.equal(decideBashCommand('rm -rf node_modules', 'feature/x').allowed, true);
});

test('main blocks modifying commands', () => {
  const d = decideBashCommand('npm install', 'main');
  assert.equal(d.allowed, false);
  assert.equal(d.code, 'protected');
});

test('main still allows read-only and preparation commands', () => {
  assert.equal(decideBashCommand('git status', 'main').allowed, true);
  assert.equal(decideBashCommand('ls -la', 'main').allowed, true);
  assert.equal(decideBashCommand('git fetch origin', 'main').allowed, true);
  assert.equal(decideBashCommand('git pull --ff-only origin main', 'main').allowed, true);
  assert.equal(decideBashCommand('git switch -c milestone/4-foo', 'main').allowed, true);
  assert.equal(
    decideBashCommand('git worktree add -b milestone/4-foo /tmp/wt abc123', 'main').allowed,
    true,
  );
  assert.equal(decideBashCommand('git worktree list --porcelain', 'main').allowed, true);
});

test('detached HEAD blocks modifying commands but allows read-only', () => {
  assert.equal(decideBashCommand('npm install', '').allowed, false);
  assert.equal(decideBashCommand('npm install', 'HEAD').allowed, false);
  assert.equal(decideBashCommand('git status', '').allowed, true);
});

test('unknown branch (detection failure) blocks modifying commands', () => {
  const d = decideBashCommand('npm install', null);
  assert.equal(d.allowed, false);
  assert.equal(d.code, 'unknown');
  // read-only still allowed so inspection works
  assert.equal(decideBashCommand('git status', null).allowed, true);
});
