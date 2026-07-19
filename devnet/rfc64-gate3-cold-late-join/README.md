# OT-RFC-64 Gate 3: cold late-join (fixtures-only)

This harness is a **CLOSED, DETERMINISTIC acceptance-contract** generator and
fail-closed verifier for the RFC-64 "Gate 3" **cold late-join** story: a
receiver that starts from an **empty** store, with **no prior live
announcement**, discovers the authenticated **current** head, bootstraps its
predecessors within a **declared bound**, converges **exactly** to the
publisher's inventory, survives a **restart** without refetching, and leaves
its state **unchanged** when handed an invalidly-authorized head. It is
**fixtures-only** and it does **NOT** prove the product passes Gate 3.

## What it is (and is not)

- The generator (`run.ts`) synthesizes an evidence document **in-process** from
  a single deterministic golden fixture (`buildGate3RawEvidence()`). No real
  multi-process adapter exists here: nothing connects to, imports, or runs
  product runtime (`packages/**`), and nothing touches the network or spawns
  DKG nodes.
- The verifier (`verify.ts` / `verifyGate3()`) re-reads that fixture and checks
  it against 9 acceptance assertions (`G3-A1`..`G3-A9`) plus fixtures-only
  guards.
- The verdict for the golden fixture is `contract-satisfied`, meaning **the
  fixture matches the contract shape** — not that any product gate passed.

## productBoundary / gateEvaluation semantics

Every raw evidence document and every verdict carries two constant self-labels:

- `productBoundary: "not-connected"` — the evidence was produced with no product
  runtime attached.
- `gateEvaluation: "not-evaluated"` — the real OT-RFC-64 Gate 3 was never
  evaluated here.

The verifier **refuses** (`contract-violated`) if the raw document's
`productBoundary` is not `"not-connected"`, if its `gateEvaluation` is not
`"not-evaluated"`, or if any field marks a scenario as passed against the real
product. A `contract-satisfied` verdict still carries both `"not-connected"` and
`"not-evaluated"` so it can never be read as a Gate 3 product pass.

## Scenarios modelled (cross-bound)

`noPriorAnnouncement`, `authenticatedCurrentHeadDiscovery`,
`boundedPredecessorBootstrap`, `exactConvergence`, `receiverRestart`,
`authorizationNegativeUnchanged`. Shared identifiers, digests, and counts appear
in multiple scenarios and the verifier asserts they **agree** (cross-binding):

- publisher `authoredHeadDigest` == discovered head digest == the head the
  receiver applies;
- publisher `inventorySetRoot` == receiver `inventorySetRoot`;
- authored row count == applied row count == inventory leaf count == row-digest
  array lengths;
- publisher `catalogSealedAt` (era + ISO) strictly precedes `receiverStartedAt`.

## Acceptance checks

- **G3-A1** publisher catalog sealed strictly before the receiver started.
- **G3-A2** the receiver started empty (`emptyStartMarker`, 0 initial inventory).
- **G3-A3** no prior live announcement; discovery pull-driven from cold.
- **G3-A4** authenticated current-head discovery (discovered == authored ==
  applied; authorization verified; head current, not stale/superseded).
- **G3-A5** predecessor bootstrap bounded by a finite positive declared bound.
- **G3-A6** exact convergence (same root, same counts, same row digests, no
  missing/extra/duplicate).
- **G3-A7** restart preserved convergence (root/count unchanged, no refetch).
- **G3-A8** authorization-negative fail-closed (zero rows applied, post-state
  root == pre-state root == converged root).
- **G3-A9** boundary (`productBoundary`/`gateEvaluation`).

## Fail-closed

`verifyGate3()` returns `contract-violated` for any missing, type-wrong, or
uncross-bound field, any unknown extra field, any scenario that fails its
acceptance assertion, or any product-gate-pass marker. It never throws on bad
input; it returns a specific violation naming the offending check.

## How to run

From the repository root:

```sh
pnpm test:gate3:rfc64-cold-late-join           # generate then verify
pnpm test:gate3:rfc64-cold-late-join:generate  # write artifacts/raw-evidence.json, print RAW_SHA256
pnpm test:gate3:rfc64-cold-late-join:verify     # write artifacts/verdict.json, print VERDICT_SHA256
pnpm test:gate3:rfc64-cold-late-join:unit       # 12 fault mutations + positive + determinism + structural sweep
pnpm typecheck:gate3:rfc64-cold-late-join       # strict tsc
```

`run.ts` prints `RAW_SHA256=<hex>` and `verify.ts` prints `VERDICT_SHA256=<hex>`
and `VERDICT_STATUS=<status>`. Two runs at the same commit print identical
digests (byte determinism). `verify.ts` requires the artifact to be the exact
canonical stable-JSON encoding and exits non-zero on any tamper or contract
violation. Generated `artifacts/*.json` are git-ignored.

## Not a Gate 3 pass

A `contract-satisfied` verdict here means only that the synthesized fixture is
internally consistent with the modelled acceptance contract. It is **not** an
OT-RFC-64 Gate 3 result. A real Gate 3 evaluation requires a product-connected
harness (which does not exist here) run against the assembled integration
commit.
