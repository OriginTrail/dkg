// SPDX-License-Identifier: Apache-2.0

pragma solidity ^0.8.20;

import {Chronos} from "./Chronos.sol";
import {HubDependent} from "../abstract/HubDependent.sol";
import {INamed} from "../interfaces/INamed.sol";
import {IVersioned} from "../interfaces/IVersioned.sol";

/**
 * @title ConvictionStakingStorage
 * @notice Primary accounting store for V10 staking.
 *
 * V10 architecture (post-migration):
 *   - All V10 delegator state lives here (positions, per-node stake totals,
 *     per-epoch operator-fee/net-rewards flags). StakingStorage becomes a
 *     read-only V8 legacy archive and the TRAC vault.
 *   - Migration to V10 is MANDATORY: every V8 delegator becomes a V10 NFT
 *     position. `RandomSampling.calculateNodeScore` and the Phase 11
 *     `scorePerStake` denominator therefore read `nodeStakeV10` here, NOT
 *     `StakingStorage.nodes[id].stake`.
 *
 * Rewards model (D19 — compound-into-raw):
 *   - The previous split-bucket model (separate `rewards` sidecar that
 *     always earned 1x) has been removed. Claimed rewards compound into
 *     `raw`, so they take on the position's current lock multiplier.
 *   - `cumulativeRewardsClaimed` is now a statistic-only counter for
 *     UI/indexer consumption; it never enters effective-stake math.
 *
 * Tier model (D20 — hardcoded wall-clock tiers):
 *   - Tier durations are expressed as real-time seconds and decoupled
 *     from epoch length: `_tierDuration(lockTier)` returns
 *     {0, 30d, 90d, 180d, 360d} for `lockTier ∈ {0, 1, 3, 6, 12}`.
 *   - `expiryEpoch = epochAtTimestamp(block.timestamp + duration +
 *     BLOCK_DRIFT_BUFFER)` so users always get AT LEAST their committed
 *     duration across epoch boundaries.
 *   - Multipliers remain on the {1x, 1.5x, 2x, 3.5x, 6x} ladder.
 */
contract ConvictionStakingStorage is INamed, IVersioned, HubDependent {
    string private constant _NAME = "ConvictionStakingStorage";
    // Version history:
    //   1.1.0 — split-bucket rewards, discrete tier ladder.
    //   1.2.0 — V10-native pending-withdrawal storage (create/delete/get).
    //   2.0.0 — V10 canonical store:
    //           * Position repack (D6+D19): cumulativeRewardsClaimed + migrationEpoch.
    //           * nodeTokens enumeration (D5).
    //           * nodeStakeV10 / totalStakeV10 aggregates (D15).
    //           * Absorbed isOperatorFeeClaimedForEpoch / netNodeEpochRewards (D3).
    //           * Hardcoded tier constants + _tierDuration/_tierMultiplier (D20).
    //           * Removed: nodeV10BaseStake (D4), split-bucket rewards mutators (D19),
    //                      PendingWithdrawal.rewardsPortion (D19).
    string private constant _VERSION = "2.0.0";

    // Multiplier scale, matches DKGStakingConvictionNFT._convictionMultiplier
    // (returns 1e18-scaled values so fractional tiers like 1.5x and 3.5x
    // are representable).
    uint256 internal constant SCALE18 = 1e18;

    // ============================================================
    //                 D20 — Hardcoded tier constants
    // ============================================================

       // Extra slack added when converting `expiryTime → expiryEpoch` so the
    // user always gets AT LEAST their committed duration across a block-
    // timing/epoch-boundary boundary. 12h is comfortably less than any
    // sane epoch length and more than any plausible block drift.
    uint256 public constant BLOCK_DRIFT_BUFFER = 12 hours;

    // Wall-clock durations (decoupled from epoch length), + BLOCK_DRIFT_BUFFER hours to account for potential block drift.
    uint256 public constant TIER_30D = 30 days + BLOCK_DRIFT_BUFFER;
    uint256 public constant TIER_90D = 90 days + BLOCK_DRIFT_BUFFER;
    uint256 public constant TIER_180D = 180 days + BLOCK_DRIFT_BUFFER;
    uint256 public constant TIER_360D = 366 days + BLOCK_DRIFT_BUFFER; // to account for leap years

 

    // Multiplier ladder (1e18-scaled).
    uint64 public constant MULT_LOCK_0 = uint64(SCALE18);              // 1.0x
    uint64 public constant MULT_LOCK_30D = uint64((15 * SCALE18) / 10); // 1.5x
    uint64 public constant MULT_LOCK_90D = uint64(2 * SCALE18);         // 2.0x
    uint64 public constant MULT_LOCK_180D = uint64((35 * SCALE18) / 10);// 3.5x
    uint64 public constant MULT_LOCK_360D = uint64(6 * SCALE18);        // 6.0x

    // Position layout (two storage slots — V10 compound-into-raw model):
    //   slot 1: raw(96) + lockTier(40) + expiryEpoch(40) + identityId(72) = 248 bits
    //   slot 2: cumulativeRewardsClaimed(96) + multiplier18(64)
    //           + lastClaimedEpoch(32) + migrationEpoch(32)             = 224 bits
    //
    // Field semantics:
    //   raw                        — principal (+ compounded rewards). Locked
    //                                pre-expiry, earns `multiplier18` pre-expiry,
    //                                drops back to 1x on `expiryEpoch`.
    //                                Claim compounds TRAC into this field.
    //   lockTier                 — tier index ∈ {0, 1, 3, 6, 12}. Storage-
    //                                compatible integer that maps to
    //                                `_tierDuration` / `_tierMultiplier`.
    //   expiryEpoch                — Chronos epoch at which the boost expires.
    //                                0 iff lockTier == 0 (rest state).
    //   identityId                 — the node this position delegates to.
    //   cumulativeRewardsClaimed   — D19 statistic: total TRAC ever compounded
    //                                into `raw` via claim for this NFT. Never
    //                                decreases, never enters effective-stake
    //                                math. UI/indexer-only.
    //   multiplier18               — materialized copy of `_tierMultiplier(lockTier)`.
    //                                Exactly one valid multiplier per lockTier
    //                                value; mismatch reverts at write time.
    //   lastClaimedEpoch           — Chronos epoch of the last successful claim.
    //                                uint32 holds ~4.3e9 epochs; plenty.
    //   migrationEpoch             — D6: if this position was seeded via the
    //                                V8→V10 migration path, this is the epoch
    //                                at which the migration happened. Drives
    //                                the retroactive-claim branch so migrated
    //                                positions can reclaim rewards emitted
    //                                from the moment of migration. 0 means
    //                                "fresh V10 stake, never migrated".
    struct Position {
        uint96 raw;
        uint40 lockTier;
        uint40 expiryEpoch;
        uint72 identityId;
        // slot 2
        uint96 cumulativeRewardsClaimed;
        uint64 multiplier18;
        uint32 lastClaimedEpoch;
        uint32 migrationEpoch;
    }

    // V10-native pending withdrawal storage.
    //
    // Decrement-at-request semantics: `createPendingWithdrawal` is called by
    // `StakingV10.createWithdrawal` AFTER the position `raw`, node stake
    // totals, and effective-stake diff have already been decremented. `delete`
    // is called by both `cancelWithdrawal` (which restores everything via
    // `increaseRaw`) and `finalizeWithdrawal` (which releases the TRAC).
    //
    // D19 drops `rewardsPortion`: with rewards compounded into `raw`, there is
    // no separate rewards share to track — the whole `amount` is raw.
    struct PendingWithdrawal {
        uint96 amount;
        uint64 releaseAt;
    }

    event PositionCreated(
        uint256 indexed tokenId,
        uint72 indexed identityId,
        uint96 raw,
        uint40 lockTier,
        uint40 expiryEpoch,
        uint64 multiplier18,
        uint32 migrationEpoch
    );
    event PositionRelocked(
        uint256 indexed tokenId,
        uint40 newLockTier,
        uint40 newExpiryEpoch,
        uint64 newMultiplier18
    );
    event PositionRedelegated(
        uint256 indexed tokenId,
        uint72 indexed oldIdentityId,
        uint72 indexed newIdentityId
    );
    event PositionDeleted(uint256 indexed tokenId);
    // D21+D23 — ephemeral NFTs: relock / redelegate burn the old tokenId and
    // mint a fresh one. `createNewPositionFromExisting` emits this event to
    // expose the continuity link (stats `cumulativeRewardsClaimed`,
    // `lastClaimedEpoch`, `migrationEpoch` carry over) that off-chain indexers
    // need to trace a position's history across NFT burns.
    event PositionReplaced(
        uint256 indexed oldTokenId,
        uint256 indexed newTokenId,
        uint72 indexed newIdentityId,
        uint96 raw,
        uint40 newLockTier,
        uint40 newExpiryEpoch,
        uint64 newMultiplier18
    );
    event LastClaimedEpochUpdated(uint256 indexed tokenId, uint32 epoch);
    event MigrationEpochSet(uint256 indexed tokenId, uint32 epoch);
    // D19 — compound-into-raw model. `increaseRaw` bumps principal
    // (including compounded rewards from claim); `decreaseRaw` drains
    // it on withdrawal. `CumulativeRewardsClaimed` is a statistic
    // side-channel that claim updates alongside `increaseRaw`.
    event RawIncreased(uint256 indexed tokenId, uint96 amount, uint96 newRaw);
    event RawDecreased(uint256 indexed tokenId, uint96 amount, uint96 newRaw);
    event CumulativeRewardsClaimedUpdated(uint256 indexed tokenId, uint96 added, uint96 newTotal);
    // V10-native pending-withdrawal lifecycle events.
    event PendingWithdrawalCreated(uint256 indexed tokenId, uint96 amount, uint64 releaseAt);
    event PendingWithdrawalDeleted(uint256 indexed tokenId);
    event EffectiveStakeFinalized(uint256 startEpoch, uint256 endEpoch);
    event NodeEffectiveStakeFinalized(uint72 indexed identityId, uint256 startEpoch, uint256 endEpoch);
    // D15 — V10 stake aggregate events.
    event NodeStakeV10Increased(uint72 indexed identityId, uint256 amount, uint256 newNodeStake, uint256 newTotal);
    event NodeStakeV10Decreased(uint72 indexed identityId, uint256 amount, uint256 newNodeStake, uint256 newTotal);
    // D7 — V10 launch marker.
    event V10LaunchEpochSet(uint256 epoch);
    // D3 — DelegatorsInfo-absorbed events.
    event IsOperatorFeeClaimedForEpochUpdated(uint72 indexed identityId, uint256 indexed epoch, bool isClaimed);
    event NetNodeEpochRewardsSet(uint72 indexed identityId, uint256 indexed epoch, uint256 amount);

    Chronos public chronos;

    mapping(uint256 => Position) public positions;

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

    // ============================================================
    //                D5 — Per-node tokenId enumeration
    // ============================================================
    //
    // Maintained in lockstep with `positions`: pushed in `createPosition`,
    // swap-popped in `deletePosition`, moved atomically between nodes in
    // `updateOnRedelegate`. Enables off-chain consumers (and migration
    // finalizers) to iterate the set of NFT positions attached to a node
    // without an external index.
    mapping(uint72 => uint256[]) public nodeTokens;
    mapping(uint72 => mapping(uint256 => uint256)) public nodeTokenIndex;

    // ============================================================
    //           D15 — V10 stake aggregates (raw TRAC principal)
    // ============================================================
    //
    // `nodeStakeV10[identityId]` is the sum of `raw` across all live
    // positions pointing at `identityId`. It is the V10 equivalent of
    // `StakingStorage.nodes[id].stake` for post-migration reads:
    //   * RandomSampling.calculateNodeScore uses it for S(t) = sqrt(stake/cap).
    //   * RandomSampling.submitProof uses `nodeEffectiveStakeAtEpoch` for the
    //     scorePerStake denominator (boost-weighted), but the raw share is
    //     here.
    //   * Profile/StakingKPI reads route through here.
    //
    // `totalStakeV10` is the protocol-wide sum, maintained in the same
    // mutators. Both are updated automatically by `createPosition`,
    // `deletePosition`, `updateOnRedelegate`, `increaseRaw`, `decreaseRaw`.
    mapping(uint72 => uint256) public nodeStakeV10;
    uint256 public totalStakeV10;

    // ============================================================
    //            D3 — Absorbed DelegatorsInfo fields (V10)
    // ============================================================
    //
    // These two mappings moved from `DelegatorsInfo` (unregistered in D13)
    // because they are per-node-per-epoch claim bookkeeping that the V10
    // claim flow still needs. All other `DelegatorsInfo` fields were V8-
    // specific (address-keyed) and are dead under the NFT model.
    mapping(uint72 => mapping(uint256 => bool)) public isOperatorFeeClaimedForEpoch;
    mapping(uint72 => mapping(uint256 => uint256)) public netNodeEpochRewards;

    // ============================================================
    //                 D7 — V10 launch epoch marker
    // ============================================================
    //
    // Set once by the migration deploy script (or by `setV10LaunchEpoch`
    // below) to the epoch at which V10 contracts go live. Drives the
    // dual straggler-rescue logic in `adminMigrateV8` / `selfMigrateV8`:
    // before `v10LaunchEpoch` the migration path is a no-op (V8 is the
    // source of truth); after it the path is the canonical migration
    // entry point.
    uint256 public v10LaunchEpoch;

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
    //                 D20 — Tier helpers
    // ============================================================

    /**
     * @notice Wall-clock duration (seconds) for a given tier id.
     * @dev `lockTier` is a tier identifier (not an epoch count).
     *      The D20 baseline ladder accepts {0, 1, 3, 6, 12}.
     */
    function _tierDuration(uint40 lockTier) internal pure returns (uint256) {
        if (lockTier == 0) return 0;
        if (lockTier == 1) return TIER_30D;
        if (lockTier == 3) return TIER_90D;
        if (lockTier == 6) return TIER_180D;
        if (lockTier == 12) return TIER_360D;
        revert("Invalid lock");
    }

    /**
     * @notice 1e18-scaled multiplier for a given tier index.
     */
    function _tierMultiplier(uint40 lockTier) internal pure returns (uint64) {
        if (lockTier == 0) return MULT_LOCK_0;
        if (lockTier == 1) return MULT_LOCK_30D;
        if (lockTier == 3) return MULT_LOCK_90D;
        if (lockTier == 6) return MULT_LOCK_180D;
        if (lockTier == 12) return MULT_LOCK_360D;
        revert("Invalid lock");
    }

    /// @notice External view; mirrors `_tierMultiplier` for callers that need the ladder value.
    function expectedMultiplier18(uint40 lockTier) public pure returns (uint64) {
        return _tierMultiplier(lockTier);
    }

    /// @notice External view; mirrors `_tierDuration` for callers that need the real-time duration.
    function tierDuration(uint40 lockTier) external pure returns (uint256) {
        return _tierDuration(lockTier);
    }

    // ============================================================
    //                        Mutators
    // ============================================================

    /**
     * @notice Create a fresh V10 position. Used by both the fresh-stake
     *         path (migrationEpoch = 0) and the V8→V10 migration path
     *         (migrationEpoch = migration epoch).
     */
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
        // Tier check subsumes "Bad multiplier" and "Lock0 must be 1x": the
        // ladder defines exactly one valid multiplier for every lock value
        // (including lock == 0 → 1x), so any deviation is a tier mismatch.
        require(multiplier18 == _tierMultiplier(lockTier), "Tier mismatch");

        uint256 currentEpoch = chronos.getCurrentEpoch();
        uint40 expiryEpoch = _computeExpiryEpoch(lockTier);

        positions[tokenId] = Position({
            raw: raw,
            lockTier: lockTier,
            expiryEpoch: expiryEpoch,
            identityId: identityId,
            cumulativeRewardsClaimed: 0,
            multiplier18: multiplier18,
            lastClaimedEpoch: uint32(currentEpoch - 1),
            migrationEpoch: migrationEpoch
        });

        // D5 — push tokenId into per-node enumeration.
        _pushNodeToken(identityId, tokenId);

        // D15 — maintain raw aggregates.
        _increaseNodeStakeV10(identityId, uint256(raw));

        // Apply diff: full effective stake (raw * multiplier18 / 1e18) enters at currentEpoch.
        // D19: no rewards bucket; effective stake is purely raw-based.
        int256 initialEffective = (int256(uint256(raw)) * int256(uint256(multiplier18))) / int256(SCALE18);
        effectiveStakeDiff[currentEpoch] += initialEffective;
        nodeEffectiveStakeDiff[identityId][currentEpoch] += initialEffective;
        _markGlobalDirty(currentEpoch);
        _markNodeDirty(identityId, currentEpoch);

        // On expiry, the multiplier boost drops away; principal remains at 1x.
        // boost = raw * (multiplier18 - 1e18) / 1e18
        if (lockTier > 0 && multiplier18 > SCALE18) {
            int256 expiryDelta = (int256(uint256(raw)) * int256(uint256(multiplier18) - SCALE18)) / int256(SCALE18);
            effectiveStakeDiff[expiryEpoch] -= expiryDelta;
            nodeEffectiveStakeDiff[identityId][expiryEpoch] -= expiryDelta;
        }

        if (currentEpoch > 1) {
            _finalizeEffectiveStakeUpTo(currentEpoch - 1);
            _finalizeNodeEffectiveStakeUpTo(identityId, currentEpoch - 1);
        }

        emit PositionCreated(tokenId, identityId, raw, lockTier, expiryEpoch, multiplier18, migrationEpoch);
    }

    function updateOnRelock(
        uint256 tokenId,
        uint40 newLockTier,
        uint64 newMultiplier18
    ) external onlyContracts {
        Position storage pos = positions[tokenId];
        require(pos.identityId != 0, "No position");
        require(newMultiplier18 == _tierMultiplier(newLockTier), "Tier mismatch");

        uint256 currentEpoch = chronos.getCurrentEpoch();
        // Relock is a post-expiry re-commit: prior lock must be done (or never existed)
        require(pos.expiryEpoch == 0 || currentEpoch >= pos.expiryEpoch, "Not expired");

        uint96 raw = pos.raw;
        require(raw > 0, "No raw");
        uint72 identityId = pos.identityId;

        // Position is currently at raw*1 (permanent, post-expiry). Lift to raw*newMultiplier18.
        // boost = raw * (newMultiplier18 - SCALE18) / SCALE18
        int256 boost = (int256(uint256(raw)) * int256(uint256(newMultiplier18) - SCALE18)) / int256(SCALE18);
        effectiveStakeDiff[currentEpoch] += boost;
        nodeEffectiveStakeDiff[identityId][currentEpoch] += boost;
        _markGlobalDirty(currentEpoch);
        _markNodeDirty(identityId, currentEpoch);

        uint40 newExpiry = _computeExpiryEpoch(newLockTier);
        if (newLockTier > 0 && newMultiplier18 > SCALE18) {
            effectiveStakeDiff[newExpiry] -= boost;
            nodeEffectiveStakeDiff[identityId][newExpiry] -= boost;
        }

        pos.expiryEpoch = newExpiry;
        pos.lockTier = newLockTier;
        pos.multiplier18 = newMultiplier18;

        if (currentEpoch > 1) {
            _finalizeEffectiveStakeUpTo(currentEpoch - 1);
            _finalizeNodeEffectiveStakeUpTo(identityId, currentEpoch - 1);
        }

        emit PositionRelocked(tokenId, newLockTier, newExpiry, newMultiplier18);
    }

    function updateOnRedelegate(uint256 tokenId, uint72 newIdentityId) external onlyContracts {
        require(newIdentityId != 0, "Zero node");
        Position storage pos = positions[tokenId];
        require(pos.identityId != 0, "No position");
        uint72 oldIdentityId = pos.identityId;
        require(oldIdentityId != newIdentityId, "Same node");

        uint256 currentEpoch = chronos.getCurrentEpoch();

        uint96 raw = pos.raw;
        uint40 expiryEpoch = pos.expiryEpoch;
        uint64 multiplier18 = pos.multiplier18;
        bool stillBoosted = expiryEpoch != 0 && currentEpoch < expiryEpoch;

        // D19: effective stake is purely raw-based (no rewards addend).
        // Contribution to transfer RIGHT NOW = raw * (boosted ? mult : 1).
        uint256 effectiveNow = stillBoosted
            ? (uint256(raw) * uint256(multiplier18)) / SCALE18
            : uint256(raw);

        // Per-node diff move only; global totals unchanged
        int256 signedEffectiveNow = int256(effectiveNow);
        nodeEffectiveStakeDiff[oldIdentityId][currentEpoch] -= signedEffectiveNow;
        nodeEffectiveStakeDiff[newIdentityId][currentEpoch] += signedEffectiveNow;
        _markNodeDirty(oldIdentityId, currentEpoch);
        _markNodeDirty(newIdentityId, currentEpoch);

        // Pending expiry drop (the raw-side boost) must follow the position.
        if (stillBoosted && multiplier18 > SCALE18) {
            int256 expiryDelta = (int256(uint256(raw)) * int256(uint256(multiplier18) - SCALE18)) / int256(SCALE18);
            // cancel old subtraction
            nodeEffectiveStakeDiff[oldIdentityId][expiryEpoch] += expiryDelta;
            // install on new node
            nodeEffectiveStakeDiff[newIdentityId][expiryEpoch] -= expiryDelta;
        }

        pos.identityId = newIdentityId;

        // D5 — move tokenId between per-node enumerations.
        _popNodeToken(oldIdentityId, tokenId);
        _pushNodeToken(newIdentityId, tokenId);

        // D15 — move raw between per-node aggregates. Total unchanged.
        uint256 rawU = uint256(raw);
        nodeStakeV10[oldIdentityId] -= rawU;
        nodeStakeV10[newIdentityId] += rawU;
        emit NodeStakeV10Decreased(oldIdentityId, rawU, nodeStakeV10[oldIdentityId], totalStakeV10);
        emit NodeStakeV10Increased(newIdentityId, rawU, nodeStakeV10[newIdentityId], totalStakeV10);

        if (currentEpoch > 1) {
            _finalizeNodeEffectiveStakeUpTo(oldIdentityId, currentEpoch - 1);
            _finalizeNodeEffectiveStakeUpTo(newIdentityId, currentEpoch - 1);
        }

        emit PositionRedelegated(tokenId, oldIdentityId, newIdentityId);
    }

    /**
     * @notice D23 primitive — atomically replace a live position at
     *         `oldTokenId` with a fresh one at `newTokenId`, preserving
     *         `cumulativeRewardsClaimed`, `lastClaimedEpoch`, and
     *         `migrationEpoch` while applying caller-supplied new
     *         `identityId`, lock tier, and multiplier.
     *
     * @dev D21 ephemeral-NFT enabler. `StakingV10.relock` /
     *      `StakingV10.redelegate` call this with a fresh `newTokenId`
     *      minted by `DKGStakingConvictionNFT`; the wrapper then burns
     *      `oldTokenId`. All continuity a delegator cares about (lifetime
     *      reward stats, reward cursor, migration marker) rides the
     *      preserved fields so the burn-and-mint is invisible at the
     *      economic layer.
     *
     *      Invariants / requires:
     *        - `oldTokenId` references a live position (`identityId != 0`, `raw > 0`).
     *        - `newTokenId` is unused (`positions[newTokenId].identityId == 0`).
     *        - No pending withdrawal on `oldTokenId` — the withdrawal is keyed
     *          by tokenId and the new tokenId must start clean; callers must
     *          cancel first.
     *        - `newIdentityId != 0`, `newMultiplier18 == _tierMultiplier(newLockTier)`.
     *
     *      Side effects (all atomic):
     *        1. Unwind old-identity effective-stake contribution at
     *           `currentEpoch` (and cancel the old expiry drop if still
     *           boosted).
     *        2. Install new-identity effective-stake contribution at
     *           `currentEpoch` and schedule the new expiry drop.
     *        3. Write `positions[newTokenId]` with preserved stats and
     *           caller-supplied identity/tier.
     *        4. Delete `positions[oldTokenId]`.
     *        5. `_popNodeToken(oldIdentityId, oldTokenId)` +
     *           `_pushNodeToken(newIdentityId, newTokenId)`.
     *        6. If identity changes, move `raw` between per-node aggregates;
     *           `totalStakeV10` invariant (raw stays in system).
     *        7. Finalize dirty epochs up to `currentEpoch - 1`.
     *        8. Emit `PositionReplaced`.
     *
     *      Caller obligations (in `StakingV10`):
     *        - Settle per-node score-per-stake indices via
     *          `_prepareForStakeChangeV10` on BOTH old and new identities at
     *          `currentEpoch` BEFORE calling this primitive. The primitive
     *          only touches CSS internal diff tables; it does not talk to
     *          `RandomSamplingStorage`.
     *        - Sharding-table maintenance + Ask recalculation after this
     *          call based on the resulting per-node `nodeStakeV10`.
     */
    function createNewPositionFromExisting(
        uint256 oldTokenId,
        uint256 newTokenId,
        uint72 newIdentityId,
        uint40 newLockTier,
        uint64 newMultiplier18
    ) external onlyContracts {
        require(newIdentityId != 0, "Zero node");
        require(newMultiplier18 == _tierMultiplier(newLockTier), "Tier mismatch");
        require(positions[newTokenId].identityId == 0, "New token used");
        require(oldTokenId != newTokenId, "Same tokenId");
        require(pendingWithdrawals[oldTokenId].amount == 0, "Has pending");

        Position memory old = positions[oldTokenId];
        require(old.identityId != 0, "No position");
        uint96 raw = old.raw;
        require(raw > 0, "Zero raw");

        uint72 oldIdentityId = old.identityId;
        uint40 oldExpiryEpoch = old.expiryEpoch;
        uint64 oldMultiplier18 = old.multiplier18;

        uint256 currentEpoch = chronos.getCurrentEpoch();

        // --- 1. Unwind old-identity effective-stake contribution (D19 — no rewards addend). ---
        bool oldStillBoosted = oldExpiryEpoch != 0 && currentEpoch < oldExpiryEpoch;
        uint256 effectiveNowOld = oldStillBoosted
            ? (uint256(raw) * uint256(oldMultiplier18)) / SCALE18
            : uint256(raw);
        int256 signedOld = int256(effectiveNowOld);
        nodeEffectiveStakeDiff[oldIdentityId][currentEpoch] -= signedOld;
        _markNodeDirty(oldIdentityId, currentEpoch);
        // Cancel the old pending expiry drop on the old identity (if scheduled).
        int256 oldExpiryDelta;
        if (oldStillBoosted && oldMultiplier18 > SCALE18) {
            oldExpiryDelta =
                (int256(uint256(raw)) * int256(uint256(oldMultiplier18) - SCALE18)) / int256(SCALE18);
            nodeEffectiveStakeDiff[oldIdentityId][oldExpiryEpoch] += oldExpiryDelta;
        }

        // --- 2. Install new-identity effective-stake contribution. ---
        // New position enters fresh at currentEpoch under the caller-supplied
        // multiplier. Full `raw * newMultiplier18` — the lock starts now.
        uint256 effectiveNowNew = (uint256(raw) * uint256(newMultiplier18)) / SCALE18;
        int256 signedNew = int256(effectiveNowNew);
        nodeEffectiveStakeDiff[newIdentityId][currentEpoch] += signedNew;
        _markNodeDirty(newIdentityId, currentEpoch);

        uint40 newExpiryEpoch = _computeExpiryEpoch(newLockTier);
        int256 newExpiryDelta;
        if (newLockTier > 0 && newMultiplier18 > SCALE18) {
            newExpiryDelta =
                (int256(uint256(raw)) * int256(uint256(newMultiplier18) - SCALE18)) / int256(SCALE18);
            nodeEffectiveStakeDiff[newIdentityId][newExpiryEpoch] -= newExpiryDelta;
        }

        // --- 3. Global effective-stake diff: net delta at currentEpoch + move expiry drops. ---
        // Global total changes by (new contribution − old contribution) at
        // currentEpoch. Old/new expiry drops are mirrored into the global
        // table so `totalEffectiveStakeAtEpoch` stays correct past expiry.
        effectiveStakeDiff[currentEpoch] += (signedNew - signedOld);
        _markGlobalDirty(currentEpoch);
        if (oldExpiryDelta != 0) {
            effectiveStakeDiff[oldExpiryEpoch] += oldExpiryDelta;
        }
        if (newExpiryDelta != 0) {
            effectiveStakeDiff[newExpiryEpoch] -= newExpiryDelta;
        }

        // --- 4. Write new position preserving stats; delete old. ---
        positions[newTokenId] = Position({
            raw: raw,
            lockTier: newLockTier,
            expiryEpoch: newExpiryEpoch,
            identityId: newIdentityId,
            cumulativeRewardsClaimed: old.cumulativeRewardsClaimed,
            multiplier18: newMultiplier18,
            lastClaimedEpoch: old.lastClaimedEpoch,
            migrationEpoch: old.migrationEpoch
        });
        delete positions[oldTokenId];

        // --- 5. Per-node enumeration (D5). ---
        _popNodeToken(oldIdentityId, oldTokenId);
        _pushNodeToken(newIdentityId, newTokenId);

        // --- 6. Raw aggregates (D15). Totals invariant. ---
        // Manual move (not _decrease+_increase) to keep totalStakeV10 strictly
        // invariant without firing spurious "Decreased+Increased" pair events
        // that imply TRAC moved in/out of the system.
        if (oldIdentityId != newIdentityId) {
            uint256 rawU = uint256(raw);
            nodeStakeV10[oldIdentityId] -= rawU;
            nodeStakeV10[newIdentityId] += rawU;
            emit NodeStakeV10Decreased(oldIdentityId, rawU, nodeStakeV10[oldIdentityId], totalStakeV10);
            emit NodeStakeV10Increased(newIdentityId, rawU, nodeStakeV10[newIdentityId], totalStakeV10);
        }

        // --- 7. Finalize dirty epochs. ---
        if (currentEpoch > 1) {
            _finalizeEffectiveStakeUpTo(currentEpoch - 1);
            if (oldIdentityId != newIdentityId) {
                _finalizeNodeEffectiveStakeUpTo(oldIdentityId, currentEpoch - 1);
            }
            _finalizeNodeEffectiveStakeUpTo(newIdentityId, currentEpoch - 1);
        }

        emit PositionReplaced(
            oldTokenId,
            newTokenId,
            newIdentityId,
            raw,
            newLockTier,
            newExpiryEpoch,
            newMultiplier18
        );
    }

    function setLastClaimedEpoch(uint256 tokenId, uint32 epoch) external onlyContracts {
        require(positions[tokenId].identityId != 0, "No position");
        positions[tokenId].lastClaimedEpoch = epoch;
        emit LastClaimedEpochUpdated(tokenId, epoch);
    }

    /**
     * @notice Set migration epoch on a position. Used by the V8→V10
     *         migration entries to mark a position's `migrationEpoch`
     *         after seeding. Typically set once at create time via the
     *         `createPosition` parameter; this setter exists for the
     *         rare case where migration metadata needs patching after
     *         the NFT mint.
     */
    function setMigrationEpoch(uint256 tokenId, uint32 epoch) external onlyContracts {
        require(positions[tokenId].identityId != 0, "No position");
        positions[tokenId].migrationEpoch = epoch;
        emit MigrationEpochSet(tokenId, epoch);
    }

    function setV10LaunchEpoch(uint256 epoch) external onlyContracts {
        v10LaunchEpoch = epoch;
        emit V10LaunchEpochSet(epoch);
    }

    function deletePosition(uint256 tokenId) external onlyContracts {
        Position memory pos = positions[tokenId];
        require(pos.identityId != 0, "No position");

        uint256 currentEpoch = chronos.getCurrentEpoch();
        uint96 raw = pos.raw;
        uint72 identityId = pos.identityId;
        uint40 expiryEpoch = pos.expiryEpoch;
        uint64 multiplier18 = pos.multiplier18;
        bool stillBoosted = expiryEpoch != 0 && currentEpoch < expiryEpoch;
        // D19: no rewards addend.
        uint256 effectiveNow = stillBoosted
            ? (uint256(raw) * uint256(multiplier18)) / SCALE18
            : uint256(raw);

        // Remove contribution from currentEpoch onward
        int256 signedEffectiveNow = int256(effectiveNow);
        effectiveStakeDiff[currentEpoch] -= signedEffectiveNow;
        nodeEffectiveStakeDiff[identityId][currentEpoch] -= signedEffectiveNow;
        _markGlobalDirty(currentEpoch);
        _markNodeDirty(identityId, currentEpoch);

        // Cancel the pending expiry subtraction so it does not fire after delete
        if (stillBoosted && multiplier18 > SCALE18) {
            int256 expiryDelta = (int256(uint256(raw)) * int256(uint256(multiplier18) - SCALE18)) / int256(SCALE18);
            effectiveStakeDiff[expiryEpoch] += expiryDelta;
            nodeEffectiveStakeDiff[identityId][expiryEpoch] += expiryDelta;
        }

        // D5 — remove from per-node enumeration before zeroing the struct.
        _popNodeToken(identityId, tokenId);

        // D15 — subtract raw from aggregates.
        if (raw > 0) {
            _decreaseNodeStakeV10(identityId, uint256(raw));
        }

        delete positions[tokenId];

        if (currentEpoch > 1) {
            _finalizeEffectiveStakeUpTo(currentEpoch - 1);
            _finalizeNodeEffectiveStakeUpTo(identityId, currentEpoch - 1);
        }

        emit PositionDeleted(tokenId);
    }

    // ============================================================
    //       D19 — Raw-only mutators (compound-into-raw model)
    // ============================================================
    //
    //   effStake(e) = (e < expiryEpoch ? raw*mult/1e18 : raw)
    //
    // Claim compounds TRAC rewards into `raw` via `increaseRaw`, so claimed
    // rewards earn the position's current lock multiplier going forward.
    // `addCumulativeRewardsClaimed` is a statistic-only side channel that
    // claim bumps alongside `increaseRaw`; it does NOT enter effective-stake
    // math.
    //
    // All mutators use `identityId != 0` as the existence sentinel and
    // mirror the Phase 2 diff pattern (write diff at `currentEpoch`, mark
    // dirty, finalize `[last+1, currentEpoch-1]`).

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
            int256 expiryDelta = (int256(uint256(amount)) * int256(uint256(multiplier18) - SCALE18)) / int256(SCALE18);
            effectiveStakeDiff[expiryEpoch] += expiryDelta;
            nodeEffectiveStakeDiff[identityId][expiryEpoch] += expiryDelta;
        }

        pos.raw = pos.raw - amount;

        // D15 — maintain raw aggregates.
        _decreaseNodeStakeV10(identityId, uint256(amount));

        if (currentEpoch > 1) {
            _finalizeEffectiveStakeUpTo(currentEpoch - 1);
            _finalizeNodeEffectiveStakeUpTo(identityId, currentEpoch - 1);
        }

        emit RawDecreased(tokenId, amount, pos.raw);
    }

    /**
     * @notice Symmetric counterpart of `decreaseRaw`. Used by
     *         `StakingV10.cancelWithdrawal` to restore raw on cancel, and
     *         by the claim path to compound rewards into `raw` (D19).
     *
     *   pre-expiry : +amount*mult/1e18 at currentEpoch; re-install pending
     *                expiry delta (-amount*(mult-1)/1e18 at expiryEpoch).
     *   post-expiry: +amount flat at currentEpoch; no expiry delta.
     */
    function increaseRaw(uint256 tokenId, uint96 amount) external onlyContracts {
        Position storage pos = positions[tokenId];
        require(pos.identityId != 0, "No position");
        if (amount == 0) {
            emit RawIncreased(tokenId, 0, pos.raw);
            return;
        }

        // uint96 overflow guard — Solidity 0.8+ checks on increment too,
        // but we want the error to be clearly attributable to position-cap
        // arithmetic rather than a bare overflow revert.
        require(uint256(pos.raw) + uint256(amount) <= type(uint96).max, "Raw overflow");

        uint256 currentEpoch = chronos.getCurrentEpoch();
        uint72 identityId = pos.identityId;
        uint40 expiryEpoch = pos.expiryEpoch;
        uint64 multiplier18 = pos.multiplier18;
        bool stillBoosted = expiryEpoch != 0 && currentEpoch < expiryEpoch;

        uint256 effectiveNow = stillBoosted
            ? (uint256(amount) * uint256(multiplier18)) / SCALE18
            : uint256(amount);

        int256 signedEffectiveNow = int256(effectiveNow);
        effectiveStakeDiff[currentEpoch] += signedEffectiveNow;
        nodeEffectiveStakeDiff[identityId][currentEpoch] += signedEffectiveNow;
        _markGlobalDirty(currentEpoch);
        _markNodeDirty(identityId, currentEpoch);

        if (stillBoosted && multiplier18 > SCALE18) {
            int256 expiryDelta = (int256(uint256(amount)) * int256(uint256(multiplier18) - SCALE18)) / int256(SCALE18);
            effectiveStakeDiff[expiryEpoch] -= expiryDelta;
            nodeEffectiveStakeDiff[identityId][expiryEpoch] -= expiryDelta;
        }

        pos.raw = pos.raw + amount;

        // D15 — maintain raw aggregates.
        _increaseNodeStakeV10(identityId, uint256(amount));

        if (currentEpoch > 1) {
            _finalizeEffectiveStakeUpTo(currentEpoch - 1);
            _finalizeNodeEffectiveStakeUpTo(identityId, currentEpoch - 1);
        }

        emit RawIncreased(tokenId, amount, pos.raw);
    }

    /**
     * @notice D19 statistic mutator. Bumps the lifetime counter of
     *         TRAC-denominated rewards that have been compounded into
     *         `raw` for this position. Pure side channel — never enters
     *         effective-stake math.
     */
    function addCumulativeRewardsClaimed(uint256 tokenId, uint96 amount) external onlyContracts {
        Position storage pos = positions[tokenId];
        require(pos.identityId != 0, "No position");
        if (amount == 0) {
            emit CumulativeRewardsClaimedUpdated(tokenId, 0, pos.cumulativeRewardsClaimed);
            return;
        }

        uint96 newTotal = pos.cumulativeRewardsClaimed + amount;
        // Defensive guard; uint96 fits ~7.9e10 TRAC which is well above the
        // protocol cap but compounded lifetime rewards could theoretically
        // overflow on a very long-lived position. Callers should rotate
        // to a fresh NFT before hitting this.
        require(newTotal >= pos.cumulativeRewardsClaimed, "CRC overflow");
        pos.cumulativeRewardsClaimed = newTotal;
        emit CumulativeRewardsClaimedUpdated(tokenId, amount, newTotal);
    }

    // ============================================================
    //         D3 — Absorbed DelegatorsInfo mutators (V10)
    // ============================================================

    function setIsOperatorFeeClaimedForEpoch(uint72 identityId, uint256 epoch, bool isClaimed) external onlyContracts {
        isOperatorFeeClaimedForEpoch[identityId][epoch] = isClaimed;
        emit IsOperatorFeeClaimedForEpochUpdated(identityId, epoch, isClaimed);
    }

    function setNetNodeEpochRewards(uint72 identityId, uint256 epoch, uint256 amount) external onlyContracts {
        netNodeEpochRewards[identityId][epoch] = amount;
        emit NetNodeEpochRewardsSet(identityId, epoch, amount);
    }

    function getIsOperatorFeeClaimedForEpoch(uint72 identityId, uint256 epoch) external view returns (bool) {
        return isOperatorFeeClaimedForEpoch[identityId][epoch];
    }

    function getNetNodeEpochRewards(uint72 identityId, uint256 epoch) external view returns (uint256) {
        return netNodeEpochRewards[identityId][epoch];
    }

    // ============================================================
    //              V10-native pending withdrawal CRUD
    // ============================================================

    function createPendingWithdrawal(
        uint256 tokenId,
        uint96 amount,
        uint64 releaseAt
    ) external onlyContracts {
        require(amount > 0, "Zero amount");
        require(pendingWithdrawals[tokenId].amount == 0, "Pending exists");
        pendingWithdrawals[tokenId] = PendingWithdrawal({amount: amount, releaseAt: releaseAt});
        emit PendingWithdrawalCreated(tokenId, amount, releaseAt);
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

    // D15 — V10 stake aggregate reads.
    function getNodeStakeV10(uint72 identityId) external view returns (uint256) {
        return nodeStakeV10[identityId];
    }

    function getTotalStakeV10() external view returns (uint256) {
        return totalStakeV10;
    }

    // D5 — per-node tokenId enumeration reads.
    function getNodeTokens(uint72 identityId) external view returns (uint256[] memory) {
        return nodeTokens[identityId];
    }

    function getNodeTokenCount(uint72 identityId) external view returns (uint256) {
        return nodeTokens[identityId].length;
    }

    function getNodeTokenAt(uint72 identityId, uint256 index) external view returns (uint256) {
        return nodeTokens[identityId][index];
    }

    // ============================================================
    //                     External finalizers
    // ============================================================

    // Hub contracts (notably Phase 11 reward math) can amortize the
    // O(currentEpoch - lastFinalizedEpoch) simulate path into a single
    // write by calling these before reading getTotalEffectiveStakeAtEpoch /
    // getNodeEffectiveStakeAtEpoch across a long dormant window.

    function finalizeEffectiveStakeUpTo(uint256 epoch) external onlyContracts {
        require(epoch < chronos.getCurrentEpoch(), "Future or current epoch");
        _finalizeEffectiveStakeUpTo(epoch);
    }

    function finalizeNodeEffectiveStakeUpTo(uint72 identityId, uint256 epoch) external onlyContracts {
        require(epoch < chronos.getCurrentEpoch(), "Future or current epoch");
        _finalizeNodeEffectiveStakeUpTo(identityId, epoch);
    }

    // ============================================================
    //                       Internal helpers
    // ============================================================

    /**
     * @dev Wall-clock expiry computation (D20). Rounds up via
     *      `BLOCK_DRIFT_BUFFER` so the user always gets AT LEAST their
     *      committed duration across epoch boundaries. Returns 0 for
     *      tier-0 (permanent rest state).
     */
    function _computeExpiryEpoch(uint40 lockTier) internal view returns (uint40) {
        if (lockTier == 0) return 0;
        uint256 duration = _tierDuration(lockTier);
        uint256 exp = chronos.epochAtTimestamp(block.timestamp + duration + BLOCK_DRIFT_BUFFER);
        require(exp <= type(uint40).max, "Expiry overflow");
        return uint40(exp);
    }

    function _pushNodeToken(uint72 identityId, uint256 tokenId) internal {
        nodeTokenIndex[identityId][tokenId] = nodeTokens[identityId].length;
        nodeTokens[identityId].push(tokenId);
    }

    function _popNodeToken(uint72 identityId, uint256 tokenId) internal {
        uint256[] storage arr = nodeTokens[identityId];
        uint256 idx = nodeTokenIndex[identityId][tokenId];
        uint256 last = arr.length - 1;
        if (idx != last) {
            uint256 movedToken = arr[last];
            arr[idx] = movedToken;
            nodeTokenIndex[identityId][movedToken] = idx;
        }
        arr.pop();
        delete nodeTokenIndex[identityId][tokenId];
    }

    function _increaseNodeStakeV10(uint72 identityId, uint256 amount) internal {
        nodeStakeV10[identityId] += amount;
        totalStakeV10 += amount;
        emit NodeStakeV10Increased(identityId, amount, nodeStakeV10[identityId], totalStakeV10);
    }

    function _decreaseNodeStakeV10(uint72 identityId, uint256 amount) internal {
        nodeStakeV10[identityId] -= amount;
        totalStakeV10 -= amount;
        emit NodeStakeV10Decreased(identityId, amount, nodeStakeV10[identityId], totalStakeV10);
    }

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
