// SPDX-License-Identifier: Apache-2.0

pragma solidity ^0.8.20;

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
 *      directly for mutations — the only storage read it does is
 *      `convictionStakingStorage.getPosition(tokenId)` in `redelegate`,
 *      to capture the pre-call `identityId` for the wrapper-layer event.
 *
 *      User-facing entry points:
 *        - `createConviction`                             — mint path, fresh V10 stake
 *        - `selfMigrateV8`                                — mint path, D7 self migration
 *        - `adminMigrateV8` / `adminMigrateV8Batch`       — mint path, D7 straggler rescue (admin)
 *        - `finalizeMigrationBatch`                       — DAO closer (D11), sets `v10LaunchEpoch`
 *        - `relock`                                       — D21 burn-and-mint tier re-commit
 *        - `redelegate`                                   — D25 in-place node swap (stable tokenId)
 *        - `withdraw`                                     — D14 atomic burn-and-payout
 *        - `claim`
 *
 *      NFT lifecycle:
 *        - `createConviction` / `selfMigrateV8` / `adminMigrateV8*`:
 *          fresh mints. Monotonic `nextTokenId`.
 *        - `relock` (D21): burns `oldTokenId` and mints `newTokenId`.
 *          CSS-level position state migrates via the D23
 *          `createNewPositionFromExisting` primitive, preserving
 *          `cumulativeRewardsClaimed`, `lastClaimedEpoch`, and
 *          `migrationEpoch` into the new tokenId so off-chain reward
 *          accounting stays intact across the burn-mint.
 *        - `redelegate` (D25): tokenId is STABLE — no mint, no burn,
 *          only `pos.identityId` mutates on CSS via `updateOnRedelegate`.
 *          `expiryTimestamp` is preserved: the lock clock keeps ticking.
 *        - `withdraw` (D14): atomic. Burns `tokenId` after CSS deletes
 *          the position and TRAC is released to the owner.
 */
/// @dev M5 — this contract does NOT implement `INamed`. ERC-721's `name()`
///      already occupies that function selector with a different contract —
///      the collection display name returned to wallets — so an `INamed`
///      implementation would collide. Use `contractName()` below for the
///      dev-facing contract id (matches other V10 contracts' INamed value).
contract DKGStakingConvictionNFT is IVersioned, ContractStatus, IInitializable, ERC721Enumerable {
    string private constant _CONTRACT_NAME = "DKGStakingConvictionNFT";
    // 1.1.0 — initial V10 NFT wrapper.
    // 1.2.0 — D26 code-review follow-ups:
    //         * M5 — `name()` now returns the ERC-721 collection name
    //           (`"DKG Staker Conviction"`) as ERC-721 consumers expect;
    //           the dev-facing contract id is exposed via `contractName()`.
    //           `INamed` inheritance removed to avoid the selector collision.
    //         * L1 — stale `expiryEpoch` references scrubbed from NatSpec.
    //         * L2 — `nextTokenId` starts at 1 so `tokenId == 0` is a
    //           guaranteed sentinel ("no position").
    //         * L3 — `lockTier` widened to `uint40` across all entry
    //           points and events.
    //         * L8 — `identityId != 0` guard added on mint paths so
    //           ambiguous "zero-node" mints fail fast at the wrapper.
    string private constant _VERSION = "1.2.0";

    // ========================================================================
    // Constants
    // ========================================================================

    /// @notice 1e18 fixed-point scale shared with `ConvictionStakingStorage`.
    ///         Tier table and reward math all use this scale.
    uint256 public constant SCALE18 = 1e18;

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

    /// @notice Monotonic token id counter. The first mint produces tokenId 1
    ///         (L2 — tokenId 0 is reserved as a sentinel so `ownerOf(0)` is
    ///         always "unambiguously nothing"). `++nextTokenId` bumps the
    ///         counter before use, so `nextTokenId == N` means "N positions
    ///         have been minted (ever)".
    uint256 public nextTokenId;

    // ========================================================================
    // Events
    // ========================================================================

    /// @notice Emitted by `createConviction` and `convertToNFT` after the
    ///         NFT is minted. The authoritative position-created event (with
    ///         raw / expiryTimestamp / multiplier18) is emitted by
    ///         `ConvictionStakingStorage.createPosition` via `StakingV10.stake`;
    ///         this wrapper-layer event is kept so off-chain indexers that
    ///         watch the NFT contract alone still see the mint.
    event PositionCreated(
        address indexed owner,
        uint256 indexed tokenId,
        uint72 indexed identityId,
        uint96 amount,
        uint40 lockTier
    );

    /// @notice Emitted by `relock` after the old NFT is burned and a fresh
    ///         one is minted under a new lock tier. D21 — NFTs are ephemeral;
    ///         off-chain indexers follow `oldTokenId → newTokenId` via this
    ///         event (and `PositionReplaced` on `ConvictionStakingStorage`,
    ///         which carries the full reward-stat continuity).
    event PositionRelocked(
        uint256 indexed oldTokenId,
        uint256 indexed newTokenId,
        uint40 newLockTier
    );

    /// @notice Emitted by `redelegate` after the position's identity is
    ///         mutated in place. D25 — tokenId, `expiryTimestamp`, lock tier,
    ///         multiplier, and reward cursor are all preserved; only the
    ///         node assignment changes. Global totals are invariant; only
    ///         per-node effective stake moves. Authoritative event (same
    ///         shape) is emitted by `ConvictionStakingStorage` via
    ///         `updateOnRedelegate`; this wrapper-layer event is kept so
    ///         off-chain indexers watching the NFT contract alone still
    ///         see the transition.
    event PositionRedelegated(
        uint256 indexed tokenId,
        uint72 indexed oldIdentityId,
        uint72 indexed newIdentityId
    );

    /// @notice Emitted by `withdraw` after CSS deletes the position and TRAC
    ///         is released from the vault to the owner. The NFT is burned
    ///         immediately after. Authoritative event (with `staker`) is
    ///         emitted by `StakingV10.withdraw`; this wrapper-layer event
    ///         is kept so off-chain indexers watching the NFT contract
    ///         alone still see the exit.
    event PositionWithdrawn(uint256 indexed tokenId, uint96 amount);

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
        uint40 lockTier,
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
    /// @notice L8 — rejected at the wrapper layer when a mint-path or
    ///         redelegate call would otherwise forward a zero identity to
    ///         StakingV10 (which uses `identityId == 0` internally as the
    ///         "no position" sentinel).
    error InvalidIdentityId();

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

    // M5 — `name()` (ERC-721) is deliberately NOT overridden; it returns the
    //      constructor-supplied collection name ("DKG Staker Conviction")
    //      that wallets display. The dev-facing contract id lives on
    //      `contractName()`.
    function contractName() external pure returns (string memory) {
        return _CONTRACT_NAME;
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
    // Tier 0 → 1x is a first-class tier, not an edge case:
    //   V10 policy is that every staking position is an NFT, including
    //   no-lock liquid stake. Tier 0 is valid on every entry point that
    //   takes a lockTier:
    //     - createConviction(_, _, 0): fresh mint at rest state.
    //     - relock(_, 0)             : post-expiry opt-out to permanent 1x.
    //     - _convertToNFT(_, _, 0)   : V8 migrants landing at rest state.
    //     - any caller reading a live position's current tier after its
    //       lock has expired back to the rest state.
    //   Semantics: 1.0x multiplier, `expiryTimestamp == 0` (permanent, no
    //   boost decay ever fires), TRAC withdrawable at any time via the
    //   atomic `withdraw` path (D14 — no delay, the lock IS the delay
    //   and tier 0 has no lock).
    //
    //   `createConviction` still rejects DEACTIVATED tiers at the CSS
    //   layer: `CSS.createPosition` requires `active == true` whenever
    //   `migrationEpoch == 0`. Tier 0 is seeded active at
    //   `CSS.initialize()` and a HubOwner could deactivate it via
    //   `deactivateTier(0)` if the no-lock product is ever retired;
    //   relock and V8→V10 migration paths bypass the `active` check
    //   (existence only) so users can renew under a tier they
    //   originally committed to.
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

    /// @notice Mint a fresh NFT-backed staking position on `identityId` with
    ///         `amount` TRAC under the `lockTier` tier. Valid tiers are
    ///         whatever `CSS.getTier(lockTier).active == true`; the seeded
    ///         baseline is tier 0 (rest state, 1x, no lock) plus 1/3/6/12
    ///         (30d/90d/180d/366d → 1.5x/2x/3.5x/6x). All tiers — including
    ///         tier 0 — produce an NFT; every V10 staking position is an NFT.
    function createConviction(
        uint72 identityId,
        uint96 amount,
        uint40 lockTier
    ) external returns (uint256 tokenId) {
        if (identityId == 0) revert InvalidIdentityId();
        if (amount == 0) revert ZeroAmount();
        // Fail-fast on tiers that don't exist in `CSS._tiers` (e.g. 2, 4,
        // 7, 13): `_convictionMultiplier` reverts `InvalidLockTier()` when
        // the tier is unregistered. Tier 0 (rest state, 1x) is a valid
        // registered tier — V10 policy is that no-lock stake is a first-
        // class NFT position, not a blocked state. Deactivated tiers are
        // rejected further downstream by `CSS.createPosition` via
        // `_requireActiveTier` (fresh stakes only — migrationEpoch == 0).
        _convictionMultiplier(lockTier);

        tokenId = ++nextTokenId;
        _mint(msg.sender, tokenId);
        stakingV10.stake(msg.sender, tokenId, identityId, amount, lockTier);

        emit PositionCreated(msg.sender, tokenId, identityId, amount, lockTier);
    }

    /// @notice Post-expiry re-commit of an existing position to a new lock
    ///         tier. Raw stake unchanged; multiplier + expiry shift.
    ///
    /// @dev D21 — NFTs are ephemeral. Relock burns the old NFT and mints a
    ///      fresh one at `newTokenId = ++nextTokenId`. `StakingV10.relock`
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
    function relock(uint256 oldTokenId, uint40 newLockTier) external returns (uint256 newTokenId) {
        if (ownerOf(oldTokenId) != msg.sender) revert NotPositionOwner();
        // Fail-fast on unregistered tiers (e.g. 2, 4, 7). Tier 0 is valid:
        // relock to the rest state is a legitimate post-expiry opt-out to
        // permanent 1x with no new lock. Deactivated tiers are allowed on
        // the relock path (existence-only check in CSS) so users can
        // renew under a tier they originally committed to even if it has
        // since been retired.
        _convictionMultiplier(newLockTier);

        newTokenId = ++nextTokenId;
        _mint(msg.sender, newTokenId);
        stakingV10.relock(msg.sender, oldTokenId, newTokenId, newLockTier);
        _burn(oldTokenId);

        emit PositionRelocked(oldTokenId, newTokenId, newLockTier);
    }

    /// @notice Move a position from its current node to `newIdentityId`.
    ///         Per-node effective stake moves; global totals invariant.
    ///         The tokenId is STABLE — the caller's NFT asset identity is
    ///         preserved across the redelegation, only the node it points
    ///         at changes.
    ///
    /// @dev D25 — in-place node swap. Unlike `relock` (which burns and
    ///      mints because tier / multiplier / expiry all change), a
    ///      redelegation is a routing decision: the lock clock keeps
    ///      ticking on the same `expiryTimestamp`, the reward cursor
    ///      (`lastClaimedEpoch`, `cumulativeRewardsClaimed`,
    ///      `migrationEpoch`) carries through unchanged, and the tokenId
    ///      itself persists so wallets and marketplaces see a stable
    ///      asset. StakingV10 drives the CSS `updateOnRedelegate`
    ///      primitive which moves per-node effective-stake contributions
    ///      and pending expiry deltas across at `currentEpoch`.
    function redelegate(uint256 tokenId, uint72 newIdentityId) external {
        if (ownerOf(tokenId) != msg.sender) revert NotPositionOwner();
        if (newIdentityId == 0) revert InvalidIdentityId();
        // Capture the pre-call `identityId` so the wrapper-layer event can
        // surface both endpoints.
        uint72 oldIdentityId = convictionStakingStorage.getPosition(tokenId).identityId;

        stakingV10.redelegate(msg.sender, tokenId, newIdentityId);

        emit PositionRedelegated(tokenId, oldIdentityId, newIdentityId);
    }

    /// @notice Atomic full withdrawal. Pays out the position's entire `raw`
    ///         balance (post-auto-claim) to the owner and burns the NFT in
    ///         a single transaction. Caller must own the NFT.
    ///
    /// @dev D14 — no request/cancel/finalize dance, no address-timer
    ///      delay. Pre-expiry reverts `LockStillActive` at StakingV10.
    ///      Q3 — rewards are auto-claimed inside `StakingV10.withdraw`
    ///      before the final drain, so the user sees a single button in
    ///      the UI. Full-only by design (Q1) — a user wanting to keep
    ///      some TRAC staked should withdraw and re-stake the remainder
    ///      (tier 0 with 1x is effectively liquid).
    function withdraw(uint256 tokenId) external returns (uint96 amount) {
        if (ownerOf(tokenId) != msg.sender) revert NotPositionOwner();

        amount = stakingV10.withdraw(msg.sender, tokenId);

        _burn(tokenId);

        emit PositionWithdrawn(tokenId, amount);
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
        uint40 lockTier
    ) external returns (uint256 tokenId) {
        if (identityId == 0) revert InvalidIdentityId();
        // Fail-fast on unregistered tiers. Tier 0 is valid for V8→V10
        // migration: migrants land at the rest-state tier (1x, no lock)
        // when they want their full balance liquid post-migration.
        // Deactivated tiers are allowed on this path (existence-only
        // check in CSS) so stragglers can still be onboarded under the
        // tier they originally committed to.
        _convictionMultiplier(lockTier);

        tokenId = ++nextTokenId;
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
        uint40 lockTier
    ) external onlyOwnerOrMultiSigOwner returns (uint256 tokenId) {
        if (identityId == 0) revert InvalidIdentityId();
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
        uint40 lockTier
    ) external onlyOwnerOrMultiSigOwner returns (uint256[] memory tokenIds) {
        if (identityId == 0) revert InvalidIdentityId();
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
        uint40 lockTier
    ) internal returns (uint256 tokenId) {
        _convictionMultiplier(lockTier);
        tokenId = ++nextTokenId;
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
