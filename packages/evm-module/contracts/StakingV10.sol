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
 *     `decreaseRewards`, no `rewardsPortion` on pending withdrawals.
 */
contract StakingV10 is INamed, IVersioned, ContractStatus, IInitializable {
    // ========================================================================
    // Metadata
    // ========================================================================

    string private constant _NAME = "StakingV10";
    string private constant _VERSION = "2.0.0";

    // ========================================================================
    // Constants
    // ========================================================================

    /// @notice 1e18 fixed-point scale shared with `ConvictionStakingStorage`.
    uint256 public constant SCALE18 = 1e18;

    /// @notice Delay between `createWithdrawal` and `finalizeWithdrawal`.
    ///         D14 — set to 0. Conviction positions are lock-gated
    ///         (withdraw disallowed pre-expiry; the lock IS the delay), so
    ///         a second address-timer gate on top of expiry is redundant
    ///         and just adds operational friction. The `releaseAt` field
    ///         on `PendingWithdrawal` is preserved so on-chain storage
    ///         layout is identical to a non-zero-delay deployment; the
    ///         `finalizeWithdrawal` check simply passes immediately.
    ///
    ///         This is a deployment knob: flipping it back to a non-zero
    ///         value (e.g. `15 days`) is a one-line change + re-deploy and
    ///         requires no storage migration.
    uint256 public constant WITHDRAWAL_DELAY = 0;

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
        uint8 lockTier
    );
    event Relocked(uint256 indexed tokenId, uint8 newLockTier, uint64 newExpiryEpoch);
    event Redelegated(uint256 indexed tokenId, uint72 indexed oldIdentityId, uint72 indexed newIdentityId);
    event WithdrawalCreated(uint256 indexed tokenId, uint96 amount, uint64 releaseAt);
    event WithdrawalCancelled(uint256 indexed tokenId);
    event WithdrawalFinalized(uint256 indexed tokenId, uint96 amount);
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
        uint8 lockTier,
        bool isAdmin
    );

    // ========================================================================
    // Errors
    // ========================================================================

    error InvalidLockTier();
    error LockStillActive();
    error NotPositionOwner();
    error WithdrawalAlreadyRequested();
    error WithdrawalNotRequested();
    error WithdrawalDelayPending();
    error InsufficientWithdrawable();
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
        uint8 lockTier
    ) external onlyConvictionNFT {
        if (amount == 0) revert ZeroAmount();
        if (!profileStorage.profileExists(identityId)) revert ProfileDoesNotExist();

        if (lockTier == 0) revert InvalidLockTier();
        uint64 multiplier18 = convictionStorage.expectedMultiplier18(uint40(lockTier));

        uint256 maxStake = uint256(parametersStorage.maximumStake());
        uint256 totalNodeStakeAfter = convictionStorage.getNodeStakeV10(identityId) + uint256(amount);
        if (totalNodeStakeAfter > maxStake) revert MaxStakeExceeded();

        _prepareForStakeChangeV10(chronos.getCurrentEpoch(), tokenId, identityId);

        // TRAC flows directly into the StakingStorage vault — the vault is
        // shared with V8 (the TRAC custodian contract of the protocol).
        // The NFT wrapper never holds funds.
        token.transferFrom(staker, address(stakingStorage), amount);

        convictionStorage.createPosition(
            tokenId,
            identityId,
            amount,
            uint40(lockTier),
            multiplier18,
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
        uint8 newLockTier
    ) external onlyConvictionNFT {
        staker; // unused — see file-header rationale.

        ConvictionStakingStorage.Position memory pos = convictionStorage.getPosition(oldTokenId);
        if (pos.identityId == 0) revert PositionNotFound();
        _requireFullyClaimed(pos);

        uint256 currentEpoch = chronos.getCurrentEpoch();
        if (currentEpoch < pos.expiryEpoch) revert LockStillActive();

        _prepareForStakeChangeV10(currentEpoch, oldTokenId, pos.identityId);

        uint64 newMultiplier18 = convictionStorage.expectedMultiplier18(uint40(newLockTier));

        // D23 — atomic replace. Same identity, new tier/multiplier/expiry.
        // CSS preserves `cumulativeRewardsClaimed`, `lastClaimedEpoch`,
        // `migrationEpoch` from `oldTokenId` into `newTokenId`.
        convictionStorage.createNewPositionFromExisting(
            oldTokenId,
            newTokenId,
            pos.identityId,
            uint40(newLockTier),
            newMultiplier18
        );

        ConvictionStakingStorage.Position memory posAfter = convictionStorage.getPosition(newTokenId);
        emit Relocked(newTokenId, newLockTier, uint64(posAfter.expiryEpoch));
    }

    /**
     * @notice Move a position from its current node to `newIdentityId`.
     *         Per-node raw/effective stake moves; global totals invariant.
     *         Under D21 this is a burn-and-mint: `oldTokenId` is burned by
     *         the NFT wrapper, `newTokenId` is a freshly-minted NFT the
     *         wrapper has already allocated, and the position state moves
     *         over via the D23 `createNewPositionFromExisting` primitive.
     *
     * @dev Redelegate preserves tier and lifetime stats. CSS re-installs
     *      the boost at `currentEpoch` on the NEW identity under the old
     *      multiplier — effectively the lock "follows" the delegator to
     *      the new node, expiring at the same wall-clock boundary the
     *      caller originally committed to (the primitive re-derives
     *      `expiryEpoch` from `newLockTier = pos.lockTier`, which
     *      lengthens the remaining lock. This is a conscious UX choice:
     *      redelegation resets the clock. Operators wanting a clean
     *      pre-expiry move must cancel + re-stake explicitly).
     */
    function redelegate(
        address staker,
        uint256 oldTokenId,
        uint256 newTokenId,
        uint72 newIdentityId
    ) external onlyConvictionNFT {
        staker;

        ConvictionStakingStorage.Position memory pos = convictionStorage.getPosition(oldTokenId);
        if (pos.identityId == 0) revert PositionNotFound();
        _requireFullyClaimed(pos);
        uint72 oldIdentityId = pos.identityId;

        if (oldIdentityId == newIdentityId) revert SameIdentity();

        // Reject if a pending withdrawal exists. The D23 primitive ALSO
        // rejects this, but we check first so the revert surfaces the
        // intent-level error (UX: cancel first, then redelegate).
        ConvictionStakingStorage.PendingWithdrawal memory pending = convictionStorage.getPendingWithdrawal(oldTokenId);
        if (pending.amount != 0) revert WithdrawalAlreadyRequested();

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
        _prepareForStakeChangeV10(currentEpoch, oldTokenId, oldIdentityId);
        _prepareForStakeChangeV10(currentEpoch, oldTokenId, newIdentityId);

        // D23 — atomic replace. New identity, same tier/multiplier; CSS
        // re-schedules the expiry drop on the new node and moves
        // nodeStakeV10 across; totalStakeV10 invariant.
        convictionStorage.createNewPositionFromExisting(
            oldTokenId,
            newTokenId,
            newIdentityId,
            pos.lockTier,
            pos.multiplier18
        );

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

        emit Redelegated(newTokenId, oldIdentityId, newIdentityId);
    }

    /**
     * @notice Start the WITHDRAWAL_DELAY timer for a partial or full
     *         withdrawal. Pre-expiry: disallowed (raw is locked). Post-
     *         expiry: `amount <= pos.raw`.
     *
     * @dev D19 — no rewards/raw split anymore (rewards compound into raw),
     *      so the single amount is drawn from `pos.raw` directly.
     *      Decrement-at-request semantics: CSS `decreaseRaw` debits the
     *      position + node stake + effective-stake diff immediately; the
     *      pending struct holds only `amount` + `releaseAt`.
     */
    function createWithdrawal(
        address staker,
        uint256 tokenId,
        uint96 amount
    ) external onlyConvictionNFT {
        staker;

        if (amount == 0) revert ZeroAmount();

        ConvictionStakingStorage.Position memory pos = convictionStorage.getPosition(tokenId);
        if (pos.identityId == 0) revert PositionNotFound();
        _requireFullyClaimed(pos);

        ConvictionStakingStorage.PendingWithdrawal memory existing = convictionStorage.getPendingWithdrawal(tokenId);
        if (existing.amount != 0) revert WithdrawalAlreadyRequested();

        // Post-expiry only: pre-expiry the raw is locked (that's the whole
        // point of the conviction lock). Without a rewards sidecar to
        // withdraw from, partial withdrawals during lock are simply
        // unavailable under D19.
        uint256 currentEpoch = chronos.getCurrentEpoch();
        bool unlocked = (pos.expiryEpoch != 0 && currentEpoch >= pos.expiryEpoch)
            || pos.expiryEpoch == 0; // lock-0 rest state
        if (!unlocked) revert LockStillActive();
        if (uint256(amount) > uint256(pos.raw)) revert InsufficientWithdrawable();

        _prepareForStakeChangeV10(currentEpoch, tokenId, pos.identityId);

        // CSS decrements: position `raw`, nodeStakeV10, totalStakeV10,
        // per-epoch effective-stake diff (+ pending-expiry restore if the
        // position had one scheduled).
        convictionStorage.decreaseRaw(tokenId, amount);

        uint64 releaseAt = uint64(block.timestamp + WITHDRAWAL_DELAY);
        convictionStorage.createPendingWithdrawal(tokenId, amount, releaseAt);

        // Sharding-table maintenance: node may have dropped below minimumStake.
        uint256 newNodeStake = convictionStorage.getNodeStakeV10(pos.identityId);
        if (
            shardingTableStorage.nodeExists(pos.identityId) &&
            newNodeStake < uint256(parametersStorage.minimumStake())
        ) {
            shardingTable.removeNode(pos.identityId);
        }

        ask.recalculateActiveSet();

        emit WithdrawalCreated(tokenId, amount, releaseAt);
    }

    /**
     * @notice Cancel a pending withdrawal before the delay elapses.
     *         Symmetric inverse of `createWithdrawal` under D19.
     */
    function cancelWithdrawal(
        address staker,
        uint256 tokenId
    ) external onlyConvictionNFT {
        staker;

        ConvictionStakingStorage.Position memory pos = convictionStorage.getPosition(tokenId);
        if (pos.identityId == 0) revert PositionNotFound();
        _requireFullyClaimed(pos);

        ConvictionStakingStorage.PendingWithdrawal memory pending = convictionStorage.getPendingWithdrawal(tokenId);
        if (pending.amount == 0) revert WithdrawalNotRequested();

        _prepareForStakeChangeV10(chronos.getCurrentEpoch(), tokenId, pos.identityId);

        convictionStorage.increaseRaw(tokenId, pending.amount);
        convictionStorage.deletePendingWithdrawal(tokenId);

        uint256 newNodeStake = convictionStorage.getNodeStakeV10(pos.identityId);
        if (
            !shardingTableStorage.nodeExists(pos.identityId) &&
            newNodeStake >= uint256(parametersStorage.minimumStake())
        ) {
            shardingTable.insertNode(pos.identityId);
        }

        ask.recalculateActiveSet();

        emit WithdrawalCancelled(tokenId);
    }

    /**
     * @notice After WITHDRAWAL_DELAY elapses, transfer the previously-
     *         decremented TRAC back to `staker`. Position buckets and node
     *         aggregates already settled at create-time.
     */
    function finalizeWithdrawal(
        address staker,
        uint256 tokenId
    ) external onlyConvictionNFT {
        ConvictionStakingStorage.Position memory pos = convictionStorage.getPosition(tokenId);
        if (pos.identityId == 0) revert PositionNotFound();

        ConvictionStakingStorage.PendingWithdrawal memory pending = convictionStorage.getPendingWithdrawal(tokenId);
        if (pending.amount == 0) revert WithdrawalNotRequested();
        if (block.timestamp < pending.releaseAt) revert WithdrawalDelayPending();

        uint96 amount = pending.amount;

        // TRAC flows from the StakingStorage vault to the NFT owner. This
        // is the one mapping on StakingStorage the V10 path still interacts
        // with — the vault itself is the protocol's TRAC custody.
        stakingStorage.transferStake(staker, amount);

        convictionStorage.deletePendingWithdrawal(tokenId);

        // Clean up orphaned Position on full drain. `deletePosition` also
        // pops the token from `nodeTokens` and adjusts `nodeStakeV10` —
        // but nodeStake was already adjusted at create-time, so
        // `deletePosition`'s own `_decreaseNodeStakeV10` would
        // double-count. We only call `deletePosition` when `pos.raw == 0`,
        // meaning `_decreaseNodeStakeV10(id, 0)` is a no-op inside CSS
        // (guarded by `if (raw > 0)` in `deletePosition`).
        ConvictionStakingStorage.Position memory posAfter = convictionStorage.getPosition(tokenId);
        if (posAfter.raw == 0) {
            convictionStorage.deletePosition(tokenId);
        }

        emit WithdrawalFinalized(tokenId, amount);
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
        uint256 raw = uint256(pos.raw);
        uint256 mult18 = uint256(pos.multiplier18);
        uint256 expiryEpoch = uint256(pos.expiryEpoch);
        uint72 identityId = pos.identityId;
        bytes32 delegatorKey = bytes32(tokenId);

        uint256 rewardTotal = 0;
        for (uint256 e = claimFromEpoch; e <= claimToEpoch; e++) {
            // Per-epoch effective stake (D19 — no rewards addend).
            uint256 effStake;
            if (expiryEpoch != 0 && e < expiryEpoch) {
                effStake = (raw * mult18) / SCALE18;
            } else {
                effStake = raw;
            }

            uint256 scorePerStake36 = randomSamplingStorage.getNodeEpochScorePerStake(e, identityId);
            uint256 settledDelegatorScore18 = randomSamplingStorage.getEpochNodeDelegatorScore(
                e,
                identityId,
                delegatorKey
            );
            uint256 lastSettledIndex36 = randomSamplingStorage
                .getDelegatorLastSettledNodeEpochScorePerStake(e, identityId, delegatorKey);
            uint256 unsettledDelegatorScore18 = 0;
            if (scorePerStake36 > lastSettledIndex36) {
                unsettledDelegatorScore18 =
                    (effStake * (scorePerStake36 - lastSettledIndex36)) / SCALE18;
            }
            uint256 delegatorScore18 = settledDelegatorScore18 + unsettledDelegatorScore18;

            uint256 nodeScore18 = randomSamplingStorage.getNodeEpochScore(e, identityId);

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

            // Unconditional fee-flag write for rewardless epochs so
            // Profile.updateOperatorFee is never blocked on stale state.
            if (!convictionStorage.isOperatorFeeClaimedForEpoch(identityId, e)) {
                convictionStorage.setIsOperatorFeeClaimedForEpoch(identityId, e, true);
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
        uint8 lockTier
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
        uint8 lockTier
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
        uint8 lockTier,
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

        uint64 multiplier18 = convictionStorage.expectedMultiplier18(uint40(lockTier));
        convictionStorage.createPosition(
            tokenId,
            identityId,
            total,
            uint40(lockTier),
            multiplier18,
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
     * @dev Effective stake a position contributes at `epoch` (D19 — no rewards addend).
     */
    function _getEffectiveStakeAtEpoch(
        ConvictionStakingStorage.Position memory pos,
        uint256 epoch
    ) internal pure returns (uint256) {
        uint256 raw = uint256(pos.raw);
        uint256 expiryEpoch = uint256(pos.expiryEpoch);
        if (expiryEpoch != 0 && epoch < expiryEpoch) {
            return (raw * uint256(pos.multiplier18)) / SCALE18;
        }
        return raw;
    }

    /**
     * @dev Settles the delegator's score-per-stake index at `epoch` using
     *      effective stake. If the position lives on `identityId`, settle
     *      with real effective stake; otherwise baseline only (zero stake).
     *      Every call site passes the target node explicitly.
     */
    function _prepareForStakeChangeV10(
        uint256 epoch,
        uint256 tokenId,
        uint72 identityId
    ) internal returns (uint256 delegatorScore) {
        bytes32 delegatorKey = bytes32(tokenId);

        ConvictionStakingStorage.Position memory pos = convictionStorage.getPosition(tokenId);

        uint256 effectiveStake = (pos.identityId == identityId)
            ? _getEffectiveStakeAtEpoch(pos, epoch)
            : 0;

        uint256 nodeScorePerStake36 = randomSamplingStorage.getNodeEpochScorePerStake(epoch, identityId);
        uint256 currentDelegatorScore18 = randomSamplingStorage.getEpochNodeDelegatorScore(
            epoch,
            identityId,
            delegatorKey
        );
        uint256 lastSettled = randomSamplingStorage
            .getDelegatorLastSettledNodeEpochScorePerStake(epoch, identityId, delegatorKey);

        if (nodeScorePerStake36 == lastSettled) {
            return currentDelegatorScore18;
        }

        if (effectiveStake == 0) {
            randomSamplingStorage.setDelegatorLastSettledNodeEpochScorePerStake(
                epoch,
                identityId,
                delegatorKey,
                nodeScorePerStake36
            );
            return currentDelegatorScore18;
        }

        uint256 scorePerStakeDiff36 = nodeScorePerStake36 - lastSettled;
        uint256 scoreEarned18 = (effectiveStake * scorePerStakeDiff36) / SCALE18;

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
}
