import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  currentBranch,
  isLinkedWorktree,
  worktreeList,
  headSha,
  topLevel,
  primaryWorktreePath,
} from './git-info.mjs';
import { validateWorktreeRequest, verifyCreatedWorktrees } from './worktree-decision.mjs';

// Run git in a throwaway repo. These tests never touch the real repository and
// run inside the test process (not via the Bash tool), so repository git
// restrictions do not apply to them.
function git(args, cwd) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  });
  return result;
}

function setupRepo() {
  const root = mkdtempSync(join(tmpdir(), 'nhi-wt-primary-'));
  git(['init', '-b', 'main'], root);
  writeFileSync(join(root, 'file.txt'), 'base\n');
  git(['add', 'file.txt'], root);
  git(['commit', '-m', 'base'], root);
  const baseSha = git(['rev-parse', 'HEAD'], root).stdout.trim();
  return { root, baseSha };
}

test('linked-worktree branch detection works when .git is a file', () => {
  const { root, baseSha } = setupRepo();
  const wtA = mkdtempSync(join(tmpdir(), 'nhi-wt-a-'));
  const wtB = mkdtempSync(join(tmpdir(), 'nhi-wt-b-'));
  // mkdtemp creates the dirs; git worktree add needs them absent, so target a
  // child path that does not yet exist.
  const pathA = join(wtA, 'tree');
  const pathB = join(wtB, 'tree');
  try {
    assert.equal(git(['worktree', 'add', '-b', 'milestone/4-a', pathA, baseSha], root).status, 0);
    assert.equal(git(['worktree', 'add', '-b', 'milestone/5-b', pathB, baseSha], root).status, 0);

    // .git in a linked worktree is a file, not a directory.
    assert.equal(statSync(join(pathA, '.git')).isFile(), true);

    assert.equal(currentBranch(pathA), 'milestone/4-a');
    assert.equal(currentBranch(pathB), 'milestone/5-b');
    assert.equal(currentBranch(root), 'main');

    assert.equal(isLinkedWorktree(pathA), true);
    assert.equal(isLinkedWorktree(pathB), true);
    assert.equal(isLinkedWorktree(root), false);

    // both worktrees started from the same base SHA
    assert.equal(git(['rev-parse', 'HEAD'], pathA).stdout.trim(), baseSha);
    assert.equal(git(['rev-parse', 'HEAD'], pathB).stdout.trim(), baseSha);

    const list = worktreeList(root);
    const branches = list.map((e) => e.branch);
    assert.ok(branches.includes('milestone/4-a'));
    assert.ok(branches.includes('milestone/5-b'));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(wtA, { recursive: true, force: true });
    rmSync(wtB, { recursive: true, force: true });
  }
});

test('edits in one worktree do not appear in the other or the primary', () => {
  const { root, baseSha } = setupRepo();
  const wtA = mkdtempSync(join(tmpdir(), 'nhi-wt-a-'));
  const wtB = mkdtempSync(join(tmpdir(), 'nhi-wt-b-'));
  const pathA = join(wtA, 'tree');
  const pathB = join(wtB, 'tree');
  try {
    git(['worktree', 'add', '-b', 'milestone/4-a', pathA, baseSha], root);
    git(['worktree', 'add', '-b', 'milestone/5-b', pathB, baseSha], root);

    writeFileSync(join(pathA, 'file.txt'), 'changed in A\n');

    assert.equal(readFileSync(join(pathB, 'file.txt'), 'utf8'), 'base\n');
    assert.equal(readFileSync(join(root, 'file.txt'), 'utf8'), 'base\n');

    // primary remains clean on main
    assert.equal(currentBranch(root), 'main');
    assert.equal(git(['status', '--porcelain'], root).stdout.trim(), '');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(wtA, { recursive: true, force: true });
    rmSync(wtB, { recursive: true, force: true });
  }
});

test('partial worktree creation failure leaves the first worktree intact', () => {
  const { root, baseSha } = setupRepo();
  const wtA = mkdtempSync(join(tmpdir(), 'nhi-wt-a-'));
  const wtB = mkdtempSync(join(tmpdir(), 'nhi-wt-b-'));
  const pathA = join(wtA, 'tree');
  const pathB = join(wtB, 'tree');
  try {
    assert.equal(git(['worktree', 'add', '-b', 'milestone/4-a', pathA, baseSha], root).status, 0);

    // Second creation reuses the same branch name: git refuses, no rollback.
    const second = git(['worktree', 'add', '-b', 'milestone/4-a', pathB, baseSha], root);
    assert.notEqual(second.status, 0);

    // First worktree is still registered and on its branch (no destructive
    // rollback happened).
    assert.equal(currentBranch(pathA), 'milestone/4-a');
    const branches = worktreeList(root).map((e) => e.branch);
    assert.ok(branches.includes('milestone/4-a'));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(wtA, { recursive: true, force: true });
    rmSync(wtB, { recursive: true, force: true });
  }
});

test('existing linked worktrees are detected in the worktree list', () => {
  const { root, baseSha } = setupRepo();
  const sibling = mkdtempSync(join(tmpdir(), 'nhi-wt-siblings-'));
  const pathA = join(sibling, 'wt-a');
  try {
    // No linked worktrees yet: only the primary checkout is registered.
    assert.equal(worktreeList(root).length, 1);

    git(['worktree', 'add', '-b', 'milestone/4-a', pathA, baseSha], root);

    const linked = worktreeList(root).filter((e) => e.branch && e.branch.startsWith('milestone/'));
    assert.equal(linked.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(sibling, { recursive: true, force: true });
  }
});

test('verifyCreatedWorktrees confirms two worktrees from the same base SHA', () => {
  const { root, baseSha } = setupRepo();
  const sibling = mkdtempSync(join(tmpdir(), 'nhi-wt-verify-'));
  const pathA = join(sibling, 'wt-a');
  const pathB = join(sibling, 'wt-b');
  try {
    git(['worktree', 'add', '-b', 'milestone/4-a', pathA, baseSha], root);
    git(['worktree', 'add', '-b', 'milestone/5-b', pathB, baseSha], root);

    const { ok, plan } = validateWorktreeRequest(
      [
        { number: 4, slug: 'a', path: pathA },
        { number: 5, slug: 'b', path: pathB },
      ],
      { primaryCheckoutPath: root },
    );
    assert.equal(ok, true);

    const result = verifyCreatedWorktrees({
      worktrees: worktreeList(root),
      plan,
      baseSha,
      primaryCheckoutPath: root,
    });
    assert.equal(result.ok, true, JSON.stringify(result.errors));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(sibling, { recursive: true, force: true });
  }
});

test('headSha, topLevel and primaryWorktreePath resolve repository context', () => {
  const { root, baseSha } = setupRepo();
  const wtA = mkdtempSync(join(tmpdir(), 'nhi-wt-ctx-'));
  const pathA = join(wtA, 'tree');
  try {
    git(['worktree', 'add', '-b', 'milestone/4-a', pathA, baseSha], root);

    // HEAD SHA is the full base SHA from both the primary and the linked tree.
    assert.equal(headSha(root), baseSha);
    assert.equal(headSha(pathA), baseSha);

    // top-level reflects the current checkout; the primary worktree path is the
    // primary checkout regardless of which worktree we query from.
    assert.equal(isLinkedWorktree(root), false);
    assert.equal(isLinkedWorktree(pathA), true);

    const primaryFromRoot = primaryWorktreePath(root);
    const primaryFromLinked = primaryWorktreePath(pathA);
    assert.equal(primaryFromRoot, primaryFromLinked);
    // the primary path is the root checkout, not the linked worktree
    assert.notEqual(primaryFromLinked.replace(/\\/g, '/'), pathA.replace(/\\/g, '/'));

    // topLevel of the linked worktree is the linked path, not the primary.
    assert.notEqual(
      topLevel(pathA).replace(/\\/g, '/').toLowerCase(),
      primaryFromLinked.replace(/\\/g, '/').toLowerCase(),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(wtA, { recursive: true, force: true });
  }
});

test('detached HEAD is reported as an empty branch name', () => {
  const { root, baseSha } = setupRepo();
  try {
    git(['checkout', baseSha], root);
    assert.equal(currentBranch(root), '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
