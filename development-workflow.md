# Development workflow

This document is repository operational guidance. It describes the Claude Code
workflow that the committed repository configuration (`.claude/`) enforces, so
that anyone working in this repository understands the guardrails in effect.

It is **not** the canonical definition of the project, its milestones, or its
product scope. Those live in the external project sources; milestone scope comes
only from the approved task prompt for each milestone. This file documents
process and tooling, and defers to those external sources for product decisions.

## Principles

- The repository is built one milestone at a time and stays small.
- One branch and one pull request per milestone. No direct implementation on
  `main`.
- No abstractions are introduced solely for future milestones.
- Relevant tests, documentation, UX, error handling, security, and manual
  validation are part of each milestone — not deferred to a vague "later".
- Automated and manual validation are complementary: passing checks do not by
  themselves prove a milestone is correct, and manual review does not replace
  the quality gate.
- Assumptions and POC-versus-production tradeoffs are documented in
  `docs/assumptions.md` when they become relevant.
- A milestone is not complete while blockers, required improvements, failing
  checks, missing documentation, or missing manual validation remain.
- Everything written in the repository is in English.

## Roles

### Planning and review

- Proposes and reviews milestone plans, working from the external canonical
  project sources rather than copying them into this repository.
- Inspects the actual GitHub state rather than assuming it.
- Provides the approved Claude Code prompt for each milestone.
- Reviews the implementation: scope, tests, security, isolation, documentation,
  and manual validation, and classifies findings as blockers, required
  improvements, or optional improvements.
- Does not mark a requirement complete without evidence.

### Claude Code (implementation)

- Starts from current `main` using the **start-milestone** skill (normal mode),
  or validates an already-prepared linked worktree (prepared-worktree mode).
- Creates a `milestone/<number>-<slug>` branch before changing any files, or
  works inside the worktree's existing milestone branch.
- Implements only the approved scope, and never infers scope from a branch name.
- Stays on the same milestone branch for fix iterations instead of branching
  again.
- Runs focused checks during development.
- Runs the full quality gate (`npm run check`) before finishing, via the
  **finish-work** skill.
- Leaves all work uncommitted.
- Reports results and remaining manual validation honestly, and never weakens or
  skips a check to make it pass.

### Developer (ownership)

- Approves the milestone plan and runs the Claude Code prompt.
- Reviews the generated changes and performs the required manual validation.
- Owns all Git history and coordination: commits, pushes, branches, pull
  requests, merges, rebases, branch synchronization after a parallel pull
  request merges, and worktree removal/cleanup.
- Merges only after the completion criteria are met.

## How a single milestone runs

1. **Plan.** The milestone scope, acceptance criteria, and non-goals are agreed
   and an approved Claude Code prompt is produced.
2. **Start.** Claude runs the start-milestone skill: it requires a clean working
   tree, fast-forwards `main` from `origin/main`, creates the milestone branch,
   loads repository context, and summarizes the plan and likely changes.
3. **Implement.** Claude implements only the approved scope on the milestone
   branch, running focused checks as it goes.
4. **Fix iterations.** Follow-up fixes stay on the same milestone branch — no new
   branch is created for corrections within the milestone.
5. **Finish.** Claude runs the finish-work skill: it confirms the branch is not
   protected, inspects the diff, runs `git diff --check` and `npm run check`,
   reviews the work against the approved task, and reports honestly. All changes
   stay uncommitted.
6. **Review and own.** The implementation is reviewed; the developer performs
   manual validation, then commits, pushes, and opens the pull request.

## Parallel work with two worktrees

Two milestones can be implemented in parallel using Git worktrees:

1. **Prepare (primary checkout).** From the primary checkout on a clean,
   up-to-date `main`, Claude runs the **prepare-parallel-worktrees** skill. It
   verifies the primary checkout (its Git directory equals the common Git
   directory), fast-forwards `main`, captures one exact base SHA, and creates two
   linked worktrees — `git worktree add -b milestone/<n>-<slug> <path> <sha>` —
   both from that same SHA. It refuses to run if a linked worktree already
   exists, and after creation verifies exactly one primary checkout plus the two
   new worktrees.
2. **One session per worktree.** A separate Claude Code session is started inside
   each worktree directory and runs **start-milestone** in prepared-worktree
   mode, which validates the worktree (clean, non-detached, on the approved
   milestone branch, registered, not the primary checkout) without touching
   `main`.
3. **Independent milestones.** Each worktree has its own branch, tests,
   documentation, review, and completion decision. Parallel work never bypasses
   milestone dependencies or scope.
4. **Boundaries.** A session operates only inside its own worktree. It never
   edits, installs into, removes, cleans, resets, or otherwise modifies another
   worktree, and never creates additional worktrees. At most two implementation
   worktrees may be active at once. The primary checkout stays clean on `main`
   as the coordination checkout. The developer owns worktree removal and any
   branch synchronization after one parallel pull request merges.

## Enforced guardrails

The committed Claude Code configuration enforces the rules that can be automated:

- `.claude/hooks/guard-branch.mjs` (a `PreToolUse` hook) blocks file edits on
  `main`, `master`, a detached HEAD, or when the branch cannot be determined. It
  fails closed and uses the current worktree's branch.
- `.claude/hooks/guard-bash.mjs` (a `PreToolUse` hook) gates Bash commands. It
  resolves the repository context (active branch, whether the current checkout is
  the primary checkout or a linked worktree, the primary checkout path, and the
  current `HEAD` SHA) and injects it into the pure decision logic, which then
  fails closed per state. On the primary checkout on `main` it allows safe Git
  inspection, the exact main-update and milestone-branch-creation preparation
  commands, and a single fully validated `git worktree add`. On `master`, a
  linked worktree whose branch is protected/detached/unknown, a detached HEAD, or
  an unknown/unreadable Git state it allows only safe inspection (plus the exact
  `git switch main`/`git checkout main` recovery when the state is readable);
  `npm`, arbitrary `node`, output redirection, pipelines, command substitution,
  and output-to-file Git flags are blocked. `git worktree add` is governed by the
  same strict validator in every state: it is accepted only from the primary
  checkout on `main`, only when the base commit equals the current full `HEAD`
  SHA, and only when the target is an absolute path outside the primary checkout
  (never the primary checkout, a path nested inside it, or its `.git` directory),
  so a milestone or linked-worktree session can never create a worktree and
  cannot make `main` dirty. It also blocks malformed hook input. On a normal
  milestone branch it does not restrict ordinary development commands.
- `.claude/hooks/run-quality-gates.mjs` (a `Stop` hook) runs `git diff --check`
  and `npm run check` when relevant local changes exist, and blocks Claude from
  finishing while a required check fails.
- `.claude/settings.json` denies Git and GitHub commands that would stage,
  commit, push, merge, rebase, cherry-pick, revert, tag, force-update history,
  delete branches, or create/modify/merge/close pull requests and releases, and
  denies destructive worktree commands (`remove`, `prune`, `repair`, `move`,
  `lock`, `unlock`). Read-only Git inspection and the narrow branch- and
  worktree-preparation commands remain allowed.

The branch, Bash, and worktree decision logic is unit-tested under
`.claude/hooks/*.test.mjs` and runs as part of `npm run check`.

## Canonical commands

- `npm run dev` — run both applications.
- `npm run check` — the canonical local quality gate: lint, typecheck, all tests
  (including the workflow hook tests), then build, fail-fast in that order.
