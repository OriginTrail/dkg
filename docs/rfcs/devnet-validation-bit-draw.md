# Devnet validation — BIT value-weighted draw (Phase 2)

Real multi-node devnet run of `scripts/devnet-rs-validation.sh` against the worktree's
contracts (clean redeploy; deploy step `057` auto-unlocked the BIT). Exercises the full
production path: publish (settle-on-spend) → `createChallenge` (Fenwick draw) → `submitProof`,
across multiple proof periods on real nodes.

## Setup
- 4-node devnet, all core (publisher needs `DEFAULT_REQUIRED_ACKS = 3` connected core peers).
- Hardhat chain, 1s/block; RS proofing period = 100 blocks (~100s). ~5 min observe window.
- One public CG, 30 small KAs, never updated (RS correctness measured in isolation).

## Verdict: PASS (11 PASS / 0 WARN / 0 FAIL)
- PREFLIGHT: 4/4 nodes up; 4/4 cores have an RS prover.
- PUBLISH: owner seed-publish registered the CG; **30/30 KAs published**.
- OBSERVE (per-period proof success): core1 100% (5/5), core2 100% (5/5), core3 75% (3/4),
  core4 75% (3/4) — **16 in-window per-period successes** (the rs-validation metric, scoped to the
  ~5-min observation window). The gas table below reports **32 `submitProof` txs**: that's *every*
  successful submit across the chain's full lifetime (bootstrap + the whole run), a strict superset
  of the 16 counted in the timed window — not a contradiction.
- **0 data-corrupted, 0 no-eligible-cg, 0 errors** across all cores — the value-weighted
  draw always found the published CG (settle-on-spend populated the BIT; the Fenwick draw +
  proof verification all worked end-to-end).

### What this confirms about Phase 2
- `057` auto-`finishBackfill` brings the draw live on a clean deploy (no migration).
- settle-on-spend fires on the real publish path (`KnowledgeAssetsLifecycle.publish`) → the
  BIT leaf is populated → `createChallenge` draws the CG.
- The split picker (`_pickWeightedChallengeFull`) + KA pick + proof all succeed on real nodes.
- `no-eligible-cg = 0` → no spurious empty-tree reverts once value is published.

> An earlier 2-core run failed at PUBLISH with `QuorumUnmetError` (2 < 3 required ACK peers) —
> an environment/topology limit, not a contract issue. Notably `createChallenge` then reverted
> `NoEligibleContextGraph` (not `ChallengeDrawPaused`), which *positively* confirmed (a) `057`
> had unlocked the tree and (b) the BIT draw ran and correctly reverted on an empty ledger.

## On-chain gas (real node operation, all txs succeeded)

| function | n | avg | min | max |
|---|---|---|---|---|
| `RandomSampling.createChallenge` (BIT draw) | 32 | **310,486** | 284,202 | 458,939 |
| `RandomSampling.submitProof` | 32 | 298,351 | 287,807 | 372,467 |
| `KnowledgeAssetsLifecycle.publish` (incl. settle-on-spend) | 31 | 756,675 | 731,315 | 1,366,815 |

- **`createChallenge` ≈ 310k gas, ~constant** in N (the min→max spread is occasional
  settle-on-miss on a stale/expired draw). Compare the old O(N·D) twin scan: **~110M gas at
  just N=75** (Phase-0 analytic) — a ~350× reduction, and it no longer grows with the CG count.
  (In-process micro-benchmark isolated the selection at a flat 148,126 gas across N=1/1k/10k;
  the ~310k here is the full state-changing `createChallenge`: draw + `setNodeChallenge` +
  event + proof-period update.)
- **`publish` ≈ 757k avg** now includes settle-on-spend; the **1.37M max is the first publish**
  (cold BIT node writes for the first leaf), warming on subsequent publishes. Bounded, rare
  (write path).
- `submitProof` (~298k) is unchanged by this work (listed for reference).

## Reproduce
```
BOOTSTRAP=1 NUM_NODES=4 NUM_CORE_NODES=4 RS_OBSERVE_S=300 ./scripts/devnet-rs-validation.sh
# then, while the devnet is up:
node packages/evm-module/scripts/devnet-gas-scan.mjs
./scripts/devnet.sh clean
```
