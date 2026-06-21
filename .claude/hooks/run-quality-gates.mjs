#!/usr/bin/env node
// Claude Code Stop hook: run the repository quality gate before Claude finishes.
//
// Wired in .claude/settings.json as a Stop hook. Behavior:
//   - If a previous Stop hook is already active, exit immediately (no recursion).
//   - If there are no relevant local changes, exit successfully without running
//     anything.
//   - Otherwise run `git diff --check` then `npm run check` from the repo root.
//   - On any failure, block Claude from stopping and report the failure.
//
// It never edits files, stages, or commits, and never weakens a check.
//
// Contract: print {"decision":"block","reason":...} to stdout to block stopping;
// exit 0 with no output to allow it.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { decideBranchEdit } from './branch-decision.mjs';

function readHookInput() {
  try {
    const raw = readFileSync(0, 'utf8');
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function allowStop() {
  process.exit(0);
}

function blockStop(reason) {
  process.stdout.write(JSON.stringify({ decision: 'block', reason }) + '\n');
  process.exit(0);
}

function currentBranch() {
  const result = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    encoding: 'utf8',
  });
  if (result.status !== 0 || typeof result.stdout !== 'string') {
    return null;
  }
  return result.stdout.trim();
}

function hasRelevantChanges() {
  // --porcelain already excludes .gitignore'd files (e.g. settings.local.json).
  const result = spawnSync('git', ['status', '--porcelain'], { encoding: 'utf8' });
  if (result.status !== 0 || typeof result.stdout !== 'string') {
    return false;
  }
  return result.stdout.trim().length > 0;
}

function run(command, args) {
  // On Windows, npm resolves to npm.cmd, and recent Node refuses to spawn
  // .cmd/.bat files without a shell. Use the platform shell there.
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  return result.status === 0;
}

function main() {
  const input = readHookInput();
  if (input.stop_hook_active) {
    allowStop();
  }

  if (!hasRelevantChanges()) {
    allowStop();
  }

  const branch = currentBranch();
  const decision = decideBranchEdit(branch);
  if (!decision.allowed) {
    // Changes exist on a protected/unknown branch: the branch guard should have
    // prevented this. Do not run gates here; surface the anomaly instead.
    blockStop(
      'Local changes exist but the working tree is on a protected, detached, ' +
        'or unknown branch. Move the work onto a milestone branch via the ' +
        'start-milestone skill, then finish with the finish-work skill.',
    );
  }

  if (!run('git', ['diff', '--check'])) {
    blockStop(
      'git diff --check failed (whitespace errors or conflict markers). ' +
        'Fix the reported lines, then run the finish-work skill again.',
    );
  }

  if (!run('npm', ['run', 'check'])) {
    blockStop(
      'npm run check failed. Quality gates (lint, typecheck, tests, build) must ' +
        'pass before finishing. Read the output above, fix the failures, and ' +
        'run the finish-work skill again. Do not weaken or skip any check.',
    );
  }

  allowStop();
}

main();
