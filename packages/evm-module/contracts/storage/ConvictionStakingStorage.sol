// SPDX-License-Identifier: Apache-2.0

pragma solidity ^0.8.20;

import {Chronos} from "./Chronos.sol";
import {HubDependent} from "../abstract/HubDependent.sol";
import {INamed} from "../interfaces/INamed.sol";
import {IVersioned} from "../interfaces/IVersioned.sol";

contract ConvictionStakingStorage is INamed, IVersioned, HubDependent {
    string private constant _NAME = "ConvictionStakingStorage";
    // Phase 5 bumps to 1.2.0:
    //   - 1.1.0: rewards bucket on `Position`, three split-bucket mutators
    //     (increaseRewards / decreaseRewards / decreaseRaw), and the
    //     discrete tier ladder {0,1,3,6,12}.
    //   - 1.2.0: V10-native pending-withdrawal storage for the
    //     decrement-at-request model (`pendingWithdrawals` mapping +
    //     create/delete/get) plus the `increaseRaw` symmetric counterpart
    //     used by `StakingV10.cancelWithdrawal`.
    string private constant _VERSION = "1.2.0";

    // Multiplier scale, matches DKGStakingConvictionNFT._convictionMultiplier
    // (returns 1e18-scaled values so fractional tiers like 1.5x and 3.5x
    // are representable).
    uint256 internal constant SCALE18 = 1e18;

    // Position layout (two storage slots — Phase 5 split-bucket model):
    //   slot 1: raw(96) + lockEpochs(40) + expiryEpoch(40) + identityId(72) = 248 bits
    //   slot 2: rewards(96) + multiplier18(64) + lastClaimedEpoch(64)        = 224 bits
    // Slot 1 is unchanged from the Phase 2 layout so existing field offsets
    // and the effective-stake diff code continue to read through to the
    // same slot without any storage-layout churn.
    //
    // `raw`     — principal, locked pre-expiry, earns multiplier pre-expiry
    //             and drops back to 1x on `expiryEpoch`.
    // `rewards` — compounded rewards, withdrawable anytime via the NFT,
    //             ALWAYS contributes at 1x (no multiplier, no expiry drop).
    //             Populated by `increaseRewards` on `claim`, drained by
    //             `decreaseRewards` on partial/full rewards withdrawal.
    // `multiplier18` is 1e18-scaled; max tier 6e18 fits comfortably in uint64.
    // `lastClaimedEpoch` is a Chronos epoch number; uint64 holds ~5.8e11 years.
    struct Position {
        uint96 raw;
        uint40 lockEpochs;
        uint40 expiryEpoch;
        uint72 identityId;
        // slot 2 — `rewards` is declared first so it aligns at a slot
        //          boundary; see layout comment above.
        uint96 rewards;
        uint64 multiplier18;
        uint64 lastClaimedEpoch;
    }

    // Phase 5 — V10-native pending withdrawal storage.
    //
    // Lives on this contract instead of `StakingStorage.withdrawals` so the
    // Phase 5 NFT path owns its own withdrawal metadata end-to-end. The V8
    // `StakingStorage.withdrawals` mapping is unaffected and continues to
    // serve the legacy address-keyed flow.
    //
    // Layout (single slot, ~256 bits):
    //   - amount:         uint96  (raw + rewards portion; the value debited from
    //                              the position at request time)
    //   - rewardsPortion: uint96  (the rewards-side share of `amount`; raw share
    //                              is implicit as `amount - rewardsPortion`)
    //   - releaseAt:      uint64  (Unix timestamp at which finalize is allowed)
    //
    // Decrement-at-request semantics: `createPendingWithdrawal` is called by
    // `StakingV10.createWithdrawal` AFTER the position buckets, delegator
    // base, and node/total stake have already been decremented. `delete` is
    // called by both `cancelWithdrawal` (which restores everything) and
    // `finalizeWithdrawal` (which releases the TRAC).
    struct PendingWithdrawal {
        uint96 amount;
        uint96 rewardsPortion;
        uint64 releaseAt;
    }

    event PositionCreated(
        uint256 indexed tokenId,
        uint72 indexed identityId,
        uint96 raw,
        uint40 lockEpochs,
        uint40 expiryEpoch,
        uint64 multiplier18
    );
    event PositionRelocked(
        uint256 indexed tokenId,
        uint40 newLockEpochs,
        uint40 newExpiryEpoch,
        uint64 newMultiplier18
    );
    event PositionRedelegated(
        uint256 indexed tokenId,
        uint72 indexed oldIdentityId,
        uint72 indexed newIdentityId
    );
    event PositionDeleted(uint256 indexed tokenId);
    event LastClaimedEpochUpdated(uint256 indexed tokenId, uint64 epoch);
    // Phase 5 — split-bucket mutators. Emitted alongside the effective-stake
    // diff writes so off-chain indexers can follow the rewards bucket and
    // partial-raw-drain path without re-reading `positions[tokenId]`.
    event RewardsIncreased(uint256 indexed tokenId, uint96 amount, uint96 newRewards);
    event RewardsDecreased(uint256 indexed tokenId, uint96 amount, uint96 newRewards);
    event RawDecreased(uint256 indexed tokenId, uint96 amount, uint96 newRaw);
    // Phase 5 — V10-native decrement-at-request restoration mutator. Symmetric
    // counterpart of `RawDecreased`. Emitted by `cancelWithdrawal` when a
    // pending withdrawal is rolled back to the position.
    event RawIncreased(uint256 indexed tokenId, uint96 amount, uint96 newRaw);
    // Phase 5 — V10-native pending-withdrawal lifecycle events.
    event PendingWithdrawalCreated(
        uint256 indexed tokenId,
        uint96 amount,
        uint96 rewardsPortion,
        uint64 releaseAt
    );
    event PendingWithdrawalDeleted(uint256 indexed tokenId);
    event EffectiveStakeFinalized(uint256 startEpoch, uint256 endEpoch);
    event NodeEffectiveStakeFinalized(uint72 indexed identityId, uint256 startEpoch, uint256 endEpoch);

    Chronos public chronos;

    mapping(uint256 => Position) public positions;

    // Phase 5 — V10-native pending withdrawals, indexed by tokenId. Disjoint
    // from the V8 `StakingStorage.withdrawals` map (which is address-keyed).
    // Only one pending per tokenId at a time; create/cancel/finalize all gate
    // on `amount != 0` as the existence sentinel.
    mapping(uint256 => PendingWithdrawal) public pendingWithdrawals;

    mapping(uint256 => int256) public effectiveStakeDiff;
    mapping(uint256 => uint256) public totalEffectiveStakeAtEpoch;
    uint256 public lastFinalizedEpoch;
    // First epoch at which any diff has ever been written. Used by the finalize
    // loops to skip the all-zero prefix on a long-dormant deployment (avoids
    // the "first mutator on epoch N burns N iterations" gas bomb).
    uint256 public firstDirtyEpoch;

    mapping(uint72 => mapping(uint256 => int256)) public nodeEffectiveStakeDiff;
    mapping(uint72 => mapping(uint256 => uint256)) public nodeEffectiveStakeAtEpoch;
    mapping(uint72 => uint256) public nodeLastFinalizedEpoch;
    mapping(uint72 => uint256) public nodeFirstDirtyEpoch;

    // Phase 11 — per-node sum of V10 delegator bases (raw + rewards).
    // Updated at transaction time only (stake/claim/withdraw/redelegate/convert),
    // never at epoch boundaries. Used by RandomSampling.submitProof to compute
    //   effectiveNodeStake = nodeStake + (nodeEffective - nodeV10BaseStake)
    // so the denominator for score-per-stake separates the multiplier boost
    // from the underlying base commitment.
    mapping(uint72 => uint256) public nodeV10BaseStake;

    constructor(address hubAddress) HubDependent(hubAddress) {}

    function initialize() public onlyHub {
        chronos = Chronos(hub.getContractAddress("Chronos"));
    }

    function name() external pure virtual override returns (string memory) {
        return _NAME;
    }

    function version() external pure virtual override returns (string memory) {
        return _VERSION;
    }

    // ============================================================
    //                 Conviction tier ladder
    // ============================================================

    // Phase 5 discrete tier ladder. Valid lock set: {0, 1, 3, 6, 12}.
    // Any lock outside this set reverts — no tier snapping, no intermediate
    // locks. `lockEpochs == 0` is a storage-level sentinel for the permanent
    // 1x rest state (post-expiry positions and V8-compat defaults both land
    // here). `lockEpochs == 1` is the 1-month bootstrap tier at 1.5x.
    //
    // NOTE: `DKGStakingConvictionNFT._convictionMultiplier` uses exact-match
    // semantics aligned with this table. The legacy snap-down
    // `Staking.convictionMultiplier` has been deleted (Phase 11).
    function expectedMultiplier18(uint40 lockEpochs) public pure returns (uint64) {
        if (lockEpochs == 0) return uint64(SCALE18);              // rest state: 1.0x
        if (lockEpochs == 1) return uint64((15 * SCALE18) / 10);  // 1.5x
        if (lockEpochs == 3) return uint64(2 * SCALE18);          // 2.0x
        if (lockEpochs == 6) return uint64((35 * SCALE18) / 10);  // 3.5x
        if (lockEpochs == 12) return uint64(6 * SCALE18);         // 6.0x
        revert("Invalid lock");
    }

    // ============================================================
    //                        Mutators
    // ============================================================

    function createPosition(
        uint256 tokenId,
        uint72 identityId,
        uint96 raw,
        uint40 lockEpochs,
        uint64 multiplier18
    ) external onlyContracts {
        require(identityId != 0, "Zero node");
        require(positions[tokenId].raw == 0, "Position exists");
        require(raw > 0, "Zero raw");
        // Tier check subsumes "Bad multiplier" and "Lock0 must be 1x": the
        // ladder defines exactly one valid multiplier for every lock value
        // (including lock == 0 → 1x), so any deviation is a tier mismatch.
        require(multiplier18 == expectedMultiplier18(lockEpochs), "Tier mismatch");

        uint256 currentEpoch = chronos.getCurrentEpoch();
        uint40 expiryEpoch = lockEpochs == 0 ? 0 : uint40(currentEpoch) + lockEpochs;

        positions[tokenId] = Position({
            raw: raw,
            lockEpochs: lockEpochs,
            expiryEpoch: expiryEpoch,
            identityId: identityId,
            // Phase 5: rewards bucket starts at 0 and is populated by
            // `increaseRewards` on each `claim`. It tracks compounded
            // rewards, always contributes at 1x, no multiplier, no expiry.
            rewards: 0,
            multiplier18: multiplier18,
            lastClaimedEpoch: uint64(currentEpoch - 1)
        });

        // Phase 11: track the raw base for this node (rewards starts at 0).
        nodeV10BaseStake[identityId] += uint256(raw);

        // Apply diff: full effective stake (raw * multiplier18 / 1e18) enters at currentEpoch
        int256 initialEffective = (int256(uint256(raw)) * int256(uint256(multiplier18))) / int256(SCALE18);
        effectiveStakeDiff[currentEpoch] += initialEffective;
        nodeEffectiveStakeDiff[identityId][currentEpoch] += initialEffective;
        _markGlobalDirty(currentEpoch);
        _markNodeDirty(identityId, currentEpoch);

        // On expiry, the multiplier boost drops away; principal remains at 1x.
        // boost = raw * (multiplier18 - 1e18) / 1e18
        if (lockEpochs > 0 && multiplier18 > SCALE18) {
            int256 expiryDelta = (int256(uint256(raw)) * int256(uint256(multiplier18) - SCALE18)) / int256(SCALE18);
            effectiveStakeDiff[expiryEpoch] -= expiryDelta;
            nodeEffectiveStakeDiff[identityId][expiryEpoch] -= expiryDelta;
        }

        if (currentEpoch > 1) {
            _finalizeEffectiveStakeUpTo(currentEpoch - 1);
            _finalizeNodeEffectiveStakeUpTo(identityId, currentEpoch - 1);
        }

        emit PositionCreated(tokenId, identityId, raw, lockEpochs, expiryEpoch, multiplier18);
    }

    function updateOnRelock(
        uint256 tokenId,
        uint40 newLockEpochs,
        uint64 newMultiplier18
    ) external onlyContracts {
        Position storage pos = positions[tokenId];
        require(pos.raw > 0, "No position");
        // Phase 5 update: tier 0 (permanent rest state, 1x) is a valid
        // post-expiry relock target per the roadmap
        // (`04_TOKEN_ECONOMICS §4.1` — "no lockup / 1 / 3 / 6 / 12 months"
        // is the full user-facing tier set). The original Phase 2 Hotfix
        // rejected `newLockEpochs == 0` with a "Lock too short" guard; we
        // drop it here because the discrete-set validation inside
        // `expectedMultiplier18` is already the canonical source of valid
        // lock values, and tier-0 relock is mathematically well-defined:
        // `boost = raw * (SCALE18 - SCALE18) / SCALE18 == 0`, so both the
        // `currentEpoch` and `newExpiry` diff writes below are zero-delta
        // no-ops — the only observable mutation is the `pos.lockEpochs`,
        // `pos.multiplier18`, `pos.expiryEpoch` writeback that drives the
        // position back to the rest state, matching `createPosition`'s
        // lock-0 branch. Any lock outside the discrete set {0,1,3,6,12}
        // still reverts inside `expectedMultiplier18` with "Invalid lock".
        require(newMultiplier18 == expectedMultiplier18(newLockEpochs), "Tier mismatch");

        uint256 currentEpoch = chronos.getCurrentEpoch();
        // Relock is a post-expiry re-commit: prior lock must be done (or never existed)
        require(pos.expiryEpoch == 0 || currentEpoch >= pos.expiryEpoch, "Not expired");

        uint96 raw = pos.raw;
        uint72 identityId = pos.identityId;

        // Position is currently at raw*1 (permanent, post-expiry). Lift to raw*newMultiplier18.
        // boost = raw * (newMultiplier18 - SCALE18) / SCALE18
        int256 boost = (int256(uint256(raw)) * int256(uint256(newMultiplier18) - SCALE18)) / int256(SCALE18);
        effectiveStakeDiff[currentEpoch] += boost;
        nodeEffectiveStakeDiff[identityId][currentEpoch] += boost;
        _markGlobalDirty(currentEpoch);
        _markNodeDirty(identityId, currentEpoch);

        uint40 newExpiry = uint40(currentEpoch) + newLockEpochs;
        effectiveStakeDiff[newExpiry] -= boost;
        nodeEffectiveStakeDiff[identityId][newExpiry] -= boost;

        pos.expiryEpoch = newExpiry;
        pos.lockEpochs = newLockEpochs;
        pos.multiplier18 = newMultiplier18;

        if (currentEpoch > 1) {
            _finalizeEffectiveStakeUpTo(currentEpoch - 1);
            _finalizeNodeEffectiveStakeUpTo(identityId, currentEpoch - 1);
        }

        emit PositionRelocked(tokenId, newLockEpochs, pos.expiryEpoch, newMultiplier18);
    }

    function updateOnRedelegate(uint256 tokenId, uint72 newIdentityId) external onlyContracts {
        require(newIdentityId != 0, "Zero node");
        Position storage pos = positions[tokenId];
        require(pos.raw > 0, "No position");
        uint72 oldIdentityId = pos.identityId;
        require(oldIdentityId != newIdentityId, "Same node");

        uint256 currentEpoch = chronos.getCurrentEpoch();

        uint96 raw = pos.raw;
        uint96 rewardsBucket = pos.rewards;
        uint40 expiryEpoch = pos.expiryEpoch;
        uint64 multiplier18 = pos.multiplier18;
        bool stillBoosted = expiryEpoch != 0 && currentEpoch < expiryEpoch;

        // Phase 5: effective stake contribution that must transfer per-node
        // RIGHT NOW = raw*(boosted ? mult : 1) + rewards. The rewards bucket
        // always contributes at 1x, regardless of boost state.
        uint256 effectiveNow = (
            stillBoosted
                ? (uint256(raw) * uint256(multiplier18)) / SCALE18
                : uint256(raw)
        ) + uint256(rewardsBucket);

        // Per-node diff move only; global totals unchanged
        int256 signedEffectiveNow = int256(effectiveNow);
        nodeEffectiveStakeDiff[oldIdentityId][currentEpoch] -= signedEffectiveNow;
        nodeEffectiveStakeDiff[newIdentityId][currentEpoch] += signedEffectiveNow;
        _markNodeDirty(oldIdentityId, currentEpoch);
        _markNodeDirty(newIdentityId, currentEpoch);

        // Pending expiry drop (only the raw-side boost) must follow the
        // position. The rewards bucket has no pending expiry delta — it
        // earns 1x forever — so nothing to move for rewards.
        if (stillBoosted) {
            int256 expiryDelta = (int256(uint256(raw)) * int256(uint256(multiplier18) - SCALE18)) / int256(SCALE18);
            // cancel old subtraction
            nodeEffectiveStakeDiff[oldIdentityId][expiryEpoch] += expiryDelta;
            // install on new node
            nodeEffectiveStakeDiff[newIdentityId][expiryEpoch] -= expiryDelta;
        }

        pos.identityId = newIdentityId;

        // Phase 11: move the base (raw + rewards) between nodes.
        uint256 base = uint256(raw) + uint256(rewardsBucket);
        nodeV10BaseStake[oldIdentityId] -= base;
        nodeV10BaseStake[newIdentityId] += base;

        if (currentEpoch > 1) {
            _finalizeNodeEffectiveStakeUpTo(oldIdentityId, currentEpoch - 1);
            _finalizeNodeEffectiveStakeUpTo(newIdentityId, currentEpoch - 1);
        }

        emit PositionRedelegated(tokenId, oldIdentityId, newIdentityId);
    }

    function setLastClaimedEpoch(uint256 tokenId, uint64 epoch) external onlyContracts {
        require(positions[tokenId].identityId != 0, "No position");
        positions[tokenId].lastClaimedEpoch = epoch;
        emit LastClaimedEpochUpdated(tokenId, epoch);
    }

    function deletePosition(uint256 tokenId) external onlyContracts {
        Position memory pos = positions[tokenId];
        require(pos.identityId != 0, "No position");

        uint256 currentEpoch = chronos.getCurrentEpoch();
        uint96 raw = pos.raw;
        uint96 rewardsBucket = pos.rewards;
        uint72 identityId = pos.identityId;
        uint40 expiryEpoch = pos.expiryEpoch;
        uint64 multiplier18 = pos.multiplier18;
        bool stillBoosted = expiryEpoch != 0 && currentEpoch < expiryEpoch;
        // Phase 5: total effective contribution = raw*(boosted ? mult : 1) + rewards.
        // Rewards always contribute at 1x and must also be removed.
        uint256 effectiveNow = (
            stillBoosted
                ? (uint256(raw) * uint256(multiplier18)) / SCALE18
                : uint256(raw)
        ) + uint256(rewardsBucket);

        // Remove contribution from currentEpoch onward
        int256 signedEffectiveNow = int256(effectiveNow);
        effectiveStakeDiff[currentEpoch] -= signedEffectiveNow;
        nodeEffectiveStakeDiff[identityId][currentEpoch] -= signedEffectiveNow;
        _markGlobalDirty(currentEpoch);
        _markNodeDirty(identityId, currentEpoch);

        // Cancel the pending expiry subtraction so it does not fire after delete
        if (stillBoosted) {
            int256 expiryDelta = (int256(uint256(raw)) * int256(uint256(multiplier18) - SCALE18)) / int256(SCALE18);
            effectiveStakeDiff[expiryEpoch] += expiryDelta;
            nodeEffectiveStakeDiff[identityId][expiryEpoch] += expiryDelta;
        }

        // Phase 11: subtract the full base before zeroing the struct.
        nodeV10BaseStake[identityId] -= uint256(raw) + uint256(rewardsBucket);

        delete positions[tokenId];

        if (currentEpoch > 1) {
            _finalizeEffectiveStakeUpTo(currentEpoch - 1);
            _finalizeNodeEffectiveStakeUpTo(identityId, currentEpoch - 1);
        }

        emit PositionDeleted(tokenId);
    }

    // ============================================================
    //           Phase 5 — split-bucket rewards mutators
    // ============================================================
    //
    // These three mutators exist for the Phase 5 split-bucket Position model:
    //
    //   effStake(e) = (e < expiryEpoch ? raw*mult/1e18 : raw) + rewards
    //
    // `rewards` is compounded claim output, withdrawable anytime, always at
    // 1x (no multiplier, no expiry drop). Call sites are Phase 5
    // `DKGStakingConvictionNFT.claim` (increaseRewards) and the partial /
    // full rewards + raw withdrawal flow (decreaseRewards + decreaseRaw).
    //
    // All three:
    //   • Use `identityId != 0` as the existence sentinel so they remain
    //     valid even after `decreaseRaw` has drained `raw` to 0, keeping
    //     the rewards bucket accessible for withdrawal.
    //   • Mirror the existing Phase 2 diff pattern: write the diff at
    //     `currentEpoch`, mark dirty, finalize `[last+1, currentEpoch-1]`.
    //   • Do NOT touch `lockEpochs`, `expiryEpoch`, `multiplier18`, or
    //     `lastClaimedEpoch`. Those are owned by `createPosition` /
    //     `updateOnRelock` / `setLastClaimedEpoch`.

    function increaseRewards(uint256 tokenId, uint96 amount) external onlyContracts {
        Position storage pos = positions[tokenId];
        // `identityId != 0` is the Phase 5 existence sentinel: a position
        // with raw==0 and rewards>0 is a valid "rewards-only" state after
        // `decreaseRaw` has fully drained the principal.
        require(pos.identityId != 0, "No position");
        if (amount == 0) {
            // No-op: avoid burning a dirty-epoch write and an empty finalize
            // loop on a zero-value call. Still a legitimate path for callers
            // that compute `amount = pending - claimed` and can land on 0.
            emit RewardsIncreased(tokenId, 0, pos.rewards);
            return;
        }

        uint256 currentEpoch = chronos.getCurrentEpoch();
        uint72 identityId = pos.identityId;

        // Rewards always contribute at 1x → diff at currentEpoch is +amount
        // for both global and per-node. NO expiry delta: rewards never lose
        // their contribution (they are already at 1x).
        int256 signedAmount = int256(uint256(amount));
        effectiveStakeDiff[currentEpoch] += signedAmount;
        nodeEffectiveStakeDiff[identityId][currentEpoch] += signedAmount;
        _markGlobalDirty(currentEpoch);
        _markNodeDirty(identityId, currentEpoch);

        pos.rewards = pos.rewards + amount;

        // Phase 11: rewards are part of the base.
        nodeV10BaseStake[identityId] += uint256(amount);

        if (currentEpoch > 1) {
            _finalizeEffectiveStakeUpTo(currentEpoch - 1);
            _finalizeNodeEffectiveStakeUpTo(identityId, currentEpoch - 1);
        }

        emit RewardsIncreased(tokenId, amount, pos.rewards);
    }

    function decreaseRewards(uint256 tokenId, uint96 amount) external onlyContracts {
        Position storage pos = positions[tokenId];
        require(pos.identityId != 0, "No position");
        require(pos.rewards >= amount, "Insufficient rewards");
        if (amount == 0) {
            emit RewardsDecreased(tokenId, 0, pos.rewards);
            return;
        }

        uint256 currentEpoch = chronos.getCurrentEpoch();
        uint72 identityId = pos.identityId;

        int256 signedAmount = int256(uint256(amount));
        effectiveStakeDiff[currentEpoch] -= signedAmount;
        nodeEffectiveStakeDiff[identityId][currentEpoch] -= signedAmount;
        _markGlobalDirty(currentEpoch);
        _markNodeDirty(identityId, currentEpoch);

        pos.rewards = pos.rewards - amount;

        // Phase 11: rewards are part of the base.
        nodeV10BaseStake[identityId] -= uint256(amount);

        if (currentEpoch > 1) {
            _finalizeEffectiveStakeUpTo(currentEpoch - 1);
            _finalizeNodeEffectiveStakeUpTo(identityId, currentEpoch - 1);
        }

        emit RewardsDecreased(tokenId, amount, pos.rewards);
    }

    function decreaseRaw(uint256 tokenId, uint96 amount) external onlyContracts {
        Position storage pos = positions[tokenId];
        require(pos.identityId != 0, "No position");
        require(pos.raw >= amount, "Insufficient raw");
        if (amount == 0) {
            emit RawDecreased(tokenId, 0, pos.raw);
            return;
        }

        uint256 currentEpoch = chronos.getCurrentEpoch();
        uint72 identityId = pos.identityId;
        uint40 expiryEpoch = pos.expiryEpoch;
        uint64 multiplier18 = pos.multiplier18;
        bool stillBoosted = expiryEpoch != 0 && currentEpoch < expiryEpoch;

        // Mirror `deletePosition` pattern, scaled down to `amount` of raw:
        //   pre-expiry: subtract amount*mult/1e18 at currentEpoch,
        //               and SHRINK the pending expiry delta by
        //               amount*(mult-1e18)/1e18 (because the remaining raw
        //               still has that much boost left to drop at expiry).
        //   post-expiry: subtract flat `amount` at currentEpoch; no delta.
        uint256 effectiveNow = stillBoosted
            ? (uint256(amount) * uint256(multiplier18)) / SCALE18
            : uint256(amount);

        int256 signedEffectiveNow = int256(effectiveNow);
        effectiveStakeDiff[currentEpoch] -= signedEffectiveNow;
        nodeEffectiveStakeDiff[identityId][currentEpoch] -= signedEffectiveNow;
        _markGlobalDirty(currentEpoch);
        _markNodeDirty(identityId, currentEpoch);

        if (stillBoosted && multiplier18 > SCALE18) {
            // The original `createPosition` call installed
            //   diff[expiryEpoch] -= raw * (mult-1) / SCALE18.
            // A `decreaseRaw(amount)` shrinks the future boost drop by
            //   amount * (mult-1) / SCALE18 — i.e. we ADD that much back
            //   to diff[expiryEpoch] to cancel the over-subtraction.
            int256 expiryDelta = (int256(uint256(amount)) * int256(uint256(multiplier18) - SCALE18)) / int256(SCALE18);
            effectiveStakeDiff[expiryEpoch] += expiryDelta;
            nodeEffectiveStakeDiff[identityId][expiryEpoch] += expiryDelta;
        }

        pos.raw = pos.raw - amount;

        // Phase 11: raw is part of the base.
        nodeV10BaseStake[identityId] -= uint256(amount);

        if (currentEpoch > 1) {
            _finalizeEffectiveStakeUpTo(currentEpoch - 1);
            _finalizeNodeEffectiveStakeUpTo(identityId, currentEpoch - 1);
        }

        emit RawDecreased(tokenId, amount, pos.raw);
    }

    // Phase 5 — Symmetric counterpart of `decreaseRaw`. Used by
    // `StakingV10.cancelWithdrawal` to restore a pending raw share back to
    // the position when the user cancels a pending withdrawal under the V10
    // decrement-at-request model.
    //
    // This is a sign-flipped mirror of `decreaseRaw`'s diff propagation:
    //   pre-expiry  : add amount*mult/1e18 at currentEpoch and re-install the
    //                 corresponding pending expiry delta (-amount*(mult-1)/1e18
    //                 at expiryEpoch) so the remaining boost drop matches the
    //                 restored raw.
    //   post-expiry : add flat `amount` at currentEpoch; no expiry delta.
    function increaseRaw(uint256 tokenId, uint96 amount) external onlyContracts {
        Position storage pos = positions[tokenId];
        require(pos.identityId != 0, "No position");
        if (amount == 0) {
            emit RawIncreased(tokenId, 0, pos.raw);
            return;
        }

        uint256 currentEpoch = chronos.getCurrentEpoch();
        uint72 identityId = pos.identityId;
        uint40 expiryEpoch = pos.expiryEpoch;
        uint64 multiplier18 = pos.multiplier18;
        bool stillBoosted = expiryEpoch != 0 && currentEpoch < expiryEpoch;

        // Mirror of `decreaseRaw`, signs flipped:
        //   pre-expiry : add amount*mult/1e18 at currentEpoch.
        //   post-expiry: add flat `amount` at currentEpoch.
        uint256 effectiveNow = stillBoosted
            ? (uint256(amount) * uint256(multiplier18)) / SCALE18
            : uint256(amount);

        int256 signedEffectiveNow = int256(effectiveNow);
        effectiveStakeDiff[currentEpoch] += signedEffectiveNow;
        nodeEffectiveStakeDiff[identityId][currentEpoch] += signedEffectiveNow;
        _markGlobalDirty(currentEpoch);
        _markNodeDirty(identityId, currentEpoch);

        if (stillBoosted && multiplier18 > SCALE18) {
            // Symmetric inverse of the `decreaseRaw` cancel: re-install the
            //   diff[expiryEpoch] -= amount * (mult-1) / SCALE18
            // edge so the raw still has its boost drop scheduled at expiry.
            int256 expiryDelta = (int256(uint256(amount)) * int256(uint256(multiplier18) - SCALE18)) / int256(SCALE18);
            effectiveStakeDiff[expiryEpoch] -= expiryDelta;
            nodeEffectiveStakeDiff[identityId][expiryEpoch] -= expiryDelta;
        }

        pos.raw = pos.raw + amount;

        // Phase 11: raw is part of the base.
        nodeV10BaseStake[identityId] += uint256(amount);

        if (currentEpoch > 1) {
            _finalizeEffectiveStakeUpTo(currentEpoch - 1);
            _finalizeNodeEffectiveStakeUpTo(identityId, currentEpoch - 1);
        }

        emit RawIncreased(tokenId, amount, pos.raw);
    }

    // ============================================================
    //         Phase 5 — V10-native pending withdrawal CRUD
    // ============================================================
    //
    // These three mutators back the V10 NFT-side pending withdrawal flow.
    // They are independent of `StakingStorage.withdrawals` (the legacy V8
    // address-keyed mapping is left untouched by Phase 5). Only one pending
    // per tokenId at a time; the sentinel is `amount != 0`.

    function createPendingWithdrawal(
        uint256 tokenId,
        uint96 amount,
        uint96 rewardsPortion,
        uint64 releaseAt
    ) external onlyContracts {
        require(amount > 0, "Zero amount");
        require(rewardsPortion <= amount, "Bad split");
        require(pendingWithdrawals[tokenId].amount == 0, "Pending exists");
        pendingWithdrawals[tokenId] = PendingWithdrawal({
            amount: amount,
            rewardsPortion: rewardsPortion,
            releaseAt: releaseAt
        });
        emit PendingWithdrawalCreated(tokenId, amount, rewardsPortion, releaseAt);
    }

    function deletePendingWithdrawal(uint256 tokenId) external onlyContracts {
        require(pendingWithdrawals[tokenId].amount != 0, "No pending");
        delete pendingWithdrawals[tokenId];
        emit PendingWithdrawalDeleted(tokenId);
    }

    function getPendingWithdrawal(uint256 tokenId) external view returns (PendingWithdrawal memory) {
        return pendingWithdrawals[tokenId];
    }

    // ============================================================
    //                          Reads
    // ============================================================

    function getPosition(uint256 tokenId) external view returns (Position memory) {
        return positions[tokenId];
    }

    function getTotalEffectiveStakeAtEpoch(uint256 epoch) public view returns (uint256) {
        if (epoch <= lastFinalizedEpoch) {
            return totalEffectiveStakeAtEpoch[epoch];
        }
        int256 simulated = lastFinalizedEpoch > 0
            ? int256(totalEffectiveStakeAtEpoch[lastFinalizedEpoch])
            : int256(0);
        for (uint256 e = lastFinalizedEpoch + 1; e <= epoch; e++) {
            simulated += effectiveStakeDiff[e];
            // Unify policy with the mutate path: an intermediate negative
            // cumulative signals ledger corruption. Even if a later diff
            // restores it, the mutate path would have reverted at the first
            // bad epoch — so the view path must too.
            require(simulated >= 0, "Negative total");
        }
        return uint256(simulated);
    }

    function getNodeEffectiveStakeAtEpoch(uint72 identityId, uint256 epoch) public view returns (uint256) {
        uint256 lastFinalized = nodeLastFinalizedEpoch[identityId];
        if (epoch <= lastFinalized) {
            return nodeEffectiveStakeAtEpoch[identityId][epoch];
        }
        int256 simulated = lastFinalized > 0
            ? int256(nodeEffectiveStakeAtEpoch[identityId][lastFinalized])
            : int256(0);
        for (uint256 e = lastFinalized + 1; e <= epoch; e++) {
            simulated += nodeEffectiveStakeDiff[identityId][e];
            require(simulated >= 0, "Negative node total");
        }
        return uint256(simulated);
    }

    function getLastFinalizedEpoch() external view returns (uint256) {
        return lastFinalizedEpoch;
    }

    function getNodeLastFinalizedEpoch(uint72 identityId) external view returns (uint256) {
        return nodeLastFinalizedEpoch[identityId];
    }

    function getNodeV10BaseStake(uint72 identityId) external view returns (uint256) {
        return nodeV10BaseStake[identityId];
    }

    // ============================================================
    //                     External finalizers
    // ============================================================

    // Hub contracts (notably Phase 11 reward math) can amortize the
    // O(currentEpoch - lastFinalizedEpoch) simulate path into a single
    // write by calling these before reading getTotalEffectiveStakeAtEpoch /
    // getNodeEffectiveStakeAtEpoch across a long dormant window.
    //
    // Only past epochs may be finalized: finalizing the current or a future
    // epoch would crystallize diff[currentEpoch] before in-flight mutators
    // finished writing to it, leaving every subsequent read stuck on a stale
    // cached value. Mirrors `ContextGraphValueStorage.finalizeCGValueUpTo`.

    function finalizeEffectiveStakeUpTo(uint256 epoch) external onlyContracts {
        require(epoch < chronos.getCurrentEpoch(), "Future or current epoch");
        _finalizeEffectiveStakeUpTo(epoch);
    }

    function finalizeNodeEffectiveStakeUpTo(uint72 identityId, uint256 epoch) external onlyContracts {
        require(epoch < chronos.getCurrentEpoch(), "Future or current epoch");
        _finalizeNodeEffectiveStakeUpTo(identityId, epoch);
    }

    // ============================================================
    //                       Internal finalize
    // ============================================================

    function _finalizeEffectiveStakeUpTo(uint256 epoch) internal {
        uint256 last = lastFinalizedEpoch;
        if (last >= epoch) return;

        uint256 firstDirty = firstDirtyEpoch;
        if (firstDirty == 0) {
            // No diff has ever been written. Whole range is default zero —
            // advance the cursor without touching any mapping slot.
            lastFinalizedEpoch = epoch;
            emit EffectiveStakeFinalized(last + 1, epoch);
            return;
        }

        // Skip the all-zero prefix before the first dirty epoch.
        uint256 startEpoch = last + 1;
        if (startEpoch < firstDirty) startEpoch = firstDirty;
        if (startEpoch > epoch) {
            // Entire [last+1, epoch] range is in the zero prefix.
            lastFinalizedEpoch = epoch;
            emit EffectiveStakeFinalized(last + 1, epoch);
            return;
        }

        for (uint256 e = startEpoch; e <= epoch; e++) {
            int256 prev = 0;
            if (e > 1) {
                prev = int256(totalEffectiveStakeAtEpoch[e - 1]);
            }
            int256 result = prev + effectiveStakeDiff[e];
            require(result >= 0, "Negative total");
            totalEffectiveStakeAtEpoch[e] = uint256(result);
        }
        lastFinalizedEpoch = epoch;

        emit EffectiveStakeFinalized(startEpoch, epoch);
    }

    function _finalizeNodeEffectiveStakeUpTo(uint72 identityId, uint256 epoch) internal {
        uint256 last = nodeLastFinalizedEpoch[identityId];
        if (last >= epoch) return;

        uint256 firstDirty = nodeFirstDirtyEpoch[identityId];
        if (firstDirty == 0) {
            nodeLastFinalizedEpoch[identityId] = epoch;
            emit NodeEffectiveStakeFinalized(identityId, last + 1, epoch);
            return;
        }

        uint256 startEpoch = last + 1;
        if (startEpoch < firstDirty) startEpoch = firstDirty;
        if (startEpoch > epoch) {
            nodeLastFinalizedEpoch[identityId] = epoch;
            emit NodeEffectiveStakeFinalized(identityId, last + 1, epoch);
            return;
        }

        for (uint256 e = startEpoch; e <= epoch; e++) {
            int256 prev = 0;
            if (e > 1) {
                prev = int256(nodeEffectiveStakeAtEpoch[identityId][e - 1]);
            }
            int256 result = prev + nodeEffectiveStakeDiff[identityId][e];
            require(result >= 0, "Negative node total");
            nodeEffectiveStakeAtEpoch[identityId][e] = uint256(result);
        }
        nodeLastFinalizedEpoch[identityId] = epoch;

        emit NodeEffectiveStakeFinalized(identityId, startEpoch, epoch);
    }

    // ============================================================
    //                Dirty-epoch bookkeeping
    // ============================================================

    function _markGlobalDirty(uint256 epoch) internal {
        uint256 current = firstDirtyEpoch;
        if (current == 0 || epoch < current) {
            firstDirtyEpoch = epoch;
        }
    }

    function _markNodeDirty(uint72 identityId, uint256 epoch) internal {
        uint256 current = nodeFirstDirtyEpoch[identityId];
        if (current == 0 || epoch < current) {
            nodeFirstDirtyEpoch[identityId] = epoch;
        }
    }
}
