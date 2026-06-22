// Pure, side-effect-free classification for the Bash PreToolUse guard.
//
// The Edit/Write hook only covers file-edit tools, but Bash commands such as
// `npm install` can also modify tracked files (node_modules, lockfiles, build
// output). This module decides whether a Bash command may run given the current
// branch, without touching git, the filesystem, or the process.
//
// Policy:
//   - On a normal (non-protected) branch every command is allowed; we never get
//     in the way of normal development.
//   - On a protected branch (main/master), a detached HEAD, or an unknown/
//     unreadable branch state, repository-modifying commands are blocked while
//     read-only commands and the explicit preparation commands stay allowed.
//   - Commands that are not recognized as modifying are treated as read-only and
//     allowed, so routine inspection (ls, cat, git status, …) keeps working on
//     main. Branch *detection* still fails closed: an unknown branch blocks the
//     modifying commands we do recognize.

import { decideBranchEdit } from './branch-decision.mjs';

// Package managers run arbitrary lifecycle scripts and rewrite node_modules and
// lockfiles, so any invocation counts as repository-modifying. This covers the
// `npm install`, `npm ci`, and `npm run …` commands the permission allowlist
// permits, plus the other managers, without enumerating each subcommand.
const PACKAGE_MANAGERS = new Set(['npm', 'npx', 'pnpm', 'pnpx', 'yarn', 'bun', 'bunx']);

// First tokens that directly write or remove files. Defensive coverage so that
// broadening the Bash allowlist later does not silently expose main.
const FILE_MUTATORS = new Set([
  'rm', 'rmdir', 'mv', 'cp', 'tee', 'truncate', 'dd', 'ln', 'install', 'shred',
]);

// Strip a leading `env`/inline VAR=value assignments and return the argv tokens
// of a single command segment, or null when the segment is empty.
function tokenize(segment) {
  const trimmed = segment.trim();
  if (trimmed === '') {
    return null;
  }
  const tokens = trimmed.split(/\s+/);
  let i = 0;
  while (i < tokens.length && (tokens[i] === 'env' || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]))) {
    i += 1;
  }
  const rest = tokens.slice(i);
  return rest.length > 0 ? rest : null;
}

// Split a compound command into individual command segments on shell operators
// (&&, ||, ;, |, newlines). Best-effort: good enough to catch a modifying
// command hidden inside a chain like `git status && npm install`.
function splitSegments(command) {
  return String(command)
    .split(/\|\||&&|[;\n|]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

const GIT_READONLY_SUBCOMMANDS = new Set([
  'status', 'diff', 'log', 'show', 'branch', 'rev-parse', 'ls-remote',
  'ls-files', 'cat-file', 'config', 'remote', 'describe', 'blame', 'shortlog',
  'rev-list', 'for-each-ref', 'symbolic-ref', 'reflog', 'tag',
]);

// Classify a single, already-tokenized command segment.
function classifySegment(tokens) {
  const cmd = tokens[0];

  if (PACKAGE_MANAGERS.has(cmd)) {
    return { kind: 'modifying', reason: `package-manager command "${cmd}" can modify tracked files` };
  }

  if (FILE_MUTATORS.has(cmd)) {
    return { kind: 'modifying', reason: `"${cmd}" can modify or remove files` };
  }

  // `sed -i`, `perl -i` rewrite files in place.
  if ((cmd === 'sed' || cmd === 'perl') && tokens.slice(1).some((t) => t === '-i' || t.startsWith('-i'))) {
    return { kind: 'modifying', reason: `"${cmd} -i" rewrites files in place` };
  }

  if (cmd === 'git') {
    return classifyGit(tokens);
  }

  // Anything else is presumed read-only (and thus allowed on protected
  // branches). The permission allowlist gates which Bash commands run at all.
  return { kind: 'read-only', reason: `"${cmd}" is not a recognized repository-modifying command` };
}

// Git is special: read-only inspection and the explicit preparation commands
// are allowed on a protected branch, while anything else git could do is left
// for the deny list / treated as preparation. (Destructive git commands are
// already denied in settings.json; this guard focuses on file-modifying
// commands the permission layer otherwise permits.)
function classifyGit(tokens) {
  const sub = tokens[1];
  if (sub === undefined) {
    return { kind: 'read-only', reason: 'bare git invocation' };
  }
  if (sub === 'worktree') {
    const action = tokens[2];
    if (action === 'list') {
      return { kind: 'read-only', reason: 'git worktree list is read-only' };
    }
    if (action === 'add') {
      return { kind: 'preparation', reason: 'git worktree add is an approved preparation command' };
    }
    // remove/prune/repair/move/lock/unlock are denied in settings.json.
    return { kind: 'read-only', reason: `git worktree ${action ?? ''} handled by permission policy` };
  }
  if (sub === 'switch' || sub === 'checkout') {
    return { kind: 'preparation', reason: `git ${sub} is an approved preparation command` };
  }
  if (sub === 'pull') {
    return { kind: 'preparation', reason: 'git pull --ff-only is an approved preparation command' };
  }
  if (sub === 'fetch') {
    return { kind: 'preparation', reason: 'git fetch is an approved preparation command' };
  }
  if (GIT_READONLY_SUBCOMMANDS.has(sub)) {
    return { kind: 'read-only', reason: `git ${sub} is read-only` };
  }
  // Unknown git subcommands: leave to the permission layer; do not block here.
  return { kind: 'read-only', reason: `git ${sub} handled by permission policy` };
}

/**
 * Classify a (possibly compound) Bash command.
 *
 * @param {string} command
 * @returns {{ kind: 'modifying'|'preparation'|'read-only', reason: string }}
 *   `modifying` if any segment modifies the repository; otherwise the kind of
 *   the most privileged segment seen (preparation over read-only).
 */
export function classifyBashCommand(command) {
  const segments = splitSegments(command);
  if (segments.length === 0) {
    return { kind: 'read-only', reason: 'empty command' };
  }

  let result = { kind: 'read-only', reason: 'no modifying or preparation segment' };
  for (const segment of segments) {
    const tokens = tokenize(segment);
    if (tokens === null) {
      continue;
    }
    const classified = classifySegment(tokens);
    if (classified.kind === 'modifying') {
      return classified; // a single modifying segment taints the whole command
    }
    if (classified.kind === 'preparation') {
      result = classified;
    }
  }
  return result;
}

/**
 * Decide whether a Bash command may run on the given branch.
 *
 * @param {string} command  The Bash command line.
 * @param {string|null|undefined} branch  Current branch (see decideBranchEdit).
 * @returns {{ allowed: boolean, code: 'ok'|'protected'|'detached'|'unknown', reason: string }}
 */
export function decideBashCommand(command, branch) {
  const branchDecision = decideBranchEdit(branch);
  if (branchDecision.allowed) {
    return { allowed: true, code: 'ok', reason: `Command allowed on "${String(branch).trim()}".` };
  }

  const classified = classifyBashCommand(command);
  if (classified.kind === 'modifying') {
    return {
      allowed: false,
      code: branchDecision.code,
      reason:
        `${branchDecision.reason} Blocked Bash command because ${classified.reason}. ` +
        'Run repository-modifying commands from a milestone branch (use the ' +
        'start-milestone or prepare-parallel-worktrees skill).',
    };
  }

  return {
    allowed: true,
    code: branchDecision.code,
    reason: `Allowed on protected branch: ${classified.reason}.`,
  };
}
