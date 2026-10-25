# Primary CI nightly-equivalent profile

Run the full primary workflow at a chosen candidate ref:

```sh
gh workflow run ci.yml --repo OriginTrail/dkg --ref <candidate-ref> \
  -f profile=nightly-equivalent -f seed=13064
gh run list --repo OriginTrail/dkg --workflow ci.yml --event workflow_dispatch
```

The ref selects the workflow **and** every candidate checkout. There is no second
checkout/ref input. Check the full `subject` in the plan log and
`nightly-profile-summary` artifact against the intended commit. Seed is optional;
nightly runs default to the recorded workflow run number. Overrides accept signed
32-bit decimal integers, including zero. Unknown profiles and malformed seeds fail
planning. Ordinary PR/push/merge-group and standard dispatch retain 100 trials,
seed 640905, and their existing lane selection and browser coverage.

Schedule and `nightly-equivalent` dispatch both select the immutable controller's
full plan, four-node managed-local Playwright suite, and 1,000 property trials.
Their setup, assertions, deadlines and aggregate requirements are identical.
An ordinary run cannot cancel this campaign. Another campaign on the same ref
supersedes it; cancellation remains enabled for ordinary PRs.

`scripts/ci/resolve-ci-profile.mjs` is the sole execution-settings resolver. It
runs **after** the trusted planner has finalized lane selection. Its profile record
is converted to runner environment variables by `scripts/ci/apply-ci-profile.mjs`
only for test and coverage consumers; build and aggregate jobs do not receive
unused execution settings. The existing
resolver also validates resolved records for both runner setup and evidence
verification, including the run identity and canonical profile settings. Campaign
completion is checked against that validated trial budget. The
planner/aggregate controller stays pinned to reviewed protected commit
`8af04a376332c17527ce0f7dffaac8432ba1a9b3`; this change does not rotate it or remove
the publisher-route shim. The existing `CI gate` requires both coverage and the
execution-profile verdict, then always runs the trusted aggregate so one missing
verdict does not suppress other failures. No protected controller activation is
needed for this workflow wiring. Scheduled execution starts using it when the
change reaches the default branch; dispatch can validate the candidate first.

## Evidence and diagnosis

Download `nightly-profile-summary`, `node-ui-playwright-report-*-of-7`,
`lift-campaign-*-of-4`, and the existing Vitest reports. The compact summary records
the commit, profile, seed, requested/completed trials, runtime metadata, durations,
timestamps, test identities, attempts, job outcomes, and artifact names. A running
campaign receipt is incomplete evidence, even when its last recorded count is
close to 1,000. A timeout, skipped required scenario, missing shard, zero discovery,
or failed campaign blocks the profile. All errors are retained together.

The October 23 UI trace showed a successful API pipeline followed by a request to
open **Agent Registry**. The fixture selected the first daemon graph, whereas
`fetchContextGraphs` deliberately filters `isSystem` graphs from the sidebar.
The API's system-first ordering therefore cannot identify the user graph for this
scenario. The fixture must select the seeded `devnet-test` ID explicitly, verify
its readiness, and fail if it is missing. Do not expose system graphs in the UI or
weaken the real publish/refresh assertions to accommodate the fixture.

The historical publisher seed is **13064**. The October 23 report records a
30,000 ms Vitest deadline, not a fast-check counterexample; no shrinking path was
reported. Inspect `failureReason` alongside the counterexample/path: an assertion
identifies an invariant failure, a per-example timeout identifies a stuck or slow
operation, and an interrupted/unfinished receipt identifies budget or process
failure. A timeout can also retain a counterexample; its presence alone does not
classify the failure.
Keep the original generated command domain, independent real stores, legal/illegal
transition oracle and `finally` cleanup when investigating either.

The scaling defect was one enabled `AsyncLocalStorage` per publisher instance,
including every generated restart. Node 22 propagates all enabled stores on each
promise, so settled publishers kept adding overhead. Journal completion now uses
one shared context resource with per-instance ownership. Regression tests bound
resource allocation and preserve nested/concurrent drain behavior. The campaign
retains its original 30-second limit and yields between independent trials so
deadline and cancellation timers can run.

For focused reproduction in an isolated checkout with dependencies and package
outputs built (Node 22), use unused loopback ports:

```sh
CI=1 PW_DEVNET_LOCAL=1 HARDHAT_PORT=28545 DEVNET_OXIGRAPH_BASE=37900 \
PLAYWRIGHT_DEVNET_API_PORT_BASE=29201 PLAYWRIGHT_DEVNET_LIBP2P_PORT_BASE=30001 \
pnpm --filter @origintrail-official/dkg-node-ui exec playwright test \
  e2e/specs/devnet-local/wm-swm-vm-lifecycle.devnet.spec.ts --retries=0 --trace=on

DKG_PROPERTY_SEED=13064 DKG_PROPERTY_RUNS=1000 \
pnpm --filter @origintrail-official/dkg-publisher exec vitest run \
  test/lift-lifecycle.property.test.ts
```

Three clean focused UI runs and three property seeds are implementation evidence;
they do not replace a complete hosted nightly-equivalent run with a passing
`CI gate`. Three green scheduled nights after merge are a subsequent rollout check.
Do not operate shared nodes, lower StorageACK quorum, alter coverage floors, or
change branch protection to obtain a pass.
