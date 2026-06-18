// SPDX-License-Identifier: Apache-2.0

pragma solidity ^0.8.20;

import {IVersioned} from "./interfaces/IVersioned.sol";
import {IInitializable} from "./interfaces/IInitializable.sol";
import {ContractStatus} from "./abstract/ContractStatus.sol";
import {Ask} from "./Ask.sol";
import {ShardingTable} from "./ShardingTable.sol";
import {StakingV10} from "./StakingV10.sol";
import {ShardingTableStorage} from "./storage/ShardingTableStorage.sol";
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
 *      `token.transferFrom(staker, convictionStorage, amount)` — CSS is
 *      the V10 vault as of v4.0.0. The wrapper never calls
 *      `ConvictionStakingStorage.*` directly for mutations — the only
 *      storage read it does is `convictionStakingStorage.getPosition(tokenId)`
 *      in `redelegate`, to capture the pre-call `identityId` for the
 *      wrapper-layer event.
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
    //         * 10.0.3 — OT-RFC-50 operator-fee migration: added
    //           `adminDrainOperatorFeesBatch` + `OperatorFeeMigrated`; bumped so
    //           the breaking migration ABI is detectable via `version()`.
    string private constant _VERSION = "10.0.3";

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

    /// @notice Emitted when a delegator's V8 stake is drained into migration
    ///         credit by the admin sweep (OT-RFC-50). `credited` is the total
    ///         moved into that delegator's credit by this event.
    event MigrationStarted(address indexed delegator, uint96 credited);

    /// @notice Emitted when a node's V8 operator fee (resting balance + any open
    ///         fee-withdrawal request) is drained into the operator's migration
    ///         credit by the admin sweep (OT-RFC-50). Keyed by `identityId` so
    ///         per-node fee migration reconciles against the V8 vault; `operator`
    ///         is the validated current ADMIN_KEY holder that was credited.
    /// @dev    Reconciliation: total migration credit issued = Σ `MigrationStarted`
    ///         (delegator stake) + Σ `OperatorFeeMigrated` (operator fees). An
    ///         indexer must sum BOTH events or it undercounts operators.
    event OperatorFeeMigrated(uint72 indexed identityId, address indexed operator, uint96 credited);

    /// @notice Emitted when migration credit is allocated into a fresh V10
    ///         conviction position. `creditApplied` is true when the tier-6/12
    ///         conviction lock-credit was applied (any 6/12 migration allocation,
    ///         rev 5: universal).
    event Allocated(
        address indexed delegator,
        uint256 indexed tokenId,
        uint72 indexed targetNode,
        uint96 amount,
        uint40 lockTier,
        bool creditApplied
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
    /// @notice OT-RFC-50 — thrown by `adminMigrateToCredit` when the delegator
    ///         has no V8 stake across the given source nodes (nothing drained,
    ///         so no credit would be created). `adminDrainBatch` SKIPS such
    ///         entries instead of reverting.
    error NothingToMigrate();
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
    // `token.transferFrom(staker, convictionStorage, amount)` — CSS is
    // the v4.0.0 TRAC vault. The NFT layer only mints/burns ERC-721 tokens.

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
        // CEI ordering: settle CSS state and pull TRAC FIRST, then `_mint`
        // last so the wrapper never observes a half-built (NFT-without-
        // position) state. `_mint` (not `_safeMint`) is intentional:
        // contract callers without `IERC721Receiver` are part of the
        // supported caller set (multisigs, treasuries, AA wallets, etc.).
        stakingV10.stake(msg.sender, tokenId, identityId, amount, lockTier);
        _mint(msg.sender, tokenId);

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
    ///      CEI ordering — state changes first, NFT mint last:
    ///        1. `stakingV10.relock` — drives CSS's `createNewPositionFromExisting`
    ///           which itself asserts the new slot is empty
    ///           (`positions[newTokenId].identityId == 0`). That assertion is
    ///           a CSS-state check, not an NFT-existence check, so the new
    ///           NFT does NOT need to exist yet.
    ///        2. `_burn(oldTokenId)` — removes the old NFT after CSS has
    ///           moved the position. A mid-call revert leaves BOTH NFT and
    ///           position state intact at the old tokenId.
    ///        3. `_mint(msg.sender, newTokenId)` — last, so the wrapper
    ///           never observes a half-built burn-mint state. `_mint`
    ///           (not `_safeMint`) is intentional: contract callers
    ///           without `IERC721Receiver` are part of the supported
    ///           caller set, including any contract holding an existing
    ///           position from a prior `_mint`-era relock.
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
        stakingV10.relock(msg.sender, oldTokenId, newTokenId, newLockTier);
        _burn(oldTokenId);
        _mint(msg.sender, newTokenId);

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

        // CEI ordering — the receipt NFT is dropped BEFORE the CSS
        // teardown + TRAC payout run, so the on-chain ownership claim
        // ends before any external token movement. ownerOf-gated
        // re-entry paths on this contract (claim / withdraw / relock /
        // redelegate) revert at the entry ownership check.
        // StakingV10.withdraw gates on the CSS position (`pos.identityId
        // == 0`), not NFT existence, so the teardown is unaffected.
        _burn(tokenId);

        amount = stakingV10.withdraw(msg.sender, tokenId);

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
    // OT-RFC-50 — V8 → V10 "pool & allocate" migration
    // ========================================================================
    //
    // Admin-push (OT-RFC-50): the protocol drains EVERY wallet's V8 stake across
    // its source nodes into that wallet's in-protocol migration credit, via
    // `adminDrainBatch` (bulk) / `adminMigrateToCredit` (single delegator) —
    // both onlyOwnerOrMultiSigOwner. Users never drain themselves; they only
    // call `allocate` to spend their pre-populated credit into V10 conviction
    // positions (node + amount + tier), repeatably. A tier-6/12 allocation earns
    // the conviction lock-credit (rev 5: universal — no eligibility registry).
    // Credit is non-withdrawable as credit; `allocate` is its only sink — but a
    // tier-0 allocation carries no lock and is immediately withdrawable, so
    // drained funds are always recoverable to the wallet in two txs. The credit
    // ledger + drain/allocate workers live on CSS / StakingV10
    // (onlyConvictionNFT); this wrapper owns the tokenId counter + ERC-721 mint
    // and the owner gating.
    //
    // There is intentionally NO self-service drain: the off-chain sweep is the
    // only path that empties V8, so its completeness (per-chain
    // StakingStorage.getTotalStake() == 0) is a release gate before the V8
    // `Staking` contract is unregistered.

    /// @notice Single-delegator admin drain — move `delegator`'s V8 stake across
    ///         `sourceNodes` into THEIR migration credit (no allocation). See
    ///         `adminDrainBatch` for the bulk sweep. Gate:
    ///         `onlyOwnerOrMultiSigOwner`. Reverts `NothingToMigrate` if nothing
    ///         was drained (caller-error guard on an intentional single call).
    function adminMigrateToCredit(
        address delegator,
        uint72[] calldata sourceNodes
    ) external onlyOwnerOrMultiSigOwner returns (uint96 credited) {
        // Benign: _drainAll calls only the onlyConvictionNFT worker over trusted
        // storage (no callback); the event after it carries no reentrancy risk.
        // slither-disable-next-line reentrancy-events
        credited = _drainAll(delegator, sourceNodes);
        if (credited == 0) revert NothingToMigrate();
        emit MigrationStarted(delegator, credited);
    }

    /// @notice Bulk admin-push drain. Each index `i` is ONE (delegator, node)
    ///         pair — the flattened form matches the V8 storage key and the
    ///         off-chain DelegatorsInfo enumeration, giving even per-pair gas so
    ///         the driver packs uniform chunks. Pairs with nothing to drain are
    ///         SKIPPED (not reverted), so a chunk mixing already-drained and
    ///         fresh pairs still lands and re-running a chunk after a partial
    ///         failure is safe (`drainV8ToCredit` is idempotent — a zeroed slot
    ///         yields 0). Amounts are NOT passed in — they are read on-chain from
    ///         V8 state, so the credit is exactly what was drained. Gate:
    ///         `onlyOwnerOrMultiSigOwner`. Emits one `MigrationStarted` per pair
    ///         that moved credit.
    function adminDrainBatch(
        address[] calldata delegators,
        uint72[] calldata identityIds
    ) external onlyOwnerOrMultiSigOwner {
        uint256 n = delegators.length;
        require(n == identityIds.length, "length mismatch");
        for (uint256 i = 0; i < n; i++) {
            // Benign: owner-only batch; the callee is onlyConvictionNFT over
            // trusted protocol storage, moves plain ERC20 TRAC (no callback),
            // and is idempotent — no value-reentrancy vector, event-after-call ok.
            // slither-disable-next-line calls-loop,reentrancy-events
            uint96 t = stakingV10.drainV8ToCredit(delegators[i], identityIds[i]);
            if (t > 0) emit MigrationStarted(delegators[i], t);
        }
    }

    /// @notice Bulk operator-fee drain — companion to `adminDrainBatch` for the
    ///         node side. Each index `i` is ONE (node, operator) pair: the V8
    ///         operator fee on `identityIds[i]` (resting balance + open
    ///         withdrawal request) is moved into `operators[i]`'s migration
    ///         credit (OT-RFC-50 §0 Option B — the SAME bucket as delegator
    ///         stake). `operators[i]` MUST currently hold ADMIN_KEY on the node
    ///         (validated in `StakingV10.drainOperatorFeeToCredit`, which
    ///         REVERTS a stale/wrong address) — so a mis-resolved operator
    ///         reverts the whole batch rather than crediting wrongly; the
    ///         off-chain sweep re-resolves and retries. Nodes with no fee are
    ///         SKIPPED (idempotent: a re-drained node yields 0). Amounts are
    ///         read on-chain, never passed in. Gate: `onlyOwnerOrMultiSigOwner`.
    ///         Emits one `OperatorFeeMigrated` per node that moved credit.
    function adminDrainOperatorFeesBatch(
        uint72[] calldata identityIds,
        address[] calldata operators
    ) external onlyOwnerOrMultiSigOwner {
        uint256 n = identityIds.length;
        require(n == operators.length, "length mismatch");
        for (uint256 i = 0; i < n; i++) {
            // Benign: owner-only batch; the callee is onlyConvictionNFT over
            // trusted protocol storage, moves plain ERC20 TRAC (no callback),
            // and is idempotent — no value-reentrancy vector, event-after-call ok.
            // slither-disable-next-line calls-loop,reentrancy-events
            uint96 t = stakingV10.drainOperatorFeeToCredit(identityIds[i], operators[i]);
            if (t > 0) emit OperatorFeeMigrated(identityIds[i], operators[i], t);
        }
    }

    /// @notice Self-service straggler backstop. The connected wallet drains ITS
    ///         OWN V8 stake (keyed by `keccak256(msg.sender)`) across `sourceNodes`
    ///         into its own migration credit. Admin-push (`adminDrainBatch`) is the
    ///         primary path; this exists so any delegator the off-chain sweep
    ///         missed can never be stranded. Permissionless and self-validating —
    ///         you can only ever drain the V8 key that hashes from your own
    ///         address, into your own credit. Works after V8 Staking is
    ///         unregistered (the drain goes through StakingStorage directly); the
    ///         worker's freeze gate means it is only callable once V8 Staking is
    ///         frozen (so it cannot race live V8 reward/sharding accounting).
    function selfMigrate(uint72[] calldata sourceNodes) external returns (uint96 credited) {
        credited = _drainAll(msg.sender, sourceNodes);
        if (credited == 0) revert NothingToMigrate();
        emit MigrationStarted(msg.sender, credited);
    }

    /// @notice Self-service operator-fee backstop: the node admin (msg.sender,
    ///         validated against ADMIN_KEY inside `drainOperatorFeeToCredit`)
    ///         drains the node's V8 operator fee into its own migration credit.
    ///         Same freeze-gated, post-unregister-safe properties as `selfMigrate`.
    function selfMigrateOperatorFee(uint72 identityId) external returns (uint96 credited) {
        credited = stakingV10.drainOperatorFeeToCredit(identityId, msg.sender);
        if (credited == 0) revert NothingToMigrate();
        emit OperatorFeeMigrated(identityId, msg.sender, credited);
    }

    /// @notice Spend `amount` of the caller's migration credit into a fresh V10
    ///         conviction position on `targetNode` at `lockTier`. Repeatable
    ///         until the credit is spent. Any tier-6/12 allocation receives the
    ///         conviction lock-credit (rev 5: universal).
    function allocate(
        uint72 targetNode,
        uint96 amount,
        uint40 lockTier
    ) external returns (uint256 tokenId) {
        if (targetNode == 0) revert InvalidIdentityId();
        if (amount == 0) revert ZeroAmount();
        tokenId = ++nextTokenId;
        // CEI: settle CSS state (credit debit + position) first, mint last.
        // `_mint` (not `_safeMint`) — same supported-caller rationale as
        // `createConviction`.
        bool creditApplied = stakingV10.allocateFromCredit(msg.sender, tokenId, targetNode, amount, lockTier);
        _mint(msg.sender, tokenId);
        emit Allocated(msg.sender, tokenId, targetNode, amount, lockTier, creditApplied);
    }

    /// @dev Drain `delegator`'s V8 stake across `sourceNodes` into credit,
    ///      summing the total. A node with no V8 stake contributes 0;
    ///      idempotent (a re-drained node yields 0).
    function _drainAll(
        address delegator,
        uint72[] calldata sourceNodes
    ) internal returns (uint96 total) {
        uint256 n = sourceNodes.length;
        for (uint256 i = 0; i < n; i++) {
            // Benign: onlyConvictionNFT callee over trusted storage, plain ERC20,
            // idempotent (see adminDrainBatch).
            // slither-disable-next-line calls-loop
            total += stakingV10.drainV8ToCredit(delegator, sourceNodes[i]);
        }
    }

    /// @notice Set the V8→V10 conviction lock-credit (seconds). Owner-settable;
    ///         set it before running the admin sweep. CSS caps it below the
    ///         tier-6 lock duration so a position's expiry cannot underflow.
    function setConvictionCreditSeconds(uint40 secondsValue) external onlyOwnerOrMultiSigOwner {
        stakingV10.setConvictionCreditSeconds(secondsValue);
    }

    // ---- Migration credit views (forward to the CSS ledger, OT-RFC-50 §0 Option B) ----

    function migrationCredit(address user) external view returns (uint96) {
        return convictionStakingStorage.migrationCredit(user);
    }

    function convictionCreditSeconds() external view returns (uint40) {
        return convictionStakingStorage.convictionCreditSeconds();
    }

    /// @notice DAO closer — D11. Sets the `v10LaunchEpoch` marker on
    ///         `ConvictionStakingStorage` to formally close the V10
    ///         migration window. After this, late drains are still possible via
    ///         `adminDrainBatch` / `adminMigrateToCredit`, but the launch-epoch
    ///         field is the canonical off-chain cut-off for retroactive
    ///         reward / analytics windows.
    function finalizeMigrationBatch(uint256 v10LaunchEpoch) external onlyOwnerOrMultiSigOwner {
        stakingV10.setV10LaunchEpoch(v10LaunchEpoch);
        emit MigrationBatchFinalized(v10LaunchEpoch);
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
