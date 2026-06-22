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

On a protected branch the Bash guard allows only safe Git inspection and the
exact preparation commands listed below; any other shell command is blocked.
Use Claude's own file tools (Read/Glob), not Bash, for filesystem inspection.

The Bash guard independently enforces the safety of `git worktree add`: it is
accepted only from the **primary checkout** while it is on **main**, only when
the supplied base commit exactly equals the current full `HEAD` SHA, and only
when the target is an **absolute path outside the primary checkout** (not the
primary checkout itself, not nested inside it, and not its `.git` directory). A
relative path, an abbreviated or stale SHA, or a path inside the primary
checkout is blocked before Git runs. Resolve and pass absolute paths to satisfy
this guard; do not rely on it as your only check.

## Inputs

Exactly **two** approved milestone specifications, each with:

- milestone number (a positive integer)
- short kebab-case slug
- target worktree path (outside the primary checkout's working tree)

Before validating, resolve each target path to a **normalized absolute path**
(collapse any `.`/`..` segments). Use those exact absolute paths everywhere
below — in validation, in the final report, and in the `git worktree add`
commands. Never pass a relative path to `git worktree add`; the Bash guard
rejects relative paths, paths equal to or inside the primary checkout, and the
primary checkout's `.git` directory.

The branch name for each is built as `milestone/<number>-<slug>`.

`validateWorktreeRequest` in `.claude/hooks/worktree-decision.mjs` is the source
of truth for request validation. STOP and report before doing anything if it
rejects the request, including when:

- fewer or more than two specifications are given,
- a milestone number is not a positive integer,
- a slug is not short kebab-case,
- two specifications share the same milestone number or branch name,
- the two paths resolve to equivalent normalized absolute paths (e.g. `../x`
  and `../a/../x`, or case-equivalent paths on Windows),
- one path is nested inside the other, or
- a path equals or is nested inside the primary checkout directory.

## Steps

1. **Confirm this is the primary checkout** — not merely a checkout named
   `main`. Compare the Git directories:
   - `git rev-parse --absolute-git-dir`
   - `git rev-parse --path-format=absolute --git-common-dir`
   - They must be **equal** (primary checkout). If they differ, this is a linked
     worktree → STOP. If either cannot be determined, STOP.
2. Confirm the primary checkout is clean and on `main`:
   - `git status --porcelain` must be empty. If not, STOP and report. Never
     stash, reset, clean, or discard changes.
   - `git branch --show-current` must be `main`. If not, STOP and report.
3. **Enforce the two-worktree limit.** Inspect `git worktree list --porcelain`.
   It must contain only the primary checkout — no linked implementation
   worktree may already exist. If a linked worktree is already registered, STOP
   and report; the developer owns removing it. Never remove, prune, repair, or
   reuse an existing worktree.
4. Update main:
   - `git fetch origin`
   - `git pull --ff-only origin main` (if this fails, STOP — do not force or
     rebase)
5. Verify the update: `git rev-parse main` must equal `git rev-parse origin/main`.
6. Capture the exact **full** base commit SHA once and reuse it for both
   worktrees. Run `git rev-parse HEAD`, read the printed full SHA, and substitute
   that literal value into the `git worktree add` commands below. Do not use
   shell command substitution (`$(...)`) or shell variables — each Bash call is a
   fresh shell, and the Bash guard blocks command substitution on a protected
   branch. Do not abbreviate the SHA: the guard requires the base commit to equal
   the current full `HEAD` SHA exactly.
7. For each of the two branches, confirm it does not already exist:
   - `git branch --list "<branch>"` (local)
   - `git ls-remote --heads origin "<branch>"` (remote)
   - If either exists, STOP and report. Never overwrite, reset, delete, or reuse.
8. For each target path, confirm it does not already exist on disk (use the
   Read/Glob tools, not Bash). If a path exists, STOP and report.
   - `evaluateWorktreePreparation` in `.claude/hooks/worktree-decision.mjs`
     captures the combined path/branch/worktree-limit preconditions.
9. Create the worktrees **sequentially** (never concurrently), both from the
   captured full `BASE_SHA`, using exactly this form with the **normalized
   absolute paths** resolved earlier:
   - `git worktree add -b "<branch-1>" "<absolute-path-1>" "<BASE_SHA>"`
   - then `git worktree add -b "<branch-2>" "<absolute-path-2>" "<BASE_SHA>"`
   - Each path must be absolute and outside the primary checkout. Never pass a
     relative path. Do not add other flags, omit `-b`, or perform more than one
     operation in a single command; the Bash guard rejects those variants, a
     relative path, an inside-primary path, or a SHA that is not the current full
     `HEAD`.
10. If the first worktree succeeds and the second fails, STOP and report the
    partial state. Do **not** delete the branch, remove the worktree, reset,
    clean, stash, or roll back. The developer owns cleanup.

## Verify after creation

Read `git worktree list --porcelain` once and verify from its parsed output
(do not use `git -C`, which is not a permitted command):

- there are exactly three worktrees — the primary checkout plus the two new
  linked worktrees,
- each created worktree is on its expected `milestone/<number>-<slug>` branch,
- each created worktree's `HEAD` equals `BASE_SHA`,
- the primary checkout is still present, on `main`, and clean.

`verifyCreatedWorktrees` in `.claude/hooks/worktree-decision.mjs` encodes these
checks against the parsed `git worktree list --porcelain` output.

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
