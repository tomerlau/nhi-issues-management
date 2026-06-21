import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideBranchEdit, isProtectedBranch } from './branch-decision.mjs';

test('a normal feature branch is allowed', () => {
  const decision = decideBranchEdit('milestone/2-persistence');
  assert.equal(decision.allowed, true);
  assert.equal(decision.code, 'ok');
});

test('an arbitrary feature branch is allowed', () => {
  const decision = decideBranchEdit('chore/claude-code-workflow');
  assert.equal(decision.allowed, true);
});

test('surrounding whitespace is trimmed before deciding', () => {
  const decision = decideBranchEdit('  feature/x\n');
  assert.equal(decision.allowed, true);
});

test('main is rejected as protected', () => {
  const decision = decideBranchEdit('main');
  assert.equal(decision.allowed, false);
  assert.equal(decision.code, 'protected');
});

test('master is rejected as protected', () => {
  const decision = decideBranchEdit('master');
  assert.equal(decision.allowed, false);
  assert.equal(decision.code, 'protected');
});

test('detached HEAD (literal "HEAD") is rejected', () => {
  const decision = decideBranchEdit('HEAD');
  assert.equal(decision.allowed, false);
  assert.equal(decision.code, 'detached');
});

test('detached HEAD (empty string) is rejected', () => {
  const decision = decideBranchEdit('');
  assert.equal(decision.allowed, false);
  assert.equal(decision.code, 'detached');
});

test('null branch (detection failure) is rejected as unknown', () => {
  const decision = decideBranchEdit(null);
  assert.equal(decision.allowed, false);
  assert.equal(decision.code, 'unknown');
});

test('undefined branch (detection failure) is rejected as unknown', () => {
  const decision = decideBranchEdit(undefined);
  assert.equal(decision.allowed, false);
  assert.equal(decision.code, 'unknown');
});

test('isProtectedBranch only flags named protected branches', () => {
  assert.equal(isProtectedBranch('main'), true);
  assert.equal(isProtectedBranch('master'), true);
  assert.equal(isProtectedBranch('feature/x'), false);
  // Detached/unknown are blocked for editing but are not "protected branches".
  assert.equal(isProtectedBranch('HEAD'), false);
  assert.equal(isProtectedBranch(null), false);
});
