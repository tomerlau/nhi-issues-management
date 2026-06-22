import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildMilestoneBranch,
  validateWorktreeRequest,
  decideStartMode,
  validatePreparedWorktree,
} from './worktree-decision.mjs';

test('buildMilestoneBranch composes the expected name', () => {
  assert.equal(buildMilestoneBranch(4, 'agent-runtime'), 'milestone/4-agent-runtime');
});

test('a valid two-worktree request passes and builds branches', () => {
  const result = validateWorktreeRequest([
    { number: 4, slug: 'agent-runtime', path: '../wt-m4' },
    { number: 5, slug: 'reporting', path: '../wt-m5' },
  ]);
  assert.equal(result.ok, true);
  assert.deepEqual(
    result.plan.map((p) => p.branch),
    ['milestone/4-agent-runtime', 'milestone/5-reporting'],
  );
});

test('exactly two specifications are required', () => {
  assert.equal(validateWorktreeRequest([{ number: 4, slug: 'a', path: 'x' }]).ok, false);
  assert.equal(
    validateWorktreeRequest([
      { number: 4, slug: 'a', path: 'x' },
      { number: 5, slug: 'b', path: 'y' },
      { number: 6, slug: 'c', path: 'z' },
    ]).ok,
    false,
  );
});

test('duplicate milestone numbers are rejected', () => {
  const result = validateWorktreeRequest([
    { number: 4, slug: 'a', path: '../x' },
    { number: 4, slug: 'b', path: '../y' },
  ]);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /Duplicate milestone numbers/.test(e)));
});

test('duplicate branch names are rejected', () => {
  const result = validateWorktreeRequest([
    { number: 4, slug: 'same', path: '../x' },
    { number: 4, slug: 'same', path: '../y' },
  ]);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /Duplicate (milestone numbers|branch names)/.test(e)));
});

test('identical worktree paths are rejected', () => {
  const result = validateWorktreeRequest([
    { number: 4, slug: 'a', path: '../same' },
    { number: 5, slug: 'b', path: '../same' },
  ]);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /paths must be different/.test(e)));
});

test('non-kebab slugs are rejected', () => {
  assert.equal(
    validateWorktreeRequest([
      { number: 4, slug: 'Bad_Slug', path: '../x' },
      { number: 5, slug: 'ok', path: '../y' },
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
