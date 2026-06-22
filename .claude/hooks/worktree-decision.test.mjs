import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildMilestoneBranch,
  validateWorktreeRequest,
  evaluateWorktreePreparation,
  verifyCreatedWorktrees,
  decideStartMode,
  validatePreparedWorktree,
} from './worktree-decision.mjs';

test('buildMilestoneBranch composes the expected name', () => {
  assert.equal(buildMilestoneBranch(4, 'agent-runtime'), 'milestone/4-agent-runtime');
});

test('a valid two-worktree request passes and builds branches', () => {
  const result = validateWorktreeRequest([
    { number: 4, slug: 'agent-runtime', path: '/repo/wt-m4' },
    { number: 5, slug: 'reporting', path: '/repo/wt-m5' },
  ]);
  assert.equal(result.ok, true);
  assert.deepEqual(
    result.plan.map((p) => p.branch),
    ['milestone/4-agent-runtime', 'milestone/5-reporting'],
  );
});

test('exactly two specifications are required', () => {
  assert.equal(validateWorktreeRequest([{ number: 4, slug: 'a', path: '/x' }]).ok, false);
  assert.equal(
    validateWorktreeRequest([
      { number: 4, slug: 'a', path: '/x' },
      { number: 5, slug: 'b', path: '/y' },
      { number: 6, slug: 'c', path: '/z' },
    ]).ok,
    false,
  );
});

test('positive integer milestone numbers are accepted', () => {
  assert.equal(
    validateWorktreeRequest([
      { number: 4, slug: 'a', path: '/x' },
      { number: 12, slug: 'b', path: '/y' },
    ]).ok,
    true,
  );
});

test('zero, negative, non-numeric and fractional milestone numbers are rejected', () => {
  for (const bad of [0, -1, '4.5', '4a', 'abc', '']) {
    const result = validateWorktreeRequest([
      { number: bad, slug: 'a', path: '/x' },
      { number: 99, slug: 'b', path: '/y' },
    ]);
    assert.equal(result.ok, false, `expected rejection for number=${JSON.stringify(bad)}`);
  }
});

test('duplicate milestone numbers and duplicate branches are rejected', () => {
  assert.equal(
    validateWorktreeRequest([
      { number: 4, slug: 'a', path: '/x' },
      { number: 4, slug: 'b', path: '/y' },
    ]).ok,
    false,
  );
  assert.equal(
    validateWorktreeRequest([
      { number: 4, slug: 'same', path: '/x' },
      { number: 4, slug: 'same', path: '/y' },
    ]).ok,
    false,
  );
});

test('non-kebab slugs are rejected', () => {
  assert.equal(
    validateWorktreeRequest([
      { number: 4, slug: 'Bad_Slug', path: '/x' },
      { number: 5, slug: 'ok', path: '/y' },
    ]).ok,
    false,
  );
});

test('equivalent normalized paths are rejected', () => {
  const result = validateWorktreeRequest([
    { number: 4, slug: 'a', path: '../x' },
    { number: 5, slug: 'b', path: '../a/../x' },
  ]);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /equivalent/.test(e)));
});

test('the primary-checkout path is rejected as a target', () => {
  const result = validateWorktreeRequest(
    [
      { number: 4, slug: 'a', path: '/repo/primary' },
      { number: 5, slug: 'b', path: '/repo/wt-b' },
    ],
    { primaryCheckoutPath: '/repo/primary', caseInsensitive: false },
  );
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /primary checkout path/.test(e)));
});

test('a target nested inside the primary checkout is rejected', () => {
  const result = validateWorktreeRequest(
    [
      { number: 4, slug: 'a', path: '/repo/primary/inside' },
      { number: 5, slug: 'b', path: '/repo/wt-b' },
    ],
    { primaryCheckoutPath: '/repo/primary', caseInsensitive: false },
  );
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /inside the primary checkout/.test(e)));
});

test('one target nested inside the other is rejected', () => {
  const result = validateWorktreeRequest([
    { number: 4, slug: 'a', path: '/repo/wt' },
    { number: 5, slug: 'b', path: '/repo/wt/inner' },
  ]);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /nested inside the other/.test(e)));
});

test('Windows case-equivalent paths are handled per case sensitivity', () => {
  const specs = [
    { number: 4, slug: 'a', path: '/Repo/WT-A' },
    { number: 5, slug: 'b', path: '/repo/wt-a' },
  ];
  assert.equal(validateWorktreeRequest(specs, { caseInsensitive: true }).ok, false);
  assert.equal(validateWorktreeRequest(specs, { caseInsensitive: false }).ok, true);
});

function validPlan() {
  return validateWorktreeRequest(
    [
      { number: 4, slug: 'a', path: '/repo/wt-a' },
      { number: 5, slug: 'b', path: '/repo/wt-b' },
    ],
    { primaryCheckoutPath: '/repo/primary', caseInsensitive: false },
  ).plan;
}

test('preparation passes when no facts conflict', () => {
  const result = evaluateWorktreePreparation({
    plan: validPlan(),
    existingLinkedWorktreeCount: 0,
    pathExists: () => false,
    isRegisteredWorktree: () => false,
    branchExistsLocally: () => false,
    branchExistsRemotely: () => false,
  });
  assert.equal(result.ok, true);
});

test('an existing linked worktree blocks preparation', () => {
  const result = evaluateWorktreePreparation({
    plan: validPlan(),
    existingLinkedWorktreeCount: 1,
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /already exist/.test(e)));
});

test('existing paths, registrations, and branches block preparation', () => {
  assert.equal(
    evaluateWorktreePreparation({ plan: validPlan(), pathExists: (p) => p.endsWith('wt-a') }).ok,
    false,
  );
  assert.equal(
    evaluateWorktreePreparation({ plan: validPlan(), isRegisteredWorktree: () => true }).ok,
    false,
  );
  assert.equal(
    evaluateWorktreePreparation({ plan: validPlan(), branchExistsLocally: (b) => b === 'milestone/4-a' }).ok,
    false,
  );
  assert.equal(
    evaluateWorktreePreparation({ plan: validPlan(), branchExistsRemotely: () => true }).ok,
    false,
  );
});

test('verifyCreatedWorktrees accepts exactly two worktrees from the same base SHA', () => {
  const plan = validPlan();
  const result = verifyCreatedWorktrees({
    worktrees: [
      { path: '/repo/primary', branch: 'main', head: 'BASESHA' },
      { path: '/repo/wt-a', branch: 'milestone/4-a', head: 'BASESHA' },
      { path: '/repo/wt-b', branch: 'milestone/5-b', head: 'BASESHA' },
    ],
    plan,
    baseSha: 'BASESHA',
    primaryCheckoutPath: '/repo/primary',
    caseInsensitive: false,
  });
  assert.equal(result.ok, true);
});

test('verifyCreatedWorktrees rejects wrong count, branch, or base SHA', () => {
  const plan = validPlan();
  const base = (worktrees) =>
    verifyCreatedWorktrees({
      worktrees,
      plan,
      baseSha: 'BASESHA',
      primaryCheckoutPath: '/repo/primary',
      caseInsensitive: false,
    });

  assert.equal(
    base([
      { path: '/repo/primary', branch: 'main', head: 'BASESHA' },
      { path: '/repo/wt-a', branch: 'milestone/4-a', head: 'BASESHA' },
    ]).ok,
    false,
  );
  assert.equal(
    base([
      { path: '/repo/primary', branch: 'main', head: 'BASESHA' },
      { path: '/repo/wt-a', branch: 'milestone/9-wrong', head: 'BASESHA' },
      { path: '/repo/wt-b', branch: 'milestone/5-b', head: 'BASESHA' },
    ]).ok,
    false,
  );
  assert.equal(
    base([
      { path: '/repo/primary', branch: 'main', head: 'BASESHA' },
      { path: '/repo/wt-a', branch: 'milestone/4-a', head: 'OTHERSHA' },
      { path: '/repo/wt-b', branch: 'milestone/5-b', head: 'BASESHA' },
    ]).ok,
    false,
  );
});

test('decideStartMode routes by checkout type', () => {
  assert.equal(decideStartMode({ isPrimaryCheckout: true }), 'normal');
  assert.equal(decideStartMode({ isPrimaryCheckout: false }), 'prepared');
});

test('prepared-worktree mode accepts the expected branch', () => {
  const d = validatePreparedWorktree({
    activeBranch: 'milestone/4-agent-runtime',
    expectedBranch: 'milestone/4-agent-runtime',
    isPrimaryCheckout: false,
    isWorktreeRegistered: true,
    isClean: true,
  });
  assert.equal(d.ok, true);
  assert.equal(d.code, 'prepared');
});

test('prepared-worktree mode rejects an unexpected branch', () => {
  const d = validatePreparedWorktree({
    activeBranch: 'milestone/9-other',
    expectedBranch: 'milestone/4-agent-runtime',
    isPrimaryCheckout: false,
    isWorktreeRegistered: true,
    isClean: true,
  });
  assert.equal(d.ok, false);
  assert.equal(d.code, 'branch-mismatch');
});

test('prepared-worktree mode rejects the primary main checkout', () => {
  const d = validatePreparedWorktree({
    activeBranch: 'main',
    expectedBranch: 'milestone/4-agent-runtime',
    isPrimaryCheckout: true,
    isWorktreeRegistered: true,
    isClean: true,
  });
  assert.equal(d.ok, false);
  assert.equal(d.code, 'primary-checkout');
});

test('prepared-worktree mode rejects a dirty worktree', () => {
  const d = validatePreparedWorktree({
    activeBranch: 'milestone/4-agent-runtime',
    expectedBranch: 'milestone/4-agent-runtime',
    isPrimaryCheckout: false,
    isWorktreeRegistered: true,
    isClean: false,
  });
  assert.equal(d.ok, false);
  assert.equal(d.code, 'dirty');
});

test('prepared-worktree mode rejects a detached HEAD', () => {
  const d = validatePreparedWorktree({
    activeBranch: '',
    expectedBranch: 'milestone/4-agent-runtime',
    isPrimaryCheckout: false,
    isWorktreeRegistered: true,
    isClean: true,
  });
  assert.equal(d.ok, false);
  assert.equal(d.code, 'detached');
});

test('prepared-worktree mode rejects an unregistered worktree branch', () => {
  const d = validatePreparedWorktree({
    activeBranch: 'milestone/4-agent-runtime',
    expectedBranch: 'milestone/4-agent-runtime',
    isPrimaryCheckout: false,
    isWorktreeRegistered: false,
    isClean: true,
  });
  assert.equal(d.ok, false);
  assert.equal(d.code, 'not-registered');
});
