// Pure, side-effect-free Bash-command policy for the PreToolUse guard.
//
// The Edit/Write guard covers file-edit tools; this covers Bash commands such
// as `npm install` or `node --test --test-reporter-destination=…` that can
// modify tracked files or write output. No git, filesystem, or process access.
//
// Policy:
//   - On a normal (non-protected) branch every command is allowed; normal
//     development is never blocked here (it is still subject to the
//     .claude/settings.json permission rules).
//   - On a protected branch (main/master), a detached HEAD, or an unknown/
//     unreadable Git state, the guard FAILS CLOSED: only commands that match an
//     explicit allowlist of exact safe-inspection or exact approved-preparation
//     forms are permitted. Everything else is blocked. There is no open-ended
//     blacklist of "modifying" commands.

import { decideBranchEdit } from './branch-decision.mjs';

// A milestone branch is `milestone/<positive-integer>-<short-kebab-slug>`.
const MILESTONE_BRANCH = /^milestone\/[1-9][0-9]*-[a-z0-9]+(-[a-z0-9]+)*$/;

// 7–40 hex characters (abbreviated or full commit SHA).
const BASE_SHA = /^[0-9a-f]{7,40}$/i;

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

// ---- exact approved preparation forms --------------------------------------

function eq(tokens, expected) {
  return tokens.length === expected.length && expected.every((t, i) => tokens[i] === t);
}

function isApprovedPreparation(tokens) {
  if (tokens[0] !== 'git') {
    return false;
  }

  if (eq(tokens, ['git', 'fetch', 'origin'])) {
    return true;
  }
  if (eq(tokens, ['git', 'pull', '--ff-only', 'origin', 'main'])) {
    return true;
  }
  if (eq(tokens, ['git', 'switch', 'main']) || eq(tokens, ['git', 'checkout', 'main'])) {
    return true;
  }

  // git switch -c milestone/<n>-<slug>  /  git checkout -b milestone/<n>-<slug>
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

  // git worktree add -b milestone/<n>-<slug> <path> <base-sha>
  if (
    tokens.length === 7 &&
    tokens[1] === 'worktree' &&
    tokens[2] === 'add' &&
    tokens[3] === '-b' &&
    MILESTONE_BRANCH.test(tokens[4]) &&
    !tokens[5].startsWith('-') &&
    BASE_SHA.test(tokens[6])
  ) {
    return true;
  }

  return false;
}

/**
 * Decide whether a command is allowed on a protected/detached/unknown branch.
 *
 * @param {string} command
 * @returns {{ allowed: boolean, category: 'inspection'|'preparation'|'blocked', reason: string }}
 */
export function classifyProtectedCommand(command) {
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

  if (isApprovedPreparation(tokens)) {
    return { allowed: true, category: 'preparation', reason: 'exact approved preparation command' };
  }

  return {
    allowed: false,
    category: 'blocked',
    reason: 'not an allowed safe-inspection or approved-preparation command',
  };
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

  const classified = classifyProtectedCommand(command);
  if (classified.allowed) {
    return {
      allowed: true,
      code: branchDecision.code,
      reason: `Allowed on protected branch: ${classified.reason}.`,
    };
  }

  return {
    allowed: false,
    code: branchDecision.code,
    reason:
      `${branchDecision.reason} Blocked Bash command: ${classified.reason}. ` +
      'On a protected branch only safe Git inspection and the exact approved ' +
      'preparation commands are allowed. Run other commands from a milestone ' +
      'branch (use the start-milestone or prepare-parallel-worktrees skill).',
  };
}
