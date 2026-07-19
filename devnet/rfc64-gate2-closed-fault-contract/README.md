# OT-RFC-64 Gate 2: closed fault-contract (fixtures-only)

This harness is a **CLOSED, DETERMINISTIC acceptance-contract** generator and
fail-closed verifier for the RFC-64 "Gate 2" cold late-join + multi-peer
failover story. It is **fixtures-only** and it does **NOT** prove the product
passes Gate 2.

## What it is (and is not)

- The generator (`run.ts`) synthesizes an evidence document **in-process** from
  a single deterministic golden fixture (`buildGate2RawEvidence()`). No real
  multi-process adapter exists yet: nothing here connects to, imports, or runs
  product runtime (`packages/**`), and nothing touches the network or spawns
  DKG nodes.
- The verifier (`verify.ts` / `verifyGate2()`) re-reads that fixture and checks
  it against 20 acceptance assertions (`A1`..`A20`) plus fixtures-only guards.
- The verdict for the golden fixture is `contract-satisfied`, meaning **the
  fixture matches the contract shape** — not that any product gate passed.

## productBoundary / gateEvaluation semantics

Every raw evidence document and every verdict carries two constant self-labels:

- `productBoundary: "not-connected"` — the evidence was produced with no product
  runtime attached.
- `gateEvaluation: "not-evaluated"` — the real OT-RFC-64 Gate 2 was never
  evaluated here.

The verifier **refuses** (`contract-violated`) if the raw document's
`productBoundary` is not `"not-connected"`, if its `gateEvaluation` is not
`"not-evaluated"`, or if any field marks a scenario as passed against the real
product. A `contract-satisfied` verdict still carries both `"not-connected"` and
`"not-evaluated"` so it can never be read as a Gate 2 product pass.

## Scenarios modelled (cross-bound)

`coldLateJoin`, `multiProviderFailover`, `freshCheckpointAuthorityFailover`,
`appliedSealAndPostReads`, `watermarkGapReporting`, `zeroEligibleTerminalOutcome`,
`providerContinuation`, `crashRestart`. Shared identifiers, digests, and counts
appear in multiple scenarios and the verifier asserts they **agree** (e.g.
publisher authoredHead digest == receiver appliedHead digest == the head named
in the checkpoint; authored row set count == applied row count == inventory-set-
root leaf count; a provider switch resumes at the exact verified chunk boundary
offset the prior provider left).

## Fail-closed

`verifyGate2()` returns `contract-violated` for any missing, type-wrong, or
uncross-bound field, any unknown extra field, any scenario that fails its
acceptance assertion, or any product-gate-pass marker. It never throws on bad
input; it returns a specific violation naming the offending check.

## How to run

From the repository root:

```sh
pnpm test:gate2:rfc64-closed-fault-contract          # generate then verify
pnpm test:gate2:rfc64-closed-fault-contract:generate # write artifacts/raw-evidence.json, print RAW_SHA256
pnpm test:gate2:rfc64-closed-fault-contract:verify    # write artifacts/verdict.json, print VERDICT_SHA256
pnpm test:gate2:rfc64-closed-fault-contract:unit      # 18 fault mutations + positive + determinism + guards
pnpm typecheck:gate2:rfc64-closed-fault-contract      # strict tsc
```

`run.ts` prints `RAW_SHA256=<hex>` and `verify.ts` prints `VERDICT_SHA256=<hex>`
and `VERDICT_STATUS=<status>`. Two runs at the same commit print identical
digests (byte determinism). Generated `artifacts/*.json` are git-ignored.

## Not a Gate 2 pass

A `contract-satisfied` verdict here means only that the synthesized fixture is
internally consistent with the modelled acceptance contract. It is **not** an
OT-RFC-64 Gate 2 result. A real Gate 2 evaluation requires a product-connected
harness (which does not exist yet) run against the assembled integration commit.
