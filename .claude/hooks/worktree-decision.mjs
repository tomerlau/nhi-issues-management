// Pure, side-effect-free validation for the parallel-worktree workflow.
//
// Used as the source of truth that the prepare-parallel-worktrees and
// start-milestone skills describe in prose, and exercised directly by the
// workflow tests. No git, filesystem, or process mutation here. Filesystem and
// Git facts are injected as data so the decision logic stays pure and testable
// without touching a real repository (see evaluateWorktreePreparation and
// verifyCreatedWorktrees).

export const PROTECTED_BRANCHES = ['main', 'master'];

const MILESTONE_NUMBER = /^[1-9][0-9]*$/;
const KEBAB_SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function platformCaseInsensitive() {
  return process.platform === 'win32';
}

// Collapse a path to a normalized form: forward slashes, no `.`/`..` segments,
// no trailing slash. Preserves a POSIX root (`/…`) or a Windows drive (`C:/…`).
function collapse(input) {
  let s = String(input).replace(/\\/g, '/');

  let prefix = '';
  if (/^[A-Za-z]:\//.test(s)) {
    prefix = s.slice(0, 2); // drive letter + colon
    s = s.slice(2);
  }
  const absolute = s.startsWith('/');

  const out = [];
  for (const part of s.split('/')) {
    if (part === '' || part === '.') {
      continue;
    }
    if (part === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') {
        out.pop();
      } else if (!absolute && prefix === '') {
        out.push('..');
      }
      continue;
    }
    out.push(part);
  }

  const body = out.join('/');
  if (prefix) {
    return `${prefix}/${body}`;
  }
  if (absolute) {
    return `/${body}`;
  }
  return body;
}

function isAbsolute(s) {
  return s.startsWith('/') || /^[A-Za-z]:[\\/]/.test(s);
}

// Resolve a (possibly relative) path against a base directory and normalize it.
function resolvePath(base, p) {
  const normalizedInput = String(p).replace(/\\/g, '/');
  if (base && !isAbsolute(normalizedInput)) {
    return collapse(`${String(base).replace(/\\/g, '/')}/${normalizedInput}`);
  }
  return collapse(normalizedInput);
}

function canonical(resolved, caseInsensitive) {
  return caseInsensitive ? resolved.toLowerCase() : resolved;
}

function isInside(parentCanonical, childCanonical) {
  return childCanonical !== parentCanonical && childCanonical.startsWith(`${parentCanonical}/`);
}

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
 * Pure checks only: spec shape, positive-integer numbers, kebab slugs, branch
 * uniqueness, and path normalization/equivalence/nesting (including against the
 * primary checkout). Filesystem/Git existence is handled separately by
 * evaluateWorktreePreparation.
 *
 * @param {Array<{ number: number|string, slug: string, path: string }>} specs
 * @param {{ primaryCheckoutPath?: string, caseInsensitive?: boolean }} [options]
 * @returns {{ ok: boolean, errors: string[], plan: Array<{ number: string, slug: string, branch: string, path: string, resolvedPath: string, canonicalPath: string }> }}
 */
export function validateWorktreeRequest(specs, options = {}) {
  const caseInsensitive = options.caseInsensitive ?? platformCaseInsensitive();
  const base = options.primaryCheckoutPath ? String(options.primaryCheckoutPath) : null;

  if (!Array.isArray(specs) || specs.length !== 2) {
    return {
      ok: false,
      errors: ['Exactly two milestone worktree specifications are required.'],
      plan: [],
    };
  }

  const errors = [];

  const plan = specs.map((spec) => {
    const number = String(spec.number ?? '').trim();
    const slug = String(spec.slug ?? '').trim();
    const path = String(spec.path ?? '').trim();
    const branch = buildMilestoneBranch(number, slug);
    const resolvedPath = path === '' ? '' : resolvePath(base, path);
    const canonicalPath = resolvedPath === '' ? '' : canonical(resolvedPath, caseInsensitive);
    return { number, slug, path, branch, resolvedPath, canonicalPath };
  });

  for (const entry of plan) {
    if (!MILESTONE_NUMBER.test(entry.number)) {
      errors.push(`Milestone number "${entry.number}" must be a positive integer.`);
    }
    if (!KEBAB_SLUG.test(entry.slug)) {
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

  const [a, b] = plan;
  if (a.canonicalPath && b.canonicalPath) {
    if (a.canonicalPath === b.canonicalPath) {
      errors.push('The two worktree paths must not be equivalent.');
    } else if (isInside(a.canonicalPath, b.canonicalPath) || isInside(b.canonicalPath, a.canonicalPath)) {
      errors.push('One worktree path must not be nested inside the other.');
    }
  }

  if (base) {
    const primaryCanonical = canonical(collapse(base), caseInsensitive);
    for (const entry of plan) {
      if (!entry.canonicalPath) {
        continue;
      }
      if (entry.canonicalPath === primaryCanonical) {
        errors.push(`Worktree path "${entry.path}" must not be the primary checkout path.`);
      } else if (isInside(primaryCanonical, entry.canonicalPath)) {
        errors.push(`Worktree path "${entry.path}" must not be inside the primary checkout.`);
      }
    }
  }

  return { ok: errors.length === 0, errors, plan };
}

/**
 * Evaluate filesystem/Git preconditions for preparation, given injected facts.
 *
 * @param {{
 *   plan: Array<{ branch: string, path: string, resolvedPath: string }>,
 *   existingLinkedWorktreeCount?: number,
 *   pathExists?: (resolvedPath: string) => boolean,
 *   isRegisteredWorktree?: (resolvedPath: string) => boolean,
 *   branchExistsLocally?: (branch: string) => boolean,
 *   branchExistsRemotely?: (branch: string) => boolean,
 * }} ctx
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function evaluateWorktreePreparation(ctx) {
  const {
    plan,
    existingLinkedWorktreeCount,
    pathExists,
    isRegisteredWorktree,
    branchExistsLocally,
    branchExistsRemotely,
  } = ctx;
  const errors = [];

  if (typeof existingLinkedWorktreeCount === 'number' && existingLinkedWorktreeCount > 0) {
    errors.push(
      `${existingLinkedWorktreeCount} linked worktree(s) already exist. At most two ` +
        'implementation worktrees may be active, so preparation must stop. The ' +
        'developer owns removing existing worktrees.',
    );
  }

  for (const entry of plan) {
    if (pathExists && pathExists(entry.resolvedPath)) {
      errors.push(`Target path "${entry.path}" already exists.`);
    }
    if (isRegisteredWorktree && isRegisteredWorktree(entry.resolvedPath)) {
      errors.push(`Target path "${entry.path}" is already a registered Git worktree.`);
    }
    if (branchExistsLocally && branchExistsLocally(entry.branch)) {
      errors.push(`Branch "${entry.branch}" already exists locally.`);
    }
    if (branchExistsRemotely && branchExistsRemotely(entry.branch)) {
      errors.push(`Branch "${entry.branch}" already exists on origin.`);
    }
  }

  return { ok: errors.length === 0, errors };
}

function shaMatches(actual, expected) {
  if (!actual || !expected) {
    return false;
  }
  const a = String(actual).toLowerCase();
  const b = String(expected).toLowerCase();
  return a === b || a.startsWith(b) || b.startsWith(a);
}

/**
 * Verify, from parsed `git worktree list --porcelain` output, that preparation
 * produced exactly the primary checkout plus the two expected worktrees, each
 * on its expected branch and at the expected base SHA.
 *
 * @param {{
 *   worktrees: Array<{ path: string, branch: string|null, head: string|null }>,
 *   plan: Array<{ branch: string, path: string, resolvedPath: string }>,
 *   baseSha: string,
 *   primaryCheckoutPath: string,
 *   caseInsensitive?: boolean,
 * }} ctx
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function verifyCreatedWorktrees(ctx) {
  const caseInsensitive = ctx.caseInsensitive ?? platformCaseInsensitive();
  const errors = [];

  if (!Array.isArray(ctx.worktrees)) {
    return { ok: false, errors: ['git worktree list output was unavailable.'] };
  }

  const canon = (p) => canonical(collapse(String(p)), caseInsensitive);
  const byPath = new Map(ctx.worktrees.map((w) => [canon(w.path), w]));

  if (ctx.worktrees.length !== 3) {
    errors.push(`Expected exactly 3 worktrees (1 primary + 2 created), found ${ctx.worktrees.length}.`);
  }

  const primaryCanonical = canon(ctx.primaryCheckoutPath);
  if (!byPath.has(primaryCanonical)) {
    errors.push('The primary checkout is not registered in git worktree list.');
  }

  for (const entry of ctx.plan) {
    const found = byPath.get(canon(entry.resolvedPath));
    if (!found) {
      errors.push(`Worktree "${entry.path}" is not a registered worktree.`);
      continue;
    }
    if (found.branch !== entry.branch) {
      errors.push(`Worktree "${entry.path}" is on "${found.branch}", expected "${entry.branch}".`);
    }
    if (!shaMatches(found.head, ctx.baseSha)) {
      errors.push(`Worktree "${entry.path}" started from "${found.head}", expected base "${ctx.baseSha}".`);
    }
  }

  return { ok: errors.length === 0, errors };
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
