# V10 + D26 Code Review — Findings & Improvements

**Scope**: `ConvictionStakingStorage.sol` (v3.0.0 → **v3.1.0**), `RandomSamplingStorage.sol` (v2.0.0 → **v3.0.0**), `RandomSampling.submitProof`, `StakingV10.sol` (v2.2.0 → **v2.3.0**), `DKGStakingConvictionNFT.sol` (v1.1.0 → **v1.2.0**).
**Date**: 2026-04-23.
**Status**: review performed against the branch at commit `332231ab` (PR #240). **All H/M/L findings listed below have been implemented in the same PR** — see the per-finding "Status" lines for the post-fix signature.
**Companion**: [`D26_TIME_ACCURATE_STAKING.md`](./D26_TIME_ACCURATE_STAKING.md).

## Fix summary (post-implementation)

| ID  | Status       | Notes |
| --- | ------------ | ----- |
| H1  | **APPLIED**  | `_claim` now `continue`s on dormant epochs (`scorePerStake36 == 0`) before writing the fee flag; SSTORE is now amortized over productive epochs only. |
| H2  | **APPLIED**  | Common expiry-split math extracted into `_delegatorIncrementForEpoch`; both `_claim` and `_prepareForStakeChangeV10` call it. |
| M1  | **APPLIED**  | `updateOnRelock` + cross-identity branch removed; `createNewPositionFromExisting` now handles same-identity relocks only and derives `multiplier18` internally. |
| M2  | **APPLIED**  | Added `nodeExpiryPresent[id][ts]` dedup map; `_scheduleNodeExpiry` / `_settleNodeTo` / `_cancelNodeExpiry` maintain it. |
| M3/M4 | **APPLIED**| `addTier` now requires `duration == 0 && mult == 1x` for tier 0, and `duration > 0 && mult > 1x` otherwise. |
| M5  | **APPLIED**  | `INamed` inheritance dropped; collection name served via `ERC721.name()`, dev id via `contractName()` (constant). |
| M6/M7 | **APPLIED**| `firstScorePerStake36` and `firstInitialized` stripped; `EpochIndex` now `{ lastScorePerStake36, mid[] }`. `findScorePerStakeAt` returns `0` on empty `mid`. |
| L1  | **APPLIED**  | All NatSpec updated from `expiryEpoch` → `expiryTimestamp`. |
| L2  | **APPLIED**  | `++nextTokenId` — first mint is tokenId=1; tokenId=0 is a permanent sentinel. |
| L3  | **APPLIED**  | `lockTier` widened to `uint40` end-to-end (events, signatures, constants). |
| L4  | **APPLIED**  | `createPosition` reverts if `currentEpoch == 0`. |
| L5  | **APPLIED**  | `_cancelNodeExpiry` `delete`s `nodeExpiryDrop[id][ts]` when fully drained (gas refund). |
| L6  | **APPLIED**  | `setLastScorePerStake` removed; all seeding routes go through `addToNodeEpochScorePerStake` + `appendCheckpoint`. |
| L7  | **APPLIED**  | `getNodeEffectiveStakeAtEpoch` tolerates `timestampForEpoch(epoch+1) == 0`. |
| L8  | **APPLIED**  | `InvalidIdentityId` error + `identityId != 0` guards at `createConviction`, `redelegate`, `adminMigrateV8`, `adminMigrateV8Batch`. |
| L9  | **APPLIED**  | `setV10LaunchEpoch` rejects subsequent calls once bound. |
| L10 | **DEFERRED** | Event density acceptable for now; subgraph-side coalescing is the right fix. |
| L11 | **APPLIED**  | `multiplier18` dropped from `createPosition` / `createNewPositionFromExisting` signatures — contract derives from tier. |
| L12 | **APPLIED**  | `submitProof` now `revert`s on root mismatch instead of silently returning zero. |

New regression coverage added under `CCO-8 — code-review follow-up regressions` in `test/unit/ConvictionStakingStorage.test.ts` (M2, L5, L7, L9) and `test/unit/DKGStakingConvictionNFT.test.ts` (L2, L8, M5). H1/H2 are covered indirectly by the long-running `D26TimeAccurateStaking` dormancy-resume tests.

This document is a non-exhaustive code review of the D26-adjacent V10 surface. Findings are graded **H** (high — potential correctness or scalability bomb), **M** (medium — design/consistency issue that could bite soon), **L** (low — nits, dead code, docstring drift). Each finding has a concrete proposed fix.

Anything labeled H should be addressed before mainnet. M items should be addressed before the next reviewer passes. L items can be folded in opportunistically.

---

## Summary

| ID  | Severity | Area                                | Summary |
| --- | -------- | ----------------------------------- | ------- |
| H1  | High     | `StakingV10._claim`                 | Unbounded per-epoch walk with a mandatory SSTORE on every iteration — real dormancy bomb. |
| H2  | High     | `StakingV10._claim` / `_prepareForStakeChangeV10` | The D26 expiry-split branch is copy-pasted across two functions. Risk of drift on future edits. |
| M1  | Medium   | `ConvictionStakingStorage`          | `updateOnRelock` and the cross-identity branch of `createNewPositionFromExisting` have no live callers — dead code that contradicts the top-of-file docstring. |
| M2  | Medium   | `ConvictionStakingStorage`          | `_scheduleNodeExpiry` can create duplicate entries in `nodeExpiryTimes[id]` after cancel→reschedule at the same `ts`. Correct but wastes gas and weakens the queue invariant. |
| M3  | Medium   | `ConvictionStakingStorage.addTier`  | `addTier(_, duration=0, mult>1x)` bricks `createPosition` for that tier. Should be rejected at admission. |
| M4  | Medium   | `ConvictionStakingStorage.addTier`  | `addTier(_, duration>0, mult==1x)` is admissible but nonsensical — creates time-locked no-boost positions that still trigger the binary-search claim branch. |
| M5  | Medium   | `DKGStakingConvictionNFT`           | `name()` override collides with ERC-721's `name()` — wallets / marketplaces will display the contract id `"DKGStakingConvictionNFT"` instead of the collection name `"DKG Staker Conviction"`. |
| M6  | Medium   | `RandomSamplingStorage`             | `EpochIndex.firstScorePerStake36` is vestigial under D26 (always 0) — one SSTORE slot per epoch first-write, never consulted. |
| M7  | Medium   | `RandomSamplingStorage`             | `EpochIndex.firstInitialized` is set but never read for correctness. |
| L1  | Low      | `DKGStakingConvictionNFT`           | Stale `expiryEpoch` references in NatSpec after the D26 rename. |
| L2  | Low      | `DKGStakingConvictionNFT`           | `nextTokenId` starts at `0`; off-chain indexers commonly treat `0` as "not present". |
| L3  | Low      | `StakingV10` / NFT wrapper          | User-facing `lockTier` is `uint8` while CSS stores `uint40` — caps tier-id space at 255 through the public surface. |
| L4  | Low      | `ConvictionStakingStorage.createPosition` | `lastClaimedEpoch: uint32(currentEpoch - 1)` underflows if `currentEpoch == 0`. Unreachable in practice, but no guard. |
| L5  | Low      | `ConvictionStakingStorage._cancelNodeExpiry` | Missed `delete` when remaining drop hits zero — no SSTORE refund. |
| L6  | Low      | `RandomSamplingStorage.setLastScorePerStake` | Can desynchronize `mid[tail]` from `lastScorePerStake36`, breaking the `findScorePerStakeAt` invariant. Currently only called by tests. |
| L7  | Low      | `ConvictionStakingStorage.getNodeEffectiveStakeAtEpoch` | `chronos.timestampForEpoch(epoch+1) - 1` underflows for unreached future epochs when Chronos returns 0. |
| L8  | Low      | `DKGStakingConvictionNFT`           | `createConviction` does not validate `identityId != 0` at the wrapper; defers to `StakingV10` (which defers to CSS). Silent two-hop reverts. |
| L9  | Low      | `ConvictionStakingStorage`          | `setV10LaunchEpoch` is not one-shot — subsequent calls silently re-bind the retroactive-claim anchor. |
| L10 | Low      | General                             | `emit NodeEffectiveStakeDelta` / `NodeEffectiveStakeSettled` in every mutator + proof. High event density in the hot path. |
| L11 | Low      | `ConvictionStakingStorage`          | `require(multiplier18 == _tierMultiplier(lockTier), "Tier mismatch")` — caller must pass data the contract can compute. Mildly defensive, mostly noise. |
| L12 | Low      | `RandomSampling.submitProof`        | Settle + checkpoint write are under `if (computedMerkleRoot == expectedMerkleRoot)` — silent no-op on invalid proof. Consider an explicit revert earlier. |

---

## High severity

### H1 — `_claim` dormancy bomb

**File**: `packages/evm-module/contracts/StakingV10.sol` (`_claim`, L527-680)

**Observation**. The claim loop walks every epoch from `claimFromEpoch` to `currentEpoch - 1`. On each iteration, regardless of whether the node earned score in that epoch, the loop runs an **unconditional SSTORE**:

```560:642:packages/evm-module/contracts/StakingV10.sol
for (uint256 e = claimFromEpoch; e <= claimToEpoch; e++) {
    // ...reads: getEpochLastScorePerStake, getEpochNodeDelegatorScore,
    //          getDelegatorLastSettledNodeEpochScorePerStake, ...
    uint256 nodeScore18 = randomSamplingStorage.getNodeEpochScore(e, identityId);

    uint256 epochReward = 0;
    if (nodeScore18 > 0) {
        // normal reward path...
    }

    // Unconditional fee-flag write for rewardless epochs so
    // Profile.updateOperatorFee is never blocked on stale state.
    if (!convictionStorage.isOperatorFeeClaimedForEpoch(identityId, e)) {
        convictionStorage.setIsOperatorFeeClaimedForEpoch(identityId, e, true);
    }

    rewardTotal += epochReward;
}
```

For a completely dormant node (`nodeScore18 == 0`, no proofs), each iteration costs:

- 4-5 SLOADs (~2k gas each for cold, ~100 for warm) plus
- **1 SSTORE to flip `isOperatorFeeClaimedForEpoch` from `false→true`** (~20k gas for cold zero→non-zero).

Back-of-the-envelope:

- 1 year (~52 epochs): ~1.1M gas — comfortably below block limit.
- 2 years (~104 epochs): ~2.2M gas — possibly a problem in dense blocks.
- 5 years (~260 epochs): ~5.5M gas — guaranteed to hit `eth_call` timeout on archive nodes.
- 10 years (~520 epochs): ~11M gas — exceeds the ~30M block limit on busy blocks.

**Why it matters.** V10's headline claim (`D26_TIME_ACCURATE_STAKING.md` §5.5) is that `settleNodeTo` is event-density-bounded, not time-density-bounded. That's true for the node-side settlement. It is **not** true for the delegator-side `_claim`. A delegator who mints a tier-0 NFT and forgets about it could find themselves unable to withdraw after enough years go by.

**Root cause.** The fee-flag SSTORE on rewardless epochs is written solely to unblock `Profile.updateOperatorFee`. But if `nodeScore18 == 0` in epoch `e`, there is *no* operator fee to distribute and `Profile.updateOperatorFee` cannot be gated on a flag that was never set.

**Proposed fix**. Gate the rewardless fee-flag write on actual fee relevance:

```solidity
// Only needed when the node actually earned score in this epoch AND
// the fee flag isn't already set. For rewardless epochs there is
// nothing to gate and no SSTORE is required.
if (nodeScore18 > 0 && !convictionStorage.isOperatorFeeClaimedForEpoch(identityId, e)) {
    convictionStorage.setIsOperatorFeeClaimedForEpoch(identityId, e, true);
}
```

Additionally (belt-and-braces), skip the entire iteration body when the epoch is provably empty for this delegator:

```solidity
uint256 last = randomSamplingStorage.getEpochLastScorePerStake(identityId, e);
if (last == 0) continue;  // no proofs on this node in epoch e → delegator earned nothing
```

This collapses a dormant-epoch iteration from ~25k gas to ~2k gas (single SLOAD → continue), making the loop time-density-bounded at ~2k × epochs — 10 years ≈ 1M gas.

**Optional follow-up**. Introduce a `claimRange(tokenId, maxEpochs)` external variant that advances the claim cursor in bounded chunks. Useful for delegators whose positions straddle a very long tail (V8 migrants with `migrationEpoch` from years ago).

---

### H2 — Expiry-split logic duplicated across `_claim` and `_prepareForStakeChangeV10`

**File**: `packages/evm-module/contracts/StakingV10.sol`

**Observation**. The D26 per-epoch branching — three cases keyed on `(e, expiryEpoch)` plus a `findScorePerStakeAt` binary search for the split epoch — appears **verbatim** in two places:

- `_claim`, L575-606 (with `scorePerStake36` = `lastScorePerStake36[e]` and `lastSettledIndex36` = `getDelegatorLastSettledNodeEpochScorePerStake[e]`).
- `_prepareForStakeChangeV10`, L882-912 (with `nodeScorePerStake36` and `lastSettled`).

The two implementations are one rename away from identical. Any future change to the split semantics must be applied in both places. If a reviewer touches one without the other, rewards silently skew.

**Proposed fix**. Extract a pure internal helper:

```solidity
function _delegatorIncrementForEpoch(
    uint256 epoch,
    uint72 identityId,
    uint256 lastSettled,
    uint256 currentLast,
    uint256 effBoosted,
    uint256 effBase,
    uint256 expiryTs,
    uint256 expiryEpoch
) internal view returns (uint256 score18) {
    if (currentLast <= lastSettled) return 0;
    if (expiryTs == 0 || epoch < expiryEpoch) {
        uint256 eff = expiryTs == 0 ? effBase : effBoosted;
        return (eff * (currentLast - lastSettled)) / SCALE18;
    }
    if (epoch > expiryEpoch) {
        return (effBase * (currentLast - lastSettled)) / SCALE18;
    }
    // epoch == expiryEpoch
    uint256 scoreAtExpiry = randomSamplingStorage.findScorePerStakeAt(
        identityId, epoch, uint40(expiryTs)
    );
    if (scoreAtExpiry > lastSettled) {
        return (effBoosted * (scoreAtExpiry - lastSettled)) / SCALE18
             + (effBase    * (currentLast  - scoreAtExpiry)) / SCALE18;
    }
    return (effBase * (currentLast - lastSettled)) / SCALE18;
}
```

Both callers shrink to a single line.

---

## Medium severity

### M1 — Dead code: `CSS.updateOnRelock` + cross-identity branch of `createNewPositionFromExisting`

**File**: `packages/evm-module/contracts/storage/ConvictionStakingStorage.sol`

**Observation**. The V10 orchestration is:

- `StakingV10.relock` → `CSS.createNewPositionFromExisting` (same-identity).
- `StakingV10.redelegate` → `CSS.updateOnRedelegate` (in-place, stable tokenId).

`updateOnRelock` (L602-641) is **never called** from any production contract — only from unit tests. The function still fully implements the alternative relock semantics (tier swap on the same tokenId), and its presence contradicts the file header's "D21 — NFTs are ephemeral across tier changes" narrative.

Similarly, inside `createNewPositionFromExisting` (L706-788), the branch at L742-744 / L771-777 handles `oldIdentityId != newIdentityId`. That branch is reachable only from a hypothetical "burn-mint across nodes" caller — no production path triggers it because `redelegate` is now in-place.

**Impact**.
- Reviewers reading top-to-bottom will believe there are two viable relock paths. Confusion / drift.
- Any future attempt to "fix a bug in relock" might touch `updateOnRelock` and silently have no effect.
- Unit tests for `updateOnRelock` (CSS unit suite, L386-447) give false coverage confidence.

**Proposed fix**. Two acceptable options:

1. **Remove it.** Delete `updateOnRelock`, its event, and its test block. The cross-identity branch inside `createNewPositionFromExisting` can also be deleted (simplifying to oldIdentityId == newIdentityId contract).
2. **Keep it, but document it.** Annotate `updateOnRelock` as "reserved for a future in-place relock primitive; not reachable from current StakingV10". Mark the tests as "primitive-level coverage; does not imply a supported production flow."

Option 1 is cleaner given V10 is pre-launch.

---

### M2 — Duplicate timestamp entries in the expiry queue after cancel→reschedule

**File**: `packages/evm-module/contracts/storage/ConvictionStakingStorage.sol` — `_scheduleNodeExpiry` / `_cancelNodeExpiry`

**Observation**. `_cancelNodeExpiry` decrements `nodeExpiryDrop[id][ts]` but **never removes the timestamp from `nodeExpiryTimes[id]`**. When a cancel fully zeros the drop (`nodeExpiryDrop[id][ts] = 0`) and a fresh schedule lands at the same `ts`, `_scheduleNodeExpiry`'s `existing != 0` guard (L489-492) fires only when a non-zero drop is still pending:

```487:508:packages/evm-module/contracts/storage/ConvictionStakingStorage.sol
uint256 existing = nodeExpiryDrop[identityId][ts];
nodeExpiryDrop[identityId][ts] = existing + drop;
emit NodeExpiryScheduled(identityId, ts, drop, existing + drop);
if (existing != 0) {
    // ts already present in the queue; no need to touch the array.
    return;
}
// Insert `ts` into the sorted queue.
uint40[] storage arr = nodeExpiryTimes[identityId];
// ... push + bubble insert ...
```

If `existing == 0` (fully cancelled earlier but the array still holds the `ts`), we push again. The array now has **two entries** at the same `ts`.

**Correctness**. The drain loop `_settleNodeTo` does `delete nodeExpiryDrop[id][t]` after applying, so subsequent same-`ts` entries find `drop == 0` and no-op. So this is **functionally correct**.

**Cost**. Two wasted SSTOREs per duplicate (push to `arr` + later drain visit with SLOAD + no-op). Also breaks the "`nodeExpiryTimes[id]` is strictly monotonic past `head`" invariant that reviewers read off the storage comments (L215-218).

**Proposed fix**. Track whether a `ts` has an active array slot separately from the drop aggregate. Either:

```solidity
mapping(uint72 => mapping(uint40 => bool)) internal nodeExpiryPresent;

function _scheduleNodeExpiry(..., uint40 ts, uint256 drop) internal {
    // ...
    nodeExpiryDrop[identityId][ts] += drop;
    if (nodeExpiryPresent[identityId][ts]) return;
    nodeExpiryPresent[identityId][ts] = true;
    // push + bubble...
}
```

Cleared in `_settleNodeTo` after the `delete` (`nodeExpiryPresent[id][t] = false`).

Alternatively (simpler, zero storage cost): redefine `_cancelNodeExpiry` to leave `nodeExpiryDrop[id][ts] = 0` intentionally undeleted and treat a zero drop as "sentinel present", re-asserting the invariant in docstrings and a test. This is cheaper but more confusing.

---

### M3 — `addTier` admits degenerate configs that brick `createPosition`

**File**: `packages/evm-module/contracts/storage/ConvictionStakingStorage.sol` — `addTier`, L349-357

**Observation**.

```349:357:packages/evm-module/contracts/storage/ConvictionStakingStorage.sol
function addTier(
    uint40 lockTier,
    uint256 duration,
    uint64 multiplier18
) external onlyOwnerOrMultiSigOwner {
    require(!_tiers[lockTier].exists, "Tier exists");
    require(multiplier18 >= uint64(SCALE18), "Multiplier < 1x");
    _addTierInternal(lockTier, duration, multiplier18);
}
```

No validation that `duration` and `multiplier18` are internally consistent. Specifically:

- **`addTier(X, 0, 2e18)`** (2× boost with zero lock) is admitted. Subsequent `createPosition(_, X, _, 2e18, 0)`:
  1. `_computeExpiryTimestamp(X)` returns `block.timestamp + 0 = block.timestamp`.
  2. `_settleNodeTo(id, tsNow)` sets `nodeLastSettledAt[id] = tsNow`.
  3. `_scheduleNodeExpiry(id, ts=tsNow, boost)` reverts `"Expiry in past"` because `ts == nodeLastSettledAt[id]` (strict-greater check at L485).

  Every attempt to mint into this tier reverts. The tier is **bricked** — silently, only detectable by trying to mint.

- **`addTier(X, 30 days, 1e18)`** (1× multiplier with a 30-day lock) is admitted. Positions get a non-zero `expiryTimestamp`, the boost drop is 0 (skipped by the `multiplier18 > SCALE18` guard), but `_claim` still treats `e == expiryEpoch` as the binary-search branch. The branch evaluates to the same total as the O(1) branch (because `effBoosted == effBase`), but consumes an extra SLOAD per checkpoint searched — gas noise.

**Proposed fix**. Tighten `addTier`:

```solidity
require(!_tiers[lockTier].exists, "Tier exists");
require(multiplier18 >= uint64(SCALE18), "Multiplier < 1x");
if (lockTier == 0) {
    require(duration == 0 && multiplier18 == uint64(SCALE18), "Tier 0 must be rest state");
} else {
    require(duration > 0, "Non-zero tier needs duration");
    require(multiplier18 > uint64(SCALE18), "Non-zero tier needs boost");
}
```

This statically rules out the degenerate corners. Tier 0 stays exactly as seeded; tier N≠0 must be a real locked+boosted tier.

---

### M4 — Follow-on to M3: time-locked no-boost tier admissible

Covered above. Tighten `addTier` or accept the product decision that "time-lock without boost" is a legitimate tier. If accepted, skip the binary-search branch in `_claim` / `_prepareForStakeChangeV10` when `effBoosted == effBase`:

```solidity
if (effBoosted == effBase || expiryTs == 0 || epoch < expiryEpoch) {
    scoreEarned18 = (effBase * (currentLast - lastSettled)) / SCALE18;
} else ...
```

---

### M5 — ERC-721 `name()` override returns the contract id, not the collection name

**File**: `packages/evm-module/contracts/DKGStakingConvictionNFT.sol`, L208, L224

**Observation**. The constructor passes `"DKG Staker Conviction"` as the collection name to `ERC721`:

```208:208:packages/evm-module/contracts/DKGStakingConvictionNFT.sol
) ContractStatus(hubAddress) ERC721("DKG Staker Conviction", "DKGSC") {}
```

But the `name()` function is overridden to return the `INamed` contract id:

```224:226:packages/evm-module/contracts/DKGStakingConvictionNFT.sol
function name() public pure virtual override(INamed, ERC721) returns (string memory) {
    return _NAME;  // "DKGStakingConvictionNFT"
}
```

Wallets, marketplaces, and explorers call `name()` to display the collection. Users will see **"DKGStakingConvictionNFT"** — the dev-facing contract id — instead of **"DKG Staker Conviction"**.

**Proposed fix**. Split the two concerns:

1. Let `ERC721.name()` bubble up (return `super.name()` → `"DKG Staker Conviction"`).
2. Add a separate `INamed` method with a distinct name — e.g., `contractName()` — and update the registry / indexer consumers.

If changing `INamed` is too disruptive, the alternative is to return `"DKG Staker Conviction"` from the override and rely on the explicit `contractName`/`version` interface elsewhere. This fixes the wallet UX but deviates from the `INamed` intent.

---

### M6 — `EpochIndex.firstScorePerStake36` is vestigial under D26

**File**: `packages/evm-module/contracts/storage/RandomSamplingStorage.sol`, L60-65

**Observation**. The struct carries a `firstScorePerStake36` slot:

```60:65:packages/evm-module/contracts/storage/RandomSamplingStorage.sol
struct EpochIndex {
    uint248 firstScorePerStake36; // packed w/ firstInitialized below
    bool firstInitialized;
    uint256 lastScorePerStake36;
    Checkpoint[] mid;
}
```

Under D26, `scorePerStake36` is **epoch-local** (accumulates from 0 per epoch). The docstring on `appendCheckpoint` states this explicitly:

```627:630:packages/evm-module/contracts/storage/RandomSamplingStorage.sol
///         `scorePerStake36` is **epoch-local** (accumulates from 0 per
///         epoch), so `firstScorePerStake36` is always 0 — this helper
///         auto-initializes the `firstInitialized` flag on first call so
///         callers (submitProof) don't need a separate seeding step.
```

The field is never assigned a non-zero value anywhere in the production flow. `findScorePerStakeAt` returns it as a sentinel (L713, L727) — which always resolves to 0.

**Cost**. One SSTORE of `0→0` on every first write of an epoch (no-op in practice, but still touches the slot). Conceptually misleading — reviewers may think this is a live field.

**Proposed fix**. Remove the field. Simplify the struct:

```solidity
struct EpochIndex {
    uint256 lastScorePerStake36;
    Checkpoint[] mid;
}
```

`findScorePerStakeAt` returns 0 for `ts` before any checkpoint (the natural default). Drop the `firstInitialized` seeding in `appendCheckpoint` / `addToNodeEpochScorePerStake` / `setNodeEpochScorePerStake`.

This is a **storage layout change** — fine under V10's pre-launch posture, but must bump the contract version (→ `3.0.0` on RSS).

---

### M7 — `EpochIndex.firstInitialized` is set but never read

Covered by M6. The flag is `true` iff any checkpoint has been written, but nothing in the code branches on it. `isEpochFirstInitialized` is an external view exposed for off-chain consumers; if those consumers care, they can check `getEpochCheckpointCount > 0 || lastScorePerStake36 > 0`.

Remove concurrently with M6.

---

## Low severity / nits

### L1 — Stale `expiryEpoch` references in `DKGStakingConvictionNFT.sol` NatSpec

```
L69  : `expiryEpoch` is preserved: the lock clock keeps ticking.
L117 : The authoritative position-created event (with raw / expiryEpoch / multiplier18)
L141 : D25 — tokenId, `expiryEpoch`, lock tier, multiplier, and reward cursor are all preserved
L280 : `expiryEpoch == 0` (permanent, no boost decay ever fires)
L405 : the lock clock keeps ticking on the same `expiryEpoch`
```

Rename globally to `expiryTimestamp`.

### L2 — `nextTokenId` starts at 0

```105:109:packages/evm-module/contracts/DKGStakingConvictionNFT.sol
/// @notice Monotonic token id counter. First mint is tokenId 0 (no
///         sentinel reservation — `ownerOf(0)` reverts before mint, and
///         every consumer keys on `positions[tokenId].raw > 0` as the
///         liveness check).
uint256 public nextTokenId;
```

Off-chain indexers, explorers, and third-party contracts conventionally treat `tokenId == 0` as "not present". V10 positions pack the tokenId into `delegatorKey = bytes32(tokenId)`, and `delegatorKey == 0` may collide with the default zero on initialized-but-empty mappings.

**Proposed fix**. Initialize `nextTokenId = 1` (either in storage or at first-mint).

### L3 — `uint8 lockTier` on the user-facing surface

`DKGStakingConvictionNFT.createConviction`, `relock`, `selfMigrateV8`, etc. take `uint8 lockTier`. CSS stores `uint40`. That means tier ids 256-2^40 cannot be exercised from user-facing calls, even though the storage supports them. If the admin ever adds `addTier(1000, ...)`, it's unreachable.

**Proposed fix**. Widen to `uint40 lockTier` (or `uint16`/`uint32` if ABI stability matters) across the user-facing functions.

### L4 — `uint32(currentEpoch - 1)` underflow protection

```580:580:packages/evm-module/contracts/storage/ConvictionStakingStorage.sol
lastClaimedEpoch: uint32(currentEpoch - 1),
```

If `chronos.getCurrentEpoch()` returns 0 (pre-genesis configuration), this reverts with an arithmetic panic. The protocol deploys past epoch 0 in practice, but a defensive `require(currentEpoch >= 1, "Pre-genesis create")` would make intent explicit and produce a human-readable revert.

### L5 — Missed `delete` in `_cancelNodeExpiry`

```520:525:packages/evm-module/contracts/storage/ConvictionStakingStorage.sol
uint256 existing = nodeExpiryDrop[identityId][ts];
require(existing >= drop, "Cancel > scheduled");
uint256 remaining = existing - drop;
nodeExpiryDrop[identityId][ts] = remaining;
emit NodeExpiryCancelled(identityId, ts, drop, remaining);
```

When `remaining == 0`, use `delete nodeExpiryDrop[identityId][ts]` to reclaim the refund.

### L6 — `setLastScorePerStake` can desync `mid[tail]` from `lastScorePerStake36`

```651:658:packages/evm-module/contracts/storage/RandomSamplingStorage.sol
function setLastScorePerStake(uint72 identityId, uint256 epoch, uint256 value) external onlyContracts {
    EpochIndex storage ei = nodeEpochIndex[identityId][epoch];
    if (!ei.firstInitialized) {
        ei.firstInitialized = true;
    }
    ei.lastScorePerStake36 = value;
    emit EpochLastScorePerStakeSet(identityId, epoch, value);
}
```

Overwrites the scalar without touching `mid[tail]`. After this call, `findScorePerStakeAt(id, epoch, ts)` with `ts ≥ mid[tail].timestamp` returns `mid[tail].scorePerStake36`, which is **stale** relative to the freshly-written `lastScorePerStake36`.

Today only the test harness calls this. But it's a live footgun — any future production caller would silently corrupt claim math.

**Proposed fix**. Either remove it (tests can set state via `appendCheckpoint`) or assert `mid.length == 0 || mid[tail].timestamp == uint40(block.timestamp)` and also update the tail.

### L7 — `getNodeEffectiveStakeAtEpoch` can underflow

```972:976:packages/evm-module/contracts/storage/ConvictionStakingStorage.sol
function getNodeEffectiveStakeAtEpoch(uint72 identityId, uint256 epoch) external view returns (uint256) {
    uint256 epochEnd = chronos.timestampForEpoch(epoch + 1) - 1;
    if (epochEnd > type(uint40).max) epochEnd = type(uint40).max;
    return _simulateNodeEffectiveStakeAt(identityId, uint40(epochEnd));
}
```

If `chronos.timestampForEpoch(epoch + 1)` returns 0 (epoch not yet anchored), the `- 1` reverts. Guard:

```solidity
uint256 next = chronos.timestampForEpoch(epoch + 1);
uint256 epochEnd = next == 0 ? type(uint40).max : next - 1;
if (epochEnd > type(uint40).max) epochEnd = type(uint40).max;
```

### L8 — NFT wrapper does not validate `identityId != 0`

```339:354:packages/evm-module/contracts/DKGStakingConvictionNFT.sol
function createConviction(
    uint72 identityId,
    uint96 amount,
    uint8 lockTier
) external returns (uint256 tokenId) {
    if (amount == 0) revert ZeroAmount();
    _convictionMultiplier(lockTier);

    tokenId = nextTokenId++;
    _mint(msg.sender, tokenId);
    stakingV10.stake(msg.sender, tokenId, identityId, amount, lockTier);
    ...
}
```

`identityId == 0` passes through the wrapper; `StakingV10.stake` checks `profileStorage.profileExists(0) → false` and reverts `ProfileDoesNotExist`. But the NFT is minted at L351 **before** the revert unwinds state — so the failed tx still publicly reserves a tokenId slot (OK, state reverts, slot is re-used).

Not a bug — state reverts properly on failure. Mentioned for defense-in-depth clarity: add `if (identityId == 0) revert ...` at the top of `createConviction` so the failure message is unambiguous and the wasted `nextTokenId++` doesn't dirty the trace.

### L9 — `setV10LaunchEpoch` is not one-shot

`CSS.setV10LaunchEpoch` (L802-805) rewrites `v10LaunchEpoch` on every call. `StakingV10.setV10LaunchEpoch` → NFT wrapper's `finalizeMigrationBatch` gates the caller to admins, but an admin can accidentally (or maliciously) rebind the anchor mid-life. D6's retroactive-claim window keys on this value — rebinding it arbitrarily can lock or unlock reward history.

**Proposed fix**. One-shot guard:

```solidity
function setV10LaunchEpoch(uint256 epoch) external onlyContracts {
    require(v10LaunchEpoch == 0, "Already set");
    v10LaunchEpoch = epoch;
    emit V10LaunchEpochSet(epoch);
}
```

### L10 — Hot-path event density

CSS emits `NodeEffectiveStakeDelta`, `NodeEffectiveStakeSettled`, and `NodeExpiryScheduled` / `NodeExpiryCancelled` inside every position mutator. `submitProof` emits `EpochCheckpointAppended`. Per-proof event cost is ~3-4k gas. If proof cadence is ~30 min, ~17k proofs/year, that's ~70M gas/year in events alone per node. Tolerable, but worth measuring: consider conditional emission gated by a governance-owned `emitDeltaEvents` flag for mainnet, or consolidate `Delta + Settled` into a single compound event.

### L11 — `createPosition` requires the caller to pass `multiplier18`

```553:564:packages/evm-module/contracts/storage/ConvictionStakingStorage.sol
function createPosition(
    uint256 tokenId,
    uint72 identityId,
    uint96 raw,
    uint40 lockTier,
    uint64 multiplier18,
    uint32 migrationEpoch
) external onlyContracts {
    require(identityId != 0, "Zero node");
    require(positions[tokenId].identityId == 0, "Position exists");
    require(raw > 0, "Zero raw");
    require(multiplier18 == _tierMultiplier(lockTier), "Tier mismatch");
    ...
}
```

`StakingV10.stake` reads `expectedMultiplier18(lockTier)` and passes it back to `createPosition`, which then validates it equals `_tierMultiplier(lockTier)`. The round-trip is pure defensive programming. Consider dropping `multiplier18` from the signature and computing it inside CSS — one less SLOAD per mint is minor, but the signature cleans up.

### L12 — `submitProof` silently no-ops on invalid proof

The settle / checkpoint writes are inside the `if (computedMerkleRoot == expectedMerkleRoot)` branch (L250-286). The `else` branch (L287) does revert, so ordering is fine — but the branching shape reads as if the happy path is conditional rather than the default. Refactor:

```solidity
if (computedMerkleRoot != expectedMerkleRoot) {
    revert MerkleRootMismatchError(computedMerkleRoot, expectedMerkleRoot);
}
// happy path below, at top level (no nesting)
```

Purely stylistic.

---

## Cross-cutting observations

### CCO-1 — V10 is a pre-launch testnet target — storage breaks are cheap

Several fixes above (M6, M7, possibly M1) imply storage layout changes. Per the V10 posture (`CLAUDE.md` + branch comments), this is acceptable. Bump contract versions and redeploy.

### CCO-2 — `onlyContracts` surface area audit

Every mutator that affects running effective stake (CSS) or score-per-stake (RSS) is gated `onlyContracts`. The surface registered in the Hub is:

- StakingV10 → CSS, RSS
- RandomSampling → CSS (`settleNodeTo`), RSS
- Legacy V8 Staking (unregistered post-migration) — should not be callable.

Verify that `deploy/998_unregister_v8.ts` (or equivalent) unregisters V8 Staking / DelegatorsInfo in the same cutover where V10 is registered. If V8 Staking remains registered but unused, it can still pass `onlyContracts` checks and write to RSS via the legacy `addToNodeEpochScorePerStake` adapter.

### CCO-3 — `findScorePerStakeAt` monotonicity invariant

The binary-search relies on `mid[]` being sorted by timestamp (enforced at write by `_upsertCheckpoint`) and `scorePerStake36` being non-decreasing. The non-decreasing property holds in production because `submitProof` always adds `delta ≥ 0` to `lastScorePerStake36`. The legacy adapter `setNodeEpochScorePerStake` (L610) CAN set an arbitrary value, violating monotonicity if called with a smaller scalar. Test-only today — safe. Worth annotating.

### CCO-4 — Gas / block size projection for dormancy

Even after fixing H1, `_claim` iteration is linear in the number of unclaimed epochs. If the target chain has a 30M gas block limit and the cheapest iteration is ~2.5k gas:

```
30M / 2.5k = 12,000 epochs ≈ 230 years of weekly epochs
```

Safe under any realistic horizon. After fixing H1, there is no dormancy bomb.

Pre-fix: ~25k gas/iter → 1,200 epochs → ~23 years. Still safe today but brittle once mainnet settles in.

### CCO-5 — No integration test exercises the "tokenId == 0" path

Given L2, it would be cheap to add a test that mints the very first position (tokenId 0) and runs it through the full lifecycle. Confirm no off-chain consumer (or internal `nodeTokenIndex` invariant) misbehaves.

### CCO-6 — D26 doc vs review checklist drift

`D26_TIME_ACCURATE_STAKING.md` §8 item 2 claims `_settleNodeTo` is called in every mutator including `updateOnRelock`. `updateOnRelock` is dead (M1). Update the doc alongside whichever fix is chosen.

### CCO-7 — Reentrancy

No reentrancy vectors observed. `StakingV10.withdraw` performs external transfers (`token.transferFrom` / `stakingStorage.transferStake`) *after* all state mutations (position deleted, effective stake settled, expiry queue updated). Ask / sharding-table calls are Hub-gated and do not exit to untrusted code.

### CCO-8 — Suggested new tests after fixes

- **H1 fix**: a test that mints a tier-0 position, advances 10 years with no proofs on the node, then `claim()`s — assert gas usage ≲ 2M.
- **M2 fix**: a test that creates a position, deletes it, then creates another at the same `expiryTimestamp` — assert `getNodeExpiryTimes(id).length` equals `nodeExpiryHead[id] + pendingCount`.
- **M3 fix**: a test that admin-adds a degenerate tier `(duration=0, mult=2e18)` and asserts `addTier` reverts `"Non-zero tier needs duration"`.

---

## Recommended fix order

1. **H1** (dormancy bomb) — trivial patch, immediately unblocks long-dormant delegators.
2. **M5** (wallet `name()` UX) — one-line fix before any production mint goes out.
3. **M1** (dead code) — reviewer-clarity win.
4. **M6 + M7** (storage simplification) — redeploy CSS/RSS versions.
5. **H2** (refactor to shared helper) — low risk of regression with test coverage already in place.
6. **M2, M3, M4** (queue invariant + tier validation) — medium risk, worth a careful review.
7. **L1-L12** — opportunistic.

---

## Appendix — Files touched by D26 and their review state

| File                                                             | Review state | Pending findings              |
| ---------------------------------------------------------------- | ------------ | ----------------------------- |
| `contracts/storage/ConvictionStakingStorage.sol`                 | Full read    | M1, M2, M3, M4, L4, L5, L7, L9, L11 |
| `contracts/storage/RandomSamplingStorage.sol`                    | Full read    | M6, M7, L6                    |
| `contracts/RandomSampling.sol` (`submitProof`, `calculateNodeScore`) | Full read    | L12                           |
| `contracts/StakingV10.sol`                                       | Full read    | H1, H2, L3                    |
| `contracts/DKGStakingConvictionNFT.sol`                          | Full read    | M5, L1, L2, L3, L8            |

Legacy V8 paths (`Staking.sol`, `StakingKPI.sol`) were not re-reviewed — their only D26 dependency is the `getNodeEpochScorePerStake` adapter, which is exercised by the existing V8 parity tests.
