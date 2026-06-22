// Pure, side-effect-free Bash-command policy for the PreToolUse guard.
//
// The Edit/Write guard covers file-edit tools; this covers Bash commands such
// as `npm install` or `git worktree add` that can modify tracked files, write
// output, or create directories. No git, filesystem, or process access here:
// the entry point (guard-bash.mjs) resolves the repository context and injects
// it so this module stays pure and testable.
//
// Policy (keyed on the resolved repository state, not just the branch name):
//   - Normal (non-protected) branch: every command is allowed; normal
//     development is never blocked here (still subject to .claude/settings.json).
//   - Primary checkout on `main`: safe inspection, the exact main-update and
//     branch-creation preparation commands, and a single fully validated
//     `git worktree add` are allowed.
//   - Primary checkout on `master`, a linked worktree on a protected/detached/
//     unknown branch, a detached HEAD, or an unknown/unreadable Git state:
//     FAIL CLOSED. Only safe inspection is allowed (plus the exact `git switch
//     main`/`git checkout main` recovery command when the Git state is
//     readable). No fetch/pull, branch creation, or worktree creation.
//
// There is no open-ended blacklist of "modifying" commands.

import { decideBranchEdit } from './branch-decision.mjs';
import {
  collapse,
  canonical,
  isInside,
  isAbsolute,
  platformCaseInsensitive,
} from './worktree-decision.mjs';

// A milestone branch is `milestone/<positive-integer>-<short-kebab-slug>`.
const MILESTONE_BRANCH = /^milestone\/[1-9][0-9]*-[a-z0-9]+(-[a-z0-9]+)*$/;

// A plain hex SHA shape (7–64 hex). Worktree creation additionally requires the
// supplied SHA to equal the full current HEAD SHA, so abbreviations are
// rejected by that equality check, not by this shape alone.
const HEX_SHA = /^[0-9a-f]{7,64}$/i;

// A plain ref/branch name argument (no shell metacharacters, no `=`).
const REF_ARG = /^[A-Za-z0-9._/@^~-]+$/;

// Shell features that could redirect output, chain commands, substitute
// commands, or expand variables. On a protected branch any of these blocks the
// command outright, so the allowlist below only ever sees a single plain
// command with plain arguments.
const SHELL_METACHARACTERS = /[|&;<>(){}`$\n\r]/;

function hasShellMetacharacters(command) {
  return SHELL_METACHARACTERS.test(command);
}

// Strip one layer of matching surrounding quotes from a token. Worktree branch
// names, SHAs, and paths are frequently quoted; the surrounding quotes are not
// significant for matching the allowlist. (This is deliberately not a shell
// parser: a quoted argument containing whitespace or shell metacharacters is
// still rejected, which fails closed.)
function unquote(token) {
  if (token.length >= 2) {
    const first = token[0];
    const last = token[token.length - 1];
    if ((first === '"' || first === "'") && first === last) {
      return token.slice(1, -1);
    }
  }
  return token;
}

function tokenize(command) {
  return command
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .map(unquote);
}

// Normalize the injected context. A bare string (or null/undefined) is treated
// as a branch-only context with no primary/HEAD facts known, which fails closed
// for any state-dependent allowance (preparation, worktree creation).
function normalizeContext(context) {
  if (context === null || context === undefined || typeof context === 'string') {
    return {
      branch: context === undefined ? null : context,
      isPrimaryCheckout: null,
      primaryCheckoutPath: null,
      primaryGitDir: null,
      headSha: null,
    };
  }
  return {
    branch: context.branch ?? null,
    isPrimaryCheckout: context.isPrimaryCheckout ?? null,
    primaryCheckoutPath: context.primaryCheckoutPath ?? null,
    primaryGitDir: context.primaryGitDir ?? null,
    headSha: context.headSha ?? null,
  };
}

// ---- exact safe inspection forms -------------------------------------------

// Read-only `git diff`/`git status` flags that cannot write files or run an
// external helper. Anything outside this set (e.g. --output, --output=<path>,
// --ext-diff) falls through and blocks the command.
const SAFE_DIFF_FLAGS = new Set([
  '--check', '--staged', '--cached', '--stat', '--numstat', '--shortstat',
  '--name-only', '--name-status', '--no-color',
]);

// `git rev-parse` is read-only and has no file-writing flags; allow a curated
// set of flags plus plain refs.
const SAFE_REV_PARSE_FLAGS = new Set([
  '--abbrev-ref', '--absolute-git-dir', '--git-common-dir', '--git-dir',
  '--show-toplevel', '--is-inside-work-tree', '--verify', '--quiet', '--short',
  '--symbolic-full-name', '--path-format=absolute',
]);

function isSafeInspection(tokens) {
  if (tokens[0] !== 'git' || tokens.length < 2) {
    return false;
  }
  const sub = tokens[1];
  const rest = tokens.slice(2);

  if (sub === 'status') {
    return rest.length === 0 || (rest.length === 1 && (rest[0] === '--short' || rest[0] === '--porcelain'));
  }

  if (sub === 'diff') {
    return rest.every((t) => SAFE_DIFF_FLAGS.has(t));
  }

  if (sub === 'branch') {
    if (rest.length === 1 && rest[0] === '--show-current') {
      return true;
    }
    if (rest.length === 2 && rest[0] === '--list' && REF_ARG.test(rest[1])) {
      return true;
    }
    return false;
  }

  if (sub === 'rev-parse') {
    return rest.length > 0 && rest.every((t) => (t.startsWith('-') ? SAFE_REV_PARSE_FLAGS.has(t) : REF_ARG.test(t)));
  }

  if (sub === 'ls-remote') {
    return rest.length === 3 && rest[0] === '--heads' && rest[1] === 'origin' && REF_ARG.test(rest[2]);
  }

  if (sub === 'worktree') {
    return rest.length === 1 && rest[0] === 'list'
      ? true
      : rest.length === 2 && rest[0] === 'list' && rest[1] === '--porcelain';
  }

  return false;
}

// ---- recovery and preparation forms ----------------------------------------

function eq(tokens, expected) {
  return tokens.length === expected.length && expected.every((t, i) => tokens[i] === t);
}

// `git switch main` / `git checkout main`: returning to main is always safe and
// is allowed from any readable Git state (named branch or detached HEAD).
function isRecoveryToMain(tokens) {
  return eq(tokens, ['git', 'switch', 'main']) || eq(tokens, ['git', 'checkout', 'main']);
}

// Whether the current state is "primary checkout on main", the only state in
// which preparation and worktree creation may be allowed.
function isPrimaryOnMain(ctx) {
  return ctx.branch === 'main' && ctx.isPrimaryCheckout === true;
}

// Main-update and milestone-branch-creation preparation (no worktree add).
function isMainPreparation(tokens) {
  if (tokens[0] !== 'git') {
    return false;
  }
  if (eq(tokens, ['git', 'fetch', 'origin'])) {
    return true;
  }
  if (eq(tokens, ['git', 'pull', '--ff-only', 'origin', 'main'])) {
    return true;
  }
  if (
    tokens.length === 4 &&
    tokens[1] === 'switch' &&
    tokens[2] === '-c' &&
    MILESTONE_BRANCH.test(tokens[3])
  ) {
    return true;
  }
  if (
    tokens.length === 4 &&
    tokens[1] === 'checkout' &&
    tokens[2] === '-b' &&
    MILESTONE_BRANCH.test(tokens[3])
  ) {
    return true;
  }
  return false;
}

// Classify `git worktree add` against the strict, fully validated form:
//   git worktree add -b milestone/<n>-<slug> <absolute-path> <full-head-sha>
// Returns { match, allowed, reason }. `match` is true when the command is a
// `git worktree add` at all, so the caller can surface a specific rejection
// reason instead of the generic "not allowed" message.
function classifyWorktreeAdd(tokens, ctx) {
  if (tokens[0] !== 'git' || tokens[1] !== 'worktree' || tokens[2] !== 'add') {
    return { match: false };
  }

  const reject = (reason) => ({ match: true, allowed: false, reason });

  // Exactly: add -b <branch> <path> <sha>. No extra or missing flags.
  if (tokens.length !== 7 || tokens[3] !== '-b') {
    return reject('git worktree add must be exactly "git worktree add -b <milestone-branch> <absolute-path> <full-head-sha>".');
  }

  const branch = tokens[4];
  const path = tokens[5];
  const sha = tokens[6];

  if (!MILESTONE_BRANCH.test(branch)) {
    return reject(`"${branch}" is not a valid milestone/<n>-<slug> branch.`);
  }
  if (path.startsWith('-')) {
    return reject('the worktree path must not look like a flag.');
  }
  if (!isAbsolute(path)) {
    return reject('the worktree path must be an absolute path.');
  }
  if (!HEX_SHA.test(sha)) {
    return reject('the base commit must be a full hex SHA.');
  }

  if (ctx.isPrimaryCheckout !== true) {
    return reject('git worktree add is only allowed from the primary checkout.');
  }
  if (ctx.branch !== 'main') {
    return reject('git worktree add is only allowed while the primary checkout is on main.');
  }
  if (!ctx.primaryCheckoutPath) {
    return reject('the primary checkout path could not be determined.');
  }
  if (!ctx.headSha) {
    return reject('the current HEAD SHA could not be determined.');
  }
  if (sha.toLowerCase() !== ctx.headSha.toLowerCase()) {
    return reject('the base commit must equal the current full HEAD SHA (abbreviated or stale SHAs are rejected).');
  }

  const caseInsensitive = platformCaseInsensitive();
  const targetCanonical = canonical(collapse(path), caseInsensitive);
  const primaryCanonical = canonical(collapse(ctx.primaryCheckoutPath), caseInsensitive);

  if (targetCanonical === primaryCanonical) {
    return reject('the worktree path must not be the primary checkout itself.');
  }
  if (isInside(primaryCanonical, targetCanonical)) {
    return reject('the worktree path must be outside the primary checkout (it must not be nested inside it).');
  }
  if (ctx.primaryGitDir) {
    const gitDirCanonical = canonical(collapse(ctx.primaryGitDir), caseInsensitive);
    if (targetCanonical === gitDirCanonical) {
      return reject("the worktree path must not be the primary checkout's .git directory.");
    }
  }

  return { match: true, allowed: true, reason: 'fully validated milestone worktree creation' };
}

/**
 * Decide whether a command is allowed on a protected/detached/unknown state.
 *
 * @param {string} command
 * @param {object|string|null} context  Resolved repository context (see normalizeContext).
 * @returns {{ allowed: boolean, category: 'inspection'|'recovery'|'preparation'|'blocked', reason: string }}
 */
export function classifyProtectedCommand(command, context) {
  const ctx = normalizeContext(context);
  const text = String(command ?? '');

  if (text.trim() === '') {
    return { allowed: false, category: 'blocked', reason: 'empty command' };
  }

  if (hasShellMetacharacters(text)) {
    return {
      allowed: false,
      category: 'blocked',
      reason:
        'shell operators (redirection, pipes, command substitution, chaining, ' +
        'or variable expansion) are not allowed on a protected branch',
    };
  }

  const tokens = tokenize(text);

  if (isSafeInspection(tokens)) {
    return { allowed: true, category: 'inspection', reason: 'recognized safe Git inspection command' };
  }

  // Recovery to main is allowed whenever the Git state is readable (a named
  // branch or a detached HEAD), but not when the state is unknown (branch null).
  if (ctx.branch !== null && isRecoveryToMain(tokens)) {
    return { allowed: true, category: 'recovery', reason: 'exact git switch/checkout main recovery command' };
  }

  // Preparation and worktree creation are only permitted from the primary
  // checkout while it is on main.
  if (isPrimaryOnMain(ctx)) {
    if (isMainPreparation(tokens)) {
      return { allowed: true, category: 'preparation', reason: 'exact approved preparation command' };
    }
    const wt = classifyWorktreeAdd(tokens, ctx);
    if (wt.match) {
      return wt.allowed
        ? { allowed: true, category: 'preparation', reason: wt.reason }
        : { allowed: false, category: 'blocked', reason: `git worktree add rejected: ${wt.reason}` };
    }
  } else {
    // Surface a precise reason when a worktree add is attempted from a state
    // that can never allow it.
    const wt = classifyWorktreeAdd(tokens, ctx);
    if (wt.match) {
      return { allowed: false, category: 'blocked', reason: `git worktree add rejected: ${wt.reason}` };
    }
  }

  return {
    allowed: false,
    category: 'blocked',
    reason: 'not an allowed safe-inspection or approved-preparation command for the current Git state',
  };
}

/**
 * Decide whether a Bash command may run given the resolved repository context.
 *
 * @param {string} command  The Bash command line.
 * @param {object|string|null|undefined} context
 *   Either the current branch name (string / '' detached / null unknown) or a
 *   context object: { branch, isPrimaryCheckout, primaryCheckoutPath,
 *   primaryGitDir, headSha }.
 * @returns {{ allowed: boolean, code: 'ok'|'protected'|'detached'|'unknown', reason: string }}
 */
export function decideBashCommand(command, context) {
  const ctx = normalizeContext(context);
  const branchDecision = decideBranchEdit(ctx.branch);
  const text = String(command ?? '');

  // `git worktree add` is governed by the strict validator in every Git state,
  // including normal milestone branches, so that a milestone or linked-worktree
  // session can never spawn another worktree and only the primary checkout on
  // main can — at a validated path outside the primary checkout.
  if (text.trim() !== '') {
    const tokens = tokenize(text);
    if (tokens[0] === 'git' && tokens[1] === 'worktree' && tokens[2] === 'add') {
      if (hasShellMetacharacters(text)) {
        return {
          allowed: false,
          code: branchDecision.code,
          reason: 'Blocked Bash command: git worktree add must not contain shell operators.',
        };
      }
      const wt = classifyWorktreeAdd(tokens, ctx);
      if (wt.allowed) {
        return { allowed: true, code: branchDecision.code, reason: `Allowed: ${wt.reason}.` };
      }
      return {
        allowed: false,
        code: branchDecision.code,
        reason: `Blocked Bash command: git worktree add rejected: ${wt.reason}.`,
      };
    }
  }

  if (branchDecision.allowed) {
    return { allowed: true, code: 'ok', reason: `Command allowed on "${String(ctx.branch).trim()}".` };
  }

  const classified = classifyProtectedCommand(command, ctx);
  if (classified.allowed) {
    return {
      allowed: true,
      code: branchDecision.code,
      reason: `Allowed on protected Git state: ${classified.reason}.`,
    };
  }

  return {
    allowed: false,
    code: branchDecision.code,
    reason:
      `${branchDecision.reason} Blocked Bash command: ${classified.reason}. ` +
      'On a protected Git state only safe Git inspection is allowed, plus the ' +
      'exact approved preparation commands from the primary checkout on main. ' +
      'Run other commands from a milestone branch (use the start-milestone or ' +
      'prepare-parallel-worktrees skill).',
  };
}
