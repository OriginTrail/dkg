// SPDX-License-Identifier: Apache-2.0

pragma solidity ^0.8.20;

import {ShardingTable} from "./ShardingTable.sol";
import {Ask} from "./Ask.sol";
import {ParametersStorage} from "./storage/ParametersStorage.sol";
import {ProfileStorage} from "./storage/ProfileStorage.sol";
import {ShardingTableStorage} from "./storage/ShardingTableStorage.sol";
import {StakingStorage} from "./storage/StakingStorage.sol";
import {ConvictionStakingStorage} from "./storage/ConvictionStakingStorage.sol";
import {IdentityStorage} from "./storage/IdentityStorage.sol";
import {RandomSamplingStorage} from "./storage/RandomSamplingStorage.sol";
import {EpochStorage} from "./storage/EpochStorage.sol";
import {Chronos} from "./storage/Chronos.sol";
import {ContractStatus} from "./abstract/ContractStatus.sol";
import {IInitializable} from "./interfaces/IInitializable.sol";
import {INamed} from "./interfaces/INamed.sol";
import {IVersioned} from "./interfaces/IVersioned.sol";
import {IdentityLib} from "./libraries/IdentityLib.sol";
import {Permissions} from "./libraries/Permissions.sol";
import {StakingLib} from "./libraries/StakingLib.sol";
import {TokenLib} from "./libraries/TokenLib.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title StakingV10
 * @notice V10 NFT-backed staking orchestrator. Canonical staking entry point
 *         post-migration.
 *
 * V10 architecture (post-consolidation, v3.0.0 / CSS v4.0.0):
 *   - All V10 delegator state, the TRAC vault, AND operator-fee accounting
 *     live in `ConvictionStakingStorage` (CSS). CSS extends `Guardian`, holds
 *     `tokenContract`, and exposes `transferStake` for outflows. Deposits
 *     route TRAC into the CSS address; withdrawals call `cs.transferStake`.
 *   - `StakingStorage` is dead weight in the V10 hot path. It is read ONLY
 *     by `_convertToNFT` (V8→V10 drain at cutover). Operator-fee balances,
 *     operator-fee withdrawal requests, and the TRAC vault role moved into
 *     CSS in v4.0.0.
 *   - DelegatorsInfo is unregistered (D13). The two per-node-per-epoch
 *     flags it used to hold (`isOperatorFeeClaimedForEpoch`,
 *     `netNodeEpochRewards`) were absorbed into ConvictionStakingStorage.
 *   - The V8 Staking contract is unregistered. The V8-side score
 *     settlement helper (`Staking.prepareForStakeChange`) is no longer
 *     reachable from V10 (D17); the V10-native `_prepareForStakeChangeV10`
 *     handles all V10 settlement. Operator-fee request/finalize/cancel
 *     was V8-only — v3.0.0 ports it to V10 (CSS-backed) so post-consolidation
 *     deploys can fully drain operator fees without the V8 contract.
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
    using SafeERC20 for IERC20;

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
    //   3.0.0 — Storage consolidation (CSS v4.0.0):
    //           * `stake` deposits TRAC into `convictionStorage` (CSS) instead
    //             of `stakingStorage` (SS). CSS extends Guardian and is the
    //             V10 TRAC vault.
    //           * `withdraw` outflow uses `convictionStorage.transferStake`.
    //           * `_claim` operator-fee accrual writes to
    //             `convictionStorage.increaseOperatorFeeBalance`.
    //           * NEW: `requestOperatorFeeWithdrawal`,
    //             `finalizeOperatorFeeWithdrawal`, `cancelOperatorFeeWithdrawal`
    //             — V10-native operator-fee withdrawal API (was V8-only). Uses
    //             `parametersStorage.stakeWithdrawalDelay` cooldown.
    //           * `stakingStorage` is retained ONLY for `_convertToNFT`'s
    //             V8→V10 drain at cutover.
    //   3.1.0 — V8→V10 migration conviction credit (CSS v4.1.0):
    //           * `allocateFromCredit`, for migrants picking lockTier 6 or 12,
    //             shortens the V10 NFT's default `expiryTimestamp` by
    //             `convictionCreditSeconds` (universal — no eligibility
    //             registry; every 6/12 migration allocation earns it).
    //           * `convictionStorage.createPosition(...)` calls now pass the
    //             new `expiryShortenedBy` arg (CSS v4.1.0). `stake` always
    //             passes 0; `_convertToNFT` passes 0 except for eligible
    //             6m/12m migrants.
    //   10.0.3 — Audit fix: mid-epoch `redelegate`/`relock` orphaned the
    //           current epoch's settled delegator score (the old
    //           (epoch, node, key) RSS slot was never read again after the
    //           identity flip / tokenId re-key).
    //           * `redelegate` / `relock` record a `RewardCarry` pointer in
    //             CSS when the settled score is non-zero.
    //           * `_claim` integrates matured carries (epoch closed) via the
    //             extracted `_nodeEpochReward` helper, then clears them.
    string private constant _VERSION = "10.0.3";

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

    /// @notice V8 archive accessor — present ONLY for `_convertToNFT`'s V8→V10
    ///         drain. The V10 hot path (stake/withdraw/claim/operator-fee
    ///         accrual + withdrawal) reads and writes `convictionStorage`
    ///         exclusively (v4.0.0 consolidation).
    StakingStorage public stakingStorage;
    ConvictionStakingStorage public convictionStorage;
    Chronos public chronos;
    RandomSamplingStorage public randomSamplingStorage;
    ShardingTableStorage public shardingTableStorage;
    ShardingTable public shardingTable;
    Ask public ask;
    ParametersStorage public parametersStorage;
    ProfileStorage public profileStorage;
    /// @notice IdentityStorage for `onlyAdmin(identityId)` admin-key checks
    ///         (operator-fee withdrawal request / finalize / cancel).
    IdentityStorage public identityStorage;
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
    error UnclaimedEpochs();
    error V8StakingStillLive();

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
        identityStorage = IdentityStorage(hub.getContractAddress("IdentityStorage"));
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

    /// @notice Operator-fee admin gate. Mirrors V8 `Staking.onlyAdmin` —
    ///         the caller's address (hashed) must hold ADMIN_KEY purpose
    ///         on `identityId` per `IdentityStorage`.
    modifier onlyAdmin(uint72 identityId) {
        if (
            !identityStorage.keyHasPurpose(
                identityId,
                keccak256(abi.encodePacked(msg.sender)),
                IdentityLib.ADMIN_KEY
            )
        ) {
            revert Permissions.OnlyProfileAdminFunction(msg.sender);
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

        if (token.allowance(staker, address(this)) < amount) {
            revert TokenLib.TooLowAllowance(address(token), token.allowance(staker, address(this)), amount);
        }

        if (token.balanceOf(staker) < amount) {
            revert TokenLib.TooLowBalance(address(token), token.balanceOf(staker), amount);
        }

        _prepareForStakeChangeV10(chronos.getCurrentEpoch(), tokenId, identityId);

        // v4.0.0 — TRAC flows into the CSS vault. CSS extends Guardian and
        // exposes `transferStake` for the withdraw outflow side. The NFT
        // wrapper never holds funds; the V8 StakingStorage is no longer in
        // the deposit path.
        //
        // Slither flags this site twice:
        //   - `arbitrary-send-erc20`: `staker` is the `from` argument. NOT
        //     arbitrary — the `onlyConvictionNFT` modifier restricts callers
        //     to the convictionNFT contract, which only invokes `stake()`
        //     for the NFT holder whose token is being created. The allowance
        //     check at line 340 above proves the `staker` authorised this
        //     specific transfer (or the call reverts before reaching here).
        //   - `unchecked-transfer`: `safeTransferFrom` (SafeERC20) reverts
        //     on failure; the false-return path Slither warns about does
        //     not apply.
        // slither-disable-next-line arbitrary-send-erc20,unchecked-transfer
        token.safeTransferFrom(staker, address(convictionStorage), amount);

        // L11 — multiplier18 is no longer passed in; CSS reads it from the
        //       tier table (single source of truth).
        // v4.1.0 — fresh V10 stakes never receive the V8 migration credit;
        //          `expiryShortenedBy` is therefore always 0 here.
        convictionStorage.createPosition(
            tokenId,
            identityId,
            amount,
            lockTier,
            0, // fresh V10 stake: no migrationEpoch
            0 // fresh V10 stake: no expiry credit
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

        uint256 currentEpoch = chronos.getCurrentEpoch();
        uint256 settledEpochScore18 = _prepareForStakeChangeV10(currentEpoch, oldTokenId, pos.identityId);

        // v10.0.3 — baseline the NEW tokenId's settlement cursor at the
        // current score-per-stake BEFORE the position exists under it
        // (cursor-bump-only branch: `positions[newTokenId].identityId == 0`).
        // Without this the new key re-integrates the epoch's score from 0
        // at the NEW multiplier — over-crediting the delegator and
        // overdrawing the node's epoch pool. Mirrors the `stake` baseline.
        _prepareForStakeChangeV10(currentEpoch, newTokenId, pos.identityId);

        // M1 + L11 — same-identity relock. CSS reads the multiplier from the
        //            tier table; no need to pass it in. Migrates any existing
        //            reward carries from oldTokenId to newTokenId (v10.0.3).
        convictionStorage.createNewPositionFromExisting(
            oldTokenId,
            newTokenId,
            pos.identityId,
            newLockTier
        );

        // v10.0.3 — the score settled this epoch lives in RSS under the OLD
        // tokenId's delegator key, which `_claim(newTokenId)` would never
        // read. Carry the pointer across the burn-mint.
        if (settledEpochScore18 > 0) {
            convictionStorage.addRewardCarry(
                newTokenId,
                pos.identityId,
                uint32(currentEpoch),
                bytes32(oldTokenId)
            );
        }

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
        uint256 oldNodeEpochScore18 = _prepareForStakeChangeV10(currentEpoch, tokenId, oldIdentityId);
        _prepareForStakeChangeV10(currentEpoch, tokenId, newIdentityId);

        // v10.0.3 — the score settled on the OLD node for the in-progress
        // epoch becomes unreachable once `pos.identityId` flips (later
        // claims read only the current node). Record a carry pointer so
        // the next claim integrates it against the old node's pool.
        if (oldNodeEpochScore18 > 0) {
            convictionStorage.addRewardCarry(
                tokenId,
                oldIdentityId,
                uint32(currentEpoch),
                bytes32(tokenId)
            );
        }

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

        // v4.0.0 — TRAC flows from the CSS vault to the NFT owner.
        convictionStorage.transferStake(staker, amount);

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

    // ========================================================================
    // Operator-fee withdrawal (v4.0.0)
    //
    // Operators accrue fees inside `_claim` (the gross-vs-net split). The
    // accrued balance lives on CSS (`nodeOperatorFeeBalance`); withdrawing
    // it back to the operator's wallet is a request → cooldown → finalize
    // dance, mirroring V8 `Staking.{request,finalize,cancel}OperatorFeeWithdrawal`
    // exactly. The cooldown reuses `parametersStorage.stakeWithdrawalDelay`
    // (no separate operator-fee delay parameter).
    //
    // Restake-fee-as-stake is handled by the existing 2-step path
    // (`finalizeOperatorFeeWithdrawal` → `DKGStakingConvictionNFT.createConviction`)
    // — no dedicated `restakeOperatorFee` primitive exists in V10 because
    // V10 stake is NFT-keyed and lock-tiered; the operator picks tier on
    // re-stake.
    //
    // ── Deprecated V8 lifetime statistics ─────────────────────────────────
    // V8 `StakingStorage` tracked `operatorFeeCumulative{Earned,PaidOut}Rewards`
    // (with paired events) so off-chain dashboards could compute lifetime
    // operator-fee throughput per node. V10 deliberately drops these counters:
    // the on-chain working set is `nodeOperatorFeeBalance` + queued
    // `operatorFeeWithdrawals` only. Lifetime analytics for V10 are computed
    // off-chain by replaying the existing `OperatorFeeBalanceUpdated`,
    // `OperatorFeeWithdrawalRequestCreated`, and `OperatorFeeWithdrawalRequestDeleted`
    // events (or via the per-epoch `IsOperatorFeeClaimedForEpoch` flag), and
    // are not part of the staking-storage surface. Any consumer that needs the
    // legacy cumulative reads must be ported to event replay; CSS will not be
    // extended with the V8 fields. Documented here so the omission is
    // intentional rather than an oversight in the V8→V10 consolidation.
    // ========================================================================

    /// @notice Initiate an operator-fee withdrawal. Caller must hold ADMIN_KEY
    ///         on `identityId`. Subsequent calls before finalize/cancel
    ///         augment the existing request (combined amount = old + new).
    function requestOperatorFeeWithdrawal(uint72 identityId, uint96 withdrawalAmount) external onlyAdmin(identityId) {
        if (withdrawalAmount == 0) revert TokenLib.ZeroTokenAmount();

        ConvictionStakingStorage cs = convictionStorage;

        uint96 existingRequestAmount = cs.getOperatorFeeWithdrawalRequestAmount(identityId);
        uint96 currentOperatorFeeBalance = cs.getOperatorFeeBalance(identityId);

        // If a request already exists, the requested funds were already
        // moved out of the balance into the queue — restore them before we
        // re-check the cap so the totalRequestAmount comparison is honest.
        if (existingRequestAmount > 0) {
            currentOperatorFeeBalance += existingRequestAmount;
        }

        uint96 totalRequestAmount = existingRequestAmount + withdrawalAmount;
        if (totalRequestAmount > currentOperatorFeeBalance) {
            revert StakingLib.AmountExceedsOperatorFeeBalance(currentOperatorFeeBalance, totalRequestAmount);
        }

        uint256 withdrawalReleaseTimestamp = block.timestamp + parametersStorage.stakeWithdrawalDelay();
        cs.setOperatorFeeBalance(identityId, currentOperatorFeeBalance - totalRequestAmount);
        cs.createOperatorFeeWithdrawalRequest(identityId, totalRequestAmount, /*indexed*/ 0, withdrawalReleaseTimestamp);
    }

    /// @notice Complete an operator-fee withdrawal after the cooldown has
    ///         elapsed. Pays out from the CSS TRAC vault.
    function finalizeOperatorFeeWithdrawal(uint72 identityId) external onlyAdmin(identityId) {
        ConvictionStakingStorage cs = convictionStorage;

        (uint96 operatorFeeWithdrawalAmount, , uint256 withdrawalReleaseTimestamp) = cs.getOperatorFeeWithdrawalRequest(
            identityId
        );
        if (operatorFeeWithdrawalAmount == 0) revert StakingLib.WithdrawalWasntInitiated();
        if (block.timestamp < withdrawalReleaseTimestamp) {
            revert StakingLib.WithdrawalPeriodPending(block.timestamp, withdrawalReleaseTimestamp);
        }

        cs.deleteOperatorFeeWithdrawalRequest(identityId);
        cs.transferStake(msg.sender, operatorFeeWithdrawalAmount);
    }

    /// @notice Cancel a pending operator-fee withdrawal and return the queued
    ///         amount to the operator-fee balance. No cooldown applies.
    function cancelOperatorFeeWithdrawal(uint72 identityId) external onlyAdmin(identityId) {
        ConvictionStakingStorage cs = convictionStorage;

        uint96 operatorFeeWithdrawalAmount = cs.getOperatorFeeWithdrawalRequestAmount(identityId);
        if (operatorFeeWithdrawalAmount == 0) revert StakingLib.WithdrawalWasntInitiated();

        cs.deleteOperatorFeeWithdrawalRequest(identityId);
        cs.increaseOperatorFeeBalance(identityId, operatorFeeWithdrawalAmount);
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
            // what keeps long-dormant tier-0 positions claimable.
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

            rewardTotal += _nodeEpochReward(e, identityId, delegatorScore18);
        }

        // v10.0.3 — integrate matured reward carries (pointers to RSS score
        // slots recorded by mid-epoch `redelegate`/`relock`; see CSS struct
        // docs). A carry matures once its epoch is <= `claimToEpoch`.
        {
            ConvictionStakingStorage.RewardCarry[] memory carries =
                convictionStorage.getRewardCarries(tokenId);
            bool carriesMatured = false;
            for (uint256 i = 0; i < carries.length; i++) {
                if (uint256(carries[i].epoch) > claimToEpoch) continue;
                carriesMatured = true;
                // The main loop above already integrated the position's
                // CURRENT (node, key) slot for every epoch in the window —
                // skip a carry that points at it (e.g. A→B→A round-trip).
                if (carries[i].identityId == identityId && carries[i].delegatorKey == delegatorKey) {
                    continue;
                }
                uint256 carryScore18 = randomSamplingStorage.getEpochNodeDelegatorScore(
                    uint256(carries[i].epoch),
                    carries[i].identityId,
                    carries[i].delegatorKey
                );
                if (carryScore18 == 0) continue;
                rewardTotal += _nodeEpochReward(
                    uint256(carries[i].epoch),
                    carries[i].identityId,
                    carryScore18
                );
            }
            if (carriesMatured) {
                convictionStorage.clearRewardCarries(tokenId, uint32(claimToEpoch));
            }
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

    // ========================================================================
    // V8→V10 "pool & allocate" migration workers
    // ========================================================================
    //
    // The NFT wrapper (DKGStakingConvictionNFT) is the only caller
    // (onlyConvictionNFT). It owns the tokenId counter + ERC-721 mint and the
    // owner gating; these workers do the privileged StakingStorage/CSS
    // mutations. `drainV8ToCredit` is the drain half of the old `_convertToNFT`
    // (now per-node, mints nothing, credits CSS); `allocateFromCredit` is the
    // V10-seed half (now funded from migration credit, not a fresh transfer).

    /// @notice Drain ALL of `delegator`'s V8 stake on `identityId` (active
    ///         stakeBase + any pending withdrawal, D8) into their migration
    ///         credit on CSS. Returns the drained `total` so the wrapper can
    ///         aggregate across nodes and revert if the grand total is zero;
    ///         a node with no V8 stake contributes 0 (no revert here).
    /// @dev    no per-source eligibility: the full drained amount is
    ///         credited to the delegator; the tier-6/12 lock-credit is decided
    ///         later in `allocateFromCredit` from the chosen tier.
    function drainV8ToCredit(
        address delegator,
        uint72 identityId
    ) external onlyConvictionNFT returns (uint96 total) {
        // Freeze-first invariant (on-chain): the V8 `Staking` logic must be
        // unregistered before ANY drain (admin sweep OR self-migrate). A drain
        // zeroes stakeBase without settling the reward cursor; if V8 `Staking`
        // is still live it keeps computing rewards/sharding off StakingStorage,
        // so draining against live state corrupts it. Gating here covers every
        // drain path through one chokepoint; selfMigrate auto-opens at freeze.
        if (hub.isContract("Staking")) revert V8StakingStillLive();
        bytes32 v8Key = keccak256(abi.encodePacked(delegator));
        StakingStorage ss = stakingStorage;
        uint96 stakeBase = ss.getDelegatorStakeBase(identityId, v8Key);
        uint96 pending = ss.getDelegatorWithdrawalRequestAmount(identityId, v8Key);
        total = stakeBase + pending;
        if (total == 0) return 0;

        // V8 drain. Pending was already excluded from node/total stake at
        // request time, so only the active base is decremented.
        if (stakeBase > 0) {
            ss.setDelegatorStakeBase(identityId, v8Key, 0);
            ss.decreaseNodeStake(identityId, stakeBase);
            ss.decreaseTotalStake(stakeBase);
        }
        if (pending > 0) {
            ss.deleteDelegatorWithdrawalRequest(identityId, v8Key);
        }
        // Move the migrated TRAC SS -> CSS so the credit stays collateralized.
        ss.transferStake(address(convictionStorage), total);

        convictionStorage.addMigrationCredit(delegator, total);
    }

    /// @notice Drain node `identityId`'s V8 operator fee (the resting
    ///         `operatorFeeBalance` PLUS any open fee-withdrawal request) into
    ///         `operator`'s migration credit on CSS. Returns the drained
    ///         `total`; a node with no fee contributes 0 (no revert here), so
    ///         the wrapper can sweep in bulk.
    /// @dev    "one credit": the operator fee folds
    ///         into the SAME `migrationCredit` bucket as delegator stake, so
    ///         the operator recovers it exactly like a delegator — `allocate`
    ///         at tier 0 (immediately withdrawable) or 6/12 (conviction).
    ///
    ///         Operator addresses are NOT recoverable on-chain — IdentityStorage
    ///         holds key *hashes*, not addresses — so the off-chain sweep
    ///         supplies `operator` and this function validates it currently
    ///         holds ADMIN_KEY on the node (mirroring who V8
    ///         `finalizeOperatorFeeWithdrawal` would have paid). A stale/wrong
    ///         address REVERTS rather than crediting silently, so a
    ///         mis-resolved operator can never be paid; the sweep hard-fails
    ///         and re-resolves. The check is skipped only when there is nothing
    ///         to drain (`total == 0`), keeping re-runs idempotent and cheap.
    function drainOperatorFeeToCredit(
        uint72 identityId,
        address operator
    ) external onlyConvictionNFT returns (uint96 total) {
        // Freeze-first invariant (see drainV8ToCredit) — no fee drain while V8
        // Staking is still live and could finalize/restake the same balance.
        if (hub.isContract("Staking")) revert V8StakingStillLive();
        StakingStorage ss = stakingStorage;
        uint96 feeBalance = ss.getOperatorFeeBalance(identityId);
        uint96 feeRequest = ss.getOperatorFeeWithdrawalRequestAmount(identityId);
        total = feeBalance + feeRequest;
        if (total == 0) return 0;

        // Credit only an address that currently controls the node.
        if (
            !identityStorage.keyHasPurpose(
                identityId,
                keccak256(abi.encodePacked(operator)),
                IdentityLib.ADMIN_KEY
            )
        ) {
            revert Permissions.OnlyProfileAdminFunction(operator);
        }

        // Zero the V8 fee slots (idempotent: a re-drain reads 0, returns 0).
        // The open-request amount stayed in the SS vault at request time (no
        // token moved), so deleting it here releases it for the SS->CSS move.
        if (feeBalance > 0) {
            ss.setOperatorFeeBalance(identityId, 0);
        }
        if (feeRequest > 0) {
            ss.deleteOperatorFeeWithdrawalRequest(identityId);
        }
        // Move the migrated TRAC SS -> CSS so the credit stays collateralized.
        ss.transferStake(address(convictionStorage), total);

        convictionStorage.addMigrationCredit(operator, total);
    }

    /// @notice Spend `amount` of `staker`'s migration credit into a fresh V10
    ///         conviction position on `targetNode` at `lockTier`. Runs the full
    ///         stake tail (score-cursor baseline → createPosition → sharding
    ///         insert → ask recalc). Any tier-6/12 allocation applies the
    ///         `convictionCreditSeconds` lock-shortening (universal). The
    ///         wrapper supplies `tokenId` and mints after.
    function allocateFromCredit(
        address staker,
        uint256 tokenId,
        uint72 targetNode,
        uint96 amount,
        uint40 lockTier
    ) external onlyConvictionNFT returns (bool creditApplied) {
        if (!profileStorage.profileExists(targetNode)) revert ProfileDoesNotExist();
        ConvictionStakingStorage cs = convictionStorage;
        // Active-tier check: createPosition skips _requireActiveTier on the
        // migration path (migrationEpoch > 0), and this is a NEW tier choice
        // (not honoring a prior V8 commitment), so reject deactivated tiers —
        // EXCEPT tier 0. Tier 0 is the no-lock recovery sink that guarantees
        // admin-drained credit is always withdrawable in two txs (allocate
        // tier-0 -> withdraw); exempting it keeps that safety net independent of
        // whether the owner has retired the no-lock product.
        require(lockTier == 0 || cs.getTier(lockTier).active, "Inactive tier");

        // maxStake cap on the destination node (post-allocation aggregate).
        if (cs.getNodeStakeV10(targetNode) + uint256(amount) > uint256(parametersStorage.maximumStake())) {
            revert MaxStakeExceeded();
        }

        // Debit credit (reverts if amount == 0 or > migrationCredit). The
        // tier-6/12 conviction lock-credit is universal — any 6/12
        // migration allocation earns it (no per-staker eligibility).
        cs.spendMigrationCredit(staker, amount);
        // `creditApplied` must reflect shortening that was ACTUALLY applied:
        // a tier-6/12 allocation while `convictionCreditSeconds == 0` (credit
        // not yet configured) shortens by 0, so the flag/event would otherwise
        // claim a credit that wasn't granted. Gate it on a non-zero duration.
        uint40 creditSeconds = cs.convictionCreditSeconds();
        creditApplied = (lockTier == 6 || lockTier == 12) && creditSeconds > 0;
        uint40 expiryShortenedBy = creditApplied ? creditSeconds : 0;

        uint256 currentEpoch = chronos.getCurrentEpoch();
        // Baseline the V10 score cursor BEFORE createPosition so the creation
        // epoch is not retroactively over-credited.
        _prepareForStakeChangeV10(currentEpoch, tokenId, targetNode);

        cs.createPosition(tokenId, targetNode, amount, lockTier, uint32(currentEpoch), expiryShortenedBy);

        if (
            !shardingTableStorage.nodeExists(targetNode) &&
            cs.getNodeStakeV10(targetNode) >= uint256(parametersStorage.minimumStake())
        ) {
            shardingTable.insertNode(targetNode);
        }
        ask.recalculateActiveSet();
    }

    /// @notice Set the V8→V10 conviction lock-credit (seconds) on CSS. Driven
    ///         by the owner-gated `setConvictionCreditSeconds` entrypoint on the
    ///         NFT wrapper (no freeze gate; settable any time pre-sweep).
    function setConvictionCreditSeconds(uint40 secondsValue) external onlyConvictionNFT {
        convictionStorage.setConvictionCreditSeconds(secondsValue);
    }

    /**
     * @notice Admin: set the V10 launch epoch marker on CSS. This is the
     *         retroactive-attribution boundary used by the admin migration
     *         bookkeeping and off-chain analytics. Expected to be called
     *         exactly once, in the deploy-script migration cutover. Gate
     *         enforced at the NFT wrapper (`onlyOwnerOrMultiSigOwner`).
     *
     * @dev D7 — the V10 launch epoch is the cutoff past which V8-era
     *      state should not continue to accrue rewards; anything the
     *      migration process hasn't swept by this epoch is treated as a
     *      straggler and drained via `adminDrainBatch` / `adminMigrateToCredit`.
     */
    function setV10LaunchEpoch(uint256 epoch) external onlyConvictionNFT {
        convictionStorage.setV10LaunchEpoch(epoch);
    }


    // ========================================================================
    // Internal helpers — V10 score-per-stake settlement
    // ========================================================================

    /**
     * @dev Convert a delegator's epoch score on `identityId` into TRAC,
     *      lazily materializing the node's operator-fee split for `(e,
     *      identityId)` on first touch. Extracted from the `_claim` epoch
     *      loop (v10.0.3) so reward carries share the exact same math.
     *
     *      H1 note — on epochs with `scorePerStake36 > 0 && nodeScore18 ==
     *      0` this returns 0. That combination is essentially impossible in
     *      production (score-per-stake can only be advanced by submitProof,
     *      which also adds to node score), but defensive: there is no fee
     *      to collect and no reward.
     */
    function _nodeEpochReward(
        uint256 e,
        uint72 identityId,
        uint256 delegatorScore18
    ) internal returns (uint256 epochReward) {
        uint256 nodeScore18 = randomSamplingStorage.getNodeEpochScore(e, identityId);
        if (nodeScore18 == 0) return 0;

        uint256 netNodeRewards;
        if (!convictionStorage.isOperatorFeeClaimedForEpoch(identityId, e)) {
            uint256 allNodesScore18 = randomSamplingStorage.getAllNodesEpochScore(e);
            if (allNodesScore18 > 0) {
                uint256 grossNodeRewards = (epochStorage.getEpochPool(EPOCH_POOL_INDEX, e)
                    * nodeScore18) / allNodesScore18;
                uint96 operatorFeeAmount = uint96(
                    (grossNodeRewards
                        * profileStorage.getOperatorFeePercentageByTimestampReverse(identityId, chronos.timestampForEpoch(e + 1) - 1))
                        / parametersStorage.maxOperatorFee()
                );
                netNodeRewards = grossNodeRewards - operatorFeeAmount;
                convictionStorage.setIsOperatorFeeClaimedForEpoch(identityId, e, true);
                convictionStorage.setNetNodeEpochRewards(identityId, e, netNodeRewards);
                // v4.0.0 — operator-fee balance lives on CSS now.
                convictionStorage.increaseOperatorFeeBalance(identityId, operatorFeeAmount);
            }
        } else {
            netNodeRewards = convictionStorage.getNetNodeEpochRewards(identityId, e);
        }

        if (delegatorScore18 > 0) {
            epochReward = (delegatorScore18 * netNodeRewards) / nodeScore18;
        }
    }

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
