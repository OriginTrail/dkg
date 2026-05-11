# V10 core-flows — findings

Curated snapshot of bugs and observations surfaced by `pnpm test:devnet:v10-core-flows`. The suite is a release-gate: run before any change that touches the assertion route, staking contracts, publisher chain-submit path, or the operator-fee mechanism. Runtime evidence is regenerated at `FINDINGS.local.md` on each run.

## Bugs filed

### Bug 1 (FIXED) — standalone `/api/assertion/:name/finalize` did not emit `memory_graph_changed`

**Where:** `packages/cli/src/daemon/routes/assertion.ts`, the standalone `/finalize` handler.

**Symptom:** A client composing the sign-at-creation lifecycle by hand (`POST /api/assertion/create` → `/write` → `/finalize` → `/promote`, four separate calls) saw three SSE `memory_graph_changed` events instead of four. The `assertion_finalized` step was silently dropped, so any UI watching the assertion state machine (staking-ui, dkg-node-ui, external integrators) missed the seal-applied transition.

**Why it didn't fire:** the chained `/api/assertion/create` handler emits all four events when called with `quads + finalize: true + promote: true`. The standalone routes for `/write` and `/promote` each emit independently. The standalone `/finalize` route returned the EIP-712 seal but skipped its emit — a merge-conflict resolution oversight (the route had to add author-attestation logic from PR #436 *and* the emit hook from `main` Phase B, and only the former landed cleanly).

**Fix:** `packages/cli/src/daemon/routes/assertion.ts` now emits `memory_graph_changed` with `operation: "assertion_finalized"` immediately after `agent.assertion.finalize(...)` in the standalone route, mirroring the chained handler's emit pattern.

**Regression pin:** `packages/cli/test/memory-graph-events.test.ts` — `it('emits an assertion_finalized refresh on standalone /api/assertion/:name/finalize')`. Two tests in this suite (the `/create` and `/finalize` cases) were the missing per-route coverage; the file already had `/write` and `/promote` cases when the bug shipped.

## Architectural notes confirmed

### Edge-node publish is "tentative" by design

When an edge node (`nodeRole: "edge"`, no on-chain identity registered) calls `/api/shared-memory/publish`, the daemon:

1. Walks the full assertion lifecycle (create/write/finalize/promote) successfully.
2. Computes the merkle root over the SWM selection and prepares the publish payload.
3. Collects ACKs from peer cores via direct P2P (`[ACKCollector]`).
4. Skips on-chain submission with the explicit log line: `Identity not set (0) — skipping on-chain publish [WARN]`.
5. Returns `status: "tentative"`, `kcId: "0"` to the API caller.

This is correct: edge nodes are app/relay servers, not validators; chain anchoring requires a wallet with `ProfileStorage` registration. The `tentative` return surface gives the calling app actionable information ("gossiped, not anchored") without crashing or pretending to chain-submit. Test 2 in this suite pins both halves of the contract.

### Operator-fee accrual obeys RFC-26 to within rounding

Test 4 sets a 10% operator fee on identityId=1, reads the pending fee's effective timestamp, generates fresh publishes to seed the epoch pool, waits for RS to score the epoch, warps past that exact effective timestamp, and has a delegator claim. The accrued operator-fee balance equals `(getEpochPool(EPOCH_POOL_INDEX, e) × nodeScore / totalScore) × feeBps / 10_000` to under 100 bps drift. The first claim per (identity, epoch) pair locks the accrual via `isOperatorFeeClaimedForEpoch[id][e] = true`; subsequent delegator claims for the same epoch use the cached `netNodeEpochRewards` and do not re-accrue.

### `Profile.updateOperatorFee` half-epoch median rule

`updateOperatorFee` calls in the **first half** of the current epoch take effect at the next epoch boundary. Calls in the second half take effect at the boundary *after* next. This prevents an operator from raising the fee mid-epoch to capture rewards earned under the old fee. Test 4 reads the pending effective timestamp and warps past it, so it is deterministic regardless of which half of the epoch the suite starts in.

## Warnings

### Boundary timing fragility on warp-driven tests

`getActiveOperatorFeePercentage` uses strict `>` against `effectiveDate`, so a warp that lands `block.timestamp == effectiveDate` (instead of `>`) underflows when reading `operatorFees[length-2]`. Mitigated in test 4 by adding +120s past the next-epoch boundary. If the test starts failing on the `getOperatorFee(1)` call after the warp, increase the safety margin in step (d).

### Hardhat interval-mining nonce races on shared admin wallet

The Hardhat default-account-0 admin wallet is shared between this suite (operator-fee withdraw), the devnet bootstrap, and any background process that uses it. With `evm_setIntervalMining` on, ethers' nonce cache can desync between transactions; we work around this in step (f) by reading a fresh nonce from the chain before the finalize call. If you start seeing `Nonce too low. Expected nonce to be N+1 but got N` on operator-fee finalize, the workaround is the same: explicit `getTransactionCount → { nonce }` override.
