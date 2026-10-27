# Issue 3520: deterministic shared-memory retention test

Date: 2026-10-26. Status: In progress. Owner: Codex.
Branch: `codex/3520-deterministic-retention-test`.
Base: `origin/testnet-canary` at `bd6ca610999f48486a407528ee48fbb7b37b681a`,
selected from `.github/CONTRIBUTING.md` and the affected CI branch.
Risk: low; test-only change, with no package or deployment changes.

The retention test at `scripts/lib/__tests__/one-graph-reports.test.mjs:333`
depends on real sleeps and clock-based stub responses. CI run 40387784341
records an in-window miss where the test expects only a final confirmation
miss. `watch.close()` includes completions in the current millisecond by
setting the bound to elapsed time plus one millisecond. Changing the stub to
missing before that deadline can therefore produce a valid in-window miss.
The transient-loss cases can also miss their intended intervals under load.

Use Node 22's test-scoped mock Date and setTimeout APIs for these four
retention scenarios. Advance the clock in small steps and drain asynchronous
reads between steps. Close while present, cross the actual bound, then remove
the report for the confirmation. Retain the existing outcome assertions and
add state evidence distinguishing an in-window lapse from a confirmation miss.
This controls both observation order and deadline semantics without changing
the watcher API. A production clock injection would add unnecessary scope;
longer real sleeps would preserve the race.

## Work and verification

1. [x] Inspect issue, failed CI log, watcher, tests, runtime and branch rules.
   Baseline focused test passes locally (1/1), matching the reported flake.
2. [x] Reproduce the deadline gap with a controlled clock, then make the four
   retention scenarios deterministic. Owner: Codex; only the test file changes.
3. [x] Run the focused test repeatedly, the whole reports test file, and
   `pnpm run test:scripts` (the failing CI command). Inspect diff and whitespace.
   Re-plan if the clock cannot control the imported sleep helper, or if a
   production behavior defect is found rather than fixture scheduling.
4. [ ] Commit and open one small PR against `testnet-canary`, attach it, and
   observe CI/review for up to 30 minutes, polling at two-minute intervals
   (at most 10 feedback rounds). Inspect all reviews, comments and threads.
   Do not merge or deploy. Acceptance: intended retention states are observed
   deterministically, repository script tests pass, and remote CI status is
   reported accurately.

## Evidence and handoff

- [Issue 3520](https://github.com/OriginTrail/dkg/issues/3520)
- [Failing CI run](https://github.com/OriginTrail/dkg/actions/runs/40387784341)
- Node v22.23.3 locally; CI uses `.nvmrc` (22).
- No applicable AGENTS.md files or pre-existing working-tree changes found.
- Controlled reproduction: schedule close and a polling read at the same
  simulated 200 ms boundary. The original fixture reports an in-window
  `MISSING ... though it must stay in shared memory`, matching CI exactly.
- Updated focused test: 50/50 fresh-process runs passed while the repository
  script suite ran concurrently. Complete reports file: 21/21 passed.
- `pnpm lint`, `pnpm check:file-size` and `git diff --check` passed.
- First full-script attempt began without workspace dependencies: missing
  `yaml` and `@playwright/test`. Installing with the frozen lockfile before
  rerunning; these are environment failures, not passing validation.
- With dependencies installed, 994/1003 script tests passed. Missing package
  builds caused core/agent/OpenClaw failures; running CI's
  `DKG_SKIP_EVM_BUILD=1 pnpm run build:packages` prerequisite. Four preparation
  fixture failures are caused by local Node and pnpm sharing a binary directory:
  `release-process.mjs` prepends that directory ahead of the fixture's PATH stub.
  Use an isolated copy of the same Node binary to preserve the fixture's PATH
  interception, matching CI's separate executable locations.
- CI package-build prerequisite passed: 26/26 tasks. The isolated Node run
  passed 1003/1004 tests; the remaining cache test requires npm beside Node.
  Added a symlink to the existing npm executable. Final full script suite:
  **1004/1004 passed**, zero failed, cancelled or skipped (62.8 seconds).
- Review/check observation deadline and results will be recorded here.

## Task resources

| Resource | Owner / purpose | Retention / cleanup |
| --- | --- | --- |
| This worktree's ignored `node_modules` directories | Codex; locked test dependencies | Retain for review and reproduction in this active checkout |
| `.tmp/issue-3520-runtime/` | Codex; same Node binary and npm symlink, without colocated pnpm | Remove after the local script suite completes |
| Ignored package `dist`, `.turbo`, TypeScript build metadata | Codex; CI build prerequisites | Retain for reproduction in this active checkout |
| `/tmp/dkg-3520-*.log` | Codex; bounded command output | Remove after summarizing results in this plan and the PR |
| `/tmp/dkg-3520-pr-body.md` | Codex; exact PR description | Remove after submitting the final description |
