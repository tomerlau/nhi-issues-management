---
name: start-milestone
description: Prepare an updated main and a fresh milestone branch, then load repository context before any milestone implementation. Use this before editing files for a new milestone.
---

# Start milestone

Use this workflow before implementing a new milestone. It only prepares and
validates the branch and context — it does not implement anything.

For a **fix iteration inside an existing milestone**, do NOT run this skill and
do NOT create another branch. Stay on the existing `milestone/<n>-<slug>` branch.

## Inputs

- The approved milestone number and a short kebab-case slug, used to build the
  branch name `milestone/<number>-<short-kebab-case-slug>`. Derive the slug from
  the approved milestone title if it was not given explicitly.

## Choosing a mode

This skill runs in one of two modes. Decide first:

1. Inspect the current checkout:
   - `git rev-parse --abbrev-ref HEAD` (branch; `HEAD` means detached)
   - `git rev-parse --absolute-git-dir` and
     `git rev-parse --path-format=absolute --git-common-dir`
2. If the two git dirs are **equal**, this is the **primary checkout** → run
   **Normal mode**.
3. If they **differ**, this is a **linked worktree** → run **Prepared-worktree
   mode**.

`decideStartMode` in `.claude/hooks/worktree-decision.mjs` encodes this rule
(primary checkout → normal, linked worktree → prepared).

Never infer milestone scope from the branch name in either mode; scope comes
only from the approved task prompt.

## Normal mode (primary checkout)

Prepare an updated main and a fresh milestone branch, then load context. Follow
the steps below exactly as written.

## Prepared-worktree mode (linked worktree)

The worktree was already created by `prepare-parallel-worktrees` from the
correct base commit. Do **not** switch to main, pull main, or create another
branch. Instead validate and report:

1. The working tree is clean: `git status --porcelain` is empty. If not, STOP.
2. HEAD is not detached (the branch from `git branch --show-current` is a real
   branch, not empty/`HEAD`).
3. The active branch exactly equals the approved
   `milestone/<number>-<slug>` branch. If it differs, STOP and report a branch
   mismatch — do not guess scope from the branch name.
4. The active checkout is **not** the primary `main` checkout (already confirmed
   by the linked-worktree detection above).
5. The branch is registered in `git worktree list --porcelain`.

`validatePreparedWorktree` in `.claude/hooks/worktree-decision.mjs` encodes
these checks. If any fails, STOP and report; never delete, reset, clean, or
recreate anything.

Then capture and report the current base commit (`git rev-parse HEAD`), load
the normal repository context (the **Load context** section), summarize (the
**Summarize** section), and stop. Do not begin implementation.

## Steps (Normal mode)

1. Inspect state: run `git status --porcelain` and `git branch --show-current`.
2. If there are any tracked or untracked local changes, STOP and report them.
   Do not continue.
   - Never use `git stash`, `git reset`, `git clean`, checkout-based discarding,
     or file deletion to clear local changes. The developer resolves them.
3. Run `git fetch origin`.
4. Switch to main: `git switch main` (or `git checkout main`).
5. Fast-forward only: `git pull --ff-only origin main`. If this fails, STOP and
   report — do not force or rebase.
6. Verify the update: `git rev-parse main` must equal `git rev-parse origin/main`.
7. Choose the branch name `milestone/<number>-<short-kebab-case-slug>` and check
   it does not already exist:
   - `git branch --list "<name>"`
   - `git ls-remote --heads origin "<name>"`
   - If it exists locally or remotely, STOP and report. Never overwrite, reset,
     delete, or reuse it.
8. Create and switch to it: `git switch -c "<name>"` (or `git checkout -b`).
9. Confirm the new branch is active with `git branch --show-current` before any
   implementation.

## Load context

Read the current repository context (skip files that do not exist):

- `CLAUDE.md`
- `README.md`
- `docs/architecture.md`
- `docs/assumptions.md`
- root `package.json`
- the relevant application package files (`apps/api/package.json`,
  `apps/web/package.json`)
- the files and tests relevant to the approved milestone

## Summarize

Report back, then stop:

- active branch
- base commit SHA (`git rev-parse HEAD`)
- current implemented state
- approved milestone scope
- files likely to change
- any detected inconsistencies or blockers

Do not begin implementation until the new branch is confirmed active and the
summary is reported.
