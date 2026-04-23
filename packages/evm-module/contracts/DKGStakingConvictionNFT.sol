// SPDX-License-Identifier: Apache-2.0

pragma solidity ^0.8.20;

import {INamed} from "./interfaces/INamed.sol";
import {IVersioned} from "./interfaces/IVersioned.sol";
import {IInitializable} from "./interfaces/IInitializable.sol";
import {ContractStatus} from "./abstract/ContractStatus.sol";
import {Ask} from "./Ask.sol";
import {ShardingTable} from "./ShardingTable.sol";
import {StakingV10} from "./StakingV10.sol";
import {ShardingTableStorage} from "./storage/ShardingTableStorage.sol";
import {StakingStorage} from "./storage/StakingStorage.sol";
import {ConvictionStakingStorage} from "./storage/ConvictionStakingStorage.sol";
import {ParametersStorage} from "./storage/ParametersStorage.sol";
import {ProfileStorage} from "./storage/ProfileStorage.sol";
import {RandomSamplingStorage} from "./storage/RandomSamplingStorage.sol";
import {Chronos} from "./storage/Chronos.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC721Enumerable} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721Enumerable.sol";
import {ICustodian} from "./interfaces/ICustodian.sol";
import {HubLib} from "./libraries/HubLib.sol";

/**
 * @title DKGStakingConvictionNFT
 * @notice Wraps V10 DKG staking positions as transferable ERC-721 NFTs.
 *
 * Each NFT represents a staking position on a specific node with a discrete
 * conviction lock tier ({0, 1, 3, 6, 12} months → 1.0x / 1.5x / 2.0x / 3.5x /
 * 6.0x boost, D20 hardcoded tier ladder). The position can be transferred to
 * another address (accrued-interest transfer model — the new owner inherits
 * both the raw stake and any unclaimed rewards; see `_update` below).
 *
 * @dev V10 split-contract architecture. This contract is a dumb ERC-721
 *      ownership receipt: it mints/burns tokens, validates ownership on
 *      mutating calls, and forwards every business action to `StakingV10`.
 *      All stake / withdrawal / reward / migration logic lives in
 *      `StakingV10`, gated by `onlyConvictionNFT` so only this wrapper can
 *      invoke it. TRAC never touches this contract: users approve
 *      `StakingV10` directly and `StakingV10.stake` pulls TRAC via
 *      `token.transferFrom(staker, stakingStorage, amount)`. The wrapper
 *      never calls `StakingStorage.*` or `ConvictionStakingStorage.*`
 *      directly for mutations — the only storage reads it does are:
 *        - one-shot `convictionStakingStorage.getPosition(oldTokenId)` in
 *          `redelegate` (to capture the pre-call `identityId` for the
 *          mirror event), and
 *        - `convictionStakingStorage.getPosition(tokenId)` in
 *          `finalizeWithdrawal` (to detect a fully-drained position so the
 *          NFT can be burned).
 *
 *      User-facing entry points:
 *        - `createConviction`                             — mint path, fresh V10 stake
 *        - `selfMigrateV8`                                — mint path, D7 self migration
 *        - `adminMigrateV8` / `adminMigrateV8Batch`       — mint path, D7 straggler rescue (admin)
 *        - `finalizeMigrationBatch`                       — DAO closer (D11), sets `v10LaunchEpoch`
 *        - `relock` / `redelegate`                        — D21 burn-and-mint position mutations
 *        - `createWithdrawal` / `cancelWithdrawal` / `finalizeWithdrawal`
 *        - `claim`
 *
 *      D21 — NFTs are ephemeral across state-changing transitions:
 *        - `relock` and `redelegate` each burn `oldTokenId` and mint
 *          `newTokenId`. The CSS-level position migrates via the D23
 *          `createNewPositionFromExisting` primitive, which preserves
 *          `cumulativeRewardsClaimed`, `lastClaimedEpoch`, and
 *          `migrationEpoch` into the new tokenId so off-chain reward
 *          accounting stays intact across the burn-mint.
 *        - `finalizeWithdrawal` burns the NFT iff the position is fully
 *          drained (`raw == 0` after the finalize-side CSS delete).
 */
contract DKGStakingConvictionNFT is INamed, IVersioned, ContractStatus, IInitializable, ERC721Enumerable {
    string private constant _NAME = "DKGStakingConvictionNFT";
    string private constant _VERSION = "1.0.0";

    // ========================================================================
    // Constants
    // ========================================================================

    /// @notice 1e18 fixed-point scale shared with `ConvictionStakingStorage`.
    ///         Tier table and reward math all use this scale.
    uint256 public constant SCALE18 = 1e18;

    /// @notice Time between `createWithdrawal` and `finalizeWithdrawal`.
    ///         D14 — set to 0 (see `StakingV10.WITHDRAWAL_DELAY` for the
    ///         full rationale: conviction lock expiry is itself the delay
    ///         gate, a second address-timer is redundant). This constant
    ///         is kept on the wrapper for off-chain integrations that
    ///         read it; the authoritative value used in the flow is
    ///         `StakingV10.WITHDRAWAL_DELAY`.
    uint256 public constant WITHDRAWAL_DELAY = 0;

    // ========================================================================
    // Hub-wired dependencies
    // ========================================================================

    StakingV10 public stakingV10;
    StakingStorage public stakingStorage;
    ConvictionStakingStorage public convictionStakingStorage;
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
        uint8 lockTier
    );

    /// @notice Emitted by `relock` after the old NFT is burned and a fresh
    ///         one is minted under a new lock tier. D21 — NFTs are ephemeral;
    ///         off-chain indexers follow `oldTokenId → newTokenId` via this
    ///         event (and `PositionReplaced` on `ConvictionStakingStorage`,
    ///         which carries the full reward-stat continuity).
    event PositionRelocked(
        uint256 indexed oldTokenId,
        uint256 indexed newTokenId,
        uint8 newLockTier
    );

    /// @notice Emitted by `redelegate` after the old NFT is burned and a
    ///         fresh one is minted on a new node. Global totals are
    ///         invariant; only per-node effective stake moves. D21 — see
    ///         `PositionRelocked` for NFT-continuity semantics.
    event PositionRedelegated(
        uint256 indexed oldTokenId,
        uint256 indexed newTokenId,
        uint72 indexed newIdentityId,
        uint72 oldIdentityId
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

    /// @notice Emitted by `selfMigrateV8` / `adminMigrateV8` when a V8
    ///         address-keyed delegation is migrated into a V10 NFT-backed
    ///         position. The authoritative event (with stakeBase /
    ///         pending absorption split and `isAdmin` flag — D7/D8) is
    ///         emitted by `StakingV10.selfConvertToNFT` /
    ///         `StakingV10.adminConvertToNFT`; this wrapper-layer event is
    ///         kept so off-chain indexers watching the NFT contract still
    ///         see the mint.
    event ConvertedFromV8(
        address indexed delegator,
        uint256 indexed tokenId,
        uint72 indexed identityId,
        uint8 lockTier,
        bool isAdmin
    );

    /// @notice Emitted by `finalizeMigrationBatch` when the DAO closes the
    ///         V10 migration window by setting the `v10LaunchEpoch` marker
    ///         on CSS. Retroactive-attribution analyses use this epoch.
    event MigrationBatchFinalized(uint256 v10LaunchEpoch);

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
    error InvalidLockTier();
    error NotPositionOwner();
    error ZeroAmount();
    /// @notice Thrown by `adminMigrateV8Batch` when the input array is empty.
    error EmptyBatch();

    // ========================================================================
    // Constructor + initialize
    // ========================================================================

    // solhint-disable-next-line no-empty-blocks
    constructor(
        address hubAddress
    ) ContractStatus(hubAddress) ERC721("DKG Staker Conviction", "DKGSC") {}

    function initialize() public onlyHub {
        stakingV10 = StakingV10(hub.getContractAddress("StakingV10"));
        stakingStorage = StakingStorage(hub.getContractAddress("StakingStorage"));
        convictionStakingStorage = ConvictionStakingStorage(hub.getContractAddress("ConvictionStakingStorage"));
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
    // Admin gate — used by D7 `adminMigrateV8*` and D11 `finalizeMigrationBatch`
    // ========================================================================

    /// @dev Matches the ownership + multisig pattern used by other admin
    ///      entry points on V10 contracts (e.g. `RandomSampling`).
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

    // ========================================================================
    // Conviction multiplier tier ladder — delegates to CSS (v2.1.0)
    // ========================================================================
    //
    // Source of truth is `ConvictionStakingStorage._tiers`. The baseline
    // ladder seeded at `CSS.initialize()` is {0, 1, 3, 6, 12} mapping to
    // {1x, 1.5x, 2x, 3.5x, 6x} and {0, 30d, 90d, 180d, 360d} wall-clock
    // lock durations — matching the roadmap in `04_TOKEN_ECONOMICS §4.1`.
    // New tiers can be appended by the HubOwner via `CSS.addTier`; this
    // helper picks them up automatically via the storage read.
    //
    // Discrete, exact-match semantics — no snap-down. An unregistered
    // `lockTier` reverts `InvalidLockTier()`.
    //
    // Why `0 → 1x` rather than a revert at the helper level:
    //   The post-expiry rest state in `ConvictionStakingStorage` is
    //   encoded as `lockTier == 0 → 1x`, and reward-math / relock /
    //   migration callers legitimately invoke this helper with tier 0:
    //     - relock(_, 0)          : post-expiry opt-out to permanent 1x.
    //     - _convertToNFT(_, _, 0): V8 migrants landing at rest state
    //                               (they never chose conviction staking).
    //     - any caller reading a live position's current tier after its
    //       lock has expired back to the rest state.
    //   See Phase 5 decisions doc Q5 for the full reasoning.
    //
    //   The only entry point that forbids tier 0 is `createConviction`
    //   (fresh mint): a brand-new conviction NFT must commit to a real
    //   lock (tier ∈ {1, 3, 6, 12}). That policy is enforced by
    //   `StakingV10.stake` — see the fail-fast note there.
    //
    //   Additionally, `createConviction` rejects DEACTIVATED tiers at
    //   the CSS layer: `CSS.createPosition` requires `active == true`
    //   whenever `migrationEpoch == 0`. Relock and V8→V10 migration
    //   paths bypass that check (existence only) so users can renew
    //   under a tier they originally committed to.
    //
    // @param lockTier Tier id; must exist in `CSS._tiers`. Maps to the
    //                 wall-clock duration registered there. NOT a Chronos
    //                 epoch count.
    // @return multiplier18 1e18-scaled tier multiplier.
    function _convictionMultiplier(uint256 lockTier) internal view returns (uint256) {
        ConvictionStakingStorage.TierConfig memory tc =
            convictionStakingStorage.getTier(uint40(lockTier));
        if (!tc.exists) revert InvalidLockTier();
        return uint256(tc.multiplier18);
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
    //   2. For mint paths, fails fast on `lockTier` via `_convictionMultiplier`.
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
    ///         `amount` TRAC locked under the `lockTier` tier (tier index
    ///         ∈ {1, 3, 6, 12} → wall-clock durations {30d, 90d, 180d, 360d};
    ///         tier 0 is rejected — no rest-state mints).
    function createConviction(
        uint72 identityId,
        uint96 amount,
        uint8 lockTier
    ) external returns (uint256 tokenId) {
        if (amount == 0) revert ZeroAmount();
        // Fail-fast on off-ladder tier values (e.g. 2, 4, 7):
        // `_convictionMultiplier` reverts `InvalidLockTier()` for any value
        // outside {0, 1, 3, 6, 12}. This does NOT reject tier 0 — the helper
        // is intentionally tolerant of the rest state because relock and
        // migration legitimately pass tier 0. The "no fresh mint at rest
        // state" policy is enforced downstream by `StakingV10.stake`, which
        // reverts `InvalidLockTier()` if `lockTier == 0`. A fresh conviction
        // NFT must commit to a real lock (tier ∈ {1, 3, 6, 12}); a user who
        // wants no lock has no business minting a conviction position.
        _convictionMultiplier(lockTier);

        tokenId = nextTokenId++;
        _mint(msg.sender, tokenId);
        stakingV10.stake(msg.sender, tokenId, identityId, amount, lockTier);

        emit PositionCreated(msg.sender, tokenId, identityId, amount, lockTier);
    }

    /// @notice Post-expiry re-commit of an existing position to a new lock
    ///         tier. Raw stake unchanged; multiplier + expiry shift.
    ///
    /// @dev D21 — NFTs are ephemeral. Relock burns the old NFT and mints a
    ///      fresh one at `newTokenId = nextTokenId++`. `StakingV10.relock`
    ///      drives the D23 `createNewPositionFromExisting` primitive on CSS,
    ///      which preserves `cumulativeRewardsClaimed`, `lastClaimedEpoch`,
    ///      and `migrationEpoch` on the new tokenId; indexers that need to
    ///      track a delegator's history across relocks follow the
    ///      `PositionRelocked(oldTokenId, newTokenId, ...)` event surfaced
    ///      here (and the CSS-level `PositionReplaced` with the full reward
    ///      stat continuity).
    ///
    ///      Mint-before-forward ordering: we mint `newTokenId` BEFORE the
    ///      StakingV10 call so that CSS's `createNewPositionFromExisting`
    ///      can assert the new slot is empty (`positions[newTokenId].identityId == 0`)
    ///      — there's no NFT collision because the ERC-721 tokenId space
    ///      and the CSS position space are the same namespace.
    ///      Burn-after-forward: we burn `oldTokenId` AFTER CSS has moved
    ///      the position across, so a mid-call revert leaves BOTH NFT and
    ///      position state intact at the old tokenId.
    function relock(uint256 oldTokenId, uint8 newLockTier) external returns (uint256 newTokenId) {
        if (ownerOf(oldTokenId) != msg.sender) revert NotPositionOwner();
        // Fail-fast on invalid tier. Same note as createConviction: the
        // `lockTier == 0` policy check lives in `StakingV10.relock`.
        _convictionMultiplier(newLockTier);

        newTokenId = nextTokenId++;
        _mint(msg.sender, newTokenId);
        stakingV10.relock(msg.sender, oldTokenId, newTokenId, newLockTier);
        _burn(oldTokenId);

        emit PositionRelocked(oldTokenId, newTokenId, newLockTier);
    }

    /// @notice Move a position from its current node to `newIdentityId`.
    ///         Per-node effective stake moves; global totals invariant.
    ///
    /// @dev D21 — ephemeral NFT semantics. See `relock` for the
    ///      mint-before-forward / burn-after-forward rationale — identical
    ///      pattern applies.
    function redelegate(
        uint256 oldTokenId,
        uint72 newIdentityId
    ) external returns (uint256 newTokenId) {
        if (ownerOf(oldTokenId) != msg.sender) revert NotPositionOwner();
        // Capture the pre-call `identityId` so the wrapper-layer event can
        // surface both endpoints.
        uint72 oldIdentityId = convictionStakingStorage.getPosition(oldTokenId).identityId;

        newTokenId = nextTokenId++;
        _mint(msg.sender, newTokenId);
        stakingV10.redelegate(msg.sender, oldTokenId, newTokenId, newIdentityId);
        _burn(oldTokenId);

        emit PositionRedelegated(oldTokenId, newTokenId, newIdentityId, oldIdentityId);
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
    ///         Burns the NFT if the position is fully drained (`raw == 0`).
    ///
    /// @dev D19 — the separate `rewards` bucket was removed; rewards are
    ///      compounded into `raw` at claim time, so "fully drained" is
    ///      defined solely by `raw == 0`. `ConvictionStakingStorage`
    ///      returns a zero-value Position struct after `deletePosition`,
    ///      which still satisfies the raw==0 check, so the defensive
    ///      read-back is safe even when StakingV10 has already deleted.
    function finalizeWithdrawal(uint256 tokenId) external {
        if (ownerOf(tokenId) != msg.sender) revert NotPositionOwner();
        stakingV10.finalizeWithdrawal(msg.sender, tokenId);

        ConvictionStakingStorage.Position memory pos = convictionStakingStorage.getPosition(tokenId);
        if (pos.raw == 0) {
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

    // ========================================================================
    // D7/D8/D11 — V8 → V10 migration entry points
    // ========================================================================
    //
    // D7 — dual migration paths:
    //   - `selfMigrateV8(identityId, lockTier)`: user-driven. The V8
    //     address-keyed delegation on `identityId` belonging to `msg.sender`
    //     is drained and a fresh V10 NFT is minted to them.
    //   - `adminMigrateV8(delegator, identityId, lockTier)`: admin-driven
    //     straggler rescue. A V8 delegator who missed the self-migration
    //     window is rescued by admin; NFT minted to the delegator, not
    //     to the admin caller.
    //   - `adminMigrateV8Batch(delegators[], identityId, lockTier)`: D11
    //     batched admin migration for gas-efficient mass rescue.
    //
    // D8 — both paths absorb `stakeBase + pendingWithdrawal` into the V10
    // position via `StakingV10._convertToNFT`.

    /// @notice Self-service V8→V10 migration. Mints an NFT to the caller
    ///         and drains their V8 address-keyed delegation on `identityId`.
    function selfMigrateV8(
        uint72 identityId,
        uint8 lockTier
    ) external returns (uint256 tokenId) {
        // Fail-fast on invalid tier. `lockTier == 0` policy check lives
        // in `StakingV10.selfConvertToNFT`.
        _convictionMultiplier(lockTier);

        tokenId = nextTokenId++;
        _mint(msg.sender, tokenId);
        stakingV10.selfConvertToNFT(msg.sender, tokenId, identityId, lockTier);

        emit ConvertedFromV8(msg.sender, tokenId, identityId, lockTier, false);
    }

    /// @notice Admin straggler-rescue V8→V10 migration for a single
    ///         delegator. NFT minted to `delegator`. Gate:
    ///         `onlyOwnerOrMultiSigOwner`.
    function adminMigrateV8(
        address delegator,
        uint72 identityId,
        uint8 lockTier
    ) external onlyOwnerOrMultiSigOwner returns (uint256 tokenId) {
        tokenId = _adminMigrateV8Single(delegator, identityId, lockTier);
    }

    /// @notice Admin batch V8→V10 migration — D11. Iterates over
    ///         `delegators`, migrating each with the same `identityId` /
    ///         `lockTier`. One NFT minted per delegator. Gate:
    ///         `onlyOwnerOrMultiSigOwner`.
    ///
    /// @dev A per-delegator `_convertToNFT` revert (e.g. `NoV8StakeToConvert`
    ///      on a delegator with zero V8 stake AND zero pending) bubbles
    ///      up and reverts the whole batch — admins should pre-filter
    ///      their input list off-chain so this doesn't happen mid-batch.
    ///      Simpler semantics than try/catch partial-success, and matches
    ///      the operator playbook's "snapshot then drain" model.
    function adminMigrateV8Batch(
        address[] calldata delegators,
        uint72 identityId,
        uint8 lockTier
    ) external onlyOwnerOrMultiSigOwner returns (uint256[] memory tokenIds) {
        uint256 n = delegators.length;
        if (n == 0) revert EmptyBatch();
        // Fail-fast on invalid tier BEFORE the loop so we don't half-mint.
        _convictionMultiplier(lockTier);

        tokenIds = new uint256[](n);
        for (uint256 i = 0; i < n; i++) {
            tokenIds[i] = _adminMigrateV8Single(delegators[i], identityId, lockTier);
        }
    }

    /// @notice DAO closer — D11. Sets the `v10LaunchEpoch` marker on
    ///         `ConvictionStakingStorage` to formally close the V10
    ///         migration window. After this, straggler rescue is still
    ///         possible via `adminMigrateV8`, but the launch-epoch field
    ///         is the canonical off-chain cut-off for retroactive
    ///         reward / analytics windows.
    function finalizeMigrationBatch(uint256 v10LaunchEpoch) external onlyOwnerOrMultiSigOwner {
        stakingV10.setV10LaunchEpoch(v10LaunchEpoch);
        emit MigrationBatchFinalized(v10LaunchEpoch);
    }

    /// @dev Shared worker for single-delegator admin migration. Factored
    ///      out so `adminMigrateV8` and `adminMigrateV8Batch` can't drift.
    function _adminMigrateV8Single(
        address delegator,
        uint72 identityId,
        uint8 lockTier
    ) internal returns (uint256 tokenId) {
        _convictionMultiplier(lockTier);
        tokenId = nextTokenId++;
        _mint(delegator, tokenId);
        stakingV10.adminConvertToNFT(delegator, tokenId, identityId, lockTier);
        emit ConvertedFromV8(delegator, tokenId, identityId, lockTier, true);
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
