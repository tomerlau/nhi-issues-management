---
name: prepare-parallel-worktrees
description: Create two isolated milestone worktrees from the same updated main commit so two Claude sessions can work in parallel. Preparation only — never implements milestone functionality.
---

# Prepare parallel worktrees

Use this from the **primary checkout** to set up two isolated milestone
worktrees from the exact same updated `main` commit. After it finishes, a
separate Claude Code session is started inside each worktree and runs the
`start-milestone` skill there (prepared-worktree mode).

This skill only prepares worktrees. It never implements milestone
functionality, never installs dependencies, and never decides milestone scope.

## Inputs

Exactly **two** approved milestone specifications, each with:

- milestone number
- short kebab-case slug
- target worktree path (outside the primary checkout's working tree)

The branch name for each is built as `milestone/<number>-<slug>`.

Reject the request before doing anything if:

- fewer or more than two specifications are given,
- two specifications share the same milestone number,
- two specifications produce the same branch name,
- two paths are identical, or
- any slug is not short kebab-case.

`validateWorktreeRequest` in `.claude/hooks/worktree-decision.mjs` is the source
of truth for this validation.

## Steps

1. Confirm this is the primary checkout and the working tree is clean:
   - `git status --porcelain` must be empty. If not, STOP and report. Never
     stash, reset, clean, or discard changes.
   - `git branch --show-current` must be `main`. If not, STOP and report.
2. Update main:
   - `git fetch origin`
   - `git pull --ff-only origin main` (if this fails, STOP — do not force or
     rebase)
3. Verify the update: `git rev-parse main` must equal `git rev-parse origin/main`.
4. Capture the exact base commit SHA once and reuse it for both worktrees:
   - `BASE_SHA="$(git rev-parse HEAD)"`
5. For each of the two branches, confirm it does not already exist:
   - `git branch --list "<branch>"` (local)
   - `git ls-remote --heads origin "<branch>"` (remote)
   - If either exists, STOP and report. Never overwrite, reset, delete, or reuse.
6. For each target path, confirm it does not already exist on disk. If a path
   exists, STOP and report.
7. Create the worktrees **sequentially** (never concurrently), both from the
   captured `BASE_SHA`:
   - `git worktree add -b "<branch-1>" "<path-1>" "<BASE_SHA>"`
   - then `git worktree add -b "<branch-2>" "<path-2>" "<BASE_SHA>"`
8. If the first worktree succeeds and the second fails, STOP and report the
   partial state. Do **not** delete the branch, remove the worktree, reset,
   clean, stash, or roll back. The developer owns cleanup.

## Verify after creation

For each created worktree:

- it appears in `git worktree list --porcelain` (registered worktree),
- it is on its expected `milestone/<number>-<slug>` branch,
- it started from exactly `BASE_SHA`
  (`git -C "<path>" rev-parse HEAD` equals `BASE_SHA`).

Also confirm the primary checkout is unchanged: still on `main`, still clean,
still at `BASE_SHA`.

## Final report

Print, then stop:

- the base SHA,
- the primary checkout path and branch,
- each worktree path,
- each milestone branch,
- the exact directory each Claude session must be started from (one per
  worktree),
- any partial failure or manual action the developer must take.

Stop here. Do **not** run `npm ci`/`npm install` and do **not** begin
implementation. Each milestone session installs dependencies and implements its
own scope after running `start-milestone` inside its worktree.
