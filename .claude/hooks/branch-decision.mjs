// Pure, side-effect-free branch-decision logic shared by the Claude Code hooks.
// No git, process, or filesystem access here so it can be unit-tested directly.

export const PROTECTED_BRANCHES = ['main', 'master'];

/**
 * Decide whether file modifications are allowed on the given branch.
 *
 * @param {string|null|undefined} branch
 *   The current branch name as reported by git. Pass `null`/`undefined` when
 *   branch detection failed, and an empty string or `"HEAD"` for a detached
 *   HEAD. Anything else is treated as a named branch.
 * @returns {{ allowed: boolean, code: 'ok'|'protected'|'detached'|'unknown', reason: string }}
 */
export function decideBranchEdit(branch) {
  if (branch === null || branch === undefined) {
    return {
      allowed: false,
      code: 'unknown',
      reason:
        'Could not determine the current Git branch. Refusing to edit files. ' +
        'Start a milestone with the start-milestone skill.',
    };
  }

  const name = String(branch).trim();

  if (name === '' || name === 'HEAD') {
    return {
      allowed: false,
      code: 'detached',
      reason:
        'HEAD is detached. Refusing to edit files. ' +
        'Use the start-milestone skill to create a milestone branch first.',
    };
  }

  if (PROTECTED_BRANCHES.includes(name)) {
    return {
      allowed: false,
      code: 'protected',
      reason:
        `The "${name}" branch is protected. Refusing to edit files on it. ` +
        'Use the start-milestone skill to create a milestone/<n>-<slug> branch.',
    };
  }

  return { allowed: true, code: 'ok', reason: `Editing allowed on "${name}".` };
}

/**
 * Whether a branch name is protected against direct file modification.
 *
 * @param {string|null|undefined} branch
 * @returns {boolean}
 */
export function isProtectedBranch(branch) {
  const decision = decideBranchEdit(branch);
  return !decision.allowed && decision.code === 'protected';
}
