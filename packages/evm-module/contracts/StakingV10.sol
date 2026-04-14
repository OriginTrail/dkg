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
    // Phase 5 SV10-withdrawal — defense-in-depth guard against a direct caller
    // racing past the NFT wrapper's `ownerOf` check with a never-minted tokenId.
    // The wrapper gate (`ownerOf` reverts on non-minted) makes this unreachable
    // through `DKGStakingConvictionNFT`, but we keep the explicit revert for
    // a tighter ABI surface and so the three withdrawal entry points have a
    // uniform "position exists" shape.
    error PositionNotFound();
    // Phase 5 SV10-convertToNFT — caller has no V8 address-keyed stake on the
    // target node. Either they never delegated or the position was already
    // migrated / withdrawn. Distinct from `V8StakeNotFullyClaimed` so the UI
    // can tell the user "you have nothing to migrate" instead of "finish your
    // V8 claims first".
    error NoV8StakeToConvert();

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
     * @param staker        Original NFT owner / caller (unused in the body —
     *                      ownership is enforced at
     *                      `DKGStakingConvictionNFT.relock` via `ownerOf`
     *                      before this function is ever reached; kept in
     *                      the signature so every `onlyConvictionNFT`
     *                      entry point shares the same call shape).
     * @param tokenId       Target position.
     * @param newLockEpochs New lock tier. Valid set: {0,1,3,6,12}. Tier 0 is
     *                      the permanent rest state and is an explicit
     *                      post-expiry relock target per the roadmap
     *                      (`04_TOKEN_ECONOMICS §4.1`). The tier check lives
     *                      in `ConvictionStakingStorage.expectedMultiplier18`
     *                      which reverts `"Invalid lock"` for anything else.
     *
     * @dev Flow:
     *        1. Read position; `raw == 0` → `PositionNotFound`.
     *        2. Require `currentEpoch > pos.expiryEpoch` (strict; the
     *           storage `updateOnRelock` accepts `>=` but the NFT UX is
     *           strict "post-expiry" per the roadmap).
     *        3. Settle score-per-stake indices at `currentEpoch` for the
     *           delegator key before mutating any effective-stake state.
     *        4. Resolve the new tier via
     *           `ConvictionStakingStorage.expectedMultiplier18` — reverts
     *           "Invalid lock" on an out-of-set tier.
     *        5. Forward to `ConvictionStakingStorage.updateOnRelock`,
     *           which owns the effective-stake diff propagation +
     *           finalizes pending epochs + rewrites pos fields.
     *        6. Emit `Relocked` with the freshly-computed `newExpiryEpoch`.
     *
     *      The raw principal stays put (it was already unlocked and is
     *      re-committed without a transfer). The rewards bucket
     *      (`pos.rewards`) is untouched — rewards always earn 1x and are
     *      withdrawable on their own rhythm.
     */
    function relock(
        address staker,
        uint256 tokenId,
        uint8 newLockEpochs
    ) external onlyConvictionNFT {
        staker; // unused — see NatSpec. Kept in the signature so every
                // `onlyConvictionNFT` entry point shares the same call
                // shape from the NFT wrapper.

        // 1. Read position. No explicit "position exists" guard here: the
        //    NFT wrapper's `ownerOf(tokenId) != msg.sender` check in
        //    `DKGStakingConvictionNFT.relock` already rejects un-minted
        //    tokenIds at the wrapper layer. A fully drained
        //    (`raw == 0 && identityId != 0`) rewards-only position would
        //    bypass that check, but the downstream
        //    `ConvictionStakingStorage.updateOnRelock` precondition
        //    `require(pos.raw > 0, "No position")` catches it with a
        //    string revert — no principal to re-lock.
        ConvictionStakingStorage.Position memory pos = convictionStorage.getPosition(tokenId);

        // 2. Lock expiry. `pos.expiryEpoch` for a freshly-minted position
        //    is always `createEpoch + lockEpochs > 0`, so no zero-guard is
        //    needed here (a zero `expiryEpoch` only arises if the position
        //    was created at lock==0, but that path is rejected by
        //    `stake()`/`createConviction` upstream). Strict `>` matches the
        //    roadmap phrasing "post-expiry re-commit".
        uint256 currentEpoch = chronos.getCurrentEpoch();
        if (currentEpoch <= pos.expiryEpoch) revert LockStillActive();

        // 3. Settle the delegator's score index at the current epoch BEFORE
        //    we mutate the effective-stake diff. `_prepareForStakeChange`
        //    bumps `delegatorLastSettledNodeEpochScorePerStake` to the
        //    node's current index so a post-relock reward claim doesn't
        //    re-collect score the delegator has already effectively earned
        //    under the old (post-expiry, 1x) contribution profile. Mirrors
        //    the Phase 4 `Staking._recordStake` settlement step.
        bytes32 delegatorKey = bytes32(tokenId);
        staking.prepareForStakeChange(currentEpoch, pos.identityId, delegatorKey);

        // 4. Resolve the new tier multiplier. Reverts `"Invalid lock"` for
        //    any lock outside {0,1,3,6,12}. Tier==0 is the rest state at 1x
        //    (permanent, no expiry drop) — an explicit valid relock target.
        uint64 newMultiplier18 = convictionStorage.expectedMultiplier18(uint40(newLockEpochs));

        // 5. Storage mutator: writes `pos.lockEpochs`, `pos.expiryEpoch`,
        //    `pos.multiplier18` and propagates the effective-stake diff at
        //    `currentEpoch` + pending drop at `currentEpoch + newLockEpochs`.
        //    Also finalizes any dormant-epoch prefix via
        //    `_finalizeEffectiveStakeUpTo(currentEpoch - 1)` and
        //    `_finalizeNodeEffectiveStakeUpTo(...)`.
        convictionStorage.updateOnRelock(tokenId, uint40(newLockEpochs), newMultiplier18);

        // 6. Emit with the freshly-computed expiry. `currentEpoch` comes from
        //    the Chronos read above; `newLockEpochs` is the user's new
        //    commitment — their sum is the epoch at which the boost drops.
        emit Relocked(tokenId, newLockEpochs, uint64(currentEpoch + uint256(newLockEpochs)));
    }

    /**
     * @notice Move a position from its current node to `newIdentityId`.
     *         Per-node effective stake moves; global totals invariant.
     * @param staker         Original NFT owner / caller (unused in the body —
     *                       ownership is enforced at
     *                       `DKGStakingConvictionNFT.redelegate` via
     *                       `ownerOf` before this function is ever reached;
     *                       kept in the signature so every
     *                       `onlyConvictionNFT` entry point shares the same
     *                       call shape).
     * @param tokenId        Target position.
     * @param newIdentityId  Destination node (must exist and be distinct
     *                       from the current node).
     *
     * @dev Flow (mirror of the V8 `Staking.redelegate` layout adapted to
     *      the V10 `bytes32(tokenId)` delegator-key scheme):
     *        1. Read position; capture `oldIdentityId` / `totalAmount`.
     *        2. Reject `SameIdentity` if `oldIdentityId == newIdentityId`.
     *        3. Validate destination profile existence.
     *        4. Enforce destination `maxStake` cap on the post-move node total.
     *        5. Settle score-per-stake indices at `currentEpoch` on BOTH
     *           nodes for `bytes32(tokenId)`. This is the V10 analog of
     *           the V8 `_prepareForStakeChange` pair in `Staking.redelegate`
     *           and the reason `Staking.prepareForStakeChange` was exposed
     *           as an `external onlyContracts` helper in Phase 4.
     *        6. Move the `StakingStorage` delegator stake base between
     *           `(oldIdentityId, bytes32(tokenId))` and
     *           `(newIdentityId, bytes32(tokenId))`. Writing `0` to the
     *           old bucket triggers `_updateDelegatorActivity`, which
     *           removes the key from the old node's `delegatorNodes` set
     *           and decrements its `delegatorCount`. Writing
     *           `totalAmount` into the new bucket re-adds it on the new
     *           node. This is the V10-key equivalent of the V8
     *           `decreaseDelegatorStakeBase` / `increaseDelegatorStakeBase`
     *           pair in `Staking.redelegate` — we use `setDelegatorStakeBase`
     *           instead because a V10 NFT owns exactly ONE position and
     *           the entire balance moves together.
     *        7. Per-node `nodeStake` move: old node -= totalAmount,
     *           new node += totalAmount. **No** `increaseTotalStake` /
     *           `decreaseTotalStake` call — global `totalStake` is an
     *           invariant during redelegate (this is the load-bearing
     *           difference vs. `stake`/`withdraw`).
     *        8. `ConvictionStakingStorage.updateOnRedelegate` owns the
     *           effective-stake diff propagation + the `pos.identityId`
     *           mutation. It also finalizes any dormant-epoch prefix on
     *           both nodes. We pass only `(tokenId, newIdentityId)` and
     *           let storage compute the rest from the live `Position`.
     *        9. Sharding-table maintenance on BOTH nodes:
     *              - old node: if post-move `nodeStake < minimumStake` and
     *                the node was previously in the sharding table, remove.
     *              - new node: if post-move `nodeStake >= minimumStake` and
     *                the node was not previously in the sharding table, insert.
     *           This mirrors the V8 `Staking.redelegate` pattern via the
     *           local `_addNodeToShardingTable` / `_removeNodeFromShardingTable`
     *           helpers there.
     *       10. `Ask.recalculateActiveSet()` — the per-node delta on either
     *           side may have shifted the active-set composition.
     *       11. Emit `Redelegated(tokenId, oldIdentityId, newIdentityId)`.
     *
     *      `totalAmount = pos.raw + pos.rewards`: both buckets contribute
     *      to `nodeStake`, so both must move. For a fresh NFT with no
     *      `claim()` yet, `pos.rewards == 0` and `totalAmount == pos.raw`
     *      — but the formulation is future-proof for the post-claim path.
     */
    function redelegate(
        address staker,
        uint256 tokenId,
        uint72 newIdentityId
    ) external onlyConvictionNFT {
        staker; // unused — see NatSpec. Kept in the signature so every
                // `onlyConvictionNFT` entry point shares the same call
                // shape from the NFT wrapper.

        // 1. Read the position up front. No explicit "position exists" guard
        //    here: the NFT wrapper's `ownerOf(tokenId) != msg.sender` check
        //    in `DKGStakingConvictionNFT.redelegate` already rejects
        //    un-minted tokenIds at the wrapper layer, and the downstream
        //    `ConvictionStakingStorage.updateOnRedelegate` precondition
        //    `require(pos.raw > 0, "No position")` catches any
        //    fully-drained rewards-only position that slipped past the
        //    owner check. Mirrors the relock precedent above.
        ConvictionStakingStorage.Position memory pos = convictionStorage.getPosition(tokenId);
        uint72 oldIdentityId = pos.identityId;

        // 2. Same-node short-circuit. Storage (`updateOnRedelegate`) also
        //    enforces this with a string revert, but a custom error here
        //    surfaces a cleaner ABI for wrapper / indexer consumers and
        //    cuts the revert distance by one cross-contract hop.
        if (oldIdentityId == newIdentityId) revert SameIdentity();

        // 3. Destination profile must exist. Mirrors the `stake()` /
        //    `_recordStake` guard — without it the sharding-table insert
        //    below would happily register a ghost node at `sha256("")` for
        //    any unregistered `newIdentityId`.
        if (!profileStorage.profileExists(newIdentityId)) {
            revert ProfileDoesNotExist();
        }

        // 4. `totalAmount` = full stake moving between nodes. Both raw and
        //    rewards contribute to `nodeStake` at 1:1 in `StakingStorage`
        //    (the multiplier only affects the CONVICTION-layer effective
        //    stake diff, not the raw per-node totals), so both buckets
        //    must move together. For a fresh NFT with no `claim()` yet,
        //    `pos.rewards == 0` — but formulation is future-proof.
        uint96 totalAmount = pos.raw + pos.rewards;

        // 5. Destination `maxStake` cap. Compute the post-move node total
        //    with explicit widening to prevent a silent uint96 wrap on
        //    hostile inputs (a malicious caller can't get past the gate,
        //    but belt-and-suspenders is free here).
        StakingStorage ss = stakingStorage;
        uint256 newNodeStakeAfter = uint256(ss.getNodeStake(newIdentityId)) + uint256(totalAmount);
        uint256 maxStake = uint256(parametersStorage.maximumStake());
        if (newNodeStakeAfter > maxStake) revert MaxStakeExceeded();

        // 6. Settle score-per-stake indices on BOTH nodes before mutating
        //    any effective-stake state. The V10 path uses the Phase 4
        //    `Staking.prepareForStakeChange(epoch, identityId, delegatorKey)`
        //    external helper — same `_prepareForStakeChange` internal that
        //    V8 `Staking.redelegate` calls for address-keyed delegators.
        //    Settling both endpoints guarantees:
        //      - old node: any score the NFT earned up to this epoch is
        //        finalized against the OLD identity before it stops
        //        contributing there.
        //      - new node: the fresh delegator key is baselined at the new
        //        node's current index so a post-move claim doesn't collect
        //        score the new node earned before the NFT ever arrived.
        uint256 currentEpoch = chronos.getCurrentEpoch();
        bytes32 delegatorKey = bytes32(tokenId);
        staking.prepareForStakeChange(currentEpoch, oldIdentityId, delegatorKey);
        staking.prepareForStakeChange(currentEpoch, newIdentityId, delegatorKey);

        // 7. Move the StakingStorage delegator stake base. Writing 0 on
        //    the old (identity, key) bucket triggers
        //    `_updateDelegatorActivity`, which removes `delegatorKey` from
        //    `delegatorNodes[key]` and decrements the old node's
        //    `delegatorCount` (V10 analog of V8 `_handleDelegatorRemovalOnZeroStake`
        //    minus the DelegatorsInfo bookkeeping, which the NFT path
        //    does not touch — V10 positions are NFT-keyed, not
        //    address-keyed, so `delegatorsInfo` entries are managed by the
        //    V8 path only). Writing `totalAmount` on the new bucket
        //    re-adds the key to `delegatorNodes[key]` and increments the
        //    new node's `delegatorCount`.
        ss.setDelegatorStakeBase(oldIdentityId, delegatorKey, 0);
        ss.setDelegatorStakeBase(newIdentityId, delegatorKey, totalAmount);

        // 8. Per-node `nodeStake` move. **NO** total-stake mutation: this
        //    is the load-bearing invariant of redelegate (funds stay in
        //    StakingStorage, only the per-node accounting shifts). We use
        //    `decreaseNodeStake` / `increaseNodeStake` instead of
        //    `setNodeStake(... - totalAmount)` / `setNodeStake(... +
        //    totalAmount)` so the delta is in the storage event stream
        //    (`NodeStakeUpdated` fires with the new totals) without an
        //    extra read of the pre-decrement value.
        ss.decreaseNodeStake(oldIdentityId, totalAmount);
        ss.increaseNodeStake(newIdentityId, totalAmount);

        // 9. Conviction-layer mutator. Owns the effective-stake diff
        //    propagation on both nodes + the pending expiry-drop move
        //    (if still boosted) + the `pos.identityId = newIdentityId`
        //    write. Also finalizes the dormant-epoch prefix on both
        //    nodes via `_finalizeNodeEffectiveStakeUpTo(...)`. We pass
        //    only `(tokenId, newIdentityId)` — storage re-reads the
        //    live `Position` for everything else.
        convictionStorage.updateOnRedelegate(tokenId, newIdentityId);

        // 10. Sharding-table maintenance on BOTH nodes. The post-move
        //     totals are `(ss.getNodeStake(oldIdentityId), ss.getNodeStake(
        //     newIdentityId))` — the decrease / increase calls above have
        //     already been applied, so reading through StakingStorage
        //     reflects the true post-move state.
        //
        //     We inline the add/remove guards here (local helpers like
        //     `_addNodeToShardingTable` only exist in the V8 `Staking.sol`
        //     contract and are out of scope for Phase 5 — we re-use the
        //     same idempotent external `ShardingTable.insertNode` /
        //     `ShardingTable.removeNode` entries from `ShardingTable.sol`
        //     that `_recordStake` on the V8 side goes through).
        ShardingTableStorage sts = shardingTableStorage;
        uint96 minStake = parametersStorage.minimumStake();

        uint96 oldNodeStakeAfter = ss.getNodeStake(oldIdentityId);
        if (sts.nodeExists(oldIdentityId) && oldNodeStakeAfter < minStake) {
            shardingTable.removeNode(oldIdentityId);
        }

        uint96 newNodeStakeAfter96 = ss.getNodeStake(newIdentityId);
        if (!sts.nodeExists(newIdentityId) && newNodeStakeAfter96 >= minStake) {
            shardingTable.insertNode(newIdentityId);
        }

        // 11. Ask recalculation — the per-node deltas on either side may
        //     have shifted the active-set composition (a sub-min node
        //     dropping out, or a newly-funded node crossing the threshold).
        ask.recalculateActiveSet();

        emit Redelegated(tokenId, oldIdentityId, newIdentityId);
    }

    /**
     * @notice Start the `WITHDRAWAL_DELAY` timer for a partial or full
     *         withdrawal. Caller (`staker`) must own the NFT. Pre-expiry,
     *         `amount` is clamped to `pos.rewards` (raw principal is
     *         locked). Post-expiry, `amount ≤ pos.raw + pos.rewards`.
     * @param staker   Original NFT owner / caller (unused in the body —
     *                 ownership is enforced at
     *                 `DKGStakingConvictionNFT.createWithdrawal` via
     *                 `ownerOf` before this function is ever reached;
     *                 kept in the signature so every
     *                 `onlyConvictionNFT` entry point shares the same
     *                 call shape).
     * @param tokenId  Target position.
     * @param amount   Amount to withdraw.
     *
     * @dev Flow:
     *        1. `amount == 0` → `ZeroAmount` (defense-in-depth; the NFT
     *           wrapper already rejects this path with its own
     *           `ZeroAmount` error).
     *        2. Read position; drained `(raw == 0 && rewards == 0)` →
     *           `PositionNotFound` (unreachable through the wrapper —
     *           burn-on-drain would have already taken the tokenId off
     *           the NFT's books — but a defensive guard for correctness).
     *        3. Compute `withdrawable`:
     *              pre-expiry : pos.rewards
     *              post-expiry: pos.raw + pos.rewards
     *           Strict `>` comparison against `amount` so a user can
     *           always drain to the withdrawable cap exactly.
     *        4. One pending withdrawal at a time per NFT — we forward to
     *           `StakingStorage.getDelegatorWithdrawalRequest` and reject
     *           if the amount slot is non-zero. The cancel path clears
     *           this slot; a fresh `createWithdrawal` must wait for the
     *           cancel or the finalize before re-arming.
     *        5. Write a new withdrawal request under the V10-disjoint
     *           `bytes32(tokenId)` key. `indexedOutAmount` stays 0 for
     *           V10: the legacy reward-index bookkeeping lived in a
     *           separate path the NFT flow does not inherit.
     *        6. `releaseAt = block.timestamp + WITHDRAWAL_DELAY` is a
     *           Unix timestamp, NOT an epoch number. The delay is a flat
     *           15 days per Phase 5 Q6, regardless of lock state.
     *
     *      **No stake mutation at this stage** — the delegator base,
     *      node stake, total stake, and the position's `raw`/`rewards`
     *      all stay put until `finalizeWithdrawal`. This differs from
     *      the V8 `Staking.requestWithdrawal` path which decrements at
     *      request time; the V10 scope intentionally keeps the stake
     *      "earning" through the delay window.
     */
    function createWithdrawal(
        address staker,
        uint256 tokenId,
        uint96 amount
    ) external onlyConvictionNFT {
        staker; // unused — see NatSpec.

        if (amount == 0) revert ZeroAmount();

        ConvictionStakingStorage.Position memory pos = convictionStorage.getPosition(tokenId);
        if (pos.raw == 0 && pos.rewards == 0) revert PositionNotFound();

        // Withdrawable:
        //   pre-expiry  : rewards only (raw is locked)
        //   post-expiry : raw + rewards (full drain allowed)
        // `currentEpoch > pos.expiryEpoch` is the strict "lock elapsed"
        // check — it matches the roadmap's "post-expiry" phrasing and the
        // relock gate above.
        uint256 currentEpoch = chronos.getCurrentEpoch();
        uint256 withdrawable = uint256(pos.rewards);
        if (currentEpoch > pos.expiryEpoch) {
            withdrawable += uint256(pos.raw);
        }
        if (uint256(amount) > withdrawable) revert InsufficientWithdrawable();

        // One pending withdrawal at a time per NFT.
        bytes32 delegatorKey = bytes32(tokenId);
        (uint96 existingAmount, , ) = stakingStorage.getDelegatorWithdrawalRequest(
            pos.identityId,
            delegatorKey
        );
        if (existingAmount != 0) revert WithdrawalAlreadyRequested();

        uint256 releaseAt = block.timestamp + WITHDRAWAL_DELAY;
        stakingStorage.createDelegatorWithdrawalRequest(
            pos.identityId,
            delegatorKey,
            amount,
            0,
            releaseAt
        );

        emit WithdrawalCreated(tokenId, amount, uint64(releaseAt));
    }

    /**
     * @notice Cancel a pending withdrawal before the delay elapses. Returns
     *         the position to its pre-`createWithdrawal` state — the stake
     *         side never moved, so the only work here is clearing the
     *         withdrawal request slot.
     *
     * @dev `cancelWithdrawal` is the inverse of `createWithdrawal` and is
     *      similarly stake-mutation-free. The position's raw / rewards /
     *      effective-stake bookkeeping is never touched during the
     *      create→cancel or create→finalize paths until the final
     *      finalize step, so cancel has nothing to re-stake.
     *
     *      Reverts:
     *        - `PositionNotFound` if `pos.identityId == 0`. Defense-in-
     *          depth against a direct path that bypasses the NFT
     *          wrapper's `ownerOf` check.
     *        - `WithdrawalNotRequested` if no pending request exists for
     *          this tokenId.
     */
    function cancelWithdrawal(
        address staker,
        uint256 tokenId
    ) external onlyConvictionNFT {
        staker; // unused — see NatSpec above.

        ConvictionStakingStorage.Position memory pos = convictionStorage.getPosition(tokenId);
        // `identityId != 0` is the Phase 5 existence sentinel. A rewards-only
        // position (raw == 0 after a prior partial finalize) is still valid
        // here — the withdrawal state machine must let the user cancel any
        // pending request regardless of the raw bucket's balance.
        if (pos.identityId == 0) revert PositionNotFound();

        bytes32 delegatorKey = bytes32(tokenId);
        (uint96 existingAmount, , ) = stakingStorage.getDelegatorWithdrawalRequest(
            pos.identityId,
            delegatorKey
        );
        if (existingAmount == 0) revert WithdrawalNotRequested();

        stakingStorage.deleteDelegatorWithdrawalRequest(pos.identityId, delegatorKey);

        emit WithdrawalCancelled(tokenId);
    }

    /**
     * @notice After `WITHDRAWAL_DELAY` has elapsed, drain the requested
     *         amount from the position (rewards bucket first, then raw)
     *         and transfer TRAC back to `staker`. Burns the NFT if the
     *         position is fully drained.
     * @param staker   Original NFT owner / caller. The NFT wrapper passes
     *                 `msg.sender` directly — we trust it because the
     *                 `ownerOf(tokenId) == msg.sender` check already ran.
     * @param tokenId  Target position.
     *
     * @dev Flow:
     *        1. Read position; `pos.identityId == 0` → `PositionNotFound`.
     *        2. Read withdrawal request; `amount == 0` →
     *           `WithdrawalNotRequested`. `block.timestamp < releaseAt` →
     *           `WithdrawalDelayPending`.
     *        3. Settle delegator score indices at `currentEpoch` BEFORE
     *           mutating any effective-stake state. Mirrors the stake /
     *           relock / redelegate pattern.
     *        4. Compute split: drain rewards first, then raw.
     *              rewardsDraw = min(reqAmount, pos.rewards)
     *              rawDraw     = reqAmount - rewardsDraw
     *        5. Forward the bucket decrements to ConvictionStakingStorage.
     *           Each storage mutator owns its own effective-stake diff
     *           propagation (decreaseRewards subtracts amount at 1x,
     *           decreaseRaw subtracts amount*multiplier pre-expiry and
     *           flat post-expiry, plus the expiry-delta shrink).
     *        6. Update `StakingStorage` delegator base, node stake, and
     *           total stake. The delegator base tracks `raw + rewards`
     *           (see the critical decision note below) so the post-write
     *           value is `(pos.raw + pos.rewards) - reqAmount`.
     *        7. Transfer TRAC from the StakingStorage vault to `staker`.
     *        8. Delete the withdrawal request slot.
     *        9. Sharding-table maintenance: if `nodeStake` dropped below
     *           `minimumStake` and the node was previously in the
     *           sharding table, remove it. Mirror of the V8
     *           `_removeNodeFromShardingTable` helper and the redelegate
     *           pattern in this contract.
     *       10. `Ask.recalculateActiveSet()` — the per-node stake delta
     *           may have shifted the active-set composition.
     *       11. Emit `WithdrawalFinalized(tokenId, rawDraw, rewardsDraw)`.
     *
     *      **No call to `ConvictionStakingStorage.deletePosition` on full
     *      drain**: the split-bucket mutators `decreaseRaw` /
     *      `decreaseRewards` handle the effective-stake diff on their own,
     *      and `deletePosition` requires `pos.raw > 0` (it cannot be
     *      called after a decreaseRaw that zeroed the principal). The
     *      final state `raw==0, rewards==0, identityId!=0` is
     *      functionally equivalent to deleted for the NFT layer's
     *      burn-on-drain check — `DKGStakingConvictionNFT.finalizeWithdrawal`
     *      reads `getPosition(tokenId)` and burns when both buckets are
     *      zero, and no caller can reach the struct through the wrapper
     *      once the NFT is burned. Leaving the dormant fields
     *      (`lockEpochs`, `expiryEpoch`, `multiplier18`, `lastClaimedEpoch`)
     *      in place is harmless because they are never read without a
     *      corresponding NFT ownership check.
     *
     *      **Critical design decision: delegator base composition.**
     *      `StakingStorage.delegatorStakeBase(id, bytes32(tokenId))`
     *      tracks `raw + rewards` (the full composite per-delegator
     *      balance), NOT `raw` alone. Precedent: Phase 4
     *      `StakingV10.redelegate` writes
     *      `setDelegatorStakeBase(newId, key, pos.raw + pos.rewards)` on
     *      the destination bucket — a future SV10-claim must also
     *      compound rewards into this base to stay consistent with the
     *      redelegate precedent. Phase 4 `stake()` only ever writes the
     *      principal (`amount`) because rewards are always zero at mint.
     *      This finalize computes `newBase = (pos.raw + pos.rewards) -
     *      reqAmount`, then `setDelegatorStakeBase(newBase)` to let
     *      `_updateDelegatorActivity` handle the active→inactive
     *      transition (removes the key from `delegatorNodes` on zero).
     */
    function finalizeWithdrawal(
        address staker,
        uint256 tokenId
    ) external onlyConvictionNFT {
        ConvictionStakingStorage.Position memory pos = convictionStorage.getPosition(tokenId);
        if (pos.identityId == 0) revert PositionNotFound();

        bytes32 delegatorKey = bytes32(tokenId);
        (uint96 reqAmount, , uint256 releaseAt) = stakingStorage.getDelegatorWithdrawalRequest(
            pos.identityId,
            delegatorKey
        );
        if (reqAmount == 0) revert WithdrawalNotRequested();
        if (block.timestamp < releaseAt) revert WithdrawalDelayPending();

        // 1. Settle score-per-stake indices at `currentEpoch` BEFORE mutating
        //    effective-stake state. Same pattern as stake/relock/redelegate.
        //    `prepareForStakeChange` is `onlyContracts` — StakingV10 is
        //    Hub-registered so the call is authorized.
        uint256 currentEpoch = chronos.getCurrentEpoch();
        staking.prepareForStakeChange(currentEpoch, pos.identityId, delegatorKey);

        // 2. Compute split: drain rewards first, raw for the remainder.
        //    `rewardsDraw` is capped at `pos.rewards`; `rawDraw` is always
        //    `reqAmount - rewardsDraw` which is ≤ pos.raw by the earlier
        //    withdrawable check in `createWithdrawal` (post-expiry check
        //    bounds reqAmount to pos.raw+pos.rewards; pre-expiry bounds it
        //    to pos.rewards, which makes rawDraw == 0 here).
        uint96 rewardsDraw = reqAmount <= pos.rewards ? reqAmount : pos.rewards;
        uint96 rawDraw = reqAmount - rewardsDraw;

        // 3. Decrement ConvictionStakingStorage buckets. Each storage
        //    mutator owns its own effective-stake diff — rewards at 1x,
        //    raw at (stillBoosted ? multiplier : 1x) plus the
        //    pending-expiry-delta shrink. Call sites guard on `amount > 0`
        //    so a zero-value call is a no-op (emits a zero-amount event
        //    and returns) — we preserve the same safety by gating here.
        ConvictionStakingStorage cs = convictionStorage;
        if (rewardsDraw > 0) cs.decreaseRewards(tokenId, rewardsDraw);
        if (rawDraw > 0) cs.decreaseRaw(tokenId, rawDraw);

        // 4. Decrement StakingStorage delegator base, node stake, total.
        //    See NatSpec "delegator base composition" note — base tracks
        //    raw + rewards. Writing 0 here triggers
        //    `_updateDelegatorActivity(wasActive=true, isActive=false)`
        //    which removes the delegator key from `delegatorNodes[key]`
        //    and decrements the node's delegator count.
        StakingStorage ss = stakingStorage;
        uint96 newBase = (pos.raw + pos.rewards) - reqAmount;
        ss.setDelegatorStakeBase(pos.identityId, delegatorKey, newBase);
        ss.decreaseNodeStake(pos.identityId, reqAmount);
        ss.decreaseTotalStake(reqAmount);

        // 5. Transfer TRAC from the StakingStorage vault to the NFT owner.
        //    The V8 Staking.finalizeWithdrawal uses the same vault path.
        ss.transferStake(staker, reqAmount);

        // 6. Delete the withdrawal request slot — the request is now
        //    satisfied and the NFT is free to arm a new one (if the
        //    position still has raw or rewards to drain).
        ss.deleteDelegatorWithdrawalRequest(pos.identityId, delegatorKey);

        // 7. Sharding-table maintenance. If the node's stake dropped below
        //    `minimumStake`, it must be removed. Matches the V8
        //    `_removeNodeFromShardingTable` pattern and the redelegate
        //    logic in this contract.
        uint96 newNodeStake = ss.getNodeStake(pos.identityId);
        if (
            shardingTableStorage.nodeExists(pos.identityId) &&
            newNodeStake < parametersStorage.minimumStake()
        ) {
            shardingTable.removeNode(pos.identityId);
        }

        // 8. Active-set recalculation — the per-node stake delta may have
        //    shifted the active set composition.
        ask.recalculateActiveSet();

        emit WithdrawalFinalized(tokenId, rawDraw, rewardsDraw);
    }

    /**
     * @notice Walk unclaimed epochs for the position, accumulate reward,
     *         and bank it into the `ConvictionStakingStorage` rewards
     *         bucket via `increaseRewards`. Updates `lastClaimedEpoch`.
     * @param staker   Original NFT owner / caller (unused in the body —
     *                 ownership is enforced at `DKGStakingConvictionNFT.claim`
     *                 via `ownerOf` before this function is ever reached;
     *                 kept in the signature so every `onlyConvictionNFT`
     *                 entry point shares the same call shape).
     * @param tokenId  Target position.
     *
     * @dev Flow (auto-compound into the `rewards` bucket — no wallet transfer):
     *        1. Read position; `identityId == 0` → `PositionNotFound`
     *           (defense-in-depth; the NFT wrapper's `ownerOf` check
     *           already rejects un-minted tokenIds).
     *        2. Compute the claim window `[pos.lastClaimedEpoch + 1
     *           .. currentEpoch - 1]`. If empty (fresh position or
     *           genesis `currentEpoch <= 1`), return as a no-op — no
     *           emit, no storage writes.
     *        3. Settle the delegator's score index at `currentEpoch`
     *           BEFORE we mutate any stake base. This mirrors the
     *           `stake` / `relock` / `redelegate` / `finalizeWithdrawal`
     *           pattern and is required because we are about to call
     *           `setDelegatorStakeBase` which changes the score-earning
     *           base from `raw + rewardsOld` to `raw + rewardsNew`.
     *        4. Walk the window and accumulate reward. Per-epoch
     *           effective stake:
     *              e <  expiryEpoch → raw*mult18/1e18 + rewardsSnapshot
     *              e >= expiryEpoch → raw + rewardsSnapshot
     *           `rewardsSnapshot` is `pos.rewards` captured once before
     *           the walk — matching the spec's semantics of "the
     *           compounded rewards value at the time of claim".
     *        5. Per-epoch reward:
     *              reward_e = effStake_e * nodeEpochScorePerStake[e] / 1e18
     *           scale matches V8 `_prepareForStakeChange`
     *           (`scoreEarned18 = stakeBase * scorePerStakeDiff36 / SCALE18`).
     *           In the V8 address-keyed path the score is further converted
     *           to TRAC via `reward = delegatorScore18 * netNodeRewards /
     *           nodeScore18` — that conversion lives in Phase 11, which will
     *           replace this formula with the actual Paymaster flow. Phase 5
     *           treats the score-weighted effective stake as the reward TRAC
     *           stub so the claim bookkeeping path can be unit-tested end-to-end.
     *        6. If the window produced zero reward (all scores were zero or
     *           the Paymaster was empty), advance `lastClaimedEpoch` to
     *           skip the walk on the next call but emit nothing and skip
     *           the node/total stake mutation.
     *        7. Otherwise: `increaseRewards` + `setDelegatorStakeBase` to
     *           `raw + rewardsNew` (per the Phase 5 decision that the
     *           delegator base tracks the composite, mirroring the
     *           `redelegate` / `finalizeWithdrawal` precedent) + per-node
     *           and global `increaseNodeStake` / `increaseTotalStake` +
     *           `setLastClaimedEpoch` + emit `RewardsClaimed`.
     *
     *      **TRAC source — Phase 11.** Phase 5 `claim` does NOT pull TRAC
     *      from any external source. The StakingStorage vault must be
     *      pre-funded with the reward TRAC by Phase 11's Paymaster /
     *      EpochStorage integration; unit tests simulate this by calling
     *      `Token.mint(stakingStorage, rewardTotal)` before `claim`. If
     *      the vault is under-funded, `increaseNodeStake` +
     *      `increaseTotalStake` still succeed (they are pure accounting
     *      mutations), but a later `finalizeWithdrawal` would revert on
     *      the `transferStake` underflow. It is Phase 11's responsibility
     *      to keep the vault funded in step with reward accrual.
     */
    function claim(
        address staker,
        uint256 tokenId
    ) external onlyConvictionNFT {
        staker; // unused — see NatSpec. Kept in the signature so every
                // `onlyConvictionNFT` entry point shares the same call
                // shape from the NFT wrapper.

        ConvictionStakingStorage.Position memory pos = convictionStorage.getPosition(tokenId);
        if (pos.identityId == 0) revert PositionNotFound();

        uint256 currentEpoch = chronos.getCurrentEpoch();
        // Genesis guard: Chronos floors `getCurrentEpoch()` at 1, so
        // `currentEpoch - 1 == 0` on the very first epoch. The claim
        // window `[last+1 .. 0]` is empty but we underflow-guard first
        // to keep the subtraction below safe.
        if (currentEpoch <= 1) return;

        uint256 claimFromEpoch = uint256(pos.lastClaimedEpoch) + 1;
        uint256 claimToEpoch = currentEpoch - 1;
        if (claimFromEpoch > claimToEpoch) return; // nothing to claim — no-op

        // Settle the delegator's score-per-stake index at `currentEpoch`
        // BEFORE mutating any stake base. Without this, a subsequent V8-
        // style reward claim at the same (identityId, delegatorKey) would
        // read `lastSettledScorePerStake` against a stale base and collect
        // score that belongs to the pre-compound delegation. Matches the
        // stake / relock / redelegate / finalizeWithdrawal pattern in this
        // contract — `prepareForStakeChange` is `external onlyContracts`
        // on the V8 `Staking` contract and StakingV10 is Hub-registered.
        bytes32 delegatorKey = bytes32(tokenId);
        staking.prepareForStakeChange(currentEpoch, pos.identityId, delegatorKey);

        // Local cache to avoid repeated SLOAD in the walk loop.
        uint256 raw = uint256(pos.raw);
        uint256 mult18 = uint256(pos.multiplier18);
        uint256 rewardsSnapshot = uint256(pos.rewards);
        uint256 expiryEpoch = uint256(pos.expiryEpoch);
        uint72 identityId = pos.identityId;

        uint256 rewardTotal = 0;
        for (uint256 e = claimFromEpoch; e <= claimToEpoch; e++) {
            // Per-epoch effective stake.
            // Pre-expiry: raw earns its multiplier, rewards earn 1x.
            // Post-expiry (e >= expiryEpoch): raw earns 1x, rewards earn 1x.
            // `expiryEpoch == 0` (lock-0 rest state) falls straight into the
            // post-expiry branch on the first epoch.
            uint256 effStake;
            if (expiryEpoch != 0 && e < expiryEpoch) {
                effStake = (raw * mult18) / SCALE18 + rewardsSnapshot;
            } else {
                effStake = raw + rewardsSnapshot;
            }

            // Per-epoch score-per-stake from RandomSamplingStorage.
            // `nodeEpochScorePerStake[e][identityId]` is stored at 1e36
            // scale (score18 * SCALE18 / totalNodeStake_wei — see
            // `RandomSampling.submitProof` at `:273`). Dividing by 1e18
            // gives a 1e18-scaled score value matching V8's
            // `_prepareForStakeChange` dimensional output:
            //   scoreEarned18 = stakeBase * scorePerStakeDiff36 / SCALE18
            // In the V8 reward path this `scoreEarned18` is further
            // converted to TRAC via `reward = delegatorScore18 *
            // netNodeRewards / nodeScore18`, where netNodeRewards comes
            // from `epochStorage.getEpochPool(...) * nodeScore18 /
            // allNodesScore18 - operatorFee`. That conversion is Phase 11's
            // responsibility; Phase 5 treats the 1e18-scaled score as the
            // reward TRAC stub so the claim bookkeeping can be exercised
            // end-to-end under unit test.
            //
            // NOTE: Unlike a "cumulative index" design, V8's
            // `nodeEpochScorePerStake` is PER-EPOCH — each epoch's value
            // is the score-per-stake accrued within that epoch alone. No
            // `[e] - [e-1]` subtraction is needed (or correct).
            uint256 scorePerStake36 = randomSamplingStorage.getNodeEpochScorePerStake(
                e,
                identityId
            );

            rewardTotal += (effStake * scorePerStake36) / SCALE18;
        }

        if (rewardTotal == 0) {
            // No-reward window — still advance `lastClaimedEpoch` so the
            // next claim doesn't redo the (cold, but potentially long)
            // walk. No event, no stake mutation: this is not an economic
            // event, just a cursor advance.
            convictionStorage.setLastClaimedEpoch(tokenId, uint64(claimToEpoch));
            return;
        }

        // 1. Bank the reward into the split-bucket rewards accumulator.
        //    `increaseRewards` updates `pos.rewards` and the conviction-layer
        //    effective-stake diff at `currentEpoch` (rewards always contribute
        //    at 1x, no expiry delta).
        convictionStorage.increaseRewards(tokenId, uint96(rewardTotal));

        // 2. Update the `StakingStorage` delegator base to reflect the
        //    composite `raw + rewardsNew`. Phase 5 decision (withdrawal
        //    precedent): the delegator base tracks the full composite
        //    per-delegator balance, not raw alone. The pre-claim base was
        //    `raw + rewardsOld`, so we can write
        //    `raw + rewardsOld + rewardTotal = raw + rewardsNew`. Using
        //    `setDelegatorStakeBase` (not `increaseDelegatorStakeBase`)
        //    keeps the write shape symmetric with the withdrawal path
        //    that shrinks the base.
        uint96 newBase = uint96(raw + rewardsSnapshot + rewardTotal);
        stakingStorage.setDelegatorStakeBase(identityId, delegatorKey, newBase);

        // 3. Node + total stake increments. These track the full
        //    composite delegator balance, mirroring the V8
        //    `claimDelegatorRewards` restake path (Staking.sol:630-632).
        stakingStorage.increaseNodeStake(identityId, uint96(rewardTotal));
        stakingStorage.increaseTotalStake(uint96(rewardTotal));

        // 4. Advance the position's claim cursor to the walked boundary so
        //    subsequent calls in the same epoch are pure no-ops.
        convictionStorage.setLastClaimedEpoch(tokenId, uint64(claimToEpoch));

        // TODO(Phase 11): transfer `rewardTotal` TRAC from Paymaster /
        // EpochStorage into the StakingStorage vault. Phase 5 assumes the
        // TRAC is already in the vault (via Phase 11's reward flow on
        // mainnet, or via `Token.mint(stakingStorage, amount)` in unit
        // tests). Claim bookkeeping does NOT revert on an under-funded
        // vault — it is Phase 11's responsibility to keep the vault
        // funded in step with reward accrual, and a later
        // `finalizeWithdrawal` would surface the discrepancy as a
        // `transferStake` underflow.

        emit RewardsClaimed(tokenId, uint96(rewardTotal));
    }

    /**
     * @notice Atomic V8 → V10 migration. Drains the caller's V8 address-keyed
     *         delegation on `identityId` and creates a fresh V10 NFT-backed
     *         position at the specified `lockEpochs` tier on the same node.
     *         The NFT itself is already minted by the wrapper before this
     *         function is reached.
     * @param staker      Original NFT owner / caller (the V8 delegator).
     * @param tokenId     Fresh NFT token id minted by the wrapper.
     * @param identityId  V8 node the delegator is migrating off of.
     * @param lockEpochs  New V10 conviction tier. Valid set: {0,1,3,6,12}.
     *                    Tier 0 is the permanent rest state (1x) — a
     *                    legitimate migration target for users who do not
     *                    want to commit to a lock but still want the NFT-
     *                    based position model.
     *
     * @dev 7-step atomic migration (V10_CONTRACTS_REDESIGN_v2.md:343-352):
     *
     *        1. Precondition check: V8 rolling rewards == 0 AND
     *           `lastClaimedEpoch >= currentEpoch - 1`. The Phase 5 scope
     *           intentionally keeps StakingV10 out of the V8 reward-
     *           distribution path: the user must run
     *           `Staking.claimDelegatorRewards` for every unclaimed epoch
     *           BEFORE invoking convertToNFT. Otherwise we would need to
     *           fold the pending rolling rewards into the V10 position's
     *           raw bucket, which drags the V10 reward math into V8's
     *           `netNodeEpochRewards` / `allNodesScore18` territory. Off
     *           limits for Phase 5.
     *
     *        2. Settle V8 indices at current epoch for the V8
     *           `keccak256(abi.encodePacked(staker))` key. This baselines
     *           the V8 delegator score cursor so any still-outstanding
     *           per-epoch score (settled but not yet distributed) is
     *           captured against the V8 key, not silently inherited by
     *           the V10 key.
     *
     *        3. Read V8 amount. `amount == 0` → `NoV8StakeToConvert`.
     *           Distinct from the precondition check: a user who never
     *           delegated on this node trivially has
     *           `lastClaimedEpoch == 0 >= currentEpoch - 1` at currentEpoch
     *           == 1, so the rolling-rewards check would pass but there's
     *           nothing to migrate. The custom error lets the UI surface
     *           "you have nothing to migrate" instead of a generic "V8
     *           stake not claimed" message.
     *
     *        4. Zero V8 key + decrement node/total/DelegatorsInfo.
     *           `setDelegatorStakeBase(id, v8Key, 0)` triggers
     *           `_updateDelegatorActivity(wasActive=true, isActive=false)`
     *           which removes the V8 key from `delegatorNodes[v8Key]` and
     *           decrements the node's `delegatorCount`. We then call
     *           `decreaseNodeStake` + `decreaseTotalStake` to remove the
     *           amount from the per-node and global counters — these will
     *           be re-added in step 6 so the net migration is zero, but
     *           the intermediate symmetry keeps the stake accounting
     *           invariants tight and matches the V8 `requestWithdrawal`
     *           pattern (decrement on leave, re-increment on re-join).
     *           `delegatorsInfo.removeDelegator(id, staker)` clears the
     *           V8 delegator set entry; the V8 path's
     *           `_handleDelegatorRemovalOnZeroStake` does the same when a
     *           delegator fully withdraws mid-epoch.
     *
     *        5. NFT already minted by the wrapper before this call — no
     *           action required here.
     *
     *        6. Create V10 position:
     *              - `staking.prepareForStakeChange(currentEpoch, id,
     *                bytes32(tokenId))` — baseline the fresh V10 key at
     *                the node's current score-per-stake index. Required
     *                even on a zero-stake key so a later
     *                `claim()` doesn't collect score that the node earned
     *                before the V10 position existed.
     *              - `setDelegatorStakeBase(id, bytes32(tokenId), amount)`
     *                writes the V10 key with the migrated amount.
     *              - `increaseNodeStake` + `increaseTotalStake` re-add the
     *                amount. Net change vs. pre-convert state: zero.
     *              - `convictionStorage.expectedMultiplier18(lockEpochs)`
     *                validates the tier (reverts "Invalid lock" on an
     *                out-of-set tier) and returns the canonical multiplier.
     *                This is the ONLY tier check in this function — the
     *                NFT wrapper's `_convictionMultiplier` already
     *                rejects tier 2, 4, etc. at the entry layer.
     *              - `convictionStorage.createPosition(tokenId, id, amount,
     *                lockEpochs, multiplier18)` writes the V10 position.
     *                Note that `createPosition` accepts `lockEpochs == 0`
     *                as the permanent rest state, so a migration at the
     *                "no lockup" tier is a legitimate flow (users who
     *                want the NFT model without committing to a lock).
     *
     *        7. `ask.recalculateActiveSet()` — the node stake delta is
     *           ZERO (V8 amount out, V10 amount in), so the sharding table
     *           never shifts (a node that was above `minimumStake` stays
     *           above, a node below stays below). No
     *           `shardingTable.insertNode` / `removeNode` call needed.
     *           The `ask` recalc is kept for symmetry with the other
     *           entry points (it's cheap — a single storage read on an
     *           empty active-set change).
     *
     *      Emits `ConvertedFromV8(staker, tokenId, identityId, amount,
     *      lockEpochs)` — off-chain indexers observe the migration as a
     *      single event on the StakingV10 layer; the wrapper also emits
     *      its own layer-local `ConvertedFromV8` for NFT-only watchers.
     */
    function convertToNFT(
        address staker,
        uint256 tokenId,
        uint72 identityId,
        uint8 lockEpochs
    ) external onlyConvictionNFT {
        uint256 currentEpoch = chronos.getCurrentEpoch();

        // 1. Precondition: V8 rolling rewards must be 0 AND V8
        //    `lastClaimedEpoch >= currentEpoch - 1`. On the very first
        //    epoch (`currentEpoch == 1`), the second branch reduces to
        //    `lastClaimedEpoch >= 0` which is trivially true (the slot
        //    defaults to 0). For `currentEpoch > 1` the user must have run
        //    `Staking.claimDelegatorRewards` for every epoch up to
        //    `currentEpoch - 1` before migrating.
        //
        //    We check rolling rewards first — that branch is the one a
        //    mid-epoch user is most likely to trip (claim loop produces
        //    non-zero rolling rewards mid-walk and clears it on the final
        //    settle). The `lastClaimedEpoch` check catches users who
        //    forgot to run claim at all.
        if (delegatorsInfo.getDelegatorRollingRewards(identityId, staker) != 0) {
            revert V8StakeNotFullyClaimed();
        }
        if (currentEpoch > 1) {
            uint256 lastClaimed = delegatorsInfo.getLastClaimedEpoch(identityId, staker);
            if (lastClaimed < currentEpoch - 1) {
                revert V8StakeNotFullyClaimed();
            }
        }

        // 2. Settle V8 indices at current epoch for the V8 address-keyed
        //    delegator. Must be called BEFORE the V8 bucket is drained —
        //    the score cursor is keyed on the stake base AT the moment of
        //    the call and zeroing the base first would leave the cursor
        //    stuck at the pre-migration baseline.
        bytes32 v8Key = keccak256(abi.encodePacked(staker));
        staking.prepareForStakeChange(currentEpoch, identityId, v8Key);

        // 3. Read V8 amount. Revert if there's nothing to migrate. This
        //    check runs AFTER the precondition so a user who has both
        //    outstanding rolling rewards AND zero stake still gets the
        //    `V8StakeNotFullyClaimed` error (the roll-up rewards slot
        //    protects against a mis-indexed delegator record).
        StakingStorage ss = stakingStorage;
        uint96 amount = ss.getDelegatorStakeBase(identityId, v8Key);
        if (amount == 0) revert NoV8StakeToConvert();

        // 4. Zero the V8 key + decrement node/total + clear DelegatorsInfo.
        //    Writing 0 on the V8 bucket triggers
        //    `_updateDelegatorActivity(wasActive=true, isActive=false)`
        //    which removes the V8 key from `delegatorNodes[v8Key]` and
        //    decrements the node's delegator count. The
        //    `delegatorsInfo.removeDelegator` call mirrors the V8
        //    `_handleDelegatorRemovalOnZeroStake` bookkeeping in
        //    `Staking.sol:884-898`.
        ss.setDelegatorStakeBase(identityId, v8Key, 0);
        ss.decreaseNodeStake(identityId, amount);
        ss.decreaseTotalStake(amount);
        delegatorsInfo.removeDelegator(identityId, staker);

        // 5. NFT already minted by the wrapper. Nothing to do here.

        // 6. Create the V10 position. Tier validation is folded into
        //    `expectedMultiplier18` — reverts "Invalid lock" for anything
        //    outside the {0,1,3,6,12} set. `createPosition` itself re-
        //    validates via `multiplier18 == expectedMultiplier18(lockEpochs)`,
        //    so the tier mismatch surface is double-covered.
        //
        //    For `lockEpochs == 0`, `createPosition` writes
        //    `expiryEpoch = 0` (permanent rest state) and the multiplier
        //    is 1x — this is a valid migration target for users who
        //    don't want to commit to a lock tier but still want the
        //    NFT-backed model.
        bytes32 v10Key = bytes32(tokenId);
        staking.prepareForStakeChange(currentEpoch, identityId, v10Key);

        ss.setDelegatorStakeBase(identityId, v10Key, amount);
        ss.increaseNodeStake(identityId, amount);
        ss.increaseTotalStake(amount);

        uint64 multiplier18 = convictionStorage.expectedMultiplier18(uint40(lockEpochs));
        convictionStorage.createPosition(
            tokenId,
            identityId,
            amount,
            uint40(lockEpochs),
            multiplier18
        );

        // 7. Ask recalculation. Node stake delta is zero so the sharding
        //    table composition is unchanged and no insert/remove is
        //    needed, but the recalc is kept for symmetry with the other
        //    entry points (`stake` / `redelegate` / `finalizeWithdrawal`
        //    all call it) — a cheap no-op that keeps the call graph
        //    uniform across all eight V10 entry points.
        ask.recalculateActiveSet();

        emit ConvertedFromV8(staker, tokenId, identityId, amount, lockEpochs);
    }
}
