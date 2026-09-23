# Delta CI policy

## Decision

Use affected-lane CI for pull-request feedback, then run every Node/EVM lane
against the exact merge candidate in GitHub's merge queue. Keep full CI on
protected-branch pushes and manual dispatches. Solidity remains independently
path-gated on pull requests: contract-relevant PRs run the four Hardhat shards,
merge candidates rerun them against the exact combined commit, and protected
pushes run the full coverage ratchet after merge. Do not add a `develop` branch
solely for CI: that would postpone integration failures and collect unrelated
changes into a large `develop -> main` batch.

The delta planner is deliberately conservative. It selects the changed
workspace's owning lane plus known downstream consumers, and falls back to full
CI whenever it cannot prove that a smaller plan is safe.

## Policy

| Change/event | CI behavior |
| --- | --- |
| Pull request, known workspace | Owning lane plus declared downstream unit/integration lanes |
| Documentation only | Planner and aggregate gates only. A document a test reads (`RELEASE_PROCESS.md`, `packages/query/README.md`) is a CI input instead: its `PATH_TRIGGERS` entry selects only the lanes that read it, not the rule of the package it documents |
| Agent lane | Also the Blazegraph lane and the Windows lifecycle job: the Blazegraph job runs the agent's live Blazegraph suites and `ci.yml` starts it for either lane; the Windows job is described below |
| A file another package's code or tests load by relative path, outside declared dependencies | The loading lane or EVM scope too, through `PATH_TRIGGERS` or the file's own workspace rule (for example the agent lane for the CLI markdown extractor, the node-ui lane for the CLI daemon sources its tests scan, the core lane for the agent, publisher and CLI sources the chain RPC-site census reads, the Blazegraph lane for the CLI's Oxigraph launcher that the storage conformance suite runs, the chain scope for the identity-wallet code its node-ui suite loads) |
| `core` / `rdf-utils` | All downstream Node and real-EVM lanes, including the browser E2E suite (its harness imports `core`) |
| Real-node browser E2E (Playwright, 7 devnet shards) | PRs touching the UI surface it drives (`node-ui`, `graph-viz`, and `cli`, the daemon HTTP API) or a package its harness code imports (`core` and its dependency `rdf-utils`). The rest of the daemon runtime (`agent`, `chain`, `storage`, `publisher`, `query`, adapters and the other packages `cli` depends on) is a deliberate exception: those PRs run their own lanes plus the CLI daemon tests and get the suite after merge. `ci-delta-routing.test.mjs` derives both sets from the harness imports and `scripts/devnet.sh`, and pins the exception list |
| Windows lifecycle job (`rfc64-inventory-windows.yml`) | Every PR that runs the agent lane; the planner derives it once for every plan, whether a package, a `devnet/` harness or the Gate 0 paths selected the agent lane. Besides the SQLite suites it runs the RFC-64 Gate 0 lifecycle and evidence harnesses, which start a real agent and run on no Linux lane |
| `evm-module` | Full Node/EVM CI; Solidity only for the established contract-relevant paths |
| Root dependency/build config, lockfile, CI control-plane workflows (`ci.yml`, `evm-integration.yml`, `rfc64-inventory-windows.yml`), any nested path under `.github/workflows/`, composite actions, planner, or any `scripts/` file | Full Node/EVM CI; Solidity only when its independent path filter matches |
| Workspace `package.json` changing only package-scoped fields (`exports`, `scripts` other than install hooks, `version`, `files`, metadata) | Same lanes as a source change in that workspace |
| Workspace `package.json` changing dependencies, `pnpm`/overrides, `engines`, `bin`, `directories`, `name`, `type`, install-time scripts (npm install/prepare lifecycle, `prepublish`, `dependencies`, any `pnpm:` hook) or unknown fields; added, removed or moved manifests; root and `devnet/*` manifests | Full CI because the install or dependency graph may differ |
| Deletion, rename or copy | Routed by every old and new path, like edits |
| Type change, unmerged or unknown git status, unknown path, or no diff | Full CI |
| Several workspaces | Union of their rules |
| `devnet/`, `test-systems/`, `bench/`, `tools/`, other top-level `.github/` files | Shared build checks plus the lanes that load them: `devnet/` the agent lane (with Blazegraph and the Windows job; the Gate 2 adapter the CLI starts, the shared `rfc64-runtime-*` modules and the CP2 batch planning it imports also the CLI lane), `bench/` the CLI lane, `test-systems/` Blazegraph, `tools/` and `.github/` the build checks alone |
| More than 100 production files | Full CI |
| PR with `ci:full` label | Full Node/EVM CI; Solidity remains path-gated |
| Merge queue | Every Node/EVM lane plus sharded Solidity on the exact candidate |
| Protected-branch push or manual dispatch | Full CI, including Solidity coverage |

Each changed path gets one routing decision, first match wins: global CI inputs
(full CI), then its package workspace, then a repository support area, then a
file-level trigger alone (such as `blazegraph-image.json`), otherwise full CI.

The planner reads `git diff --name-status -z`, so spaces and other shell-hostile
file names cannot alter the decision. For a modified workspace manifest it also
reads both versions with `git cat-file blob` from the candidate checkout (data
only; nothing from the candidate is executed); any read or parse failure keeps
full CI. Its routing tables live in
`scripts/lib/ci-routing.mjs`, next to the planner in `scripts/lib/ci-delta.mjs`, and are covered by table/snapshot-style tests in
`scripts/lib/__tests__/`: `ci-delta.test.mjs` (planner policy),
`ci-delta-routing.test.mjs` (path routing), `ci-controller.test.mjs` (trusted
controller and workflow wiring) and `ci-results.test.mjs` (aggregate gates).

## Reliability controls

- Every code PR selected for Node tests still builds the entire Node workspace,
  catching cross-package type and build failures even when a test lane is
  skipped.
- Shared packages run conservative reverse consumers and explicit integrations;
  this includes undeclared edges such as committed EVM ABIs consumed by `chain`.
  Beyond declared dependencies, a routing test seeds from what each lane runs
  (package code and tests, and the support files CI jobs run directly, through
  root `package.json` scripts or through reusable workflows), follows every
  relative reference (imports, dynamic imports, CommonJS `require`,
  `new URL(...)` paths, paths built with `path.resolve`/`join` or their
  imported aliases from a file's own directory and, in tests and test-runner
  configs, quoted repo paths naming a file; documents included, and a built
  directory counts when the file walks it; built `dist/` output stands for its
  `src/`) across packages and support areas, and fails when a file it reaches
  does not select that lane or EVM scope. Where that reach enters another
  package, the workspaces it imports by package name (and their dependencies)
  must select the lane too: the chain scope's node-ui suite starts a
  DKGAgent, so storage, publisher, query and random-sampling changes run that
  scope.
  The most expensive system lane, real-node browser E2E, follows on PRs only
  the UI surface it drives and the packages its harness imports, and runs in
  full on every protected-branch push, merge-queue candidate and nightly run;
  `ci:full` opts a PR in before merging.
  The Windows lifecycle job is not narrowed that way: its Gate 0 and evidence
  harnesses have no Linux equivalent, so it runs for the whole agent closure.
- Unknown inputs fail closed to full CI instead of silently receiving no tests.
- `CI gate` and `EVM integration gate` are always present. They fail when a
  selected job was accidentally skipped, failed, or was cancelled. The shared
  build is required when a Node lane needs it or the plan declares
  `buildChecks` (repository paths whose only CI consumer is the build job's own
  checks). One function, `needsSharedBuild`, decides this for both the build
  job's `run_node` condition and the primary gate, so the two cannot disagree;
  a delta plan that selects no lane and no build checks fails closed to full
  CI.
- CI controller changes use a two-phase rollout. The controller implementation
  lands first while every workflow remains pinned to an immutable SHA already
  present on protected `main` or `testnet-canary` history. Only a follow-up PR
  may rotate that pin to the landed controller. During this rollout, ABI
  freshness runs unconditionally, so candidate code cannot suppress it by
  choosing its own planner.

  Before any follow-up rotates the pin, fetch protected `testnet-canary` and
  require this command to exit zero for the proposed immutable SHA:

  ```sh
  git fetch origin testnet-canary
  git merge-base --is-ancestor <controller-sha> origin/testnet-canary
  ```
- `CONTROLLER_POLICY_FILES` in `scripts/ci/trusted-controller-pins.mjs` is the
  single manifest for the narrow controller boundary. The semantic workflow
  validator parses every trusted checkout and rejects missing, extra, or
  malformed sparse-checkout entries; there is no second text-rewrite model.
  File ordering is not part of the security contract.
- Ruleset and controller-tree inspection is a scheduled protected-branch
  report, not a merge prerequisite. A pull-request workflow controls its own
  execution envelope and cannot safely attest that it ran a validator; the
  read-only token may also hide ruleset bypass actors. The report therefore
  warns on missing or non-authoritative metadata, and no candidate-controlled
  job is presented as a fail-closed policy gate. A future merge prerequisite
  requires an independently protected check or attestation mechanism.
- The merge queue tests every Node/EVM lane and the sharded Solidity suite
  against the exact combined commit before it lands. Protected-branch Solidity
  coverage remains the post-merge safety net.
- The controller must stay loadable from its sparse checkout: its files may
  import only `node:` builtins and each other. A test runs `plan-ci.mjs` and
  `assert-ci-results.mjs` from a copy of exactly `CONTROLLER_POLICY_FILES`,
  because an import outside that list makes the pin impossible to rotate.
- PR plans depend only on the diff and labels. The former 5% SHA-sampled full
  runs were retired, so nothing at PR time runs a lane the plan skipped. Full CI
  on protected-branch pushes, merge-queue candidates and the nightly schedule
  catches a regression a skipped lane would have found, but it never evaluates
  the PR's routing decision, and for a PR merged directly it surfaces after the
  merge. The routing audit is static: the tests in `scripts/lib/__tests__/`
  enumerate every workspace, derive consumers from declared dependencies and
  from relative references, and pin the per-file triggers. Add `ci:full` when a
  PR's paths understate its risk.
- The routing tests enumerate all package/demo workspaces with a `test` script.
  They also close three existing coverage holes: `rdf-utils`, `okf`, and `demo`
  are now included in explicit CI lanes.

Test-result snapshots are useful for checking that the routing plan stays
stable, but they cannot establish that a skipped test would have passed. That
is why snapshots guard the planner while full merge-queue CI remains the final
correctness gate.

## Required repository settings

Delta selection is **default-off**. Until the repository variable
`CI_DELTA_ENABLED` is exactly `true`, PRs deliberately receive full Node/EVM CI.
The independent Solidity path gate still applies. Activate delta only after all
safeguards below are configured:

1. Create the `ci:full` label.
2. Enable GitHub merge queue for every branch using delta selection.
3. Require the `CI gate` and `EVM integration gate` status checks in the branch
   ruleset. Individual matrix job names should not be required because skipped
   lanes intentionally do not exist on every PR.
4. Set the Actions repository variable `CI_DELTA_ENABLED=true`.

This ordering prevents selective CI from becoming active while GitHub can still
merge without a full candidate run. Removing the variable (or setting it to any
value other than `true`) is the immediate rollback switch.

The workflow allowlist enables delta for PRs whose base is `main` or
`testnet-canary`; both branches require the aggregate gates and have active merge
queues. Add any future release branch to that expression only after it has the
same protections.

## Developer workflow

- Open or update a PR normally. The **Plan CI delta** job summary lists selected
  and skipped lanes and explains the reason.
- Add `ci:full` when the change is riskier than its paths imply or when a
  reviewer asks for the complete suite. Adding/removing the label reruns CI.
- Use **Run workflow** for an unconditional full run on any branch.
- If a new package, dependency edge, or integration consumer is introduced,
  update `WORKSPACE_RULES` and its routing snapshot in the same PR. A dependency
  change in a package manifest (and its lockfile update) already forces full CI
  for that PR.

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
- UI and daemon-API changes still run the real-node E2E suite on the PR, in
  seven isolated devnet shards; deeper protocol changes run it after merge.

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
node --test scripts/lib/__tests__/ci-delta.test.mjs scripts/lib/__tests__/ci-delta-routing.test.mjs \
  scripts/lib/__tests__/ci-controller.test.mjs scripts/lib/__tests__/ci-results.test.mjs
actionlint .github/workflows/ci.yml .github/workflows/evm-integration.yml
```
