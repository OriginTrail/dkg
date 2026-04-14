// SPDX-License-Identifier: Apache-2.0

pragma solidity ^0.8.20;

import {INamed} from "./interfaces/INamed.sol";
import {IVersioned} from "./interfaces/IVersioned.sol";
import {IInitializable} from "./interfaces/IInitializable.sol";
import {IStaking} from "./interfaces/IStaking.sol";
import {ContractStatus} from "./abstract/ContractStatus.sol";
import {Ask} from "./Ask.sol";
import {ShardingTable} from "./ShardingTable.sol";
import {ShardingTableStorage} from "./storage/ShardingTableStorage.sol";
import {StakingStorage} from "./storage/StakingStorage.sol";
import {ConvictionStakingStorage} from "./storage/ConvictionStakingStorage.sol";
import {DelegatorsInfo} from "./storage/DelegatorsInfo.sol";
import {ParametersStorage} from "./storage/ParametersStorage.sol";
import {ProfileStorage} from "./storage/ProfileStorage.sol";
import {RandomSamplingStorage} from "./storage/RandomSamplingStorage.sol";
import {Chronos} from "./storage/Chronos.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC721Enumerable} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721Enumerable.sol";

/**
 * @title DKGStakingConvictionNFT
 * @notice Wraps V10 DKG staking positions as transferable ERC-721 NFTs.
 *
 * Each NFT represents a staking position on a specific node with a discrete
 * conviction lock tier (1, 3, 6, or 12 epochs → 1.5x/2.0x/3.5x/6.0x boost).
 * The position can be transferred to another address (accrued-interest
 * transfer model — the new owner inherits both the raw stake and any
 * unclaimed rewards; see `_update` below).
 *
 * @dev V10 two-layer staking wire: this contract orchestrates the
 *      user-facing API (`createConviction`, `relock`, `redelegate`,
 *      `requestWithdrawal`, `processWithdrawal`, `claimRewards`,
 *      `convertToNFT`) and delegates authoritative storage writes to:
 *        - `Staking._recordStake` for the NFT-mint stake path (Phase 4),
 *        - `StakingStorage` direct calls for redelegate / withdrawal teardown,
 *        - `ConvictionStakingStorage` for position bookkeeping + effective
 *          stake diff accounting.
 *      TRAC never sits in this contract: at `createConviction` it flows
 *      user → StakingStorage in one hop; at `processWithdrawal` it flows
 *      StakingStorage → user via `StakingStorage.transferStake`.
 *
 *      Phase 5 scaffold: constructor, initialize, Hub wiring, tier table,
 *      and `_update` override are live; the seven external entry points
 *      are stubbed as `revert("NotImplemented")` and will be filled in
 *      by S2–S7.
 */
contract DKGStakingConvictionNFT is INamed, IVersioned, ContractStatus, IInitializable, ERC721Enumerable {
    string private constant _NAME = "DKGStakingConvictionNFT";
    string private constant _VERSION = "1.0.0";

    // ========================================================================
    // Constants
    // ========================================================================

    /// @notice 1e18 fixed-point scale shared with `ConvictionStakingStorage`
    ///         and `Staking.convictionMultiplier`. Tier table and reward
    ///         math all use this scale.
    uint256 public constant SCALE18 = 1e18;

    /// @notice Time between `requestWithdrawal` and `processWithdrawal`.
    ///         Hardcoded at 15 days per Q6 of the Phase 5 decisions — NOT
    ///         sourced from `ParametersStorage.stakeWithdrawalDelay` (that
    ///         parameter governs the V8 legacy address-keyed path).
    uint256 public constant WITHDRAWAL_DELAY = 15 days;

    // ========================================================================
    // Hub-wired dependencies
    // ========================================================================

    IStaking public stakingContract;
    StakingStorage public stakingStorage;
    ConvictionStakingStorage public convictionStakingStorage;
    DelegatorsInfo public delegatorsInfo;
    Chronos public chronos;
    RandomSamplingStorage public randomSamplingStorage;
    ShardingTableStorage public shardingTableStorage;
    ShardingTable public shardingTableContract;
    Ask public askContract;
    ParametersStorage public parametersStorage;
    ProfileStorage public profileStorage;
    IERC20 public tokenContract;

    // ========================================================================
    // Storage
    // ========================================================================

    /// @notice Monotonic token id counter. First mint is tokenId 0 (no
    ///         sentinel reservation — `ownerOf(0)` reverts before mint, and
    ///         every consumer keys on `positions[tokenId].raw > 0` as the
    ///         liveness check).
    uint256 public nextTokenId;

    // ========================================================================
    // Events
    // ========================================================================

    /// @notice Emitted by `createConviction` and `convertToNFT` after the
    ///         position is fully registered in `ConvictionStakingStorage`
    ///         and `Staking._recordStake` has run.
    event PositionCreated(
        uint256 indexed tokenId,
        address indexed owner,
        uint72 indexed identityId,
        uint96 amount,
        uint8 lockEpochs
    );

    /// @notice Emitted by `relock` after a post-expiry re-commit to a new
    ///         tier. `raw` is unchanged — only multiplier and expiry shift.
    event PositionRelocked(uint256 indexed tokenId, uint8 newLockEpochs);

    /// @notice Emitted by `redelegate`. Global totals are invariant; only
    ///         per-node effective stake moves.
    event PositionRedelegated(
        uint256 indexed tokenId,
        uint72 indexed oldIdentityId,
        uint72 indexed newIdentityId
    );

    /// @notice Emitted by `requestWithdrawal` when the 15-day delay timer
    ///         starts. `releaseAt` is a Unix timestamp.
    event WithdrawalRequested(uint256 indexed tokenId, uint256 releaseAt);

    /// @notice Emitted by `processWithdrawal` after the NFT is burned and
    ///         TRAC is released back to the owner.
    event WithdrawalProcessed(uint256 indexed tokenId, uint96 amount);

    /// @notice Emitted by `claimRewards`. Phase 5 only accrues bookkeeping;
    ///         Phase 11 wires the actual TRAC transfer.
    event RewardsAccrued(uint256 indexed tokenId, uint96 amount);

    /// @notice Emitted by `convertToNFT` when a V8 address-keyed delegation
    ///         is migrated into a V10 NFT-backed position.
    event ConvertedFromV8(
        address indexed delegator,
        uint256 indexed tokenId,
        uint72 indexed identityId,
        uint96 amount
    );

    // ========================================================================
    // Errors
    // ========================================================================

    error InvalidLockEpochs();
    error LockNotExpired();
    error LockStillActive();
    error WithdrawalNotRequested();
    error WithdrawalAlreadyRequested();
    error WithdrawalDelayPending();
    error V8StakeNotFullyClaimed();
    error NotPositionOwner();
    error PositionNotFound();
    error ZeroAmount();
    error ProfileDoesNotExist();
    error SameIdentity();
    error MaxStakeExceeded();

    // ========================================================================
    // Constructor + initialize
    // ========================================================================

    // solhint-disable-next-line no-empty-blocks
    constructor(
        address hubAddress
    ) ContractStatus(hubAddress) ERC721("DKG Staker Conviction", "DKGSC") {}

    function initialize() public onlyHub {
        stakingContract = IStaking(hub.getContractAddress("Staking"));
        stakingStorage = StakingStorage(hub.getContractAddress("StakingStorage"));
        convictionStakingStorage = ConvictionStakingStorage(hub.getContractAddress("ConvictionStakingStorage"));
        delegatorsInfo = DelegatorsInfo(hub.getContractAddress("DelegatorsInfo"));
        chronos = Chronos(hub.getContractAddress("Chronos"));
        randomSamplingStorage = RandomSamplingStorage(hub.getContractAddress("RandomSamplingStorage"));
        shardingTableStorage = ShardingTableStorage(hub.getContractAddress("ShardingTableStorage"));
        shardingTableContract = ShardingTable(hub.getContractAddress("ShardingTable"));
        askContract = Ask(hub.getContractAddress("Ask"));
        parametersStorage = ParametersStorage(hub.getContractAddress("ParametersStorage"));
        profileStorage = ProfileStorage(hub.getContractAddress("ProfileStorage"));
        tokenContract = IERC20(hub.getContractAddress("Token"));
    }

    function name() public pure virtual override(INamed, ERC721) returns (string memory) {
        return _NAME;
    }

    function version() external pure virtual returns (string memory) {
        return _VERSION;
    }

    // ========================================================================
    // Conviction multiplier tier ladder
    // ========================================================================
    //
    // Roadmap-authoritative tier set, per `04_TOKEN_ECONOMICS §4.1`
    // ("no lockup / 1 / 3 / 6 / 12 months"): {0, 1, 3, 6, 12}. After the
    // Phase 5 P2 hotfix (commit `e7528d38`),
    // `ConvictionStakingStorage.expectedMultiplier18` matches this set
    // exactly, so the NFT-side helper and the storage-side tier check
    // are now aligned — `createConviction(_, _, 1)` maps to the 1.5x
    // tier on both sides.
    //
    // Discrete, exact-match tier table — no snap-down semantics. Values
    // that don't land on one of the tiers revert. This is stricter than
    // `Staking.convictionMultiplier` (which uses snap-down `>=` branches):
    // `createConviction` / `convertToNFT` are the only entry points that
    // invoke this function with a user-supplied `lockEpochs`, and any
    // value outside the valid set is an API error that must not round
    // down silently to a lower tier (a user passing 4 silently snapping
    // to tier 3 would commit the user to a different lock than they
    // intended).
    //
    // Why `0 → SCALE18` rather than a revert at the helper level:
    //   The post-expiry rest state in `ConvictionStakingStorage` is
    //   encoded as `lockEpochs == 0 → 1x`, and reward-math callers may
    //   re-invoke this helper with a position's current `lockEpochs`
    //   after expiry has driven the tier back to the rest state. See
    //   Phase 5 decisions doc Q5 for the full reasoning. The
    //   `lockEpochs == 0` *policy* check lives in `createConviction` /
    //   `convertToNFT` themselves — they MUST reject `lockEpochs == 0`
    //   via their own validation, but the helper stays tolerant for
    //   reward-math callers.
    //
    // @param lockEpochs Lock duration in epochs.
    // @return multiplier18 1e18-scaled tier multiplier.
    function _convictionMultiplier(uint256 lockEpochs) internal pure returns (uint256) {
        if (lockEpochs == 0) return SCALE18;             // rest state: 1.0x
        if (lockEpochs == 1) return (15 * SCALE18) / 10; // 1.5x (1 month)
        if (lockEpochs == 3) return 2 * SCALE18;         // 2.0x (3 months)
        if (lockEpochs == 6) return (35 * SCALE18) / 10; // 3.5x (6 months)
        if (lockEpochs == 12) return 6 * SCALE18;        // 6.0x (12 months)
        revert InvalidLockEpochs();
    }

    // ========================================================================
    // Entry points (Phase 5 stubs — S2..S7 fill in)
    // ========================================================================
    //
    // These stubs revert `"NotImplemented"` so the Phase 5 S1 scaffold
    // compiles cleanly and deploys green without committing to a
    // partial behavior. Each is owned by a downstream subagent:
    //
    //   S2 — createConviction (Flow A atomic)
    //   S3 — relock
    //   S4 — redelegate
    //   S5 — requestWithdrawal / processWithdrawal
    //   S6 — claimRewards (stubbed TRAC transfer, Phase 11 finishes it)
    //   S7 — convertToNFT (V8 → V10 migration, 7-step atomic)
    //
    // Do NOT add partial logic here — subagents assume a clean revert
    // surface as their starting point.

    /// @notice S2 — Mint a fresh NFT-backed staking position on `identityId`
    ///         with `amount` TRAC locked for `lockEpochs` epochs.
    /// @dev `pure` stub modifier silences "can be restricted to pure" warning;
    ///      S2 will drop the modifier when wiring up state mutations.
    function createConviction(
        uint72 /* identityId */,
        uint96 /* amount */,
        uint8 /* lockEpochs */
    ) external pure returns (uint256 /* tokenId */) {
        revert("NotImplemented");
    }

    /// @notice S3 — Post-expiry re-commit of an existing position to a new
    ///         lock tier. Raw stake unchanged; multiplier + expiry shift.
    /// @dev `pure` stub modifier — S3 drops it when adding state reads.
    function relock(uint256 /* tokenId */, uint8 /* newLockEpochs */) external pure {
        revert("NotImplemented");
    }

    /// @notice S4 — Move a position from its current node to `newIdentityId`.
    ///         Per-node effective stake moves; global totals invariant.
    /// @dev `pure` stub modifier — S4 drops it when adding state reads.
    function redelegate(uint256 /* tokenId */, uint72 /* newIdentityId */) external pure {
        revert("NotImplemented");
    }

    /// @notice S5 — Start the 15-day withdrawal timer for a post-expiry
    ///         position. Caller must own the NFT.
    /// @dev `pure` stub modifier — S5 drops it when adding state reads.
    function requestWithdrawal(uint256 /* tokenId */) external pure {
        revert("NotImplemented");
    }

    /// @notice S5 — After `WITHDRAWAL_DELAY` has elapsed, refund TRAC to
    ///         the owner and burn the NFT.
    /// @dev `pure` stub modifier — S5 drops it when adding state reads.
    function processWithdrawal(uint256 /* tokenId */) external pure {
        revert("NotImplemented");
    }

    /// @notice S6 — Walk unclaimed epochs, accumulate reward, update
    ///         `lastClaimedEpoch`. Phase 5 accrues bookkeeping only;
    ///         Phase 11 wires the actual TRAC transfer.
    /// @dev `pure` stub modifier — S6 drops it when adding state reads.
    function claimRewards(uint256 /* tokenId */) external pure returns (uint96 /* amount */) {
        revert("NotImplemented");
    }

    /// @notice S7 — Atomic V8 → V10 migration: burn the caller's V8
    ///         address-keyed delegation on `identityId` and mint a fresh
    ///         V10 NFT-backed position at the specified `lockEpochs` tier.
    /// @dev `pure` stub modifier — S7 drops it when adding state mutations.
    function convertToNFT(
        uint72 /* identityId */,
        uint8 /* lockEpochs */
    ) external pure returns (uint256 /* tokenId */) {
        revert("NotImplemented");
    }

    // ========================================================================
    // ERC-721 overrides — accrued-interest transfer model (Phase 5 Q8)
    // ========================================================================
    //
    // Mint/burn/transfer all flow through `_update`. For transfers, we do
    // NOT settle rewards, reset `lastClaimedEpoch`, or touch the position —
    // the NFT carries its unclaimed rewards like a bond with accrued
    // coupon. See `V10_CONTRACTS_REDESIGN_v2.md §"NFT transfer model:
    // accrued-interest"` and the Phase 5 decisions doc Q8.
    //
    // The body is a pure `super._update` pass-through; this explicit
    // override exists to (a) document the intent and (b) satisfy the
    // compiler override requirement for `ERC721Enumerable`.

    function supportsInterface(
        bytes4 interfaceId
    ) public view virtual override(ERC721Enumerable) returns (bool) {
        return super.supportsInterface(interfaceId);
    }

    function _increaseBalance(
        address account,
        uint128 value
    ) internal virtual override(ERC721Enumerable) {
        super._increaseBalance(account, value);
    }

    function _update(
        address to,
        uint256 tokenId,
        address auth
    ) internal virtual override(ERC721Enumerable) returns (address) {
        return super._update(to, tokenId, auth);
    }
}
