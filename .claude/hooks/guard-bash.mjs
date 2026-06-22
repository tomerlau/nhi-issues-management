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
import { currentBranch } from './git-info.mjs';

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

function main() {
  const command = readCommand();

  let branch;
  try {
    branch = currentBranch();
  } catch {
    branch = null; // fail closed: treated as an unknown branch
  }

  const decision = decideBashCommand(command, branch);
  if (decision.allowed) {
    process.exit(0);
  }

  block(decision.reason);
}

main();
