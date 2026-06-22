#!/usr/bin/env node
// Claude Code PreToolUse hook: gate Bash commands on protected branches.
//
// Wired in .claude/settings.json for the Bash tool. It complements the
// Edit/Write guard: those cover file-edit tools, this covers Bash commands that
// can modify tracked files or write output. On a protected/detached/unknown
// branch only an explicit allowlist of safe-inspection and exact approved
// preparation commands is permitted (see bash-decision.mjs); everything else is
// blocked. Branch detection is cwd-relative so this works inside a linked
// worktree.
//
// The hook also fails closed on malformed hook input: empty stdin, invalid
// JSON, or a missing/non-string command blocks the call rather than being
// treated as an empty (read-only) command.
//
// Contract: exit 0 allows the tool call; exit 2 blocks it and feeds stderr back
// to Claude.

import { readFileSync } from 'node:fs';
import { decideBashCommand } from './bash-decision.mjs';
import {
  currentBranch,
  isLinkedWorktree,
  primaryWorktreePath,
  gitCommonDir,
  headSha,
} from './git-info.mjs';

function block(reason) {
  process.stderr.write(`${reason}\n`);
  process.exit(2);
}

// Parse the hook payload and return the command string, or block on any
// malformation. Never echoes raw stdin back (it could contain sensitive data).
function readCommand() {
  let raw;
  try {
    raw = readFileSync(0, 'utf8');
  } catch {
    block('Malformed Bash hook input: stdin could not be read.');
  }

  if (typeof raw !== 'string' || raw.trim() === '') {
    block('Malformed Bash hook input: empty stdin.');
  }

  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    block('Malformed Bash hook input: stdin was not valid JSON.');
  }

  if (input === null || typeof input !== 'object') {
    block('Malformed Bash hook input: payload was not a JSON object.');
  }

  const toolInput = input.tool_input;
  if (toolInput === null || typeof toolInput !== 'object') {
    block('Malformed Bash hook input: tool_input is missing.');
  }

  const command = toolInput.command;
  if (typeof command !== 'string' || command.trim() === '') {
    block('Malformed Bash hook input: tool_input.command is missing or not a non-empty string.');
  }

  return command;
}

// Resolve the repository context for the current working directory. Git
// inspection is cwd-relative so linked worktrees report their own state. Any
// helper that cannot read git returns null, which makes the decision logic fail
// closed for state-dependent allowances.
function gatherContext() {
  const safe = (fn) => {
    try {
      return fn();
    } catch {
      return null;
    }
  };

  const linked = safe(isLinkedWorktree); // true | false | null
  return {
    branch: safe(currentBranch),
    isPrimaryCheckout: linked === null ? null : !linked,
    primaryCheckoutPath: safe(primaryWorktreePath),
    primaryGitDir: safe(gitCommonDir),
    headSha: safe(headSha),
  };
}

function main() {
  const command = readCommand();
  const context = gatherContext();

  const decision = decideBashCommand(command, context);
  if (decision.allowed) {
    process.exit(0);
  }

  block(decision.reason);
}

main();
