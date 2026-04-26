// SPDX-License-Identifier: Apache-2.0

pragma solidity ^0.8.20;

import {Chronos} from "./Chronos.sol";
import {HubDependent} from "../abstract/HubDependent.sol";
import {ICustodian} from "../interfaces/ICustodian.sol";
import {INamed} from "../interfaces/INamed.sol";
import {IVersioned} from "../interfaces/IVersioned.sol";
import {HubLib} from "../libraries/HubLib.sol";

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
 * Tier model (D20 — mutable wall-clock tier ladder):
 *   - Tier durations and multipliers are stored in `_tiers` (keyed by
 *     `lockTier` id). The baseline ladder seeded at `initialize()` is
 *     {0→(0s, 1x), 1→(30d, 1.5x), 3→(90d, 2x), 6→(180d, 3.5x), 12→(366d, 6x)}.
 *   - `expiryTimestamp = block.timestamp + duration` (timestamp-accurate;
 *     no epoch rounding, no drift buffer).
 *   - New tiers can be appended via `addTier` (HubOwner or multisig owner).
 *     Existing tiers can be deactivated via `deactivateTier` to stop
 *     accepting NEW fresh stakes, but relock / migration paths still
 *     honor the original commitment (existence-only check). The model is
 *     additive-only: once added a tier id cannot be removed.
 *
 * Effective-stake accounting (D26 — timestamp-accurate):
 *   - Each node carries a `runningNodeEffectiveStake[id]` settled at
 *     `nodeLastSettledAt[id]`, plus a sorted queue of pending boost-
 *     expiry drops (`nodeExpiryTimes[id]` / `nodeExpiryDrop[id][ts]`)
 *     with a monotonic head cursor `nodeExpiryHead[id]`.
 *   - `settleNodeTo(id, ts)` advances the running stake to `ts` by
 *     draining all expiry entries whose timestamp is <= ts. Called by
 *     every CSS mutator before applying its own delta, and by
 *     `RandomSampling.submitProof` before integrating score.
 *   - This replaces the v2.x epoch-diff accumulator (effectiveStakeDiff,
 *     nodeEffectiveStakeDiff, lastFinalizedEpoch, finalize*). Past-epoch
 *     effective-stake snapshots are no longer reconstructable from CSS;
 *     consumers that need them should settle and read "current" state.
 */
contract ConvictionStakingStorage is INamed, IVersioned, HubDependent {
    string private constant _NAME = "ConvictionStakingStorage";
    // Version history:
    //   1.1.0 — split-bucket rewards, discrete tier ladder.
    //   1.2.0 — V10-native pending-withdrawal storage (create/delete/get).
    //   2.0.0 — V10 canonical store (positions + per-node aggregates +
    //           absorbed DelegatorsInfo + tier constants).
    //   2.1.0 — Mutable D20 tier ladder (lockTier rename, _tiers mapping).
    //   2.2.0 — D14/D25 atomic-withdraw & in-place redelegate (removed
    //           PendingWithdrawal).
    //   3.0.0 — D26 timestamp-accurate effective-stake accounting:
    //           * `Position.expiryEpoch` → `Position.expiryTimestamp`
    //             (uint40 seconds-since-unix-epoch, NOT a Chronos epoch).
    //           * Per-node running effective-stake with a sorted pending-
    //             expiry queue. Epoch-diff accumulator, finalize helpers
    //             and their dirty cursors removed.
    //           * `BLOCK_DRIFT_BUFFER` removed (no longer meaningful).
    //   3.1.0 — D26 code-review follow-ups:
    //           * M1 — `updateOnRelock` removed; `createNewPositionFromExisting`
    //             simplified to same-identity-only (cross-identity branch was
    //             unreachable — `redelegate` goes through `updateOnRedelegate`).
    //           * M2 — `nodeExpiryPresent` mapping added so a cancel→reschedule
    //             at the same `ts` doesn't duplicate the queue slot.
    //           * M3/M4 — `addTier` rejects degenerate tier configs
    //             (tier 0 must be rest state; non-zero tier needs both a
    //             positive duration and a >1x multiplier).
    //           * L4 — `createPosition` guards against `currentEpoch == 0`.
    //           * L5 — `_cancelNodeExpiry` `delete`s the slot when the
    //             remaining drop hits zero (refunds SSTORE).
    //           * L7 — `getNodeEffectiveStakeAtEpoch` tolerates Chronos
    //             returning 0 for unanchored epochs.
    //           * L9 — `setV10LaunchEpoch` is one-shot (anchor cannot be
    //             silently rebound).
    //           * L11 — `createPosition` no longer takes `multiplier18`;
    //             it reads the multiplier from the tier table.
    string private constant _VERSION = "3.1.0";

    // Multiplier scale, matches DKGStakingConvictionNFT._convictionMultiplier
    // (returns 1e18-scaled values so fractional tiers like 1.5x and 3.5x
    // are representable).
    uint256 internal constant SCALE18 = 1e18;

    // ============================================================
    //                 D20 — Mutable tier ladder
    // ============================================================

    // Tier definition. `duration` is the committed wall-clock lock
    // (seconds) passed to `_computeExpiryTimestamp`. `multiplier18` is the
    // 1e18-scaled effective-stake multiplier applied pre-expiry.
    //
    // `active` gates NEW fresh stakes (createPosition with migrationEpoch==0).
    // Relock and migration paths take the existence-only path so the user's
    // original commitment is honored even if a tier has since been retired.
    //
    // `exists` distinguishes a never-added tier id from a deactivated one.
    struct TierConfig {
        uint256 duration;
        uint64 multiplier18;
        bool active;
        bool exists;
    }

    // Position layout (two storage slots — V10 compound-into-raw model):
    //   slot 1: raw(96) + lockTier(40) + expiryTimestamp(40) + identityId(72) = 248 bits
    //   slot 2: cumulativeRewardsClaimed(96) + multiplier18(64)
    //           + lastClaimedEpoch(32) + migrationEpoch(32)                 = 224 bits
    //
    // Field semantics:
    //   raw                        — principal (+ compounded rewards). Earns
    //                                `multiplier18` while `block.timestamp <
    //                                expiryTimestamp`, drops back to 1x
    //                                thereafter. Claim compounds TRAC into
    //                                this field.
    //   lockTier                   — tier identifier from the mutable ladder
    //                                in `_tiers`. Baseline set is
    //                                {0, 1, 3, 6, 12} (30d / 90d / 180d /
    //                                366d wall-clock locks).
    //   expiryTimestamp            — Unix timestamp (seconds) at which the
    //                                boost drops. 0 iff lockTier == 0 (rest
    //                                state). uint40 holds ~34k years.
    //   identityId                 — the node this position delegates to.
    //   cumulativeRewardsClaimed   — D19 statistic: total TRAC ever compounded
    //                                into `raw` via claim for this NFT.
    //   multiplier18               — materialized copy of `_tierMultiplier(lockTier)`.
    //   lastClaimedEpoch           — Chronos epoch of the last successful claim.
    //   migrationEpoch             — D6: V8→V10 retroactive-claim boundary.
    //                                0 means "fresh V10 stake".
    struct Position {
        uint96 raw;
        uint40 lockTier;
        uint40 expiryTimestamp;
        uint72 identityId;
        // slot 2
        uint96 cumulativeRewardsClaimed;
        uint64 multiplier18;
        uint32 lastClaimedEpoch;
        uint32 migrationEpoch;
    }

    event PositionCreated(
        uint256 indexed tokenId,
        uint72 indexed identityId,
        uint96 raw,
        uint40 lockTier,
        uint40 expiryTimestamp,
        uint64 multiplier18,
        uint32 migrationEpoch
    );
    event PositionRedelegated(
        uint256 indexed tokenId,
        uint72 indexed oldIdentityId,
        uint72 indexed newIdentityId
    );
    event PositionDeleted(uint256 indexed tokenId);
    // D21+D23 — ephemeral NFT for `relock` only. The old tokenId is burned
    // and a fresh one is minted under a new tier. Off-chain indexers trace a
    // position's history across the burn-mint via the (oldTokenId, newTokenId)
    // link in this event.
    event PositionReplaced(
        uint256 indexed oldTokenId,
        uint256 indexed newTokenId,
        uint72 indexed newIdentityId,
        uint96 raw,
        uint40 newLockTier,
        uint40 newExpiryTimestamp,
        uint64 newMultiplier18
    );
    event LastClaimedEpochUpdated(uint256 indexed tokenId, uint32 epoch);
    event MigrationEpochSet(uint256 indexed tokenId, uint32 epoch);
    // D19 — compound-into-raw model.
    event RawIncreased(uint256 indexed tokenId, uint96 amount, uint96 newRaw);
    event RawDecreased(uint256 indexed tokenId, uint96 amount, uint96 newRaw);
    event CumulativeRewardsClaimedUpdated(uint256 indexed tokenId, uint96 added, uint96 newTotal);
    // D26 — running-effective-stake settlement.
    event NodeEffectiveStakeSettled(
        uint72 indexed identityId,
        uint40 fromTimestamp,
        uint40 toTimestamp,
        uint256 newRunningEffectiveStake
    );
    event NodeEffectiveStakeDelta(uint72 indexed identityId, int256 delta, uint256 newRunningEffectiveStake);
    event NodeExpiryScheduled(uint72 indexed identityId, uint40 timestamp, uint256 dropAdded, uint256 newTotalDrop);
    event NodeExpiryCancelled(uint72 indexed identityId, uint40 timestamp, uint256 dropRemoved, uint256 newTotalDrop);
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

    // ============================================================
    //    D26 — Running effective-stake state per node
    // ============================================================
    //
    // Invariant: `runningNodeEffectiveStake[id]` is the node's effective
    // stake AT `nodeLastSettledAt[id]` (inclusive). All expiries whose
    // timestamp is <= nodeLastSettledAt[id] have already been applied
    // (dropped from the running stake). All entries in `nodeExpiryTimes[id]`
    // at indices >= nodeExpiryHead[id] have timestamps strictly greater
    // than nodeLastSettledAt[id].
    mapping(uint72 => uint256) public runningNodeEffectiveStake;
    mapping(uint72 => uint40) public nodeLastSettledAt;

    // Sorted-ascending queue of pending boost-expiry timestamps per node.
    // We only append past index `nodeExpiryHead[id]`; partially-cancelled
    // entries stay physically present at their sorted position and drain
    // with whatever drop remains. Fully-cancelled entries (drop back to 0
    // before drain) are kept as "zero-drop" slots so that when a fresh
    // expiry lands at the same `ts`, `nodeExpiryPresent` prevents us from
    // pushing a duplicate (M2).
    mapping(uint72 => uint40[]) internal nodeExpiryTimes;
    // Aggregate boost drop scheduled at exactly `ts` for `id`. Multiple
    // positions sharing an `expiryTimestamp` are coalesced here.
    mapping(uint72 => mapping(uint40 => uint256)) internal nodeExpiryDrop;
    // Drain cursor into `nodeExpiryTimes[id]`. Entries below the head
    // are fully drained and MUST NOT be read again.
    mapping(uint72 => uint256) internal nodeExpiryHead;
    // M2 — tracks whether `ts` has a live slot in `nodeExpiryTimes[id]`
    //      at or past `nodeExpiryHead[id]`. Set on first schedule, cleared
    //      when the drain cursor walks past the slot. Without this, a
    //      cancel-to-zero followed by a fresh schedule at the same `ts`
    //      would push a second entry (functionally harmless, but doubles
    //      the SSTOREs and weakens the "at most one entry per `ts`"
    //      invariant on `nodeExpiryTimes[id]`).
    mapping(uint72 => mapping(uint40 => bool)) internal nodeExpiryPresent;

    // ============================================================
    //                D5 — Per-node tokenId enumeration
    // ============================================================
    mapping(uint72 => uint256[]) public nodeTokens;
    mapping(uint72 => mapping(uint256 => uint256)) public nodeTokenIndex;

    // ============================================================
    //           D15 — V10 stake aggregates (raw TRAC principal)
    // ============================================================
    mapping(uint72 => uint256) public nodeStakeV10;
    uint256 public totalStakeV10;

    // ============================================================
    //            D3 — Absorbed DelegatorsInfo fields (V10)
    // ============================================================
    mapping(uint72 => mapping(uint256 => bool)) public isOperatorFeeClaimedForEpoch;
    mapping(uint72 => mapping(uint256 => uint256)) public netNodeEpochRewards;

    // ============================================================
    //                 D7 — V10 launch epoch marker
    // ============================================================
    uint256 public v10LaunchEpoch;

    // ============================================================
    //           D20 (v2.1.0) — Mutable tier-ladder storage
    // ============================================================
    mapping(uint40 => TierConfig) internal _tiers;
    uint40[] public tierIds;

    // ============================================================
    //          Tier admin events (v2.1.0)
    // ============================================================
    event TierAdded(uint40 indexed lockTier, uint256 duration, uint64 multiplier18);
    event TierDeactivated(uint40 indexed lockTier);

    constructor(address hubAddress) HubDependent(hubAddress) {}

    function initialize() public onlyHub {
        chronos = Chronos(hub.getContractAddress("Chronos"));

        // Seed the baseline D20 ladder on the first call. Idempotent across
        // re-invocations (post-upgrade redeploys) because `_addTierInternal`
        // short-circuits when the tier id already exists.
        _seedBaselineTiers();
    }

    /// @dev Baseline durations are exact wall-clock commitments. Timestamp-
    ///      accurate accounting (D26) removes the v2.x BLOCK_DRIFT_BUFFER
    ///      padding: a 30-day lock means exactly 30 * 86400 seconds of boost.
    ///      Lock 12 uses 366 days so it absorbs a leap year.
    function _seedBaselineTiers() internal {
        if (!_tiers[0].exists) {
            _addTierInternal(0, 0, uint64(SCALE18)); // rest state (1x)
        }
        if (!_tiers[1].exists) {
            _addTierInternal(1, 30 days, uint64((15 * SCALE18) / 10));
        }
        if (!_tiers[3].exists) {
            _addTierInternal(3, 90 days, uint64(2 * SCALE18));
        }
        if (!_tiers[6].exists) {
            _addTierInternal(6, 180 days, uint64((35 * SCALE18) / 10));
        }
        if (!_tiers[12].exists) {
            _addTierInternal(12, 366 days, uint64(6 * SCALE18));
        }
    }

    function name() external pure virtual override returns (string memory) {
        return _NAME;
    }

    function version() external pure virtual override returns (string memory) {
        return _VERSION;
    }

    // ============================================================
    //                 D20 — Tier helpers (storage-backed)
    // ============================================================

    function _tierDuration(uint40 lockTier) internal view returns (uint256) {
        TierConfig memory tc = _tiers[lockTier];
        require(tc.exists, "Invalid tier");
        return tc.duration;
    }

    function _tierMultiplier(uint40 lockTier) internal view returns (uint64) {
        TierConfig memory tc = _tiers[lockTier];
        require(tc.exists, "Invalid tier");
        return tc.multiplier18;
    }

    function _requireActiveTier(uint40 lockTier) internal view {
        TierConfig memory tc = _tiers[lockTier];
        require(tc.exists, "Invalid tier");
        require(tc.active, "Tier inactive");
    }

    function expectedMultiplier18(uint40 lockTier) public view returns (uint64) {
        return _tierMultiplier(lockTier);
    }

    function tierDuration(uint40 lockTier) external view returns (uint256) {
        return _tierDuration(lockTier);
    }

    function getTier(uint40 lockTier) external view returns (TierConfig memory) {
        return _tiers[lockTier];
    }

    function allTierIds() external view returns (uint40[] memory) {
        return tierIds;
    }

    function tierCount() external view returns (uint256) {
        return tierIds.length;
    }

    // ============================================================
    //         D20 — Tier admin (v2.1.0, Q4=B multisig gate)
    // ============================================================

    /// @notice Add a new lock tier to the ladder (D20 governance).
    /// @dev    M3/M4 — rejects degenerate configurations that would either
    ///         brick `createPosition` (zero-duration + non-1x multiplier:
    ///         the would-be expiry lands at `block.timestamp`, the
    ///         `_scheduleNodeExpiry` "Expiry in past" check fires, every
    ///         mint reverts) or create "locked-but-boost-free" positions
    ///         that trip the `expiryEpoch` split branch in claim math for
    ///         no economic purpose (gas noise).
    ///
    ///         The tier ladder is:
    ///             * id 0 — rest state: `duration == 0`, `mult == 1e18`.
    ///             * id N>0 — real locked tier: `duration > 0` AND
    ///                        `mult > 1e18`.
    function addTier(
        uint40 lockTier,
        uint256 duration,
        uint64 multiplier18
    ) external onlyOwnerOrMultiSigOwner {
        require(!_tiers[lockTier].exists, "Tier exists");
        if (lockTier == 0) {
            require(duration == 0 && multiplier18 == uint64(SCALE18), "Tier 0 must be rest");
        } else {
            require(duration > 0, "Non-zero tier needs duration");
            require(multiplier18 > uint64(SCALE18), "Non-zero tier needs boost");
        }
        _addTierInternal(lockTier, duration, multiplier18);
    }

    function deactivateTier(uint40 lockTier) external onlyOwnerOrMultiSigOwner {
        TierConfig storage tc = _tiers[lockTier];
        require(tc.exists, "Invalid tier");
        require(tc.active, "Already inactive");
        tc.active = false;
        emit TierDeactivated(lockTier);
    }

    function _addTierInternal(
        uint40 lockTier,
        uint256 duration,
        uint64 multiplier18
    ) internal {
        _tiers[lockTier] = TierConfig({
            duration: duration,
            multiplier18: multiplier18,
            active: true,
            exists: true
        });
        tierIds.push(lockTier);
        emit TierAdded(lockTier, duration, multiplier18);
    }

    // --- Admin access control (mirrors DKGStakingConvictionNFT) ---

    modifier onlyOwnerOrMultiSigOwner() {
        address hubOwner = hub.owner();
        if (msg.sender != hubOwner && !_isMultiSigOwner(hubOwner)) {
            revert HubLib.UnauthorizedAccess("Only Hub Owner or Multisig Owner");
        }
        _;
    }

    function _isMultiSigOwner(address multiSigAddress) internal view returns (bool) {
        try ICustodian(multiSigAddress).getOwners() returns (address[] memory owners) {
            for (uint256 i = 0; i < owners.length; i++) {
                if (msg.sender == owners[i]) return true;
            }
        } catch {
            // Not a multisig or call reverted; treat as not an owner.
        }
        return false;
    }

    // ============================================================
    //          D26 — Running-effective-stake settlement
    // ============================================================
    //
    // WHAT THIS SECTION DOES
    // ----------------------
    // V10 tracks a node's *effective* stake (raw TRAC × active lock
    // multiplier) as a continuous quantity that changes at exact
    // timestamps — never at epoch boundaries. Two things make it move:
    //
    //   (1) Instantaneous deltas: someone stakes / unstakes / migrates /
    //       redelegates. These are applied via `_applyNodeStakeDelta`.
    //   (2) Time passing: a boost expires at its precise wall-clock
    //       `expiryTimestamp`, and from that second onward the position
    //       contributes `raw × 1x` instead of `raw × multiplier`. The
    //       difference is called the *drop*. Drops are pre-scheduled
    //       into a per-node sorted queue and drained by `_settleNodeTo`.
    //
    // `runningNodeEffectiveStake[id]` holds the node's effective stake
    // AS OF `nodeLastSettledAt[id]` (inclusive). To compute the value
    // "now", callers first bring the clock forward with `settleNodeTo`,
    // which walks the expiry queue up to `now` and subtracts all the
    // matured drops.
    //
    // WHO CALLS SETTLE AND WHY
    // ------------------------
    //   * `RandomSampling.submitProof` — before integrating score into
    //     `scorePerStake`, so the denominator reflects the node's
    //     effective stake at the proof's block timestamp (not at the
    //     last mutator call).
    //   * Every mutator in this file (createPosition, updateOnRelock,
    //     updateOnRedelegate, createNewPositionFromExisting,
    //     deletePosition, increaseRaw, decreaseRaw) — before touching
    //     `runningNodeEffectiveStake[id]`, so all deltas compose against
    //     a correctly-aged baseline.
    //   * Views that need a fresh instantaneous snapshot
    //     (`_simulateNodeEffectiveStakeAt` is the const-time counterpart
    //     used by `getNodeEffectiveStakeAtEpoch`).
    //
    // WHY THE STATE IS SHAPED LIKE THIS
    // ---------------------------------
    // We need sub-epoch accuracy but cannot loop over positions on every
    // read (thousands of delegators per popular node). The running
    // stake + pre-scheduled drop queue reduces every CSS mutation and
    // every proof to O(matured-drops-since-last-settle), which in
    // steady state is near-zero (see "LOOP BOUND" on `_settleNodeTo`).

    /// @notice Advance `runningNodeEffectiveStake[id]` to an explicit
    ///         target timestamp `ts`. Idempotent for past/current `ts`.
    /// @dev Exposed so `RandomSampling.submitProof` can settle to
    ///      `block.timestamp` before integrating `scorePerStake`. Also
    ///      used by views that need to simulate at an arbitrary `ts`
    ///      (though they call `_simulateNodeEffectiveStakeAt` instead,
    ///      which does not mutate state).
    /// @param identityId Canonical node id (matches StakingStorage).
    /// @param ts         Target wall-clock seconds. Treated as the
    ///                   inclusive upper bound: all expiries with
    ///                   `expiryTimestamp <= ts` are realized.
    function settleNodeTo(uint72 identityId, uint40 ts) public onlyContracts {
        _settleNodeTo(identityId, ts);
    }

    /// @notice Convenience wrapper settling to `block.timestamp`. This
    ///         is what every CSS mutator uses before applying its delta,
    ///         because `block.timestamp` is the authoritative "now" on
    ///         EVM chains.
    function settleNode(uint72 identityId) external onlyContracts {
        _settleNodeTo(identityId, uint40(block.timestamp));
    }

    /// @dev   Drain matured expiries up to `ts` and advance the node's
    ///        running effective stake and last-settled watermark.
    ///
    /// VARIABLES (in the context of the wider system):
    ///
    ///   `from`  — the node's previous last-settled watermark. Anything
    ///             with `expiryTimestamp <= from` was already applied in
    ///             a prior settle; anything > from has NOT yet been
    ///             applied and is still sitting in the queue.
    ///
    ///   `head`  — drain cursor into `nodeExpiryTimes[id]`. Entries at
    ///             indices < head are fully processed and MUST NOT be
    ///             read again. `head` only moves forward; we never pop
    ///             or rewrite the array, so the per-entry work is
    ///             strictly once-in-forever.
    ///
    ///   `times` — pointer to the per-node sorted-ascending array of
    ///             distinct `expiryTimestamp` values. Same-`ts` expiries
    ///             from multiple positions are coalesced at schedule
    ///             time (see `_scheduleNodeExpiry`) into one array slot.
    ///
    ///   `len`   — current array length. May grow (new expiries scheduled
    ///             mid-tx) but entries past `len` at call start are
    ///             irrelevant for *this* settle — they were added after
    ///             `from` and cannot have `ts <= ts` AND be sorted ahead
    ///             of the current head without violating the invariant.
    ///
    ///   `stake` — local copy of `runningNodeEffectiveStake[id]`, edited
    ///             in a scratch variable to avoid SSTORE per iteration.
    ///             Flushed back once at the end.
    ///
    ///   `t`     — the timestamp of the queue entry currently under
    ///             consideration. The loop breaks as soon as `t > ts`
    ///             because the array is sorted and all later entries
    ///             are strictly greater.
    ///
    ///   `drop`  — aggregate boost amount scheduled to expire at `t`
    ///             (summed across all positions sharing that `t`). The
    ///             drop equals `raw × (multiplier18 - 1e18) / 1e18` per
    ///             position at the moment it was scheduled, summed.
    ///             A zero drop means the entry was fully cancelled by
    ///             prior `_cancelNodeExpiry` calls (redelegate-away,
    ///             withdraw, relock) and is simply skipped.
    ///
    /// LOOP BOUND (why this cannot explode the block gas limit)
    /// --------------------------------------------------------
    /// The `while` terminates as soon as `t > ts` (1) or `head == len`
    /// (2). What could make it iterate "many" times?
    ///
    ///   (a) Entries are only added by `_scheduleNodeExpiry`, which is
    ///       itself only reachable from `onlyContracts` mutators above.
    ///       There is no external path for an attacker to spam the
    ///       queue — fresh entries cost someone real TRAC to lock.
    ///
    ///   (b) Entries with the same `ts` are coalesced into ONE array
    ///       slot (see `_scheduleNodeExpiry`: `if (existing != 0) return`).
    ///       So the queue length is bounded by the number of *distinct*
    ///       active expiry timestamps the node has ever been scheduled
    ///       against — NOT by the delegator count.
    ///
    ///   (c) Work is strictly amortized once: each array slot is
    ///       visited by exactly one `_settleNodeTo` call across the
    ///       contract's lifetime (we only ever advance `head`). In the
    ///       steady state where settle is called from every CSS mutator
    ///       and every `submitProof` (~ every epoch), the number of
    ///       entries matured between two consecutive settles is
    ///       bounded by (new expiries scheduled during that window that
    ///       also matured within it) — in practice 0 on a healthy,
    ///       proof-active node.
    ///
    /// The only scenario that produces a large iteration count in one
    /// call is long-duration node DORMANCY: the node produces no proofs
    /// AND receives no CSS mutations while many distinct-ts expiries
    /// mature. Concrete napkin math: on NeuroWeb (~12s blocks) a node
    /// that accumulates ONE brand-new distinct expiry timestamp per
    /// block for 30 days and then stops settling for 30 more days sees
    /// ~216k matured entries on resume — at ~5k gas per iteration that
    /// is ~1.1B gas, well above any block limit. That tail is tolerable
    /// because:
    ///
    ///   * To reach it, the node has to have been completely silent
    ///     (no proofs, no stake/unstake, no relock, no redelegate in or
    ///     out) for longer than its longest outstanding tier duration.
    ///     In practice `submitProof` settles on every proof, so any
    ///     proof-producing node drains continuously.
    ///   * Same-block same-tier stakes coalesce, so realistic distinct-
    ///     ts counts are far below the worst case.
    ///   * The invariant is recoverable: any single `settleNodeTo` that
    ///     OOMs blocks only the caller's tx; the queue state is
    ///     unchanged, so later calls can still make progress once gas
    ///     budgets allow.
    ///
    /// If operational telemetry later shows real-world queues
    /// approaching danger, the escape hatch is a bounded variant
    /// (`settleNodeToMax(id, ts, maxEntries)`) that advances `head` by
    /// at most `maxEntries` and lets the protocol drain a dormant queue
    /// across several txs. Not shipped now because the "who even calls
    /// this" analysis (a) + steady-state (c) make it dead code for any
    /// node that ever submits a proof.
    ///
    /// INVARIANTS MAINTAINED ON EXIT
    /// -----------------------------
    ///   I1. nodeLastSettledAt[id] == ts.
    ///   I2. For every `t` with `t <= ts`, `nodeExpiryDrop[id][t] == 0`.
    ///   I3. runningNodeEffectiveStake[id] equals the true effective
    ///       stake of the node at wall-clock second `ts`, assuming the
    ///       prior entry state was consistent (recursive invariant).
    function _settleNodeTo(uint72 identityId, uint40 ts) internal {
        // Idempotent replay: if we've already settled at or beyond `ts`,
        // the running stake is already correct for that moment.
        uint40 from = nodeLastSettledAt[identityId];
        if (ts <= from) {
            return;
        }

        // Load the drain cursor, the sorted expiry array, its length,
        // and the running stake into locals. `times` is a storage
        // pointer (not a copy): we index into it but never mutate it
        // here. `stake` is a scratch local so iteration does not
        // SSTORE; we flush once at the end.
        uint256 head = nodeExpiryHead[identityId];
        uint40[] storage times = nodeExpiryTimes[identityId];
        uint256 len = times.length;
        uint256 stake = runningNodeEffectiveStake[identityId];

        // Walk every queued expiry whose timestamp is <= `ts`, in order.
        // The queue is sorted ascending, so as soon as `times[head] > ts`
        // we are done — nothing later can satisfy the condition.
        while (head < len) {
            uint40 t = times[head];
            if (t > ts) break;

            // `drop` is the total boost (sum over all positions that
            // were coalesced at this `t`) that MUST come off the
            // running stake at exactly second `t`. Zero means the
            // entry was fully cancelled (e.g. all those positions were
            // relocked / redelegated-away / withdrawn before expiry) —
            // harmless no-op.
            uint256 drop = nodeExpiryDrop[identityId][t];
            if (drop != 0) {
                // Invariant (enforced at schedule time): drop values are
                // derived from raw × (multiplier - 1) portions of real
                // positions on this node, so their sum can never exceed
                // the running effective stake that was installed by the
                // same schedule call.
                stake -= drop;

                // Free the aggregate slot (gas refund + keeps state
                // compact). We never revisit drained `t` because `head`
                // only moves forward.
                delete nodeExpiryDrop[identityId][t];
            }
            // M2 — clear the "slot reserved" flag now that the head has
            // walked past this `ts`. A fresh schedule at the same `ts`
            // AFTER this point is impossible anyway (`_scheduleNodeExpiry`
            // requires `ts > nodeLastSettledAt[id]`); we still clear it
            // to claim the SSTORE refund and keep state compact.
            delete nodeExpiryPresent[identityId][t];
            // `head` is bounded above by `len`, both fit in uint256;
            // incrementing cannot overflow.
            unchecked {
                head++;
            }
        }

        // Flush all three pieces of state together so the invariants
        // above hold atomically.
        nodeExpiryHead[identityId] = head;
        runningNodeEffectiveStake[identityId] = stake;
        nodeLastSettledAt[identityId] = ts;
        emit NodeEffectiveStakeSettled(identityId, from, ts, stake);
    }

    /// @dev Simulated settle: computes effective stake at `ts` without
    ///      writing. `ts` must be >= nodeLastSettledAt[id] (we can't look
    ///      into the past; pre-settled history is not retained under D26).
    function _simulateNodeEffectiveStakeAt(uint72 identityId, uint40 ts) internal view returns (uint256) {
        if (ts < nodeLastSettledAt[identityId]) {
            // Caller asked for a past moment; we can't reconstruct. Return
            // 0 to match "no stake at that moment" semantics, matching
            // the pre-creation default for the running mapping.
            return 0;
        }
        uint256 head = nodeExpiryHead[identityId];
        uint40[] storage times = nodeExpiryTimes[identityId];
        uint256 len = times.length;
        uint256 stake = runningNodeEffectiveStake[identityId];
        while (head < len) {
            uint40 t = times[head];
            if (t > ts) break;
            stake -= nodeExpiryDrop[identityId][t];
            unchecked {
                head++;
            }
        }
        return stake;
    }

    // ============================================================
    //              D26 — Expiry queue helpers (internal)
    // ============================================================

    /// @dev Schedule a boost-expiry drop at `ts` for `id`. Maintains the
    ///      sorted-ascending invariant over `nodeExpiryTimes[id]` starting
    ///      at `nodeExpiryHead[id]`. Typical call pattern appends to the
    ///      tail (new lock later than all existing); cross-tier inserts
    ///      shift the tail one slot rightward until the correct position.
    /// @dev M2 — uses `nodeExpiryPresent[id][ts]` (not `drop != 0`) as the
    ///      "array slot already reserved" witness. This handles the
    ///      cancel→reschedule-at-same-ts case: after a full cancel the
    ///      drop aggregate is zero but the array slot is still live; we
    ///      must NOT push a duplicate.
    function _scheduleNodeExpiry(uint72 identityId, uint40 ts, uint256 drop) internal {
        require(drop != 0, "Zero drop");
        require(ts > nodeLastSettledAt[identityId], "Expiry in past");
        uint256 existing = nodeExpiryDrop[identityId][ts];
        nodeExpiryDrop[identityId][ts] = existing + drop;
        emit NodeExpiryScheduled(identityId, ts, drop, existing + drop);
        if (nodeExpiryPresent[identityId][ts]) {
            // ts already has a slot in the queue; just bumped the drop.
            return;
        }
        nodeExpiryPresent[identityId][ts] = true;

        // Insert `ts` into the sorted queue.
        uint40[] storage arr = nodeExpiryTimes[identityId];
        uint256 head = nodeExpiryHead[identityId];
        uint256 len = arr.length;
        arr.push(ts); // temporarily at tail
        // Bubble left while the left neighbor is strictly greater AND we
        // haven't crossed the drain head.
        uint256 i = len;
        while (i > head && arr[i - 1] > ts) {
            arr[i] = arr[i - 1];
            unchecked {
                i--;
            }
        }
        arr[i] = ts;
    }

    /// @dev Cancel part (or all) of a previously scheduled boost drop. We
    ///      keep the array entry in place (M2: `nodeExpiryPresent[id][ts]`
    ///      stays `true`) so that a re-schedule at the same `ts` does not
    ///      push a duplicate slot; the drain cursor will clean both up
    ///      when it walks past. A zero-drop entry is harmlessly drained
    ///      as a no-op when settle reaches it.
    /// @dev L5 — `delete`s the aggregate slot when remaining hits zero so
    ///      the SSTORE gets its gas refund. The `nodeExpiryPresent` flag
    ///      is deliberately NOT cleared: M2's whole point is to remember
    ///      "this `ts` already has an array slot" until the cursor walks
    ///      past it.
    function _cancelNodeExpiry(uint72 identityId, uint40 ts, uint256 drop) internal {
        if (drop == 0) return;
        if (ts <= nodeLastSettledAt[identityId]) {
            // Already drained — nothing to cancel.
            return;
        }
        uint256 existing = nodeExpiryDrop[identityId][ts];
        require(existing >= drop, "Cancel > scheduled");
        uint256 remaining = existing - drop;
        if (remaining == 0) {
            delete nodeExpiryDrop[identityId][ts];
        } else {
            nodeExpiryDrop[identityId][ts] = remaining;
        }
        emit NodeExpiryCancelled(identityId, ts, drop, remaining);
    }

    /// @dev Apply an instantaneous delta to `runningNodeEffectiveStake[id]`.
    ///      Must be called after the node has been settled to `block.timestamp`
    ///      (callers are responsible — all mutators below do so).
    function _applyNodeStakeDelta(uint72 identityId, int256 delta) internal {
        if (delta == 0) return;
        uint256 stake = runningNodeEffectiveStake[identityId];
        if (delta > 0) {
            stake += uint256(delta);
        } else {
            uint256 d = uint256(-delta);
            require(stake >= d, "Neg running stake");
            stake -= d;
        }
        runningNodeEffectiveStake[identityId] = stake;
        emit NodeEffectiveStakeDelta(identityId, delta, stake);
    }

    // ============================================================
    //                        Mutators
    // ============================================================

    /**
     * @notice Create a fresh V10 position. Used by both the fresh-stake
     *         path (migrationEpoch = 0) and the V8→V10 migration path
     *         (migrationEpoch = migration epoch).
     */
    /// @notice Create a new V10 position under `lockTier` on `identityId`.
    /// @dev    L11 — `multiplier18` is no longer an argument; CSS reads it
    ///         from the tier table (single source of truth).
    ///         L4 — guards against pre-genesis bootstrap where
    ///         `chronos.getCurrentEpoch()` returns 0 (the `currentEpoch - 1`
    ///         arithmetic would otherwise panic).
    function createPosition(
        uint256 tokenId,
        uint72 identityId,
        uint96 raw,
        uint40 lockTier,
        uint32 migrationEpoch
    ) external onlyContracts {
        require(identityId != 0, "Zero node");
        require(positions[tokenId].identityId == 0, "Position exists");
        require(raw > 0, "Zero raw");
        if (migrationEpoch == 0) {
            _requireActiveTier(lockTier);
        }
        uint64 multiplier18 = _tierMultiplier(lockTier);

        uint256 currentEpoch = chronos.getCurrentEpoch();
        require(currentEpoch >= 1, "Pre-genesis create");
        uint40 tsNow = uint40(block.timestamp);
        uint40 expiryTimestamp = _computeExpiryTimestamp(lockTier);

        positions[tokenId] = Position({
            raw: raw,
            lockTier: lockTier,
            expiryTimestamp: expiryTimestamp,
            identityId: identityId,
            cumulativeRewardsClaimed: 0,
            multiplier18: multiplier18,
            lastClaimedEpoch: uint32(currentEpoch - 1),
            migrationEpoch: migrationEpoch
        });

        _pushNodeToken(identityId, tokenId);
        _increaseNodeStakeV10(identityId, uint256(raw));

        _settleNodeTo(identityId, tsNow);

        // Effective contribution right now = raw * multiplier18 / 1e18.
        uint256 effNow = (uint256(raw) * uint256(multiplier18)) / SCALE18;
        _applyNodeStakeDelta(identityId, int256(effNow));

        // Schedule the boost drop at expiry (if there is any boost).
        if (lockTier > 0 && multiplier18 > SCALE18) {
            uint256 boost = (uint256(raw) * (uint256(multiplier18) - SCALE18)) / SCALE18;
            _scheduleNodeExpiry(identityId, expiryTimestamp, boost);
        }

        emit PositionCreated(tokenId, identityId, raw, lockTier, expiryTimestamp, multiplier18, migrationEpoch);
    }

    // M1 — `updateOnRelock` was never reached from production contracts
    //      (StakingV10.relock goes through `createNewPositionFromExisting`,
    //      which preserves reward continuity under the D21 "NFTs are
    //      ephemeral across tier changes" narrative). Removing eliminates
    //      a silent dead-code path and clarifies that relock is a
    //      burn-and-mint, not an in-place tier swap.

    function updateOnRedelegate(uint256 tokenId, uint72 newIdentityId) external onlyContracts {
        require(newIdentityId != 0, "Zero node");
        Position storage pos = positions[tokenId];
        require(pos.identityId != 0, "No position");
        uint72 oldIdentityId = pos.identityId;
        require(oldIdentityId != newIdentityId, "Same node");

        uint40 tsNow = uint40(block.timestamp);
        uint96 raw = pos.raw;
        uint40 expiryTs = pos.expiryTimestamp;
        uint64 multiplier18 = pos.multiplier18;
        bool stillBoosted = expiryTs != 0 && tsNow < expiryTs;

        uint256 effectiveNow = stillBoosted
            ? (uint256(raw) * uint256(multiplier18)) / SCALE18
            : uint256(raw);
        uint256 boost = (stillBoosted && multiplier18 > SCALE18)
            ? (uint256(raw) * (uint256(multiplier18) - SCALE18)) / SCALE18
            : 0;

        // Settle both sides so running stake is timestamp-current.
        _settleNodeTo(oldIdentityId, tsNow);
        _settleNodeTo(newIdentityId, tsNow);

        // Unwind full contribution from old node; cancel its pending boost drop.
        _applyNodeStakeDelta(oldIdentityId, -int256(effectiveNow));
        if (boost != 0) {
            _cancelNodeExpiry(oldIdentityId, expiryTs, boost);
        }

        // Install full contribution on new node; schedule its pending boost drop.
        _applyNodeStakeDelta(newIdentityId, int256(effectiveNow));
        if (boost != 0) {
            _scheduleNodeExpiry(newIdentityId, expiryTs, boost);
        }

        pos.identityId = newIdentityId;

        // D5 — per-node enumeration.
        _popNodeToken(oldIdentityId, tokenId);
        _pushNodeToken(newIdentityId, tokenId);

        // D15 — raw aggregates (total unchanged).
        uint256 rawU = uint256(raw);
        nodeStakeV10[oldIdentityId] -= rawU;
        nodeStakeV10[newIdentityId] += rawU;
        emit NodeStakeV10Decreased(oldIdentityId, rawU, nodeStakeV10[oldIdentityId], totalStakeV10);
        emit NodeStakeV10Increased(newIdentityId, rawU, nodeStakeV10[newIdentityId], totalStakeV10);

        emit PositionRedelegated(tokenId, oldIdentityId, newIdentityId);
    }

    /**
     * @notice D23 primitive — atomically replace a live position at
     *         `oldTokenId` with a fresh one at `newTokenId` on the SAME
     *         node. Preserves `cumulativeRewardsClaimed`,
     *         `lastClaimedEpoch`, and `migrationEpoch`; the new position's
     *         lock clock starts at `block.timestamp` under the caller-
     *         supplied tier.
     *
     * @dev M1 + L11 — post-review:
     *        * Cross-identity branch removed. `StakingV10.redelegate`
     *          goes through `updateOnRedelegate`; the only live caller
     *          of this helper is `StakingV10.relock`, which stays on
     *          the same node.
     *        * `multiplier18` is no longer an argument; CSS reads it
     *          from the tier table to avoid round-tripping data the
     *          contract can derive on its own.
     */
    function createNewPositionFromExisting(
        uint256 oldTokenId,
        uint256 newTokenId,
        uint72 identityId,
        uint40 newLockTier
    ) external onlyContracts {
        require(identityId != 0, "Zero node");
        require(positions[newTokenId].identityId == 0, "New token used");
        require(oldTokenId != newTokenId, "Same tokenId");

        Position memory old = positions[oldTokenId];
        require(old.identityId != 0, "No position");
        require(old.identityId == identityId, "Identity mismatch");
        uint96 raw = old.raw;
        require(raw > 0, "Zero raw");

        uint64 newMultiplier18 = _tierMultiplier(newLockTier);

        uint40 oldExpiryTs = old.expiryTimestamp;
        uint64 oldMultiplier18 = old.multiplier18;
        uint40 tsNow = uint40(block.timestamp);

        _settleNodeTo(identityId, tsNow);

        // --- Unwind old contribution ---
        bool oldStillBoosted = oldExpiryTs != 0 && tsNow < oldExpiryTs;
        uint256 effectiveNowOld = oldStillBoosted
            ? (uint256(raw) * uint256(oldMultiplier18)) / SCALE18
            : uint256(raw);
        _applyNodeStakeDelta(identityId, -int256(effectiveNowOld));
        if (oldStillBoosted && oldMultiplier18 > SCALE18) {
            uint256 oldBoost = (uint256(raw) * (uint256(oldMultiplier18) - SCALE18)) / SCALE18;
            _cancelNodeExpiry(identityId, oldExpiryTs, oldBoost);
        }

        // --- Install new contribution (fresh lock starts now) ---
        uint40 newExpiryTs = _computeExpiryTimestamp(newLockTier);
        uint256 effectiveNowNew = (uint256(raw) * uint256(newMultiplier18)) / SCALE18;
        _applyNodeStakeDelta(identityId, int256(effectiveNowNew));
        if (newLockTier > 0 && newMultiplier18 > SCALE18) {
            uint256 newBoost = (uint256(raw) * (uint256(newMultiplier18) - SCALE18)) / SCALE18;
            _scheduleNodeExpiry(identityId, newExpiryTs, newBoost);
        }

        // --- Write new position preserving stats; delete old ---
        positions[newTokenId] = Position({
            raw: raw,
            lockTier: newLockTier,
            expiryTimestamp: newExpiryTs,
            identityId: identityId,
            cumulativeRewardsClaimed: old.cumulativeRewardsClaimed,
            multiplier18: newMultiplier18,
            lastClaimedEpoch: old.lastClaimedEpoch,
            migrationEpoch: old.migrationEpoch
        });
        delete positions[oldTokenId];

        // --- Per-node enumeration ---
        _popNodeToken(identityId, oldTokenId);
        _pushNodeToken(identityId, newTokenId);

        // nodeStakeV10 is invariant — same identity, same raw. No emit.

        emit PositionReplaced(
            oldTokenId,
            newTokenId,
            identityId,
            raw,
            newLockTier,
            newExpiryTs,
            newMultiplier18
        );
    }

    function setLastClaimedEpoch(uint256 tokenId, uint32 epoch) external onlyContracts {
        require(positions[tokenId].identityId != 0, "No position");
        positions[tokenId].lastClaimedEpoch = epoch;
        emit LastClaimedEpochUpdated(tokenId, epoch);
    }

    function setMigrationEpoch(uint256 tokenId, uint32 epoch) external onlyContracts {
        require(positions[tokenId].identityId != 0, "No position");
        positions[tokenId].migrationEpoch = epoch;
        emit MigrationEpochSet(tokenId, epoch);
    }

    /// @notice Set the V10 retroactive-claim anchor (D7). One-shot.
    /// @dev    L9 — reverts if already set. Prevents an admin (or a
    ///         compromised admin) from silently rebinding the reward-history
    ///         boundary mid-life.
    function setV10LaunchEpoch(uint256 epoch) external onlyContracts {
        require(v10LaunchEpoch == 0, "V10 launch already set");
        v10LaunchEpoch = epoch;
        emit V10LaunchEpochSet(epoch);
    }

    function deletePosition(uint256 tokenId) external onlyContracts {
        Position memory pos = positions[tokenId];
        require(pos.identityId != 0, "No position");

        uint40 tsNow = uint40(block.timestamp);
        uint96 raw = pos.raw;
        uint72 identityId = pos.identityId;
        uint40 expiryTs = pos.expiryTimestamp;
        uint64 multiplier18 = pos.multiplier18;
        bool stillBoosted = expiryTs != 0 && tsNow < expiryTs;

        _settleNodeTo(identityId, tsNow);

        uint256 effectiveNow = stillBoosted
            ? (uint256(raw) * uint256(multiplier18)) / SCALE18
            : uint256(raw);
        _applyNodeStakeDelta(identityId, -int256(effectiveNow));
        if (stillBoosted && multiplier18 > SCALE18) {
            uint256 boost = (uint256(raw) * (uint256(multiplier18) - SCALE18)) / SCALE18;
            _cancelNodeExpiry(identityId, expiryTs, boost);
        }

        _popNodeToken(identityId, tokenId);
        if (raw > 0) {
            _decreaseNodeStakeV10(identityId, uint256(raw));
        }

        delete positions[tokenId];
        emit PositionDeleted(tokenId);
    }

    // ============================================================
    //       D19 — Raw-only mutators (compound-into-raw model)
    // ============================================================

    function decreaseRaw(uint256 tokenId, uint96 amount) external onlyContracts {
        Position storage pos = positions[tokenId];
        require(pos.identityId != 0, "No position");
        require(pos.raw >= amount, "Insufficient raw");
        if (amount == 0) {
            emit RawDecreased(tokenId, 0, pos.raw);
            return;
        }

        uint40 tsNow = uint40(block.timestamp);
        uint72 identityId = pos.identityId;
        uint40 expiryTs = pos.expiryTimestamp;
        uint64 multiplier18 = pos.multiplier18;
        bool stillBoosted = expiryTs != 0 && tsNow < expiryTs;

        _settleNodeTo(identityId, tsNow);

        uint256 effectiveNow = stillBoosted
            ? (uint256(amount) * uint256(multiplier18)) / SCALE18
            : uint256(amount);
        _applyNodeStakeDelta(identityId, -int256(effectiveNow));

        if (stillBoosted && multiplier18 > SCALE18) {
            uint256 boostShrink = (uint256(amount) * (uint256(multiplier18) - SCALE18)) / SCALE18;
            _cancelNodeExpiry(identityId, expiryTs, boostShrink);
        }

        pos.raw = pos.raw - amount;
        _decreaseNodeStakeV10(identityId, uint256(amount));

        emit RawDecreased(tokenId, amount, pos.raw);
    }

    function increaseRaw(uint256 tokenId, uint96 amount) external onlyContracts {
        Position storage pos = positions[tokenId];
        require(pos.identityId != 0, "No position");
        if (amount == 0) {
            emit RawIncreased(tokenId, 0, pos.raw);
            return;
        }

        require(uint256(pos.raw) + uint256(amount) <= type(uint96).max, "Raw overflow");

        uint40 tsNow = uint40(block.timestamp);
        uint72 identityId = pos.identityId;
        uint40 expiryTs = pos.expiryTimestamp;
        uint64 multiplier18 = pos.multiplier18;
        bool stillBoosted = expiryTs != 0 && tsNow < expiryTs;

        _settleNodeTo(identityId, tsNow);

        uint256 effectiveNow = stillBoosted
            ? (uint256(amount) * uint256(multiplier18)) / SCALE18
            : uint256(amount);
        _applyNodeStakeDelta(identityId, int256(effectiveNow));

        if (stillBoosted && multiplier18 > SCALE18) {
            uint256 boostGrow = (uint256(amount) * (uint256(multiplier18) - SCALE18)) / SCALE18;
            _scheduleNodeExpiry(identityId, expiryTs, boostGrow);
        }

        pos.raw = pos.raw + amount;
        _increaseNodeStakeV10(identityId, uint256(amount));

        emit RawIncreased(tokenId, amount, pos.raw);
    }

    function addCumulativeRewardsClaimed(uint256 tokenId, uint96 amount) external onlyContracts {
        Position storage pos = positions[tokenId];
        require(pos.identityId != 0, "No position");
        if (amount == 0) {
            emit CumulativeRewardsClaimedUpdated(tokenId, 0, pos.cumulativeRewardsClaimed);
            return;
        }

        uint96 newTotal = pos.cumulativeRewardsClaimed + amount;
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
    //                          Reads
    // ============================================================

    function getPosition(uint256 tokenId) external view returns (Position memory) {
        return positions[tokenId];
    }

    /// @notice Effective stake for `id` right now (simulated settle to
    ///         `block.timestamp`).
    function getNodeEffectiveStake(uint72 identityId) external view returns (uint256) {
        return _simulateNodeEffectiveStakeAt(identityId, uint40(block.timestamp));
    }

    /// @notice Effective stake for `id` at an arbitrary future timestamp
    ///         `ts` (simulated settle). For `ts < nodeLastSettledAt[id]`
    ///         the function returns 0 — past-history snapshots are NOT
    ///         retained under D26.
    function getNodeEffectiveStakeAtTimestamp(uint72 identityId, uint40 ts) external view returns (uint256) {
        return _simulateNodeEffectiveStakeAt(identityId, ts);
    }

    /// @notice Deprecated adapter for the v2.x "effective stake at end of
    ///         epoch `e`" read surface. Returns the effective stake at
    ///         the LAST SECOND of `epoch` (computed via Chronos), or 0 if
    ///         the epoch is entirely in the pre-settled past. Consumers
    ///         should migrate to `getNodeEffectiveStakeAtTimestamp`.
    /// @dev    L7 — tolerates Chronos returning 0 for unanchored future
    ///         epochs (the naive `- 1` would underflow).
    function getNodeEffectiveStakeAtEpoch(uint72 identityId, uint256 epoch) external view returns (uint256) {
        uint256 nextAnchor = chronos.timestampForEpoch(epoch + 1);
        uint256 epochEnd = nextAnchor == 0 ? type(uint40).max : nextAnchor - 1;
        if (epochEnd > type(uint40).max) epochEnd = type(uint40).max;
        return _simulateNodeEffectiveStakeAt(identityId, uint40(epochEnd));
    }

    function getNodeLastSettledAt(uint72 identityId) external view returns (uint40) {
        return nodeLastSettledAt[identityId];
    }

    function getNodeRunningEffectiveStake(uint72 identityId) external view returns (uint256) {
        return runningNodeEffectiveStake[identityId];
    }

    function getNodeExpiryHead(uint72 identityId) external view returns (uint256) {
        return nodeExpiryHead[identityId];
    }

    function getNodeExpiryTimes(uint72 identityId) external view returns (uint40[] memory) {
        return nodeExpiryTimes[identityId];
    }

    function getNodeExpiryDrop(uint72 identityId, uint40 ts) external view returns (uint256) {
        return nodeExpiryDrop[identityId][ts];
    }

    function getNodePendingExpiryCount(uint72 identityId) external view returns (uint256) {
        return nodeExpiryTimes[identityId].length - nodeExpiryHead[identityId];
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
    //                       Internal helpers
    // ============================================================

    /**
     * @dev Wall-clock expiry computation (D26). Timestamp-accurate:
     *      the boost ends exactly at `block.timestamp + duration`.
     *      Returns 0 for tier-0 (permanent rest state).
     */
    function _computeExpiryTimestamp(uint40 lockTier) internal view returns (uint40) {
        if (lockTier == 0) return 0;
        uint256 duration = _tierDuration(lockTier);
        uint256 exp = block.timestamp + duration;
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
}
