// SPDX-License-Identifier: Apache-2.0

pragma solidity ^0.8.20;

import {Staking} from "./Staking.sol";
import {ShardingTable} from "./ShardingTable.sol";
import {Ask} from "./Ask.sol";
import {ParametersStorage} from "./storage/ParametersStorage.sol";
import {ProfileStorage} from "./storage/ProfileStorage.sol";
import {ShardingTableStorage} from "./storage/ShardingTableStorage.sol";
import {StakingStorage} from "./storage/StakingStorage.sol";
import {ConvictionStakingStorage} from "./storage/ConvictionStakingStorage.sol";
import {DelegatorsInfo} from "./storage/DelegatorsInfo.sol";
import {RandomSamplingStorage} from "./storage/RandomSamplingStorage.sol";
import {Chronos} from "./storage/Chronos.sol";
import {ContractStatus} from "./abstract/ContractStatus.sol";
import {IInitializable} from "./interfaces/IInitializable.sol";
import {INamed} from "./interfaces/INamed.sol";
import {IVersioned} from "./interfaces/IVersioned.sol";
import {StakingLib} from "./libraries/StakingLib.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title StakingV10
 * @notice V10 NFT-backed staking orchestrator. Owns all V10 conviction logic
 *         (stake / relock / redelegate / withdraw / claim / convertToNFT).
 *         The legacy `Staking.sol` (V8) keeps its V8 address-keyed paths
 *         untouched — this contract is the single authoritative entry for
 *         every NFT-backed flow.
 *
 * @dev V10 split-contract architecture:
 *        - `Staking.sol` (V8)       — kept for legacy stake/redelegate/claim/withdraw.
 *        - `StakingV10.sol` (this)  — all V10 NFT-backed business logic.
 *        - `DKGStakingConvictionNFT` — the user-facing ERC-721 wrapper; calls
 *          ONLY `StakingV10.*` for staking logic, never `StakingStorage` directly.
 *
 *      Gate model: every external entry point here is `onlyConvictionNFT`,
 *      which pins the caller to the Hub-registered
 *      `DKGStakingConvictionNFT`. The `staker` argument is the original NFT
 *      owner / caller — passed in explicitly by the NFT wrapper instead of
 *      being inferred from `tx.origin`. Ownership checks inside each
 *      implementation must compare `staker == nft.ownerOf(tokenId)`.
 *
 *      Phase 5 scaffold (this file): all eight entry points are stubbed as
 *      `revert("NotImplemented")`. Downstream subagents will fill in the
 *      bodies one entry at a time. Do NOT add partial logic here — the
 *      implementation subagents assume a clean revert surface.
 */
contract StakingV10 is INamed, IVersioned, ContractStatus, IInitializable {
    // ========================================================================
    // Metadata
    // ========================================================================

    string private constant _NAME = "StakingV10";
    string private constant _VERSION = "1.0.0";

    // ========================================================================
    // Constants
    // ========================================================================

    /// @notice 1e18 fixed-point scale shared with `ConvictionStakingStorage`,
    ///         `Staking.convictionMultiplier`, and
    ///         `DKGStakingConvictionNFT._convictionMultiplier`. Tier math
    ///         and reward accounting all use this scale.
    uint256 public constant SCALE18 = 1e18;

    /// @notice Delay between `createWithdrawal` and `finalizeWithdrawal`.
    ///         Hardcoded at 15 days per Phase 5 decisions Q6 — NOT sourced
    ///         from `ParametersStorage.stakeWithdrawalDelay` (that parameter
    ///         governs the V8 legacy address-keyed path only).
    uint256 public constant WITHDRAWAL_DELAY = 15 days;

    // NOTE: `EPOCHS_PER_MONTH` is not defined here. The relock math works in
    // raw epoch counts — Chronos exposes an absolute epoch number, and lock
    // tiers {0, 1, 3, 6, 12} are the authoritative lock set per
    // `ConvictionStakingStorage.expectedMultiplier18`. If a subagent needs a
    // month-to-epoch converter, add it to Chronos, not here.

    // ========================================================================
    // Hub-wired dependencies
    // ========================================================================

    StakingStorage public stakingStorage;
    ConvictionStakingStorage public convictionStorage;
    DelegatorsInfo public delegatorsInfo;
    Chronos public chronos;
    RandomSamplingStorage public randomSamplingStorage;
    ShardingTableStorage public shardingTableStorage;
    ShardingTable public shardingTable;
    Ask public ask;
    ParametersStorage public parametersStorage;
    ProfileStorage public profileStorage;
    Staking public staking;
    IERC20 public token;

    // ========================================================================
    // Events
    // ========================================================================

    /// @notice Emitted by `stake` after the NFT-backed position is recorded.
    event Staked(
        uint256 indexed tokenId,
        address indexed staker,
        uint72 indexed identityId,
        uint96 amount,
        uint8 lockEpochs
    );

    /// @notice Emitted by `relock` after a post-expiry re-commit to a new
    ///         tier. Raw unchanged; multiplier + expiry shift.
    event Relocked(uint256 indexed tokenId, uint8 newLockEpochs, uint64 newExpiryEpoch);

    /// @notice Emitted by `redelegate`. Global effective-stake totals are
    ///         invariant; only per-node totals move.
    event Redelegated(
        uint256 indexed tokenId,
        uint72 indexed oldIdentityId,
        uint72 indexed newIdentityId
    );

    /// @notice Emitted by `createWithdrawal` when the delay timer starts.
    ///         `releaseAt` is a Unix timestamp (current block time +
    ///         `WITHDRAWAL_DELAY`).
    event WithdrawalCreated(uint256 indexed tokenId, uint96 amount, uint64 releaseAt);

    /// @notice Emitted by `cancelWithdrawal` when a pending withdrawal is
    ///         cleared before finalization.
    event WithdrawalCancelled(uint256 indexed tokenId);

    /// @notice Emitted by `finalizeWithdrawal` after the delay elapses and
    ///         TRAC is released back to the staker. `rawDraw` and
    ///         `rewardsDraw` are the amounts drained from the raw and
    ///         rewards buckets respectively.
    event WithdrawalFinalized(uint256 indexed tokenId, uint96 rawDraw, uint96 rewardsDraw);

    /// @notice Emitted by `claim` after rewards are accrued into the
    ///         position's rewards bucket via
    ///         `ConvictionStakingStorage.increaseRewards`.
    event RewardsClaimed(uint256 indexed tokenId, uint96 amount);

    /// @notice Emitted by `convertToNFT` when a V8 address-keyed delegation
    ///         is migrated into a V10 NFT-backed position.
    event ConvertedFromV8(
        address indexed staker,
        uint256 indexed tokenId,
        uint72 indexed identityId,
        uint96 amount,
        uint8 lockEpochs
    );

    // ========================================================================
    // Errors
    // ========================================================================
    //
    // All new V10 errors are declared locally here (NOT in `StakingLib.sol`)
    // per the Phase 5 scope — `StakingLib` already exports
    // `OnlyConvictionNFT` from Phase 4 and we reuse it for the modifier gate.

    error InvalidLockEpochs();
    error LockStillActive();
    error LockNotExpired();
    error NotPositionOwner();
    error WithdrawalAlreadyRequested();
    error WithdrawalNotRequested();
    error WithdrawalDelayPending();
    error InsufficientWithdrawable();
    error V8StakeNotFullyClaimed();
    error ZeroAmount();
    error MaxStakeExceeded();
    error SameIdentity();
    error ProfileDoesNotExist();

    // ========================================================================
    // Constructor + initialize
    // ========================================================================

    // solhint-disable-next-line no-empty-blocks
    constructor(address hubAddress) ContractStatus(hubAddress) {}

    /**
     * @dev Wires all Hub-registered dependencies. Called by the Hub during
     *      deployment (and on any redeploy of a dep). Mirrors the initialize
     *      pattern used by `Staking.sol` and `Profile.sol`.
     *
     *      `staking` is the legacy V8 `Staking` contract — we hold a
     *      reference only so V10 settlement paths can call
     *      `Staking.prepareForStakeChange(...)` as an `onlyContracts` cross
     *      helper (single source of score-per-stake math for both V8 and V10).
     */
    function initialize() external onlyHub {
        stakingStorage = StakingStorage(hub.getContractAddress("StakingStorage"));
        convictionStorage = ConvictionStakingStorage(hub.getContractAddress("ConvictionStakingStorage"));
        delegatorsInfo = DelegatorsInfo(hub.getContractAddress("DelegatorsInfo"));
        chronos = Chronos(hub.getContractAddress("Chronos"));
        randomSamplingStorage = RandomSamplingStorage(hub.getContractAddress("RandomSamplingStorage"));
        shardingTableStorage = ShardingTableStorage(hub.getContractAddress("ShardingTableStorage"));
        shardingTable = ShardingTable(hub.getContractAddress("ShardingTable"));
        ask = Ask(hub.getContractAddress("Ask"));
        parametersStorage = ParametersStorage(hub.getContractAddress("ParametersStorage"));
        profileStorage = ProfileStorage(hub.getContractAddress("ProfileStorage"));
        staking = Staking(hub.getContractAddress("Staking"));
        token = IERC20(hub.getContractAddress("Token"));
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

    /**
     * @dev Pins every external entry point to the Hub-registered
     *      `DKGStakingConvictionNFT` contract. Matches the Phase 4
     *      `Staking._recordStake` gate pattern (see `Staking.sol` lines
     *      ~1016–1024) so downstream subagents don't have to fight two
     *      styles.
     *
     *      We read the NFT address from the Hub on every call rather than
     *      caching an immutable — this lets the Hub owner re-point the
     *      `DKGStakingConvictionNFT` registration without redeploying
     *      StakingV10 (e.g., during a controlled NFT contract upgrade).
     *      Matching the Phase 4 pattern keeps both gates symmetric.
     */
    modifier onlyConvictionNFT() {
        if (msg.sender != hub.getContractAddress("DKGStakingConvictionNFT")) {
            revert StakingLib.OnlyConvictionNFT();
        }
        _;
    }

    // ========================================================================
    // External entry points (Phase 5 scaffold stubs — implementation
    // subagents fill in)
    // ========================================================================
    //
    // Every entry takes `address staker` as the first parameter. This is
    // the original NFT owner / caller. `DKGStakingConvictionNFT` passes
    // `msg.sender` (its own caller) explicitly here — `StakingV10` MUST
    // NOT trust `tx.origin`. Each implementation must verify
    // `staker == nft.ownerOf(tokenId)` before mutating any position.
    //
    // These stubs revert `"NotImplemented"` so the Phase 5 scaffold
    // compiles cleanly and deploys green without committing to a partial
    // behavior. Do NOT add partial logic here — subagents assume a clean
    // revert surface as their starting point.
    //
    // The `view` mutability modifier on each stub is a scaffold-only
    // artifact: the body only reads storage through `onlyConvictionNFT`
    // (`hub.getContractAddress(...)`) and then reverts, so the compiler
    // flags the function as "can be restricted to view". Downstream
    // subagents MUST drop `view` from any stub they wire up with state
    // writes — leaving it in place would make the compiler reject the
    // first `stakingStorage.setDelegatorStakeBase(...)` call.

    /**
     * @notice Mint a fresh NFT-backed staking position on `identityId` with
     *         `amount` TRAC locked for `lockEpochs` epochs.
     * @param staker      Original NFT owner / caller (passed by the NFT wrapper).
     * @param tokenId     Fresh NFT token id minted by the wrapper.
     * @param identityId  Target node (must be an existing profile).
     * @param amount      Stake amount in TRAC (>0).
     * @param lockEpochs  Conviction lock duration. Valid set: {1,3,6,12}.
     *
     * @dev Mirrors the Phase 4 `Staking._recordStake` layout step-for-step
     *      (freshness check → maxStake cap → score-per-stake baseline →
     *      TRAC pull → StakingStorage writes → sharding insert → ask
     *      recalc) but targets `bytes32(tokenId)` delegator keys instead
     *      of the V8 `keccak256(address)` key space, and creates the
     *      `ConvictionStakingStorage` position as part of the same
     *      atomic mutation.
     *
     *      NOTE: No `TokenIdAlreadyRecorded` freshness guard: the caller
     *      path `DKGStakingConvictionNFT.createConviction` does
     *      `_mint(msg.sender, tokenId)` before calling us, and ERC721
     *      `_mint` reverts on any already-minted tokenId. That already
     *      enforces per-tokenId uniqueness for the `createConviction`
     *      / `convertToNFT` entry points — the guard would be pure
     *      defense-in-depth against a hypothetical future caller, and
     *      the scope for this subagent explicitly limits new errors to
     *      the already-declared V10 set (no StakingLib edits).
     */
    function stake(
        address staker,
        uint256 tokenId,
        uint72 identityId,
        uint96 amount,
        uint8 lockEpochs
    ) external onlyConvictionNFT {
        staker; // unused in body — retained in the signature because
                // `DKGStakingConvictionNFT` passes the original caller
                // explicitly (no `tx.origin`) and every other V10 entry
                // point that follows this one DOES use it for ownership
                // checks. Keeping the argument shape uniform across all
                // eight entry points prevents the NFT wrapper from
                // shipping a bespoke call for each method.

        // 1. Validate amount. Profile existence is validated below via
        //    `profileStorage.profileExists`; the tier check is folded
        //    into the `expectedMultiplier18` call on (3).
        if (amount == 0) revert ZeroAmount();

        // 2. Profile existence. Mirrors the V8 `stake()` / Phase 4
        //    `_recordStake` guard — without it the sharding-table insert
        //    below would happily register a ghost node at `sha256("")`
        //    for any unregistered identityId.
        if (!profileStorage.profileExists(identityId)) {
            revert ProfileDoesNotExist();
        }

        // 3. Resolve the Phase 5 discrete tier. Reverts "Invalid lock"
        //    for anything outside {0,1,3,6,12}. `createConviction` must
        //    additionally reject lock==0 (it's the post-expiry rest
        //    state, not a valid fresh-mint tier): the storage helper
        //    stays tolerant of lock==0 for reward-math callers, so the
        //    policy check lives here.
        if (lockEpochs == 0) revert InvalidLockEpochs();
        uint64 multiplier18 = convictionStorage.expectedMultiplier18(uint40(lockEpochs));

        // 4. maxStake cap on the destination node.
        StakingStorage ss = stakingStorage;
        uint96 maxStake = parametersStorage.maximumStake();
        uint96 totalNodeStakeAfter = ss.getNodeStake(identityId) + amount;
        if (totalNodeStakeAfter > maxStake) revert MaxStakeExceeded();

        // 5. Baseline this fresh delegator key to the node's current
        //    score-per-stake index so a later reward claim on this NFT
        //    does NOT collect score the node earned before the NFT
        //    existed. `Staking.prepareForStakeChange` takes the
        //    stakeBase==0 fast-path for fresh keys: it bumps
        //    delegatorLastSettledNodeEpochScorePerStake to the current
        //    node index and returns without mutating any score totals.
        //    This is the same protection the V8 `_stake` path applies
        //    to first-time address-keyed delegators, and the Phase 4
        //    `_recordStake` path applies to NFT-keyed ones.
        bytes32 delegatorKey = bytes32(tokenId);
        staking.prepareForStakeChange(chronos.getCurrentEpoch(), identityId, delegatorKey);

        // 6. Pull TRAC straight from `staker` into `StakingStorage`.
        //    The NFT wrapper never holds funds (Phase 5 decision Q4):
        //    the caller has approved THIS contract, not the NFT.
        //    Matches V8 `_stake` which also calls `transferFrom`
        //    without inspecting the return value — the Hub-registered
        //    Token contract (OZ ERC20) reverts on failure, so a
        //    returned `false` is impossible in practice.
        token.transferFrom(staker, address(ss), amount);

        // 7. StakingStorage writes — delegator base, node total,
        //    global total. `bytes32(tokenId)` is the V10 delegator key
        //    (disjoint from the V8 `keccak256(address)` key space), so
        //    the fresh write is safe even if the same `staker` already
        //    has a V8 address-keyed delegation on this node.
        ss.setDelegatorStakeBase(identityId, delegatorKey, amount);
        ss.setNodeStake(identityId, totalNodeStakeAfter);
        ss.increaseTotalStake(amount);

        // 8. Create the V10 position in ConvictionStakingStorage.
        //    `createPosition` computes `expiryEpoch` internally as
        //    `currentEpoch + lockEpochs` (lockEpochs is a raw epoch
        //    count, NOT a month count — the Phase 2 storage layout is
        //    epoch-denominated, the tier labels {0,1,3,6,12} just
        //    happen to match month counts by policy).
        convictionStorage.createPosition(
            tokenId,
            identityId,
            amount,
            uint40(lockEpochs),
            multiplier18
        );

        // 9. Sharding-table maintenance — add the node if it crossed
        //    `minimumStake`. Encapsulated in
        //    `ShardingTable.insertNode` which is idempotent (it
        //    no-ops if the node already exists), but we still guard on
        //    the minimum-stake threshold locally to avoid an
        //    unnecessary external call for sub-minimum stakes.
        ParametersStorage ps = parametersStorage;
        ShardingTableStorage sts = shardingTableStorage;
        if (!sts.nodeExists(identityId) && totalNodeStakeAfter >= ps.minimumStake()) {
            shardingTable.insertNode(identityId);
        }

        // 10. Active-set recalc so the node's new effective stake is
        //     reflected in the next sampling window.
        ask.recalculateActiveSet();

        emit Staked(tokenId, staker, identityId, amount, lockEpochs);
    }

    /**
     * @notice Post-expiry re-commit of an existing position to a new lock
     *         tier. Raw stake unchanged; multiplier + expiry shift.
     * @param staker        Original NFT owner / caller.
     * @param tokenId       Target position.
     * @param newLockEpochs New lock tier. Valid set: {1,3,6,12}.
     */
    function relock(
        address staker,
        uint256 tokenId,
        uint8 newLockEpochs
    ) external view onlyConvictionNFT {
        staker; tokenId; newLockEpochs;
        revert("NotImplemented");
    }

    /**
     * @notice Move a position from its current node to `newIdentityId`.
     *         Per-node effective stake moves; global totals invariant.
     * @param staker         Original NFT owner / caller.
     * @param tokenId        Target position.
     * @param newIdentityId  Destination node (must exist and be distinct
     *                       from the current node).
     */
    function redelegate(
        address staker,
        uint256 tokenId,
        uint72 newIdentityId
    ) external view onlyConvictionNFT {
        staker; tokenId; newIdentityId;
        revert("NotImplemented");
    }

    /**
     * @notice Start the `WITHDRAWAL_DELAY` timer for a partial or full
     *         withdrawal. Caller (`staker`) must own the NFT and the
     *         position must be post-expiry.
     * @param staker   Original NFT owner / caller.
     * @param tokenId  Target position.
     * @param amount   Amount to withdraw (drains rewards bucket first,
     *                 then raw; must be ≤ raw + rewards).
     */
    function createWithdrawal(
        address staker,
        uint256 tokenId,
        uint96 amount
    ) external view onlyConvictionNFT {
        staker; tokenId; amount;
        revert("NotImplemented");
    }

    /**
     * @notice Cancel a pending withdrawal before the delay elapses. Returns
     *         the position to its pre-`createWithdrawal` state.
     */
    function cancelWithdrawal(
        address staker,
        uint256 tokenId
    ) external view onlyConvictionNFT {
        staker; tokenId;
        revert("NotImplemented");
    }

    /**
     * @notice After `WITHDRAWAL_DELAY` has elapsed, drain the withdrawable
     *         amount from the position (rewards bucket first, then raw)
     *         and transfer TRAC back to `staker`. Burns the NFT if the
     *         position is fully drained.
     */
    function finalizeWithdrawal(
        address staker,
        uint256 tokenId
    ) external view onlyConvictionNFT {
        staker; tokenId;
        revert("NotImplemented");
    }

    /**
     * @notice Walk unclaimed epochs for the position, accumulate reward,
     *         and bank it into the `ConvictionStakingStorage` rewards
     *         bucket via `increaseRewards`. Updates `lastClaimedEpoch`.
     */
    function claim(
        address staker,
        uint256 tokenId
    ) external view onlyConvictionNFT {
        staker; tokenId;
        revert("NotImplemented");
    }

    /**
     * @notice Atomic V8 → V10 migration. Burns the caller's V8 address-keyed
     *         delegation on `identityId` and mints a fresh V10 NFT-backed
     *         position at the specified `lockEpochs` tier.
     * @param staker      Original NFT owner / caller (the V8 delegator).
     * @param tokenId     Fresh NFT token id minted by the wrapper.
     * @param identityId  V8 node the delegator is migrating off of.
     * @param lockEpochs  New V10 conviction tier. Valid set: {1,3,6,12}.
     */
    function convertToNFT(
        address staker,
        uint256 tokenId,
        uint72 identityId,
        uint8 lockEpochs
    ) external view onlyConvictionNFT {
        staker; tokenId; identityId; lockEpochs;
        revert("NotImplemented");
    }
}
