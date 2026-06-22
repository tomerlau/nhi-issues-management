#!/usr/bin/env node
// Claude Code PreToolUse hook: block repository-modifying Bash commands on
// protected branches.
//
// Wired in .claude/settings.json for the Bash tool. It complements the
// Edit/Write guard: those cover file-edit tools, this covers Bash commands such
// as `npm install` that can modify tracked files. Read-only commands and the
// approved preparation commands (git fetch/pull/switch/checkout/worktree add)
// stay allowed on protected branches.
//
// Branch detection is cwd-relative so this works inside a linked worktree.
//
// Contract: exit 0 allows the tool call; exit 2 blocks it and feeds stderr back
// to Claude. The hook fails closed: if branch detection throws, the branch is
// treated as unknown and recognized modifying commands are blocked.

import { readFileSync } from 'node:fs';
import { decideBashCommand } from './bash-decision.mjs';
import { currentBranch } from './git-info.mjs';

function readCommand() {
  try {
    const raw = readFileSync(0, 'utf8');
    if (!raw) {
      return '';
    }
    const input = JSON.parse(raw);
    const command = input?.tool_input?.command;
    return typeof command === 'string' ? command : '';
  } catch {
    return '';
  }
}

function main() {
  const command = readCommand();

  let branch;
  try {
    branch = currentBranch();
  } catch {
    branch = null; // fail closed
  }

  const decision = decideBashCommand(command, branch);
  if (decision.allowed) {
    process.exit(0);
  }

  process.stderr.write(`${decision.reason}\n`);
  process.exit(2);
}

main();
