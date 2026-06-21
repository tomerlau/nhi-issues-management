#!/usr/bin/env node
// Claude Code PreToolUse hook: block file modifications on protected branches.
//
// Wired in .claude/settings.json for Edit/Write/NotebookEdit/MultiEdit. It does
// not read the tool input — any file modification is blocked when the current
// branch is main/master, HEAD is detached, or the branch cannot be determined.
//
// Contract: exit 0 allows the tool call; exit 2 blocks it and feeds stderr back
// to Claude. The hook fails closed: if branch detection throws, it blocks.

import { spawnSync } from 'node:child_process';
import { decideBranchEdit } from './branch-decision.mjs';

function currentBranch() {
  const result = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    encoding: 'utf8',
  });
  if (result.status !== 0 || typeof result.stdout !== 'string') {
    return null;
  }
  return result.stdout.trim();
}

function main() {
  let branch;
  try {
    branch = currentBranch();
  } catch {
    branch = null; // fail closed
  }

  const decision = decideBranchEdit(branch);
  if (decision.allowed) {
    process.exit(0);
  }

  process.stderr.write(`${decision.reason}\n`);
  process.exit(2);
}

main();
