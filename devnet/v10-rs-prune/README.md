# Devnet scenario: V10 Random Sampling prune keeper

End-to-end validation, against a **live devnet**, of the expired-KA prune keeper:
when a CG's sampling list accumulates expired "dead slots" they can starve the
bounded within-CG random-sampling draw, so the keeper compacts them out.

The on-chain *starvation mechanic* itself is proven deterministically in the
hardhat unit test
`packages/evm-module/test/unit/RandomSampling.test.ts`
("recovery path: a clogged CG starves previewChallengeForSeed before pruning,
succeeds after"). This scenario proves the parts a unit test can't reach — the
**deployed** contracts + the **real publish path** + the keeper as an ordinary
permissionless transaction:

1. A real CLI publish registers a KA into **both** per-CG lists — the append-only
   `_contextGraphKAList` (the chain-reconciler's registration ordinal) and the
   compacted `_samplingKAList` (what the draw reads).
2. `RandomSampling.pruneExpiredKnowledgeAssets(cgId, startIndex, maxScan)` is
   callable as a normal tx by an **arbitrary funded wallet** (it's
   permissionless) and prunes **only** the sampling list.
3. **Reconciler-safety on-chain**: after pruning, `getSamplingKaCount` shrinks to
   the live KAs while `getContextGraphKaCount` (the registration ordinal) is
   **unchanged**, so a later publish can never be skipped by the reconciler. The
   reverse binding (`kaToContextGraph`) of a pruned KA also survives.

## Why the assertions are count-based, not draw-based

`createChallenge` / `previewChallengeForSeed` draw across **every** weighted CG
on the devnet, so per-CG starvation isn't deterministically observable on a
shared network — that's the unit test's job. The per-CG count invariants this
scenario asserts (`getSamplingKaCount` / `getContextGraphKaCount` /
`getSamplingKaAt` / `kaToContextGraph`) **are** deterministic and are the
net-new, devnet-only evidence: the deployed contracts behave correctly and the
keeper is operable as a real tx.

## Run

```bash
./scripts/devnet.sh clean
./scripts/devnet.sh start 6
pnpm test:devnet:v10-rs-prune
```

Tuning (env):
- `DKG_RS_PRUNE_FLOOD` — number of 1-epoch KAs to flood (default `8`).
- `DKG_RS_PRUNE_NODE` — devnet node number to publish from (default `1`).

Not run in CI (requires a live devnet); manual/opt-in like the other
`devnet/*` scenarios. Depends on the contracts from PR #1268 (the
`getSamplingKaCount/At` getters + the `pruneExpiredKnowledgeAssets` keeper).
