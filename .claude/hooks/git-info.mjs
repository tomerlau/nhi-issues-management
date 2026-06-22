// Thin, cwd-aware wrappers around git inspection used by the workflow hooks.
//
// All helpers accept an optional working directory so the hooks behave
// correctly when Claude runs inside a linked worktree (where `.git` is a file,
// not a directory). git resolves the worktree from the current directory, so as
// long as the hook inherits the worktree as its cwd these report the worktree's
// own state. None of these helpers mutate the repository.

import { spawnSync } from 'node:child_process';

function git(args, cwd) {
  const result = spawnSync('git', args, {
    encoding: 'utf8',
    cwd: cwd ?? process.cwd(),
  });
  if (result.status !== 0 || typeof result.stdout !== 'string') {
    return null;
  }
  return result.stdout;
}

/**
 * Current branch of the checkout that owns `cwd`.
 *
 * Returns the branch name, an empty string for a detached HEAD, or `null` when
 * git could not be queried (so callers can fail closed).
 *
 * @param {string} [cwd]
 * @returns {string|null}
 */
export function currentBranch(cwd) {
  const out = git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  if (out === null) {
    return null;
  }
  const name = out.trim();
  // git prints "HEAD" for a detached HEAD; normalize to empty string so the
  // shared branch-decision logic classifies it as detached.
  return name === 'HEAD' ? '' : name;
}

/**
 * Full HEAD commit SHA of the checkout that owns `cwd`.
 * Returns `null` when git could not be queried (so callers can fail closed).
 * @param {string} [cwd]
 * @returns {string|null}
 */
export function headSha(cwd) {
  const out = git(['rev-parse', 'HEAD'], cwd);
  if (out === null) {
    return null;
  }
  const sha = out.trim();
  return sha === '' ? null : sha;
}

/**
 * Working-tree top-level path of the checkout that owns `cwd`
 * (`git rev-parse --show-toplevel`, absolute). `null` on failure.
 * @param {string} [cwd]
 * @returns {string|null}
 */
export function topLevel(cwd) {
  const out = git(['rev-parse', '--show-toplevel'], cwd);
  if (out === null) {
    return null;
  }
  const path = out.trim();
  return path === '' ? null : path;
}

/**
 * Absolute path of the primary (main) checkout for this repository.
 *
 * `git worktree list` always reports the primary checkout first, so the first
 * parsed entry is the primary checkout regardless of which worktree `cwd` is in.
 * Returns `null` when git could not be queried.
 *
 * @param {string} [cwd]
 * @returns {string|null}
 */
export function primaryWorktreePath(cwd) {
  const list = worktreeList(cwd);
  if (list === null || list.length === 0) {
    return null;
  }
  return list[0].path;
}

/**
 * Per-worktree git directory (`git rev-parse --git-dir`, absolute).
 * @param {string} [cwd]
 * @returns {string|null}
 */
export function gitDir(cwd) {
  const out = git(['rev-parse', '--absolute-git-dir'], cwd);
  return out === null ? null : out.trim();
}

/**
 * Common git directory shared by all worktrees (`--git-common-dir`, absolute).
 * @param {string} [cwd]
 * @returns {string|null}
 */
export function gitCommonDir(cwd) {
  const out = git(['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd);
  return out === null ? null : out.trim();
}

/**
 * Whether `cwd` is inside a linked (non-primary) worktree.
 *
 * A linked worktree has a per-worktree git dir (…/.git/worktrees/<name>) that
 * differs from the shared common dir (…/.git). The primary checkout has the two
 * equal. Returns `null` when git could not be queried.
 *
 * @param {string} [cwd]
 * @returns {boolean|null}
 */
export function isLinkedWorktree(cwd) {
  const dir = gitDir(cwd);
  const common = gitCommonDir(cwd);
  if (dir === null || common === null) {
    return null;
  }
  return dir !== common;
}

/**
 * Parsed `git worktree list --porcelain` entries for the current repository.
 * @param {string} [cwd]
 * @returns {Array<{ path: string, head: string|null, branch: string|null, detached: boolean }>|null}
 */
export function worktreeList(cwd) {
  const out = git(['worktree', 'list', '--porcelain'], cwd);
  if (out === null) {
    return null;
  }
  const entries = [];
  let current = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) {
      current = { path: line.slice('worktree '.length), head: null, branch: null, detached: false };
      entries.push(current);
    } else if (current && line.startsWith('HEAD ')) {
      current.head = line.slice('HEAD '.length);
    } else if (current && line.startsWith('branch ')) {
      // e.g. "branch refs/heads/milestone/4-foo" -> "milestone/4-foo"
      current.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
    } else if (current && line === 'detached') {
      current.detached = true;
    }
  }
  return entries;
}
