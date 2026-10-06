# Required Node 26 chain-RPC execution

This delivery stages lane `chain_rpc_node26`, job `chain-rpc-node26`, under the
existing `CI gate`. It does not change required check names, branch protection,
coverage floors, devnet parsing, or browser lifecycle policy.

## Runtime and selection

The inspected canary baseline was `5e9838e1558de8f1268dca8837558621fc336a4c`.
`packages/cli/package.json` and `packages/agent/package.json` declare
`>=22.13.0 <23.0.0 || >=23.4.0`, which includes Node 26. `.nvmrc` selects Node 22
for ordinary CI. The Node 26/undici 8 transport gap present at v10.0.20 remained
on canary. Changes to runtime support need a reviewed controller/policy update;
this controller requires the Node 26 lane on every full plan.

The lane follows all chain source, caller/wiring, test, helper, fixture and
configuration changes, and the shared core/http-utils/rdf-utils dependencies.
Dependency/install inputs, global configs, controller changes and both primary
and transport workflows select full CI. Runtime manifests/installation guards
are install inputs. Regression routing policy also selects the lane.
Irrelevant delta PRs and docs-only PRs declare it explicitly false. Full PRs,
rollback-to-full PRs, merge groups, protected pushes, nightly and manual full
runs declare it true. Existing routing audits remain in place.

`chain-rpc-node26.yml` is reusable and manually dispatchable. Only primary CI
triggers PR execution, preventing duplicate transport runs. It uses Node 26,
`DKG_REQUIRE_UNDICI8_FETCH=1`, and a runner that invokes Vitest with the same
`process.execPath` used by the cold-request child. It preserves both the raw
Vitest JSON report and a compact runtime/assertion record as the
`chain-rpc-node26` artifact. The reusable job passes that record to `CI gate`
through its `evidence` output.

The pinned validator requires Node 26 with bundled undici 8, the environment
requirement, successful execution, and exactly one passed assertion for each:

- Plain fetch offers HTTP/2 while chain RPC stays on HTTP/1.1.
- The application dispatcher retains its TLS trust and refuses HTTP/2.
- `NODE_USE_ENV_PROXY` retains proxy routing and uses HTTP/1.1.
- The first chain RPC request in a fresh process uses HTTP/1.1.

The names are pinned in `NODE26_REQUIRED_ASSERTIONS` in `ci-results.mjs`.
Renaming a required case requires a reviewed controller update. A successful job
with only generic tests, skipped/failed/duplicate/missing required assertions,
wrong runtime, absent/malformed evidence, or an unset environment requirement
fails the new aggregate. Selected failed/cancelled/skipped/missing jobs fail.
Even an unselected job must appear as a dependency; only an explicitly false
lane in a validated plan permits its skipped execution.

## Two-change activation

The implementation deliberately keeps the existing immutable controller pins.
At inspection, canary used `dfb3460719c13d592e2bb4d7d3c29fe55567fbe3` in both
primary and EVM workflows; main used
`4aca346d4818eb63e661c6028a4e2c1cbea2bd92`. Candidate source edits do not activate
controller enforcement.

1. Review and merge the implementation into protected `testnet-canary` (or
   `main`) history through the existing process. Its workflow supplies the job
   and `CI gate` dependency before any controller can require them. The old
   planner emits no Node 26 flag, so the documented output fallback selects it
   conservatively on every run. The old aggregate rejects failure/cancellation,
   but cannot require skipped/missing execution or validate the evidence.
2. After that merge, prepare a separate activation PR. Select the exact reviewed
   immutable commit containing this implementation, never a feature-branch SHA.
   Fetch protected history and require `git merge-base --is-ancestor <sha>
   origin/testnet-canary` (or `origin/main`) to exit zero. Confirm its controller
   files include the lane and evidence validator, and its workflow supplies the
   job. If protected policy changed meanwhile, select a reviewed protected commit
   containing the combined current policy and rerun compatibility tests.
3. Replace all four trusted checkout refs in `ci.yml` and `evm-integration.yml`
   together and update `TRUSTED_CI_CONTROLLER_SHA` in `ci-plan-fixtures.mjs`.
   Remove the `chain_rpc_node26` output fallback and its `Rotation shims` note;
   use `${{ steps.plan.outputs.chain_rpc_node26 }}` directly. The sparse controller
   file list stays unchanged; no new CLI flag requires parser coordination.
4. Run the controller/routing/result tests and provenance fetch tests. Inspect
   `inspect-ci-policy.mjs` against both workflows, checking protected provenance
   and policy-tree freshness. Freshness is a scheduled report, not a merge gate;
   it may warn between the implementation merge and rotation. Its comparison is
   against canary policy, so a main-only pin must still preserve current canary
   policy. Do not bypass provenance/freshness review with an unreviewed pin.
5. Observe activation PR CI on its exact candidate. Confirm the planning summary,
   one Node 26 execution, artifact/runtime assertions and `CI gate`. Check an
   irrelevant PR's explicit false selection. Observe the actual subsequent
   merge-group/full run; local event fixtures do not establish a real queue run.
   Merge only through separately authorized maintainer action.

The tests execute actual old and candidate controller CLIs from sparse copies.
They demonstrate old-controller/new-workflow compatibility (including the staged
skip gap), new-controller/new-workflow success and failure, and rejection of a
new controller against dependencies from a workflow without the lane. They also
run a controlled failed-assertion record through the candidate aggregate CLI
and require exit 1 even when the fixture's job result is success. Existing
provenance tests reject unmerged feature revisions. These are local/candidate
policy tests, not proof the active pinned controller already enforces the lane.

## Release-candidate invocation

After activation, dispatch the primary workflow on the candidate branch, for
example `gh workflow run ci.yml --ref <candidate-branch>`. The manual event uses
full selection and the same reusable Node 26 check. Inspect the run's actual
head SHA against the intended candidate and retain the Node 26 artifact and
aggregate conclusion. `gh workflow run chain-rpc-node26.yml --ref
<candidate-branch>` is standalone diagnosis using the same implementation; its
success alone is not the primary required CI verdict. No release certificate,
package publication, channel promotion or live-network campaign is added here.
