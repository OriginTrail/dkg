// SPDX-License-Identifier: Apache-2.0

pragma solidity ^0.8.20;

import {ShardingTable} from "./ShardingTable.sol";
import {Ask} from "./Ask.sol";
import {ParametersStorage} from "./storage/ParametersStorage.sol";
import {ProfileStorage} from "./storage/ProfileStorage.sol";
import {ShardingTableStorage} from "./storage/ShardingTableStorage.sol";
import {StakingStorage} from "./storage/StakingStorage.sol";
import {ConvictionStakingStorage} from "./storage/ConvictionStakingStorage.sol";
import {RandomSamplingStorage} from "./storage/RandomSamplingStorage.sol";
import {EpochStorage} from "./storage/EpochStorage.sol";
import {Chronos} from "./storage/Chronos.sol";
import {ContractStatus} from "./abstract/ContractStatus.sol";
import {IInitializable} from "./interfaces/IInitializable.sol";
import {INamed} from "./interfaces/INamed.sol";
import {IVersioned} from "./interfaces/IVersioned.sol";
import {StakingLib} from "./libraries/StakingLib.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title StakingV10
 * @notice V10 NFT-backed staking orchestrator. Canonical staking entry point
 *         post-migration.
 *
 * V10 architecture (post-migration):
 *   - All delegator state is NFT-keyed and lives in ConvictionStakingStorage
 *     (positions, per-node aggregates, per-epoch operator-fee / net-rewards).
 *   - StakingStorage is a read-only V8 legacy archive and the TRAC vault.
 *     V10 does NOT write to StakingStorage's nodeStake / totalStake /
 *     delegatorStakeBase mappings except during `convertToNFT`, which
 *     drains the V8 state atomically in the same transaction that creates
 *     the V10 position.
 *   - DelegatorsInfo is unregistered (D13). The two per-node-per-epoch
 *     flags it used to hold (`isOperatorFeeClaimedForEpoch`,
 *     `netNodeEpochRewards`) were absorbed into ConvictionStakingStorage.
 *   - The V8 Staking contract is unregistered. The V8-side score
 *     settlement helper (`Staking.prepareForStakeChange`) is no longer
 *     reachable from V10 (D17); the V10-native `_prepareForStakeChangeV10`
 *     handles all V10 settlement.
 *
 * Rewards model (D19 — compound into raw):
 *   - `claim()` walks the unclaimed window, sums TRAC rewards, and compounds
 *     them directly into the position's `raw` via `cs.increaseRaw`. The
 *     compounded TRAC therefore earns the position's current multiplier
 *     going forward. A parallel statistic-only counter
 *     `cs.cumulativeRewardsClaimed` tracks lifetime reward compounding for
 *     UI/indexer consumption.
 *   - There is no separate `rewards` bucket, no `increaseRewards` /
 *     `decreaseRewards`.
 *
 * Withdraw model (D14 — atomic):
 *   - `withdraw()` is a single transaction. Pre-expiry is disallowed (lock
 *     still active). Post-expiry (or tier-0 rest state) it auto-claims any
 *     outstanding rewards into `raw`, pays out the full `raw` balance from
 *     the `StakingStorage` TRAC vault to the owner, and deletes the CSS
 *     position. The NFT wrapper burns the token on the back half. There is
 *     no request/cancel/finalize dance and no address-timer delay — the
 *     lock IS the delay, and partial withdrawals are not a first-class
 *     feature (re-stake the remainder for the same economic result).
 *
 * Redelegate model (D25 — in-place):
 *   - `redelegate()` is a single transaction that mutates `pos.identityId`
 *     in place on CSS via `updateOnRedelegate`. Same tokenId, same
 *     `expiryEpoch`, same rewards cursor — only the node assignment
 *     changes. `relock` continues to use the D21/D23 burn-and-mint path
 *     because relock materially changes tier / multiplier / expiry.
 */
contract StakingV10 is INamed, IVersioned, ContractStatus, IInitializable {
    // ========================================================================
    // Metadata
    // ========================================================================

    string private constant _NAME = "StakingV10";
    // Version history:
    //   2.0.0 — initial V10 orchestrator (post-migration).
    //   2.1.0 — atomic `withdraw` + in-place `redelegate`.
    //   2.2.0 — aligned with CSS v2.2.0: `PendingWithdrawal` storage gone,
    //           `redelegate` goes through `updateOnRedelegate` (tokenId +
    //           expiryEpoch preserved), `withdraw` is a single-tx exit
    //           with auto-claim.
    //   2.3.0 — D26 code-review follow-ups:
    //           * H1 — `_claim` dormancy bomb fixed: rewardless epochs
    //             early-continue (no fee-flag SSTORE, no per-epoch SLOAD
    //             storm).
    //           * H2 — expiry-split reward math extracted into a shared
    //             `_delegatorIncrementForEpoch` helper; `_claim` and
    //             `_prepareForStakeChangeV10` share one code path.
    //           * L3 — `lockTier` widened from `uint8` to `uint40` across
    //             the public surface so admins can add tier ids above 255.
    //           * L11 — `createPosition` no longer takes `multiplier18`;
    //             CSS reads it from the tier table.
    string private constant _VERSION = "2.3.0";

    // ========================================================================
    // Constants
    // ========================================================================

    /// @notice 1e18 fixed-point scale shared with `ConvictionStakingStorage`.
    uint256 public constant SCALE18 = 1e18;

    /// @notice EpochStorage shard ID for the reward pool.
    uint256 private constant EPOCH_POOL_INDEX = 1;

    // ========================================================================
    // Hub-wired dependencies
    // ========================================================================

    StakingStorage public stakingStorage;
    ConvictionStakingStorage public convictionStorage;
    Chronos public chronos;
    RandomSamplingStorage public randomSamplingStorage;
    ShardingTableStorage public shardingTableStorage;
    ShardingTable public shardingTable;
    Ask public ask;
    ParametersStorage public parametersStorage;
    ProfileStorage public profileStorage;
    IERC20 public token;
    EpochStorage public epochStorage;

    // ========================================================================
    // Events
    // ========================================================================

    event Staked(
        uint256 indexed tokenId,
        address indexed staker,
        uint72 indexed identityId,
        uint96 amount,
        uint40 lockTier
    );
    event Relocked(uint256 indexed tokenId, uint40 newLockTier, uint64 newExpiryTimestamp);
    event Redelegated(uint256 indexed tokenId, uint72 indexed oldIdentityId, uint72 indexed newIdentityId);
    /// @notice Authoritative atomic-withdraw event. `amount` is the total
    ///         TRAC paid out to `staker` (post-auto-claim `raw`). The NFT
    ///         wrapper burns `tokenId` on the back half.
    event Withdrawn(uint256 indexed tokenId, address indexed staker, uint96 amount);
    event RewardsClaimed(uint256 indexed tokenId, uint96 amount);
    /// @notice Authoritative V8→V10 migration event. `rawAbsorbed` is the
    ///         combined `stakeBase + pendingWithdrawal` amount (D8). `isAdmin`
    ///         distinguishes self-migration (user called `selfMigrateV8`)
    ///         from straggler-rescue migration (admin called `adminMigrateV8`,
    ///         D7 dual-path).
    event ConvertedFromV8(
        address indexed delegator,
        uint256 indexed tokenId,
        uint72 indexed identityId,
        uint96 stakeBaseAbsorbed,
        uint96 pendingAbsorbed,
        uint40 lockTier,
        bool isAdmin
    );

    // ========================================================================
    // Errors
    // ========================================================================

    error InvalidLockTier();
    error LockStillActive();
    error NotPositionOwner();
    error ZeroAmount();
    error MaxStakeExceeded();
    error SameIdentity();
    error ProfileDoesNotExist();
    error RewardOverflow();
    error PositionNotFound();
    error NoV8StakeToConvert();
    error UnclaimedEpochs();

    // ========================================================================
    // Constructor + initialize
    // ========================================================================

    // solhint-disable-next-line no-empty-blocks
    constructor(address hubAddress) ContractStatus(hubAddress) {}

    /**
     * @dev Wires Hub-registered dependencies. DelegatorsInfo and the V8
     *      `Staking` contract are NOT looked up here (D3 + D17 + D13):
     *      DelegatorsInfo is unregistered by deploy script 021, V8 Staking
     *      is unregistered by deploy script 998 as part of the migration
     *      cutover.
     */
    function initialize() external onlyHub {
        stakingStorage = StakingStorage(hub.getContractAddress("StakingStorage"));
        convictionStorage = ConvictionStakingStorage(hub.getContractAddress("ConvictionStakingStorage"));
        chronos = Chronos(hub.getContractAddress("Chronos"));
        randomSamplingStorage = RandomSamplingStorage(hub.getContractAddress("RandomSamplingStorage"));
        shardingTableStorage = ShardingTableStorage(hub.getContractAddress("ShardingTableStorage"));
        shardingTable = ShardingTable(hub.getContractAddress("ShardingTable"));
        ask = Ask(hub.getContractAddress("Ask"));
        parametersStorage = ParametersStorage(hub.getContractAddress("ParametersStorage"));
        profileStorage = ProfileStorage(hub.getContractAddress("ProfileStorage"));
        token = IERC20(hub.getContractAddress("Token"));
        epochStorage = EpochStorage(hub.getContractAddress("EpochStorageV8"));
    }

    function name() external pure virtual override returns (string memory) {
        return _NAME;
    }

    function version() external pure virtual override returns (string memory) {
        return _VERSION;
    }

    // ========================================================================
    // Caller gate
    // ========================================================================

    modifier onlyConvictionNFT() {
        if (msg.sender != hub.getContractAddress("DKGStakingConvictionNFT")) {
            revert StakingLib.OnlyConvictionNFT();
        }
        _;
    }

    // ========================================================================
    // Internal guards
    // ========================================================================

    /**
     * @dev Reverts `UnclaimedEpochs` if the position has not been claimed up
     *      to `currentEpoch - 1`.  Called at the top of every stake-changing
     *      entry point so that reward history is settled before any
     *      structural mutation. NOT called in `stake` (no prior position) or
     *      `convertToNFT` (the V10 position is being seeded fresh; the V8-
     *      side rolling rewards no longer gate migration per D7/D8).
     */
    function _requireFullyClaimed(ConvictionStakingStorage.Position memory pos) internal view {
        uint256 currentEpoch = chronos.getCurrentEpoch();
        if (currentEpoch <= 1) return;
        if (uint256(pos.lastClaimedEpoch) < currentEpoch - 1) revert UnclaimedEpochs();
    }

    // ========================================================================
    // External entry points
    // ========================================================================

    /**
     * @notice Mint a fresh NFT-backed staking position on `identityId` with
     *         `amount` TRAC locked for `lockTier` epochs.
     *
     * @dev V10 flow (D15 — CSS-only accounting):
     *        1. Amount + tier validation.
     *        2. Destination profile existence.
     *        3. maxStake cap on the DESTINATION V10 node stake
     *           (`cs.nodeStakeV10`, NOT `ss.nodeStake`). StakingStorage's
     *           node stake is V8 legacy and stale post-migration.
     *        4. V10 settlement baseline (zero stake, bumps the
     *           node-epoch-score-per-stake cursor for this token).
     *        5. TRAC transfer into the StakingStorage vault (still the
     *           protocol-wide TRAC custody).
     *        6. CSS position creation (migrationEpoch = 0 — fresh stake).
     *        7. Sharding-table insert threshold, Ask recalc.
     */
    function stake(
        address staker,
        uint256 tokenId,
        uint72 identityId,
        uint96 amount,
        uint40 lockTier
    ) external onlyConvictionNFT {
        if (amount == 0) revert ZeroAmount();
        if (!profileStorage.profileExists(identityId)) revert ProfileDoesNotExist();

        // Tier-existence / activeness is checked by CSS.createPosition.

        uint256 maxStake = uint256(parametersStorage.maximumStake());
        uint256 totalNodeStakeAfter = convictionStorage.getNodeStakeV10(identityId) + uint256(amount);
        if (totalNodeStakeAfter > maxStake) revert MaxStakeExceeded();

        _prepareForStakeChangeV10(chronos.getCurrentEpoch(), tokenId, identityId);

        // TRAC flows directly into the StakingStorage vault — the vault is
        // shared with V8 (the TRAC custodian contract of the protocol).
        // The NFT wrapper never holds funds.
        token.transferFrom(staker, address(stakingStorage), amount);

        // L11 — multiplier18 is no longer passed in; CSS reads it from the
        //       tier table (single source of truth).
        convictionStorage.createPosition(
            tokenId,
            identityId,
            amount,
            lockTier,
            0 // fresh V10 stake: no migrationEpoch
        );

        // Sharding-table maintenance gates on the V10 canonical node stake.
        ParametersStorage ps = parametersStorage;
        ShardingTableStorage sts = shardingTableStorage;
        if (!sts.nodeExists(identityId) && totalNodeStakeAfter >= uint256(ps.minimumStake())) {
            shardingTable.insertNode(identityId);
        }

        ask.recalculateActiveSet();

        emit Staked(tokenId, staker, identityId, amount, lockTier);
    }

    /**
     * @notice Post-expiry re-commit of an existing position to a new lock
     *         tier. Raw stake unchanged; multiplier + expiry shift. Under
     *         D21 this is a burn-and-mint: `oldTokenId` is burned by the
     *         NFT wrapper, `newTokenId` is a freshly-minted NFT the wrapper
     *         has already allocated, and the on-chain position state moves
     *         over via the D23 `createNewPositionFromExisting` primitive.
     *
     * @dev Continuity preserved across the burn-mint:
     *        - `raw` (principal unchanged — no TRAC moves).
     *        - `cumulativeRewardsClaimed` (lifetime reward stat).
     *        - `lastClaimedEpoch` (reward cursor — prevents double-claim).
     *        - `migrationEpoch` (D6 retroactive-claim marker).
     *      Re-initialized on the new tokenId:
     *        - `lockTier`, `multiplier18`, `expiryEpoch` (the whole point
     *          of relock).
     *      `identityId` is held constant — this is relock, not redelegate.
     */
    function relock(
        address staker,
        uint256 oldTokenId,
        uint256 newTokenId,
        uint40 newLockTier
    ) external onlyConvictionNFT {
        staker; // unused — see file-header rationale.

        ConvictionStakingStorage.Position memory pos = convictionStorage.getPosition(oldTokenId);
        if (pos.identityId == 0) revert PositionNotFound();
        _requireFullyClaimed(pos);

        // D26 — timestamp-accurate lock gate. Tier-0 (expiryTimestamp == 0)
        // is already in rest state; any non-zero expiry must have elapsed.
        if (pos.expiryTimestamp != 0 && block.timestamp < uint256(pos.expiryTimestamp)) revert LockStillActive();

        _prepareForStakeChangeV10(chronos.getCurrentEpoch(), oldTokenId, pos.identityId);

        // M1 + L11 — same-identity relock. CSS reads the multiplier from the
        //            tier table; no need to pass it in.
        convictionStorage.createNewPositionFromExisting(
            oldTokenId,
            newTokenId,
            pos.identityId,
            newLockTier
        );

        ConvictionStakingStorage.Position memory posAfter = convictionStorage.getPosition(newTokenId);
        emit Relocked(newTokenId, newLockTier, uint64(posAfter.expiryTimestamp));
    }

    /**
     * @notice Move a position from its current node to `newIdentityId`.
     *         Same tokenId persists; only `pos.identityId` mutates.
     *         Per-node raw / effective stake moves across at `currentEpoch`;
     *         global totals invariant.
     *
     * @dev D25 — in-place redelegate. The tokenId, `expiryEpoch`,
     *      `lockTier`, `multiplier18`, `lastClaimedEpoch`, `migrationEpoch`
     *      and `cumulativeRewardsClaimed` are ALL preserved. The lock
     *      clock does NOT reset: a redelegation is a routing decision,
     *      not a new commitment. CSS's `updateOnRedelegate` moves the
     *      per-node effective-stake contribution at `currentEpoch` and
     *      reassigns the pending expiry drop from the old node to the
     *      new node at the same `expiryEpoch`.
     *
     *      Fresh stakes still gate on the destination's `maxStake` —
     *      redelegating INTO a near-capped node can still revert. The
     *      min-stake boundary on the OLD node may trigger a sharding-
     *      table removal; the new node may cross back in. Ask recalc
     *      runs once at the end.
     */
    function redelegate(
        address staker,
        uint256 tokenId,
        uint72 newIdentityId
    ) external onlyConvictionNFT {
        staker;

        ConvictionStakingStorage.Position memory pos = convictionStorage.getPosition(tokenId);
        if (pos.identityId == 0) revert PositionNotFound();
        _requireFullyClaimed(pos);
        uint72 oldIdentityId = pos.identityId;

        if (oldIdentityId == newIdentityId) revert SameIdentity();
        if (!profileStorage.profileExists(newIdentityId)) revert ProfileDoesNotExist();

        uint96 raw = pos.raw;
        require(raw > 0, "No raw");

        // Destination maxStake cap gates on V10 canonical node stake.
        uint256 newNodeStakeAfter = convictionStorage.getNodeStakeV10(newIdentityId) + uint256(raw);
        uint256 maxStake = uint256(parametersStorage.maximumStake());
        if (newNodeStakeAfter > maxStake) revert MaxStakeExceeded();

        // Settle score-per-stake indices on BOTH nodes before CSS mutates
        // effective stake (which shifts the delegator's contribution
        // between the two nodes at `currentEpoch`).
        uint256 currentEpoch = chronos.getCurrentEpoch();
        _prepareForStakeChangeV10(currentEpoch, tokenId, oldIdentityId);
        _prepareForStakeChangeV10(currentEpoch, tokenId, newIdentityId);

        // D25 — in-place node swap. tokenId + expiryEpoch + reward cursor
        // preserved; per-node diffs + per-node raw + pending expiry
        // subtraction all move from oldIdentityId to newIdentityId.
        convictionStorage.updateOnRedelegate(tokenId, newIdentityId);

        // Sharding-table maintenance on BOTH nodes gates on V10 canonical stake.
        ShardingTableStorage sts = shardingTableStorage;
        uint256 minStake = uint256(parametersStorage.minimumStake());

        uint256 oldNodeStakeAfter = convictionStorage.getNodeStakeV10(oldIdentityId);
        if (sts.nodeExists(oldIdentityId) && oldNodeStakeAfter < minStake) {
            shardingTable.removeNode(oldIdentityId);
        }
        if (!sts.nodeExists(newIdentityId) && newNodeStakeAfter >= minStake) {
            shardingTable.insertNode(newIdentityId);
        }

        ask.recalculateActiveSet();

        emit Redelegated(tokenId, oldIdentityId, newIdentityId);
    }

    /**
     * @notice Atomic full withdrawal. Post-expiry (or tier-0 rest state)
     *         only. Auto-claims any outstanding rewards into `raw`, pays
     *         out the full `raw` balance from the `StakingStorage` TRAC
     *         vault to `staker`, and deletes the CSS position. The NFT
     *         wrapper burns the token on return.
     *
     * @dev D14 — atomic withdraw. No request / cancel / finalize dance,
     *      no address-timer delay: the lock IS the delay. Partial
     *      withdrawals are NOT a first-class feature — a user wanting
     *      partial liquidity should withdraw the whole position and
     *      re-stake the remainder, which gives the same economic
     *      result (tier-0 with 1x multiplier is effectively liquid
     *      stake). Q3 — rewards are auto-claimed inside this call so
     *      the user sees a single button in the UI.
     */
    function withdraw(
        address staker,
        uint256 tokenId
    ) external onlyConvictionNFT returns (uint96 amount) {
        ConvictionStakingStorage.Position memory pos = convictionStorage.getPosition(tokenId);
        if (pos.identityId == 0) revert PositionNotFound();

        // Lock gate: pre-expiry withdrawals are disallowed. Tier-0
        // positions (`expiryTimestamp == 0`) always pass — they are the
        // rest state with no lock. D26 — timestamp-accurate.
        bool unlocked = pos.expiryTimestamp == 0 || block.timestamp >= uint256(pos.expiryTimestamp);
        if (!unlocked) revert LockStillActive();

        // Auto-claim any outstanding rewards (compounds into `raw`). Must
        // happen BEFORE reading the final raw, because compounding grows
        // it. No-op when `currentEpoch <= 1` or nothing is unclaimed.
        _claim(tokenId);

        // Re-read after auto-claim — raw may have grown via compounding.
        pos = convictionStorage.getPosition(tokenId);
        amount = pos.raw;
        require(amount > 0, "No raw");
        uint72 identityId = pos.identityId;

        // Delete the position: CSS handles effective-stake diff teardown,
        // pending-expiry delta cancel, per-node enumeration pop, per-node
        // raw aggregate decrement, global total decrement, finalization.
        convictionStorage.deletePosition(tokenId);

        // TRAC flows from the StakingStorage vault (protocol-wide TRAC
        // custody) to the NFT owner. This is the only mapping on
        // StakingStorage that the V10 path still writes to.
        stakingStorage.transferStake(staker, amount);

        // Sharding-table maintenance: node may have dropped below minStake.
        uint256 newNodeStake = convictionStorage.getNodeStakeV10(identityId);
        if (
            shardingTableStorage.nodeExists(identityId) &&
            newNodeStake < uint256(parametersStorage.minimumStake())
        ) {
            shardingTable.removeNode(identityId);
        }

        ask.recalculateActiveSet();

        emit Withdrawn(tokenId, staker, amount);
    }

    /**
     * @notice Walk unclaimed epochs, accumulate reward, and compound it into
     *         the position's `raw` (D19). `cumulativeRewardsClaimed` tracks
     *         lifetime compounding as a statistic.
     *
     * @dev D6 — retroactive claim for migrated positions. If
     *      `pos.migrationEpoch != 0` AND `pos.migrationEpoch > pos.lastClaimedEpoch + 1`,
     *      the claim window starts from `pos.migrationEpoch` instead of
     *      `pos.lastClaimedEpoch + 1`. For a fresh V8→V10 migration where
     *      the user never claimed pre-migration, this collapses to "start
     *      the claim at the migration epoch". For a later-life migration
     *      (shouldn't happen in the mandatory-migration model but kept
     *      behavior-defined), the `max(lastClaimedEpoch+1, migrationEpoch)`
     *      semantics prevent double-claiming.
     *
     *      D19 — reward handling:
     *        1. Sum per-epoch rewards across the window (V10 math —
     *           CSS per-epoch operator fee + net-node rewards).
     *        2. `cs.increaseRaw(tokenId, rewardTotal)` — raw grows; the
     *           compounded TRAC earns the position's current multiplier
     *           going forward; per-epoch effective-stake diff updated.
     *        3. `cs.addCumulativeRewardsClaimed(tokenId, rewardTotal)` —
     *           statistic-only lifetime counter.
     *        4. `cs.setLastClaimedEpoch(tokenId, toEpoch)` — advance cursor.
     *      No StakingStorage writes.
     */
    function claim(
        address staker,
        uint256 tokenId
    ) external onlyConvictionNFT {
        staker;
        _claim(tokenId);
    }

    /**
     * @dev Internal claim body shared between the external `claim` entry
     *      point and the atomic `withdraw` path. Advances the position's
     *      reward cursor and compounds any outstanding rewards into `raw`.
     *      No-op when the position has no unclaimed window (early epochs
     *      or `lastClaimedEpoch == currentEpoch - 1`).
     */
    function _claim(uint256 tokenId) internal {
        ConvictionStakingStorage.Position memory pos = convictionStorage.getPosition(tokenId);
        if (pos.identityId == 0) revert PositionNotFound();

        uint256 currentEpoch = chronos.getCurrentEpoch();
        if (currentEpoch <= 1) return;

        // D6 — retroactive claim on migrationEpoch.
        uint256 lastClaimed = uint256(pos.lastClaimedEpoch);
        uint256 migrationEpoch = uint256(pos.migrationEpoch);
        uint256 claimFromEpoch = lastClaimed + 1;
        if (migrationEpoch != 0 && migrationEpoch > claimFromEpoch) {
            claimFromEpoch = migrationEpoch;
        }
        uint256 claimToEpoch = currentEpoch - 1;
        if (claimFromEpoch > claimToEpoch) return;

        _prepareForStakeChangeV10(currentEpoch, tokenId, pos.identityId);

        // Local cache.
        uint256 rawU = uint256(pos.raw);
        uint256 mult18 = uint256(pos.multiplier18);
        uint256 expiryTs = uint256(pos.expiryTimestamp);
        // D26 — wall-clock → epoch projection of the position's expiry.
        // 0 for tier-0 (no boost, no expiry).
        uint256 expiryEpoch = expiryTs == 0 ? 0 : chronos.epochAtTimestamp(expiryTs);
        uint72 identityId = pos.identityId;
        bytes32 delegatorKey = bytes32(tokenId);

        uint256 effBoosted = (rawU * mult18) / SCALE18;
        uint256 effBase = rawU;

        uint256 rewardTotal = 0;
        for (uint256 e = claimFromEpoch; e <= claimToEpoch; e++) {
            // H1 — fast path for rewardless epochs. `getEpochLastScorePerStake`
            // is 0 iff no proof was ever submitted on this node in epoch `e`.
            // When that is the case: no node score, no delegator score, no
            // operator-fee math, nothing to settle. Skipping here collapses a
            // dormant-epoch iteration from ~25k gas (4 SLOADs + 1 SSTORE for
            // the fee flag) to ~2k gas (single SLOAD + continue). This is
            // what keeps long-dormant tier-0 positions claimable; see the
            // dormancy-bomb finding in CODE_REVIEW_V10_D26.md §H1.
            uint256 scorePerStake36 = randomSamplingStorage.getEpochLastScorePerStake(identityId, e);
            if (scorePerStake36 == 0) continue;

            uint256 settledDelegatorScore18 = randomSamplingStorage.getEpochNodeDelegatorScore(
                e,
                identityId,
                delegatorKey
            );
            uint256 lastSettledIndex36 = randomSamplingStorage
                .getDelegatorLastSettledNodeEpochScorePerStake(e, identityId, delegatorKey);

            // H2 — expiry-split reward integration shared with
            //      `_prepareForStakeChangeV10`.
            uint256 unsettledDelegatorScore18 = _delegatorIncrementForEpoch(
                e,
                identityId,
                scorePerStake36,
                lastSettledIndex36,
                effBoosted,
                effBase,
                expiryTs,
                expiryEpoch
            );
            uint256 delegatorScore18 = settledDelegatorScore18 + unsettledDelegatorScore18;

            uint256 nodeScore18 = randomSamplingStorage.getNodeEpochScore(e, identityId);

            // H1 — on epochs with `scorePerStake36 > 0 && nodeScore18 == 0` we
            // still fall through here. That combination is essentially
            // impossible in production (score-per-stake can only be advanced
            // by submitProof, which also adds to node score), but defensive:
            // there is no fee to collect and no reward, so epochReward stays 0.
            uint256 epochReward = 0;
            if (nodeScore18 > 0) {
                uint256 netNodeRewards;
                if (!convictionStorage.isOperatorFeeClaimedForEpoch(identityId, e)) {
                    uint256 allNodesScore18 = randomSamplingStorage.getAllNodesEpochScore(e);
                    if (allNodesScore18 > 0) {
                        uint256 grossNodeRewards = (epochStorage.getEpochPool(EPOCH_POOL_INDEX, e)
                            * nodeScore18) / allNodesScore18;
                        uint96 operatorFeeAmount = uint96(
                            (grossNodeRewards
                                * profileStorage.getLatestOperatorFeePercentage(identityId))
                                / parametersStorage.maxOperatorFee()
                        );
                        netNodeRewards = grossNodeRewards - operatorFeeAmount;
                        convictionStorage.setIsOperatorFeeClaimedForEpoch(identityId, e, true);
                        convictionStorage.setNetNodeEpochRewards(identityId, e, netNodeRewards);
                        stakingStorage.increaseOperatorFeeBalance(identityId, operatorFeeAmount);
                    }
                } else {
                    netNodeRewards = convictionStorage.getNetNodeEpochRewards(identityId, e);
                }

                if (delegatorScore18 > 0) {
                    epochReward = (delegatorScore18 * netNodeRewards) / nodeScore18;
                }
            }

            rewardTotal += epochReward;
        }

        if (rewardTotal == 0) {
            // No-reward window: just advance the claim cursor.
            convictionStorage.setLastClaimedEpoch(tokenId, uint32(claimToEpoch));
            return;
        }

        if (rewardTotal > type(uint96).max) revert RewardOverflow();
        uint96 rewardU96 = uint96(rewardTotal);

        // D19 — compound into raw. CSS writes the per-epoch effective-stake
        // diff and bumps nodeStakeV10 / totalStakeV10 in lockstep. The
        // compounded TRAC earns the position's current multiplier.
        convictionStorage.increaseRaw(tokenId, rewardU96);
        convictionStorage.addCumulativeRewardsClaimed(tokenId, rewardU96);

        // Sharding-table + Ask housekeeping — the reward compound grew
        // node stake; a node previously under `minimumStake` may now be
        // eligible for the sharding table. Reward is always an increase,
        // so only the cross-above-minimum insert is needed.
        {
            uint256 newNodeStake = convictionStorage.getNodeStakeV10(identityId);
            if (
                !shardingTableStorage.nodeExists(identityId) &&
                newNodeStake >= uint256(parametersStorage.minimumStake())
            ) {
                shardingTable.insertNode(identityId);
            }
        }
        ask.recalculateActiveSet();

        convictionStorage.setLastClaimedEpoch(tokenId, uint32(claimToEpoch));

        emit RewardsClaimed(tokenId, rewardU96);
    }

    /**
     * @notice Self-service V8 → V10 migration. The delegator calls the NFT
     *         wrapper's `selfMigrateV8`, which forwards here with
     *         `delegator == msg.sender`. Drains their V8 address-keyed
     *         delegation on `identityId` and seeds a V10 NFT-backed
     *         position at `migrationEpoch = currentEpoch`.
     *
     * @dev D7 — dual-path migration: this is the self path. The straggler-
     *      rescue path is `adminConvertToNFT`, which takes an explicit
     *      `delegator` and is gated at the NFT wrapper by
     *      `onlyOwnerOrMultiSigOwner`. Both paths share `_convertToNFT`.
     */
    function selfConvertToNFT(
        address staker,
        uint256 tokenId,
        uint72 identityId,
        uint40 lockTier
    ) external onlyConvictionNFT {
        _convertToNFT(staker, tokenId, identityId, lockTier, false);
    }

    /**
     * @notice Admin straggler-rescue V8 → V10 migration. Takes an explicit
     *         `delegator` (the V8 address whose delegation is being drained
     *         and who receives the freshly-minted V10 NFT). Access-gated at
     *         the NFT wrapper layer by `onlyOwnerOrMultiSigOwner`.
     *
     * @dev D7 — stragglers are delegators who haven't migrated by
     *      `v10LaunchEpoch`. Admin is responsible for picking a sensible
     *      default `lockTier` (typically `0` — the rest-state tier — so
     *      the user gets their full balance with no lock surprise).
     */
    function adminConvertToNFT(
        address delegator,
        uint256 tokenId,
        uint72 identityId,
        uint40 lockTier
    ) external onlyConvictionNFT {
        _convertToNFT(delegator, tokenId, identityId, lockTier, true);
    }

    /**
     * @notice Admin: set the V10 launch epoch marker on CSS. This is the
     *         retroactive-attribution boundary used by `adminMigrateV8`
     *         bookkeeping and off-chain analytics. Expected to be called
     *         exactly once, in the deploy-script migration cutover. Gate
     *         enforced at the NFT wrapper (`onlyOwnerOrMultiSigOwner`).
     *
     * @dev D7 — the V10 launch epoch is the cutoff past which V8-era
     *      state should not continue to accrue rewards; anything the
     *      migration process hasn't swept by this epoch is treated as a
     *      straggler and rescued via `adminConvertToNFT`.
     */
    function setV10LaunchEpoch(uint256 epoch) external onlyConvictionNFT {
        convictionStorage.setV10LaunchEpoch(epoch);
    }

    /**
     * @dev Core V8→V10 migration worker. Absorbs BOTH the V8 active
     *      stakeBase AND any pending V8 withdrawal (D8) into the new V10
     *      position's `raw`. TRAC stays in the StakingStorage vault; no
     *      external token transfer happens here.
     *
     * V8-side state drain:
     *   - `setDelegatorStakeBase(id, v8Key, 0)` — zero the V8 key's active stake.
     *   - `deleteDelegatorWithdrawalRequest(id, v8Key)` (only if pending).
     *   - `decreaseNodeStake(id, stakeBase)` — V8 pending was already
     *     excluded from nodeStake at request time, so we only subtract
     *     the active portion.
     *   - `decreaseTotalStake(stakeBase)` — same reasoning.
     *
     * V10-side state seed:
     *   - `cs.createPosition(tokenId, id, stakeBase + pending, lockTier,
     *     multiplier18, migrationEpoch = currentEpoch)`. This also pushes
     *     the tokenId into `nodeTokens[id]` and increments nodeStakeV10 +
     *     totalStakeV10 in the same call (D5 + D15).
     *
     * Preconditions absorbed in the V10 migration simplification:
     *   - NO V8 rolling-rewards / lastClaimedEpoch precondition: D3 drops
     *     DelegatorsInfo; pre-migration rewards are handled by `claim()`'s
     *     D6 retroactive branch starting from `migrationEpoch`.
     *   - NO V8 `Staking.prepareForStakeChange` cross-call: D13/D17 drop
     *     V8 Staking from the hub.
     *
     * `migrationEpoch = currentEpoch` anchors the retroactive claim window
     * so `claim()` starts the reward walk at the migration epoch
     * (inclusive) and not at `currentEpoch - 1` (the default for fresh V10
     * stakes).
     */
    function _convertToNFT(
        address delegator,
        uint256 tokenId,
        uint72 identityId,
        uint40 lockTier,
        bool isAdmin
    ) internal {
        uint256 currentEpoch = chronos.getCurrentEpoch();

        bytes32 v8Key = keccak256(abi.encodePacked(delegator));
        StakingStorage ss = stakingStorage;
        uint96 stakeBase = ss.getDelegatorStakeBase(identityId, v8Key);
        uint96 pending = ss.getDelegatorWithdrawalRequestAmount(identityId, v8Key);
        // D8 — absorb BOTH amounts; straggler with zero active stake but a
        // pending V8 withdrawal is still a valid migration target.
        uint96 total = stakeBase + pending;
        if (total == 0) revert NoV8StakeToConvert();

        // V8 drain — see header NatSpec for the node/total stake reasoning.
        if (stakeBase > 0) {
            ss.setDelegatorStakeBase(identityId, v8Key, 0);
            ss.decreaseNodeStake(identityId, stakeBase);
            ss.decreaseTotalStake(stakeBase);
        }
        if (pending > 0) {
            ss.deleteDelegatorWithdrawalRequest(identityId, v8Key);
        }

        // Settle V10 side at zero stake — baseline the V10 token's score
        // cursor at `currentEpoch` so a later `claim()` doesn't collect
        // pre-migration node score via the V10 key.
        _prepareForStakeChangeV10(currentEpoch, tokenId, identityId);

        // maxStake cap on the destination V10 node stake (post-migration
        // cap reads V10 canonical).
        {
            uint256 maxStake = uint256(parametersStorage.maximumStake());
            uint256 v10NodeAfter = convictionStorage.getNodeStakeV10(identityId) + uint256(total);
            if (v10NodeAfter > maxStake) revert MaxStakeExceeded();
        }

        // L11 — multiplier18 is no longer passed; CSS reads it from the tier table.
        convictionStorage.createPosition(
            tokenId,
            identityId,
            total,
            lockTier,
            uint32(currentEpoch) // D6 — retroactive claim boundary
        );

        // Sharding-table: V8 drain + V10 seed of the same on-node total is
        // typically a wash, but the guards handle the edge cases (node was
        // only in ST via V8 or only via the combined bar, and the V10
        // canonical aggregate now needs to be checked alone).
        {
            ShardingTableStorage sts = shardingTableStorage;
            uint256 minStake = uint256(parametersStorage.minimumStake());
            uint256 v10NodeStake = convictionStorage.getNodeStakeV10(identityId);
            if (!sts.nodeExists(identityId) && v10NodeStake >= minStake) {
                shardingTable.insertNode(identityId);
            }
            // V8 drain-induced ST removals are intentionally not run here:
            // the old ST entry was gated on the V8+V10 combined bar, and
            // the V10 canonical aggregate is what the post-migration ST
            // maintenance reads. The next flow that touches the node will
            // prune it if subcritical.
        }

        ask.recalculateActiveSet();

        emit ConvertedFromV8(delegator, tokenId, identityId, stakeBase, pending, lockTier, isAdmin);
    }

    // ========================================================================
    // Internal helpers — V10 score-per-stake settlement
    // ========================================================================

    /**
     * @dev D26 — settle the delegator's score accumulator for `epoch` up to
     *      the latest on-chain proof. If the position lives on `identityId`,
     *      integrate using its current effective stake, splitting at
     *      `expiryTimestamp` when the boost transition lands inside `epoch`.
     *      Otherwise (redelegate to a different node, or migration baseline)
     *      just bump the delegator's cursor to the current last-value.
     */
    function _prepareForStakeChangeV10(
        uint256 epoch,
        uint256 tokenId,
        uint72 identityId
    ) internal returns (uint256 delegatorScore) {
        bytes32 delegatorKey = bytes32(tokenId);
        ConvictionStakingStorage.Position memory pos = convictionStorage.getPosition(tokenId);

        uint256 nodeScorePerStake36 = randomSamplingStorage.getEpochLastScorePerStake(identityId, epoch);
        uint256 currentDelegatorScore18 = randomSamplingStorage.getEpochNodeDelegatorScore(
            epoch,
            identityId,
            delegatorKey
        );
        uint256 lastSettled = randomSamplingStorage.getDelegatorLastSettledNodeEpochScorePerStake(
            epoch,
            identityId,
            delegatorKey
        );

        if (nodeScorePerStake36 == lastSettled) {
            return currentDelegatorScore18;
        }

        uint256 scoreEarned18 = 0;
        if (pos.identityId == identityId) {
            uint256 rawU = uint256(pos.raw);
            uint256 mult18 = uint256(pos.multiplier18);
            uint256 expiryTs = uint256(pos.expiryTimestamp);
            uint256 expiryEpoch = expiryTs == 0 ? 0 : chronos.epochAtTimestamp(expiryTs);
            uint256 effBoosted = (rawU * mult18) / SCALE18;
            uint256 effBase = rawU;

            scoreEarned18 = _delegatorIncrementForEpoch(
                epoch,
                identityId,
                nodeScorePerStake36,
                lastSettled,
                effBoosted,
                effBase,
                expiryTs,
                expiryEpoch
            );
        }

        if (scoreEarned18 > 0) {
            randomSamplingStorage.addToEpochNodeDelegatorScore(epoch, identityId, delegatorKey, scoreEarned18);
        }
        randomSamplingStorage.setDelegatorLastSettledNodeEpochScorePerStake(
            epoch,
            identityId,
            delegatorKey,
            nodeScorePerStake36
        );

        return currentDelegatorScore18 + scoreEarned18;
    }

    /**
     * @dev H2 — shared D26 expiry-split reward integration. Returns the
     *      delegator's earned score increment (18-decimals) across the
     *      settlement window `(lastSettled, current]` in epoch `epoch`,
     *      honoring the position's boost transition at `expiryTs`.
     *
     * Cases, in order:
     *   * `current <= lastSettled`       → nothing to integrate.
     *   * `expiryTs == 0`                → tier-0 rest state; no boost
     *                                      transition ever. Use `effBase`.
     *   * `epoch < expiryEpoch`          → boost fully active in epoch.
     *                                      Use `effBoosted`.
     *   * `epoch > expiryEpoch`          → boost already dropped for the
     *                                      whole epoch. Use `effBase`.
     *   * `epoch == expiryEpoch` with
     *     `effBoosted == effBase`        → M4: boost delta is zero (1x
     *                                      "locked" tier). Skip the
     *                                      binary search, integrate with
     *                                      `effBase`.
     *   * `epoch == expiryEpoch` with
     *     `effBoosted > effBase`         → one binary search into the
     *                                      epoch's checkpoint array gives
     *                                      scorePerStake at the exact
     *                                      expiry second; integrate the
     *                                      left half at boosted rate and
     *                                      the right half at base rate.
     *                                      `scoreAtExpiry` below the
     *                                      delegator cursor collapses
     *                                      back to the base-rate path.
     */
    function _delegatorIncrementForEpoch(
        uint256 epoch,
        uint72 identityId,
        uint256 current,
        uint256 lastSettled,
        uint256 effBoosted,
        uint256 effBase,
        uint256 expiryTs,
        uint256 expiryEpoch
    ) internal view returns (uint256) {
        if (current <= lastSettled) return 0;

        if (expiryTs == 0 || epoch < expiryEpoch) {
            uint256 eff = expiryTs == 0 ? effBase : effBoosted;
            return (eff * (current - lastSettled)) / SCALE18;
        }
        if (epoch > expiryEpoch) {
            return (effBase * (current - lastSettled)) / SCALE18;
        }
        // epoch == expiryEpoch.
        if (effBoosted == effBase) {
            // M4 — degenerate tier (duration>0, mult==1x). No boost delta at
            //      expiry, so no split is needed and we skip the binary
            //      search.
            return (effBase * (current - lastSettled)) / SCALE18;
        }
        uint256 scoreAtExpiry = randomSamplingStorage.findScorePerStakeAt(
            identityId,
            epoch,
            uint40(expiryTs)
        );
        if (scoreAtExpiry > lastSettled) {
            return
                (effBoosted * (scoreAtExpiry - lastSettled)) / SCALE18 +
                (effBase * (current - scoreAtExpiry)) / SCALE18;
        }
        return (effBase * (current - lastSettled)) / SCALE18;
    }
}
