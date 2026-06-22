// Pure, side-effect-free validation for the parallel-worktree workflow.
//
// Used as the source of truth that the prepare-parallel-worktrees and
// start-milestone skills describe in prose, and exercised directly by the
// workflow tests. No git, filesystem, or process access here.

export const PROTECTED_BRANCHES = ['main', 'master'];

/**
 * Build a milestone branch name from a number and kebab-case slug.
 * @param {number|string} number
 * @param {string} slug
 * @returns {string}
 */
export function buildMilestoneBranch(number, slug) {
  return `milestone/${number}-${slug}`;
}

/**
 * Validate a request to prepare exactly two parallel milestone worktrees.
 *
 * @param {Array<{ number: number|string, slug: string, path: string }>} specs
 * @returns {{ ok: boolean, errors: string[], plan: Array<{ number: string, slug: string, branch: string, path: string }> }}
 */
export function validateWorktreeRequest(specs) {
  const errors = [];

  if (!Array.isArray(specs) || specs.length !== 2) {
    return {
      ok: false,
      errors: ['Exactly two milestone worktree specifications are required.'],
      plan: [],
    };
  }

  const plan = specs.map((spec) => ({
    number: String(spec.number).trim(),
    slug: String(spec.slug ?? '').trim(),
    path: String(spec.path ?? '').trim(),
    branch: buildMilestoneBranch(String(spec.number).trim(), String(spec.slug ?? '').trim()),
  }));

  for (const entry of plan) {
    if (entry.number === '') {
      errors.push('A milestone number is required.');
    }
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(entry.slug)) {
      errors.push(`Slug "${entry.slug}" must be short kebab-case (a-z, 0-9, hyphens).`);
    }
    if (entry.path === '') {
      errors.push('A target worktree path is required.');
    }
  }

  const numbers = plan.map((p) => p.number);
  if (new Set(numbers).size !== numbers.length) {
    errors.push('Duplicate milestone numbers are not allowed.');
  }

  const branches = plan.map((p) => p.branch);
  if (new Set(branches).size !== branches.length) {
    errors.push('Duplicate branch names are not allowed.');
  }

  const paths = plan.map((p) => p.path);
  if (new Set(paths).size !== paths.length) {
    errors.push('The two worktree paths must be different.');
  }

  return { ok: errors.length === 0, errors, plan };
}

/**
 * Decide which mode the start-milestone skill should run in.
 *
 * Normal mode prepares an updated main and a fresh branch. Prepared-worktree
 * mode validates an already-prepared linked worktree without touching main.
 * The deciding signal is whether the current checkout is the primary checkout:
 * the primary checkout always uses normal mode; a linked worktree uses prepared
 * mode.
 *
 * @param {{ isPrimaryCheckout: boolean }} ctx
 * @returns {'normal'|'prepared'}
 */
export function decideStartMode({ isPrimaryCheckout }) {
  return isPrimaryCheckout ? 'normal' : 'prepared';
}

/**
 * Validate that the current checkout is a correctly prepared linked worktree
 * for the approved milestone branch.
 *
 * @param {{
 *   activeBranch: string|null,
 *   expectedBranch: string,
 *   isPrimaryCheckout: boolean,
 *   isWorktreeRegistered: boolean,
 *   isClean: boolean,
 * }} ctx
 * @returns {{ ok: boolean, code: string, reason: string }}
 */
export function validatePreparedWorktree(ctx) {
  const {
    activeBranch,
    expectedBranch,
    isPrimaryCheckout,
    isWorktreeRegistered,
    isClean,
  } = ctx;

  if (isPrimaryCheckout) {
    return {
      ok: false,
      code: 'primary-checkout',
      reason:
        'The primary checkout cannot be used as a prepared worktree. Run ' +
        'prepare-parallel-worktrees from the primary checkout, then start this ' +
        'skill inside the created worktree.',
    };
  }

  const name = activeBranch === null || activeBranch === undefined ? '' : String(activeBranch).trim();

  if (name === '' || name === 'HEAD') {
    return { ok: false, code: 'detached', reason: 'HEAD is detached in this worktree.' };
  }

  if (PROTECTED_BRANCHES.includes(name)) {
    return {
      ok: false,
      code: 'protected',
      reason: `A prepared worktree must not be on the protected "${name}" branch.`,
    };
  }

  if (!isClean) {
    return {
      ok: false,
      code: 'dirty',
      reason: 'The worktree has local changes; the developer must resolve them first.',
    };
  }

  if (name !== expectedBranch) {
    return {
      ok: false,
      code: 'branch-mismatch',
      reason:
        `This worktree is on "${name}", not the approved branch "${expectedBranch}". ` +
        'Never infer milestone scope from the branch name.',
    };
  }

  if (!isWorktreeRegistered) {
    return {
      ok: false,
      code: 'not-registered',
      reason: `"${name}" is not a registered linked worktree in git worktree list.`,
    };
  }

  return { ok: true, code: 'prepared', reason: `Prepared worktree on "${name}" is valid.` };
}
