# Delta CI policy

## Decision

Use affected-lane CI for pull-request feedback, then run full CI against the
exact merge candidate in GitHub's merge queue. Keep full CI on protected-branch
pushes and manual dispatches. Do not add a `develop` branch solely for CI: that
would postpone integration failures and collect unrelated changes into a large
`develop -> main` batch.

The delta planner is deliberately conservative. It selects the changed
workspace's owning lane plus known downstream consumers, and falls back to full
CI whenever it cannot prove that a smaller plan is safe.

## Policy

| Change/event | CI behavior |
| --- | --- |
| Pull request, known workspace | Owning lane plus declared downstream unit/integration lanes |
| Documentation only | Planner and aggregate gates only |
| `core` / `rdf-utils` | All downstream Node and real-EVM lanes |
| `evm-module` | Full CI, including Solidity |
| Root dependency/build config, workflow, planner, or generic scripts | Full CI |
| Any workspace `package.json` | Full CI because the base and head dependency graphs may differ |
| Rename, copy, deletion, unknown path, or no diff | Full CI |
| More than 100 production files or at least 4 workspaces | Full CI |
| PR with `ci:full` label | Full CI |
| Deterministic 5% PR audit sample | Full CI |
| Merge queue, protected-branch push, or manual dispatch | Full CI |

The planner reads `git diff --name-status -z`, so spaces and other shell-hostile
file names cannot alter the decision. Its routing table lives in
`scripts/lib/ci-delta.mjs` and is covered by table/snapshot-style tests in
`scripts/lib/__tests__/ci-delta.test.mjs`.

## Reliability controls

- Every code PR selected for Node tests still builds the entire Node workspace,
  catching cross-package type and build failures even when a test lane is
  skipped.
- Shared packages run conservative reverse consumers and explicit integrations;
  this includes undeclared edges such as committed EVM ABIs consumed by `chain`
  and the real devnet used by node-UI E2E.
- Unknown inputs fail closed to full CI instead of silently receiving no tests.
- `CI gate` and `EVM integration gate` are always present. They fail when a
  selected job was accidentally skipped, failed, or was cancelled.
- Full merge-queue CI tests the exact combined commit before it lands. Full
  protected-branch CI remains a second safety net after merge.
- Five percent of PR commits run full CI even when delta would be possible. This
  continuously audits the routing model and exposes a missing dependency edge.
- The routing tests enumerate all package/demo workspaces with a `test` script.
  They also close three existing coverage holes: `rdf-utils`, `okf`, and `demo`
  are now included in explicit CI lanes.

Test-result snapshots are useful for checking that the routing plan stays
stable, but they cannot establish that a skipped test would have passed. That
is why snapshots guard the planner while full merge-queue CI remains the final
correctness gate.

## Required repository settings

Delta selection is **default-off**. Until the repository variable
`CI_DELTA_ENABLED` is exactly `true`, PRs deliberately receive full CI. Activate
it only after all safeguards below are configured:

1. Create the `ci:full` label.
2. Enable GitHub merge queue for `main`.
3. Require the `CI gate` and `EVM integration gate` status checks in the branch
   ruleset. Individual matrix job names should not be required because skipped
   lanes intentionally do not exist on every PR.
4. Set the Actions repository variable `CI_DELTA_ENABLED=true`.

This ordering prevents selective CI from becoming active while GitHub can still
merge without a full candidate run. Removing the variable (or setting it to any
value other than `true`) is the immediate rollback switch.

The initial workflow allowlist enables delta only for PRs whose base is `main`.
Release/RC PRs continue to run full CI even when the variable is true. Add a
release branch to that expression only after it has the same required gates and
merge-queue protection.

## Developer workflow

- Open or update a PR normally. The **Plan CI delta** job summary lists selected
  and skipped lanes and explains the reason.
- Add `ci:full` when the change is riskier than its paths imply or when a
  reviewer asks for the complete suite. Adding/removing the label reruns CI.
- Use **Run workflow** for an unconditional full run on any branch.
- If a new package, dependency edge, or integration consumer is introduced,
  update `WORKSPACE_RULES` and its routing snapshot in the same PR. A package
  manifest change already forces full CI for that PR.

## Measured baseline and expected effect

After the guarded rollout is activated:

Ten recent successful PR runs had a median wall time of about **14.0 minutes**
and used about **84.6 runner-minutes**. The five largest consumers were agent,
publisher, real-devnet UI E2E, CLI, and core/storage/chain, together accounting
for about 86% of compute.

- A CHANGELOG-only PR ([#1672](https://github.com/OriginTrail/dkg/pull/1672))
  launched 28 successful runners, used 83.6 runner-minutes, and took 12m57s;
  it now needs only planners and aggregate gates.
- A leaf supporting-package change should take roughly 3 minutes instead of 14
  (shared build plus the supporting lane).
- A Hardhat-plugin-only change should take roughly 5 minutes.
- UI and shared protocol changes still run the real-node E2E suite, but its 326
  tests now run in seven isolated devnet shards instead of one serial lane.

The full PR path was also measured independently of delta selection. On the
same PR, the original full workflow took
[13m07s](https://github.com/OriginTrail/dkg/actions/runs/29321182804); after
sharing EVM compilation and sharding the long CLI, chain, and real-node suites,
the full workflow and its final gate passed in
[6m05s](https://github.com/OriginTrail/dkg/actions/runs/29325452377), a 53.5%
wall-time reduction. That validation deliberately ran with delta disabled and
retained the complete key-suite totals:

- CLI: 2,705 passed + 12 skipped = 2,717 tests across 190 files.
- Chain: 1,033 passed + 1 skipped = 1,034 tests across 58 files.
- Real-node Playwright: 318 passed + 8 skipped = 326 tests.

Parallelizing a forced-full PR trades compute for latency: the measured runner
total increased from 87.9 to 109.0 minutes. Delta routing is what reduces
runner use on ordinary leaf/documentation PRs; full global/high-risk changes
pay the extra parallel compute to keep feedback near six minutes.

Protected-branch pushes and manual runs additionally retain the unsharded
Solidity coverage ratchet. That post-merge safety net currently takes about
25 minutes and is intentionally outside the PR feedback target. Safely
parallelizing it requires merging raw coverage counters and proving the merged
result equals the full baseline; concatenating LCOV files would be incorrect.

Measured runs and projections are not latency guarantees; runner availability
and test variance still affect elapsed time.

## Local verification

```sh
node --test scripts/lib/__tests__/ci-delta.test.mjs
actionlint .github/workflows/ci.yml .github/workflows/evm-integration.yml
```
