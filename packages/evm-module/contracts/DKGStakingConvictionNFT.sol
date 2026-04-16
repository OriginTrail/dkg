// SPDX-License-Identifier: Apache-2.0

pragma solidity ^0.8.20;

import {INamed} from "./interfaces/INamed.sol";
import {IVersioned} from "./interfaces/IVersioned.sol";
import {IInitializable} from "./interfaces/IInitializable.sol";
import {IStaking} from "./interfaces/IStaking.sol";
import {ContractStatus} from "./abstract/ContractStatus.sol";
import {Ask} from "./Ask.sol";
import {ShardingTable} from "./ShardingTable.sol";
import {StakingV10} from "./StakingV10.sol";
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
 * @dev V10 split-contract architecture. This contract is a dumb ERC-721
 *      ownership receipt: it mints/burns tokens, validates ownership on
 *      mutating calls, and forwards every business action to `StakingV10`.
 *      All stake/withdrawal/reward/migration logic lives in `StakingV10`,
 *      gated by `onlyConvictionNFT` so only this wrapper can invoke it.
 *      TRAC never touches this contract: users approve `StakingV10`
 *      directly and `StakingV10.stake` pulls TRAC via
 *      `token.transferFrom(staker, stakingStorage, amount)`. This wrapper
 *      never calls `StakingStorage.*` or `ConvictionStakingStorage.*`
 *      directly for mutations — the only storage read we do is a one-shot
 *      `convictionStakingStorage.getPosition(tokenId)` in `redelegate` (to
 *      capture the pre-call identity for the mirror event) and in
 *      `finalizeWithdrawal` (to detect a fully-drained position so the NFT
 *      can be burned).
 *
 *      The eight user-facing entry points are:
 *        - `createConviction` / `convertToNFT` (mint paths — forward to
 *          `StakingV10.stake` / `StakingV10.convertToNFT`)
 *        - `relock` / `redelegate`
 *        - `createWithdrawal` / `cancelWithdrawal` / `finalizeWithdrawal`
 *        - `claim`
 *
 *      Phase 5 scaffold: `StakingV10` is currently stubbed and every
 *      downstream forward reverts `"NotImplemented"`. That is expected —
 *      downstream subagents will fill in the `StakingV10` bodies in later
 *      rounds.
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
    StakingV10 public stakingV10;
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
    ///         NFT is minted. The authoritative position-created event (with
    ///         raw / expiryEpoch / multiplier18) is emitted by
    ///         `ConvictionStakingStorage.createPosition` via `StakingV10.stake`;
    ///         this wrapper-layer event is kept so off-chain indexers that
    ///         watch the NFT contract alone still see the mint.
    event PositionCreated(
        address indexed owner,
        uint256 indexed tokenId,
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

    /// @notice Emitted by `createWithdrawal` when the 15-day delay timer
    ///         starts. The authoritative event (with `releaseAt`) is emitted
    ///         by `StakingV10.createWithdrawal`; this wrapper-layer event is
    ///         kept so off-chain indexers watching the NFT contract still see
    ///         withdrawal intents.
    event WithdrawalCreated(uint256 indexed tokenId, uint96 amount);

    /// @notice Emitted by `cancelWithdrawal` when a pending withdrawal is
    ///         cleared before finalization.
    event WithdrawalCancelled(uint256 indexed tokenId);

    /// @notice Emitted by `finalizeWithdrawal` after the delay elapses and
    ///         TRAC is released back to the owner. The authoritative event
    ///         (with `rawDraw` / `rewardsDraw`) is emitted by
    ///         `StakingV10.finalizeWithdrawal`; this wrapper-layer event is
    ///         kept so off-chain indexers watching the NFT contract still see
    ///         the finalize step.
    event WithdrawalFinalized(uint256 indexed tokenId);

    /// @notice Emitted by `convertToNFT` when a V8 address-keyed delegation
    ///         is migrated into a V10 NFT-backed position.
    event ConvertedFromV8(
        address indexed delegator,
        uint256 indexed tokenId,
        uint72 indexed identityId,
        uint8 lockEpochs
    );

    // ========================================================================
    // Errors
    // ========================================================================

    // Only errors thrown at the NFT wrapper layer are declared here. Every
    // position-lifecycle check (lock expiry, withdrawal state, same-identity,
    // profile existence, max-stake, rewards/raw sufficiency, etc.) is the
    // responsibility of `StakingV10` and reverts with the matching error
    // declared there. Keeping the NFT layer's error surface minimal avoids
    // dead code at the wrapper and prevents the wrapper layer from drifting
    // into business-rule decisions.
    error InvalidLockEpochs();
    error NotPositionOwner();
    error ZeroAmount();

    // ========================================================================
    // Constructor + initialize
    // ========================================================================

    // solhint-disable-next-line no-empty-blocks
    constructor(
        address hubAddress
    ) ContractStatus(hubAddress) ERC721("DKG Staker Conviction", "DKGSC") {}

    function initialize() public onlyHub {
        stakingContract = IStaking(hub.getContractAddress("Staking"));
        stakingV10 = StakingV10(hub.getContractAddress("StakingV10"));
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
    // Entry points — thin wrappers that forward to `StakingV10`
    // ========================================================================
    //
    // The NFT contract is a dumb ownership receipt. All position business
    // logic (stake bookkeeping, conviction math, reward accrual, withdrawal
    // state machine, V8 migration) lives in `StakingV10`, which is gated by
    // `onlyConvictionNFT` so only this contract can invoke it. Each wrapper:
    //
    //   1. Validates ownership (`ownerOf == msg.sender`) on mutating calls.
    //   2. For mint paths, fails fast on `lockEpochs` via `_convictionMultiplier`.
    //   3. Mints / burns the ERC-721 token as needed.
    //   4. Forwards to the matching `StakingV10` method with `msg.sender`
    //      passed explicitly as the `staker` argument (StakingV10 never
    //      trusts `tx.origin`).
    //   5. Emits a wrapper-layer mirror event for NFT-contract watchers —
    //      the authoritative event for off-chain accounting comes from the
    //      `StakingV10` / `ConvictionStakingStorage` layer.
    //
    // TRAC never touches this contract: at `createConviction` the user has
    // approved `StakingV10` directly, and `StakingV10.stake` pulls TRAC via
    // `token.transferFrom(staker, stakingStorage, amount)`. The NFT layer
    // only mints/burns ERC-721 tokens.
    //
    // `StakingV10` is currently scaffolded — all its entry points revert
    // `"NotImplemented"`. That is expected and the runtime behavior of
    // every wrapper here is "forwards, then reverts" until downstream
    // subagents fill the StakingV10 bodies.

    /// @notice Mint a fresh NFT-backed staking position on `identityId` with
    ///         `amount` TRAC locked for `lockEpochs` epochs.
    function createConviction(
        uint72 identityId,
        uint96 amount,
        uint8 lockEpochs
    ) external returns (uint256 tokenId) {
        if (amount == 0) revert ZeroAmount();
        // Fail-fast on invalid tier: `_convictionMultiplier` reverts
        // `InvalidLockEpochs()` for any value outside {0,1,3,6,12}. Note
        // that `StakingV10.stake` is expected to additionally reject
        // `lockEpochs == 0` once its body is filled in (createConviction
        // must never mint at the rest-state tier).
        _convictionMultiplier(lockEpochs);

        tokenId = nextTokenId++;
        _mint(msg.sender, tokenId);
        stakingV10.stake(msg.sender, tokenId, identityId, amount, lockEpochs);

        emit PositionCreated(msg.sender, tokenId, identityId, amount, lockEpochs);
    }

    /// @notice Post-expiry re-commit of an existing position to a new lock
    ///         tier. Raw stake unchanged; multiplier + expiry shift.
    function relock(uint256 tokenId, uint8 newLockEpochs) external {
        if (ownerOf(tokenId) != msg.sender) revert NotPositionOwner();
        // Fail-fast on invalid tier. Same note as createConviction: the
        // `lockEpochs == 0` policy check lives in `StakingV10.relock`.
        _convictionMultiplier(newLockEpochs);
        stakingV10.relock(msg.sender, tokenId, newLockEpochs);
        emit PositionRelocked(tokenId, newLockEpochs);
    }

    /// @notice Move a position from its current node to `newIdentityId`.
    ///         Per-node effective stake moves; global totals invariant.
    function redelegate(uint256 tokenId, uint72 newIdentityId) external {
        if (ownerOf(tokenId) != msg.sender) revert NotPositionOwner();
        // Capture the pre-call `identityId` so the wrapper-layer
        // `PositionRedelegated` event can surface both endpoints. Cheap
        // (one SLOAD via `getPosition`) and keeps the event's shape aligned
        // with the storage-layer authoritative event.
        uint72 oldIdentityId = convictionStakingStorage.getPosition(tokenId).identityId;
        stakingV10.redelegate(msg.sender, tokenId, newIdentityId);
        emit PositionRedelegated(tokenId, oldIdentityId, newIdentityId);
    }

    /// @notice Start the 15-day withdrawal timer for a partial or full
    ///         withdrawal. Caller must own the NFT.
    function createWithdrawal(uint256 tokenId, uint96 amount) external {
        if (ownerOf(tokenId) != msg.sender) revert NotPositionOwner();
        if (amount == 0) revert ZeroAmount();
        stakingV10.createWithdrawal(msg.sender, tokenId, amount);
        emit WithdrawalCreated(tokenId, amount);
    }

    /// @notice Cancel a pending withdrawal before the delay elapses. Returns
    ///         the position to its pre-`createWithdrawal` state.
    function cancelWithdrawal(uint256 tokenId) external {
        if (ownerOf(tokenId) != msg.sender) revert NotPositionOwner();
        stakingV10.cancelWithdrawal(msg.sender, tokenId);
        emit WithdrawalCancelled(tokenId);
    }

    /// @notice After `WITHDRAWAL_DELAY` has elapsed, drain the withdrawable
    ///         amount from the position and transfer TRAC back to the owner.
    ///         Burns the NFT if the position is fully drained (both raw and
    ///         rewards buckets at zero).
    function finalizeWithdrawal(uint256 tokenId) external {
        if (ownerOf(tokenId) != msg.sender) revert NotPositionOwner();
        stakingV10.finalizeWithdrawal(msg.sender, tokenId);

        // Burn-on-drain check. `StakingV10.finalizeWithdrawal` is responsible
        // for calling `ConvictionStakingStorage.deletePosition(tokenId)` when
        // the final drain happens, but we defensively read the position back
        // here: if both buckets are zero, the NFT's only remaining job is to
        // stop existing. We check `positions[tokenId]` directly via the
        // getter rather than tracking a "fully drained" return value from
        // StakingV10 — keeps the storage-layer read local to the NFT and
        // tolerates a StakingV10 that has already deleted the position
        // (`getPosition` returns a zero-value Position struct after delete,
        // which still satisfies the raw==0 && rewards==0 check).
        ConvictionStakingStorage.Position memory pos = convictionStakingStorage.getPosition(tokenId);
        if (pos.raw == 0 && pos.rewards == 0) {
            _burn(tokenId);
        }

        emit WithdrawalFinalized(tokenId);
    }

    /// @notice Walk unclaimed epochs for the position, accumulate reward,
    ///         and bank it into the `ConvictionStakingStorage` rewards
    ///         bucket. Updates `lastClaimedEpoch`.
    function claim(uint256 tokenId) external {
        if (ownerOf(tokenId) != msg.sender) revert NotPositionOwner();
        stakingV10.claim(msg.sender, tokenId);
        // No wrapper-layer event — `StakingV10.claim` emits `RewardsClaimed`
        // with the amount already. The NFT layer does not duplicate reward
        // accounting events.
    }

    /// @notice Atomic V8 → V10 migration. Burns the caller's V8 address-keyed
    ///         delegation on `identityId` and mints a fresh V10 NFT-backed
    ///         position at the specified `lockEpochs` tier.
    function convertToNFT(
        uint72 identityId,
        uint8 lockEpochs
    ) external returns (uint256 tokenId) {
        // Fail-fast on invalid tier. Same note as createConviction: the
        // `lockEpochs == 0` policy check lives in `StakingV10.convertToNFT`.
        _convictionMultiplier(lockEpochs);

        tokenId = nextTokenId++;
        _mint(msg.sender, tokenId);
        stakingV10.convertToNFT(msg.sender, tokenId, identityId, lockEpochs);

        emit ConvertedFromV8(msg.sender, tokenId, identityId, lockEpochs);
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
