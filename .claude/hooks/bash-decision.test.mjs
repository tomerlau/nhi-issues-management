import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyProtectedCommand, decideBashCommand } from './bash-decision.mjs';

const PRIMARY = '/repo/primary';
const HEAD = 'a'.repeat(40);

// Primary checkout on main, with HEAD and primary paths resolved.
const primaryMain = {
  branch: 'main',
  isPrimaryCheckout: true,
  primaryCheckoutPath: PRIMARY,
  primaryGitDir: `${PRIMARY}/.git`,
  headSha: HEAD,
};

const allowedOnMain = (cmd) => decideBashCommand(cmd, primaryMain).allowed;
const blockedOnMain = (cmd) => !decideBashCommand(cmd, primaryMain).allowed;

test('safe exact inspection commands are allowed on primary main', () => {
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

test('exact approved preparation commands are allowed on primary main', () => {
  for (const cmd of [
    'git fetch origin',
    'git pull --ff-only origin main',
    'git switch main',
    'git checkout main',
    'git switch -c milestone/4-foo',
    'git checkout -b milestone/5-bar-baz',
  ]) {
    assert.equal(allowedOnMain(cmd), true, `expected allowed: ${cmd}`);
  }
});

test('quoted arguments in approved forms are allowed on primary main', () => {
  for (const cmd of [
    'git switch -c "milestone/4-foo"',
    "git checkout -b 'milestone/5-bar-baz'",
    `git worktree add -b "milestone/4-foo" "/repo/wt-4" "${HEAD}"`,
    'git branch --list "milestone/4-foo"',
    'git ls-remote --heads origin "milestone/4-foo"',
  ]) {
    assert.equal(allowedOnMain(cmd), true, `expected allowed: ${cmd}`);
  }
});

test('mismatched or partial quotes do not match approved forms on main', () => {
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
});

// ---- git worktree add validation on primary main ---------------------------

test('an absolute sibling worktree path with the exact HEAD SHA is allowed', () => {
  assert.equal(allowedOnMain(`git worktree add -b milestone/4-foo /repo/wt-4 ${HEAD}`), true);
  assert.equal(allowedOnMain(`git worktree add -b milestone/5-bar /other/place ${HEAD}`), true);
});

test('a relative worktree path is blocked', () => {
  assert.equal(blockedOnMain(`git worktree add -b milestone/4-foo child ${HEAD}`), true);
  assert.equal(blockedOnMain(`git worktree add -b milestone/4-foo ./child ${HEAD}`), true);
  assert.equal(blockedOnMain(`git worktree add -b milestone/4-foo ../sibling ${HEAD}`), true);
});

test('a worktree target equal to the primary checkout is blocked', () => {
  assert.equal(blockedOnMain(`git worktree add -b milestone/4-foo ${PRIMARY} ${HEAD}`), true);
});

test('a worktree target nested inside the primary checkout is blocked', () => {
  assert.equal(blockedOnMain(`git worktree add -b milestone/4-foo ${PRIMARY}/inside ${HEAD}`), true);
  assert.equal(blockedOnMain(`git worktree add -b milestone/4-foo ${PRIMARY}/a/b ${HEAD}`), true);
});

test('a path that normalizes back inside the primary checkout is blocked', () => {
  assert.equal(blockedOnMain(`git worktree add -b milestone/4-foo ${PRIMARY}/x/../inside ${HEAD}`), true);
});

test('the primary checkout .git directory is blocked as a worktree target', () => {
  assert.equal(blockedOnMain(`git worktree add -b milestone/4-foo ${PRIMARY}/.git ${HEAD}`), true);
});

test('Windows case-equivalent inside paths are blocked', () => {
  const winCtx = {
    branch: 'main',
    isPrimaryCheckout: true,
    primaryCheckoutPath: 'C:/Repo/Primary',
    primaryGitDir: 'C:/Repo/Primary/.git',
    headSha: HEAD,
  };
  // On Windows path comparison is case-insensitive, so this resolves inside.
  const d = decideBashCommand(`git worktree add -b milestone/4-foo c:/repo/primary/inside ${HEAD}`, winCtx);
  if (process.platform === 'win32') {
    assert.equal(d.allowed, false);
  } else {
    // On a case-sensitive platform the differing case is genuinely outside.
    assert.equal(d.allowed, true);
  }
});

test('an abbreviated SHA is blocked for worktree creation', () => {
  assert.equal(blockedOnMain(`git worktree add -b milestone/4-foo /repo/wt-4 ${HEAD.slice(0, 10)}`), true);
  assert.equal(blockedOnMain('git worktree add -b milestone/4-foo /repo/wt-4 0123abc'), true);
});

test('a different full SHA is blocked for worktree creation', () => {
  assert.equal(blockedOnMain(`git worktree add -b milestone/4-foo /repo/wt-4 ${'b'.repeat(40)}`), true);
});

test('malformed and destructive worktree commands remain blocked on main', () => {
  assert.equal(blockedOnMain('git worktree add /tmp/x'), true);
  assert.equal(blockedOnMain(`git worktree add -b milestone/4-foo /repo/wt notahex`), true);
  assert.equal(blockedOnMain(`git worktree add -b milestone/4-foo --force /repo/wt ${HEAD}`), true);
  assert.equal(blockedOnMain('git worktree remove /tmp/wt'), true);
  assert.equal(blockedOnMain('git worktree prune'), true);
  assert.equal(blockedOnMain('git worktree move a b'), true);
});

// ---- state separation -------------------------------------------------------

test('primary checkout on master allows inspection only', () => {
  const masterPrimary = { branch: 'master', isPrimaryCheckout: true, primaryCheckoutPath: PRIMARY, headSha: HEAD };
  assert.equal(decideBashCommand('git status', masterPrimary).allowed, true);
  assert.equal(decideBashCommand('git fetch origin', masterPrimary).allowed, false);
  assert.equal(decideBashCommand('git pull --ff-only origin main', masterPrimary).allowed, false);
  assert.equal(decideBashCommand('git switch -c milestone/4-foo', masterPrimary).allowed, false);
  assert.equal(decideBashCommand(`git worktree add -b milestone/4-foo /repo/wt-4 ${HEAD}`, masterPrimary).allowed, false);
  // recovery to main is still permitted from another protected branch
  assert.equal(decideBashCommand('git switch main', masterPrimary).allowed, true);
});

test('a linked worktree on a protected branch allows inspection only', () => {
  const linkedMain = { branch: 'main', isPrimaryCheckout: false, primaryCheckoutPath: PRIMARY, headSha: HEAD };
  assert.equal(decideBashCommand('git status', linkedMain).allowed, true);
  assert.equal(decideBashCommand('git fetch origin', linkedMain).allowed, false);
  assert.equal(decideBashCommand('git switch -c milestone/4-foo', linkedMain).allowed, false);
  assert.equal(decideBashCommand(`git worktree add -b milestone/4-foo /repo/wt-4 ${HEAD}`, linkedMain).allowed, false);
});

test('a linked worktree on a milestone branch allows normal development', () => {
  const linkedMilestone = { branch: 'milestone/4-foo', isPrimaryCheckout: false, primaryCheckoutPath: PRIMARY, headSha: HEAD };
  assert.equal(decideBashCommand('npm install', linkedMilestone).allowed, true);
  assert.equal(decideBashCommand('node --test', linkedMilestone).allowed, true);
});

test('detached HEAD allows inspection and recovery only', () => {
  const detached = { branch: '', isPrimaryCheckout: true, primaryCheckoutPath: PRIMARY, headSha: HEAD };
  assert.equal(decideBashCommand('git status', detached).allowed, true);
  assert.equal(decideBashCommand('git switch main', detached).allowed, true);
  assert.equal(decideBashCommand('git checkout main', detached).allowed, true);
  assert.equal(decideBashCommand('git fetch origin', detached).allowed, false);
  assert.equal(decideBashCommand('git pull --ff-only origin main', detached).allowed, false);
  assert.equal(decideBashCommand('git switch -c milestone/4-foo', detached).allowed, false);
  assert.equal(decideBashCommand(`git worktree add -b milestone/4-foo /repo/wt-4 ${HEAD}`, detached).allowed, false);
});

test('unknown Git state allows independently-safe inspection only', () => {
  // branch null => state could not be read.
  assert.equal(decideBashCommand('git status', null).allowed, true);
  assert.equal(decideBashCommand('git worktree list --porcelain', null).allowed, true);
  assert.equal(decideBashCommand('git switch main', null).allowed, false);
  assert.equal(decideBashCommand('git fetch origin', null).allowed, false);
  assert.equal(decideBashCommand('npm install', null).allowed, false);
  assert.equal(decideBashCommand(`git worktree add -b milestone/4-foo /repo/wt-4 ${HEAD}`, null).allowed, false);
});

test('preparation requires the primary checkout, not just being on main', () => {
  // isPrimaryCheckout unknown (null) => fail closed for preparation.
  const unknownPrimary = { branch: 'main', isPrimaryCheckout: null, primaryCheckoutPath: PRIMARY, headSha: HEAD };
  assert.equal(decideBashCommand('git fetch origin', unknownPrimary).allowed, false);
  assert.equal(decideBashCommand(`git worktree add -b milestone/4-foo /repo/wt-4 ${HEAD}`, unknownPrimary).allowed, false);
  assert.equal(decideBashCommand('git status', unknownPrimary).allowed, true);
});

test('a normal milestone branch allows normal development commands', () => {
  for (const cmd of ['npm install', 'npm run build', 'node --test', 'rm -rf node_modules', 'anything goes']) {
    assert.equal(decideBashCommand(cmd, 'milestone/4-foo').allowed, true, `expected allowed: ${cmd}`);
  }
});

test('classifyProtectedCommand reports the category', () => {
  assert.equal(classifyProtectedCommand('git status', primaryMain).category, 'inspection');
  assert.equal(classifyProtectedCommand('git fetch origin', primaryMain).category, 'preparation');
  assert.equal(classifyProtectedCommand('git switch main', primaryMain).category, 'recovery');
  assert.equal(classifyProtectedCommand(`git worktree add -b milestone/4-foo /repo/wt-4 ${HEAD}`, primaryMain).category, 'preparation');
  assert.equal(classifyProtectedCommand('npm install', primaryMain).category, 'blocked');
  assert.equal(classifyProtectedCommand('', primaryMain).category, 'blocked');
});
