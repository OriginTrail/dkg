// SPDX-License-Identifier: Apache-2.0

pragma solidity ^0.8.20;

import {INamed} from "./interfaces/INamed.sol";
import {IVersioned} from "./interfaces/IVersioned.sol";
import {IInitializable} from "./interfaces/IInitializable.sol";
import {IPublishingConvictionErrors} from "./interfaces/IPublishingConvictionErrors.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {ContractStatus} from "./abstract/ContractStatus.sol";
import {Chronos} from "./storage/Chronos.sol";
import {EpochStorage} from "./storage/EpochStorage.sol";
import {PublishingMathLib} from "./libraries/PublishingMathLib.sol";
import {ParametersStorage} from "./storage/ParametersStorage.sol";
import {PublishingConvictionStorage} from "./storage/PublishingConvictionStorage.sol";
import {ConvictionStakingStorage} from "./storage/ConvictionStakingStorage.sol";
import {ShardingTableStorage} from "./storage/ShardingTableStorage.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title PublishingConviction
 * @notice Stateless V10 logic contract for publisher conviction accounts.
 *
 * V10 split-contract architecture (mirrors the staking-side
 * `StakingV10` / `ConvictionStakingStorage` / `DKGStakingConvictionNFT`
 * trio):
 *   - `PublishingConvictionStorage` (PCS) holds every byte of state:
 *     `Account` records, `windowSpent[id][w]`, `topUpBalance[id]`,
 *     agent registrations, and the governance cap.
 *   - This contract holds NO application state — only Hub-resolved
 *     contract references and metadata constants. Every business rule
 *     (account creation, lazy passive-sink settlement, post-expiry
 *     final sweep, active-sink epoch distribution, agent register /
 *     deregister, transfer-hook agent clear) lives here. The contract
 *     can be redeployed and re-registered on Hub without touching any
 *     account state.
 *   - `DKGPublishingConvictionNFT` (the NFT wrapper) keeps only the
 *     ERC-721 surface, the `_nextAccountId` mint counter, and the
 *     publisher-facing TRAC `transferFrom` paths. Every state read /
 *     write goes through PCS.
 *
 * Deterministic emission schedule (since 10.0.8):
 *   - Each account lifetime is divided into `lockDurationEpochs` billing
 *     windows of length `Chronos.epochLength()`, anchored at
 *     `Account.createdAtTimestamp`. Per-window base budget is
 *     `B = committedTRAC / lockDurationEpochs`.
 *   - The staker-pool distribution of the ENTIRE committed amount is
 *     written UP FRONT via `_scheduleRemaining`: each window's budget is
 *     spread over the `lockDurationEpochs` epoch-lengths that FOLLOW that
 *     window (prorated at chain-epoch boundaries via
 *     `PublishingMathLib.prorateActiveSink`, anchored purely on STORED
 *     account fields so the schedule is deterministic). The per-account
 *     `committedTRAC % lockDurationEpochs` dust rides the last window.
 *     The schedule is therefore a pure function of the commitment's own
 *     terms (amount, lock length, creation time), fixed once at account
 *     creation; publishing draws down the per-window budget against it
 *     (see `windowSpent` below) without re-emitting already-scheduled
 *     amounts. `lastSettledWindow == lockDurationEpochs` doubles as the
 *     "schedule written" marker: `createAccount` schedules immediately;
 *     accounts created before 10.0.8 are scheduled by the one-time
 *     `migrateEmissionSchedule` batch or lazily on their first touch
 *     (`coverPublishingCost` / `topUp` / `onTransfer` / `settle`).
 *   - `windowSpent[id][w]` remains the per-window BUDGET GATE for
 *     `coverPublishingCost`: spending draws down the allowance but emits
 *     nothing further for the base portion (that TRAC is already
 *     scheduled). Only the `topUpBalance` overflow drawn on a spend is
 *     emitted at spend time — forward over `lockDurationEpochs` from the
 *     current epoch, mirroring the base schedule's shape.
 *   - `topUpBalance[accountId]` is a separate prepaid usage buffer
 *     beyond the base budget. Any leftover at account expiry is swept to
 *     the staker pool (final chain epoch) via the same `settle()` path.
 *   - Invariant: over a full account lifetime, the total TRAC drained
 *     from the escrowed `committedTRAC + sum(topUps)` is conserved and
 *     splits into exactly two destinations:
 *       (a) the staker reward pool, credited via
 *           `EpochStorage.addTokensToEpochRange(STAKER_SHARD_ID, ...)`, and
 *       (b) the protocol treasury — as the treasury EMISSION pool
 *           (`TREASURY_SHARD_ID`, scheduled alongside (a) and paid out
 *           per elapsed epoch via `collectTreasuryEmission`) plus the
 *           immediate `ConvictionStakingStorage.transferStake` skims on
 *           the topUp flows.
 *     Fee basis since 10.0.8: the treasury fee
 *     (`ParametersStorage.protocolTreasuryFee`, bps — snapshot at
 *     schedule time) is ASSESSED on the base commitment as an
 *     accounting split inside `_scheduleRemaining`: each window's
 *     remainder schedules `net` to the staker shard and `fee` to the
 *     treasury shard on the SAME forward curve. No TRAC moves during
 *     the scheduling call — the frozen wrapper funds the vault only
 *     AFTER it ("forward-before-pull"), so a physical skim there would
 *     revert; the deferred, per-epoch `collectTreasuryEmission` payout
 *     runs strictly after mint completes, when the vault is funded.
 *     TopUp flows (spend-time overflow, expiry tail) keep the
 *     immediate skim — the vault is guaranteed funded at those points.
 *     So `pool(shard 1) + pool(shard 2) + immediate fees ==
 *     committedTRAC + sum(topUps)` holds, with every fee term 0 while
 *     `protocolTreasury == address(0)` (the live state on every chain
 *     today — note `protocolTreasuryFee` itself is live at 300 bps;
 *     the unset recipient is the kill switch).
 *
 * Caller gates:
 *   - Mutating entry points driven by user actions are
 *     `onlyConvictionNFT` — only the Hub-registered
 *     `DKGPublishingConvictionNFT` can invoke them. The wrapper passes
 *     `msg.sender` (the publisher / owner / KAV10 publishing-agent
 *     resolver) explicitly so this contract never trusts `tx.origin`.
 *   - `coverPublishingCost` additionally enforces N28: KAV10 calls the
 *     NFT, the NFT forwards here with the publishing agent's address,
 *     and we resolve the paying account via PCS's `agentToAccountId`.
 *     A trusted caller cannot pass a victim's accountId.
 *   - `settle(accountId)` is intentionally permissionless — anyone can
 *     bring an account's schedule current (pre-10.0.8 accounts) and,
 *     post-expiry, flush the topUp tail. The `fullySwept` flag
 *     short-circuits redundant work.
 *   - `migrateEmissionSchedule` is `onlyHubOwner` — a one-time batched
 *     convenience over the same idempotent `_scheduleRemaining` path.
 */
contract PublishingConviction is INamed, IVersioned, ContractStatus, IInitializable, IPublishingConvictionErrors {
    string private constant _NAME = "PublishingConviction";
    // Version history:
    //   1.0.0 — initial split-out from `DKGPublishingConvictionNFT` v2.0.0.
    //           Identical lazy-settlement semantics; no economic behavior
    //           changes. State now lives on `PublishingConvictionStorage`,
    //           accessed via `onlyContracts`-gated mutators. Caller gates
    //           tightened via `onlyConvictionNFT` for NFT-driven write
    //           paths so KAV10 cannot bypass the wrapper.
    //   1.0.1 — post-discount floor in `coverPublishingCost`. Integer
    //           truncation in `(baseCost * (BPS_DENOMINATOR -
    //           discountBps)) / BPS_DENOMINATOR` collapsed `baseCost ==
    //           1` against any non-zero `discountBps` to
    //           `discountedCost == 0`, skipping `windowSpent` accounting
    //           and the active-sink reward distribution. Twin of KAV10
    //           10.1.1's `tokenAmount > 0` floor, which protects only
    //           the direct-spend branch.
    //   protocol treasury fee — a `ParametersStorage`-configured bps cut
    //           is skimmed from every staker-bound amount (active sink,
    //           passive window sweeps, final dust/topUp tail) and paid to
    //           `protocolTreasury` via `ConvictionStakingStorage.transferStake`.
    //           Fees are accumulated and transferred ONCE per settlement
    //           call, AFTER all PCS state writes (effects-before-interactions),
    //           keeping the permissionless `settle()` reentrancy-safe.
    //           Dormant while `protocolTreasury == address(0)`.
    //   10.0.3 — OT-RFC-51 "Publishing Allocation": `createAccount` gains a
    //           `primaryNode` parameter and PRORATE-SEEDS the committed TRAC
    //           as per-epoch publishing allocation onto that node;
    //           `setPrimaryNode` re-designates the node, moving FUTURE-epoch
    //           allocation net-zero on K_total. Adds a `ShardingTableStorage`
    //           dependency for `nodeExists` validation.
    //           Gas: the seed/move proration schedule is computed ONCE per
    //           call (`_scheduleFor`) and indexed per epoch (`_amountForEpoch`)
    //           instead of recomputing `prorateActiveSink` + chronos reads on
    //           every loop iteration. Behavior-preserving: per-epoch amounts
    //           are byte-identical, so seed and move stay net-zero on K_total.
    // 10.0.5 — KC→KA terminology: error InvalidConvictionKcEpochs → InvalidConvictionKaEpochs
    //          (error selector change; no behavior change).
    // 10.0.8 — deterministic emission schedule. The staker-pool distribution of
    //          committedTRAC is written UP FRONT: each billing window's budget
    //          B = committedTRAC / lockDurationEpochs is spread over the
    //          lockDurationEpochs epoch-lengths FOLLOWING that window (prorated
    //          at chain-epoch boundaries via prorateActiveSink, anchored on
    //          stored account fields), with the % dust riding the last window —
    //          so the pool schedule is fully determined by the commitment's
    //          own terms at account creation. `coverPublishingCost` keeps
    //          the windowSpent budget accounting but no longer re-emits the
    //          base portion (only topUp-drawn overflow emits, forward over the
    //          lock from the current epoch). The passive window sweep
    //          (`_settleElapsed`/`_sweepWindowProrated`) is replaced by the
    //          idempotent `_scheduleRemaining` (same call sites); `settle()`
    //          and the transfer hook reduce to schedule-if-needed + the
    //          post-expiry topUp tail. `lastSettledWindow == lockDurationEpochs`
    //          doubles as the "schedule written" marker (no new storage).
    //          One-time Hub-owner batch `migrateEmissionSchedule(uint256[])`
    //          proactively schedules accounts created before this version;
    //          any account missed by the batch self-heals on first touch.
    //          `WindowSettled` is no longer emitted (declaration kept for
    //          indexer/ABI compatibility); new event `EmissionScheduled`.
    //          FEE-BASIS NOTE: the base-commitment treasury fee is ASSESSED
    //          at schedule time (bps snapshot) as an ACCOUNTING split — each
    //          window's remainder schedules net to `STAKER_SHARD_ID` and fee
    //          to `TREASURY_SHARD_ID` on the same forward curve — and PAID
    //          later, per elapsed epoch, via the permissionless
    //          `collectTreasuryEmission`. Structural reason for the split:
    //          the frozen wrapper's forward-before-pull order funds the CSS
    //          vault only AFTER the scheduling call, so a physical skim at
    //          create would revert on an empty vault once a treasury is
    //          wired; deferring only the TRANSFER (never the assessment)
    //          keeps the fee lever real on the base commitment. TopUp flows
    //          (spend-time overflow, expiry tail) keep the immediate
    //          `transferStake` skim. Accounts scheduled while
    //          `protocolTreasury == address(0)` schedule 100% to the staker
    //          shard (fee 0 by `_treasuryParams`) and are grandfathered —
    //          a later treasury wiring never reduces already-scheduled
    //          staker pools. No live impact today (recipient unset on all
    //          chains; the bps parameter itself is live at 300).
    string private constant _VERSION = "10.0.8";

    uint256 public constant BPS_DENOMINATOR = 10_000;
    /// @notice EpochStorage shard ID for the staker reward pool. Mirrors
    ///         the constant on `KnowledgeAssetsV10` and the legacy
    ///         stateful NFT so reward-distribution semantics are identical.
    uint256 public constant STAKER_SHARD_ID = 1;
    /// @notice EpochStorage shard ID for the protocol-treasury emission pool
    ///         (10.0.8). The base-commitment treasury fee is scheduled here —
    ///         same forward curve as the staker shard, split at schedule time
    ///         in `_scheduleRemaining` — and paid out per ELAPSED epoch via
    ///         `collectTreasuryEmission`. `EpochStorage`'s pool mappings are
    ///         generic over `shardId`, so this needs no storage change; shard
    ///         2 was previously unused by any Hub contract. The `distributed`
    ///         counter per epoch is the payout's idempotence source.
    uint256 public constant TREASURY_SHARD_ID = 2;

    // ============================================================
    //                  Hub-wired dependencies
    // ============================================================

    /// @notice Application-state store for every conviction account.
    ///         Resolved once at `initialize()` from Hub; can be
    ///         replaced by Hub re-registration in a future upgrade
    ///         without touching this contract's own (empty) state.
    PublishingConvictionStorage public publishingConvictionStorage;

    /// @notice EpochStorage is the cross-V10 active/passive sink: every
    ///         TRAC distribution to the staker reward pool flows through
    ///         `addTokensToEpochRange(STAKER_SHARD_ID, ...)`.
    EpochStorage public epochStorage;

    /// @notice Chronos drives both the chain-epoch cursor (`getCurrentEpoch`,
    ///         `epochAtTimestamp`, `timestampForEpoch`) and the billing-
    ///         window length (`epochLength`). Billing windows align in
    ///         duration to chain epochs but are anchored at the account's
    ///         creation timestamp, not at chain-epoch boundaries.
    Chronos public chronos;

    /// @notice ParametersStorage exposes the protocol-wide
    ///         `publishingConvictionEpochs` setting that fixes
    ///         `Account.lockDurationEpochs` at creation time.
    ParametersStorage public parametersStorage;

    /// @notice The V10 TRAC vault. Escrowed conviction TRAC
    ///         (`committedTRAC` + top-ups) physically lives here; the
    ///         only outflow is `transferStake`. Used to pay the protocol
    ///         treasury fee out of the escrow when it is skimmed from a
    ///         staker-bound amount.
    ConvictionStakingStorage public convictionStakingStorage;

    /// @notice OT-RFC-51: used to validate that a designated `primaryNode`
    ///         exists in the sharding table before any publishing allocation
    ///         is seeded onto it (`createAccount`) or moved to it
    ///         (`setPrimaryNode`). Mirrors the `nodeExists` gate KAV10 used
    ///         to apply on realized-publishing attribution.
    ShardingTableStorage public shardingTableStorage;

    // ============================================================
    //                          Events
    // ============================================================
    //
    // The wrapper-layer NFT does NOT duplicate these events; off-chain
    // indexers watching the conviction product subscribe to the logic
    // contract for state-change events. The NFT-layer emits only ERC-721
    // Transfer / Approval / etc.

    event AccountCreated(
        uint256 indexed accountId,
        address indexed owner,
        uint96 committedTRAC,
        uint16 discountBps,
        uint40 createdAtEpoch,
        uint40 expiresAtEpoch
    );
    event ToppedUp(uint256 indexed accountId, uint96 amount, uint96 newTopUpBalance);
    event CostCovered(
        uint256 indexed accountId,
        uint40 indexed epoch,
        uint96 baseCost,
        uint96 discountedCost,
        uint96 drawnFromEpoch,
        uint96 drawnFromTopUp
    );
    event AgentRegistered(uint256 indexed accountId, address indexed agent);
    event AgentDeregistered(uint256 indexed accountId, address indexed agent);
    /// @notice Emitted when an owner bulk-clears a PCA's agent allow-list via
    ///         `clearAgents`. `cleared` is the number of agents removed.
    event AgentsCleared(uint256 indexed accountId, address indexed owner, uint256 cleared);

    /// @notice The caller is not the current owner of `accountId`'s PCA NFT.
    error NotAccountOwner(uint256 accountId, address caller);
    /// @notice OT-RFC-51: emitted when an account's designated primary node
    ///         changes (including the initial designation at creation, where
    ///         `oldNode == 0`).
    event PrimaryNodeChanged(
        uint256 indexed accountId,
        uint72 indexed oldNode,
        uint72 indexed newNode,
        uint40 changeEpoch
    );
    /// @notice LEGACY (pre-10.0.8): was emitted per elapsed billing window by
    ///         the passive sweep. The declaration is kept so existing indexer
    ///         ABIs stay valid, but no 10.0.8 code path emits it — window
    ///         budgets are scheduled up front (see `EmissionScheduled`).
    event WindowSettled(
        uint256 indexed accountId,
        uint40 indexed windowIndex,
        uint40 startChainEpoch,
        uint40 endChainEpoch,
        uint96 remainderSwept
    );
    /// @notice Emitted when an account's remaining base-budget emission is
    ///         written to the pool schedules (10.0.8+). Fires exactly
    ///         once per account — at creation for new accounts, or at
    ///         migration / first touch for accounts created before 10.0.8.
    ///         `fromWindow`..`toWindow-1` are the windows scheduled by this
    ///         call; `scheduled` is the staker-pool (shard 1) total and
    ///         `treasuryFee` the treasury-emission-pool (shard 2) total —
    ///         together they equal the remaining base budget exactly.
    ///         `treasuryFee` is 0 while `protocolTreasury == address(0)` at
    ///         schedule time (see `_scheduleRemaining`).
    event EmissionScheduled(
        uint256 indexed accountId,
        uint40 fromWindow,
        uint40 toWindow,
        uint96 scheduled,
        uint96 treasuryFee
    );
    /// @notice Emitted by `collectTreasuryEmission`: the accrued treasury
    ///         emission pool over chain epochs `fromEpoch..toEpoch` (all
    ///         strictly elapsed) was paid to `protocolTreasury`. `amount`
    ///         can be 0 (nothing accrued / already collected — the call is
    ///         idempotent via EpochStorage's `distributed` counter).
    event TreasuryEmissionCollected(uint256 fromEpoch, uint256 toEpoch, uint96 amount);
    /// @notice Emitted once per account, when the post-expiry final sweep
    ///         finishes (base remainder + topUp buffer + dust all accounted).
    event AccountFinalSwept(
        uint256 indexed accountId,
        uint96 topUpSwept,
        uint96 dustSwept
    );

    // ============================================================
    //                          Errors
    // ============================================================

    error ZeroAddressDependency(string name);
    error OnlyConvictionNFT(address caller);
    error NoConvictionAccount(address publishingAgent);
    // `InsufficientAllowance` / `AccountExpired` are declared in
    // {IPublishingConvictionErrors} (shared with KnowledgeAssetsLifecycle's
    // fall-through catch) so the two contracts can never drift on selector.
    error InvalidAmount();
    error ZeroAgentAddress();
    error AgentCapReached(uint256 accountId, uint256 cap);
    error InvalidPublishingConvictionEpochs(uint256 configuredEpochs);
    /// @notice `kaEpochs` was 0 or exceeded the account's `lockDurationEpochs`.
    error InvalidConvictionKaEpochs(uint256 lockDurationEpochs, uint256 kaEpochs);
    error UnknownAccount(uint256 accountId);
    /// @notice OT-RFC-51: a designated `primaryNode` is not in the sharding table.
    error PrimaryNodeNotInShardingTable(uint72 node);
    /// @notice OT-RFC-51: `setPrimaryNode` called more than once in the same
    ///         chain epoch (rate-limit: at most once per epoch).
    error PrimaryNodeChangeRateLimited(uint256 accountId, uint40 lastChangeEpoch);
    /// @notice OT-RFC-51: `setPrimaryNode` called with `newNode == 0`. There is
    ///         no "clear designation" semantic — `primaryNode == 0` can only
    ///         mean never-seeded. Clearing would desync the stored node from
    ///         the still-seeded future buckets and let a later re-designation
    ///         double-credit `K_n`/`K_total` (which has no decrement path).
    error ZeroPrimaryNode();
    /// @notice OT-RFC-51: `setPrimaryNode` called with `newNode` equal to the
    ///         current `primaryNode`. A no-op re-designation would still burn
    ///         the once-per-epoch change slot, emit a spurious
    ///         `PrimaryNodeChanged`, and run a pointless self-move loop — so it
    ///         is rejected.
    error PrimaryNodeUnchanged(uint256 accountId, uint72 node);
    /// @notice `collectTreasuryEmission` called while `protocolTreasury` is
    ///         unset — there is no recipient to pay (and nothing can have
    ///         accrued on the treasury shard while it was unset).
    error TreasuryNotSet();
    /// @notice `collectTreasuryEmission` epoch range is malformed or reaches
    ///         into the present/future: `fromEpoch <= toEpoch < currentEpoch`
    ///         is required — the treasury collects an epoch only once it has
    ///         fully elapsed, mirroring when stakers can claim theirs.
    error InvalidCollectionRange(uint256 fromEpoch, uint256 toEpoch, uint256 currentEpoch);

    // solhint-disable-next-line no-empty-blocks
    constructor(address hubAddress) ContractStatus(hubAddress) {}

    /// @dev Wires every Hub-registered dependency. Reverts on any
    ///      missing slot so a half-initialized deploy is impossible
    ///      (mirrors the legacy stateful NFT's defensive checks).
    function initialize() external onlyHub {
        address pcs = hub.getContractAddress("PublishingConvictionStorage");
        if (pcs == address(0)) revert ZeroAddressDependency("PublishingConvictionStorage");
        publishingConvictionStorage = PublishingConvictionStorage(pcs);

        address es = hub.getContractAddress("EpochStorageV8");
        if (es == address(0)) revert ZeroAddressDependency("EpochStorageV8");
        epochStorage = EpochStorage(es);

        address ch = hub.getContractAddress("Chronos");
        if (ch == address(0)) revert ZeroAddressDependency("Chronos");
        chronos = Chronos(ch);

        address params = hub.getContractAddress("ParametersStorage");
        if (params == address(0)) revert ZeroAddressDependency("ParametersStorage");
        parametersStorage = ParametersStorage(params);

        address css = hub.getContractAddress("ConvictionStakingStorage");
        if (css == address(0)) revert ZeroAddressDependency("ConvictionStakingStorage");
        convictionStakingStorage = ConvictionStakingStorage(css);

        address sts = hub.getContractAddress("ShardingTableStorage");
        if (sts == address(0)) revert ZeroAddressDependency("ShardingTableStorage");
        shardingTableStorage = ShardingTableStorage(sts);
    }

    function name() external pure virtual override returns (string memory) {
        return _NAME;
    }

    function version() external pure virtual override returns (string memory) {
        return _VERSION;
    }

    // ============================================================
    //                       Caller gate
    // ============================================================

    /// @dev Lazy Hub lookup so the NFT wrapper address can be re-registered
    ///      without re-initializing this contract. Mirrors
    ///      `StakingV10.onlyConvictionNFT`.
    modifier onlyConvictionNFT() {
        if (msg.sender != hub.getContractAddress("DKGPublishingConvictionNFT")) {
            revert OnlyConvictionNFT(msg.sender);
        }
        _;
    }

    /// @dev Owner-gate for the direct-to-logic BULK agent actions (`clearAgents`,
    ///      `registerAgents`). DELIBERATE, isolated exception to the usual pattern
    ///      where owner validation lives on the NFT wrapper and logic is gated by
    ///      `onlyConvictionNFT`: the wrapper is non-upgradeable and exposes no
    ///      batch entry point, so these validate ownership here against the live
    ///      `ownerOf`. New SINGLE agent ops still belong on the wrapper; only the
    ///      batch operations the frozen wrapper cannot host live here. `ownerOf`
    ///      reverts for a nonexistent account (and for an unresolvable address(0)
    ///      NFT), so a bad id cannot slip past this gate.
    modifier onlyCurrentPcaOwner(uint256 accountId) {
        address nftAddr = hub.getContractAddress("DKGPublishingConvictionNFT");
        if (IERC721(nftAddr).ownerOf(accountId) != msg.sender) {
            revert NotAccountOwner(accountId, msg.sender);
        }
        _;
    }

    // ============================================================
    //                  Account lifecycle
    // ============================================================

    /**
     * @notice Persist the `Account` record for a freshly-minted NFT.
     *
     * @dev Called by `DKGPublishingConvictionNFT.createAccount` AFTER it
     *      has allocated `accountId` from its own monotonic mint counter
     *      and minted the ERC-721 to `publisher`. The wrapper handles the
     *      TRAC `transferFrom(publisher → ConvictionStakingStorage)`
     *      itself; this function only writes accounting state.
     *
     *      Mint-then-write ordering matters for the transfer hook on the
     *      NFT wrapper: by the time the transfer hook runs (mint case
     *      `from == address(0)`), the storage record has been populated.
     *      The hook short-circuits on mint/burn so this ordering is fine.
     *
     *      `lockDurationEpochs` is fixed by the protocol-wide
     *      `parametersStorage.publishingConvictionEpochs()` setting at
     *      creation. The discount tier is set once from the 6-tier
     *      ladder applied to `committedTRAC`; subsequent top-ups do NOT
     *      change the tier or extend the expiry.
     */
    function createAccount(
        address publisher,
        uint256 accountId,
        uint96 committedTRAC,
        uint72 primaryNode
    ) external onlyConvictionNFT {
        if (committedTRAC == 0) revert InvalidAmount();

        // OT-RFC-51: a designated node must exist in the sharding table
        // before any allocation is seeded onto it. `0` is the explicit
        // "no designated node" sentinel and skips both the check and the
        // seeding entirely.
        if (primaryNode != 0 && !shardingTableStorage.nodeExists(primaryNode)) {
            revert PrimaryNodeNotInShardingTable(primaryNode);
        }

        uint40 currentEpoch = uint40(chronos.getCurrentEpoch());
        uint40 createdAtTimestamp = uint40(block.timestamp);

        uint256 configuredEpochs = parametersStorage.publishingConvictionEpochs();
        if (configuredEpochs == 0 || configuredEpochs > type(uint16).max) {
            revert InvalidPublishingConvictionEpochs(configuredEpochs);
        }
        uint16 lockDurationEpochs = uint16(configuredEpochs);

        uint256 epochLength = chronos.epochLength();
        uint40 expiresAtTimestamp = uint40(
            uint256(createdAtTimestamp) + (uint256(lockDurationEpochs) * epochLength)
        );
        uint40 expiresAtEpoch = uint40(
            chronos.epochAtTimestamp(uint256(expiresAtTimestamp) - 1)
        ) + 1;
        uint16 discountBps = uint16(getDiscountBps(committedTRAC));

        PublishingConvictionStorage.Account memory acct = PublishingConvictionStorage.Account({
            committedTRAC: committedTRAC,
            createdAtEpoch: currentEpoch,
            expiresAtEpoch: expiresAtEpoch,
            createdAtTimestamp: createdAtTimestamp,
            expiresAtTimestamp: expiresAtTimestamp,
            lockDurationEpochs: lockDurationEpochs,
            discountBps: discountBps,
            lastSettledWindow: 0,
            fullySwept: false,
            primaryNode: primaryNode,
            lastPrimaryNodeChangeEpoch: currentEpoch
        });

        publishingConvictionStorage.createAccount(accountId, acct);

        // OT-RFC-51: prorate-seed the committed TRAC as per-epoch publishing
        // allocation onto the designated node. The seeded total over the
        // lock equals `committedTRAC` by construction (see `_scheduleFor`).
        // The proration schedule is computed ONCE (it is loop-invariant) and
        // each epoch's amount is read off it via `_amountForEpoch`.
        if (primaryNode != 0) {
            PublishingMathLib.ActiveSinkRange[3] memory ranges = _scheduleFor(acct);
            uint256 lockEpochs = uint256(lockDurationEpochs);
            uint256 lastEpoch = uint256(currentEpoch) + lockEpochs;
            for (uint256 e = uint256(currentEpoch); e <= lastEpoch; e++) {
                uint96 amount = _amountForEpoch(ranges, committedTRAC, lockEpochs, e);
                if (amount > 0) {
                    epochStorage.addEpochPublishingAllocation(primaryNode, e, amount);
                }
            }
        }

        emit AccountCreated(accountId, publisher, committedTRAC, discountBps, currentEpoch, expiresAtEpoch);
        // Only emit a designation event when a node is actually designated at
        // creation. createAccount(_, 0) is an inert PCA (no seeding), so a
        // PrimaryNodeChanged(_, 0, 0, _) would be a spurious no-op that
        // indexers would otherwise record as a real assignment.
        if (primaryNode != 0) {
            emit PrimaryNodeChanged(accountId, 0, primaryNode, currentEpoch);
        }

        // 10.0.8: write the account's full staker-pool emission schedule up
        // front (windowSpent is all-zero at creation, so this schedules the
        // entire commitment). Runs for EVERY account — the money emission is
        // node-independent (the pool is global); only the K_n score seeding
        // above is gated on a designated node. Placed last: its internal
        // `_payTreasury` is the only token-moving external call in this
        // function and must be the final action (reentrancy discipline).
        _scheduleRemaining(acct, accountId);
    }

    // ============================================================
    //          OT-RFC-51 publishing-allocation schedule
    // ============================================================

    /**
     * @notice Re-designate the primary node for `accountId`, moving FUTURE
     *         epochs' publishing allocation from the old node to the new one.
     *
     * @dev Called by the NFT wrapper after it has validated `msg.sender ==
     *      ownerOf(accountId)`.
     *
     *      Rules (OT-RFC-51):
     *        - Rate-limited to at most once per chain epoch
     *          (`currentEpoch > acct.lastPrimaryNodeChangeEpoch`).
     *        - The NEW node must exist in the sharding table; the OLD node is
     *          NOT re-validated (it may have exited the table since seeding).
     *        - Only FUTURE epochs `e >= currentEpoch + 1` (within the lock)
     *          are moved. Past/current epochs stay credited to the old node,
     *          preserving already-realized scoring windows.
     *        - Per-epoch amounts are recomputed from the SAME stored-field
     *          schedule used at seeding, so each `move` byte-matches the seed
     *          and the epoch total (K_total) is unchanged.
     */
    function setPrimaryNode(uint256 accountId, uint72 newNode) external onlyConvictionNFT {
        PublishingConvictionStorage.Account memory acct =
            publishingConvictionStorage.getAccount(accountId);

        uint40 currentEpoch = uint40(chronos.getCurrentEpoch());
        if (currentEpoch <= acct.lastPrimaryNodeChangeEpoch) {
            revert PrimaryNodeChangeRateLimited(accountId, acct.lastPrimaryNodeChangeEpoch);
        }
        // OT-RFC-51: no "clear designation" semantic. Allowing newNode == 0
        // would null the stored primaryNode while leaving the old node's
        // future buckets seeded (the move loop credits/decrements neither when
        // newNode == 0), and a later re-designation would take the add-branch
        // and double-credit K_n / K_total with no offsetting decrement
        // (K_total has no decrement path). Reject it.
        if (newNode == 0) revert ZeroPrimaryNode();
        if (!shardingTableStorage.nodeExists(newNode)) {
            revert PrimaryNodeNotInShardingTable(newNode);
        }

        uint72 oldNode = acct.primaryNode;
        // A no-op re-designation to the same node would burn the once-per-epoch
        // change slot, emit a spurious PrimaryNodeChanged, and run a pointless
        // self-move loop — reject it.
        if (newNode == oldNode) revert PrimaryNodeUnchanged(accountId, newNode);

        // Move only FUTURE epochs within the lock. The schedule's last
        // credited epoch is `createdAtEpoch + lockDurationEpochs`. The
        // proration schedule is computed ONCE (it is loop-invariant and
        // anchored to the stored `Account`, so it byte-matches the
        // create-time seed) and each epoch's amount is read off it via
        // `_amountForEpoch` — making each move exactly reverse its seed.
        PublishingMathLib.ActiveSinkRange[3] memory ranges = _scheduleFor(acct);
        uint256 lockEpochs = uint256(acct.lockDurationEpochs);
        uint256 lastEpoch = uint256(acct.createdAtEpoch) + lockEpochs;
        // Effects before interactions (checks-effects-interactions): persist the
        // new designation BEFORE the external EpochStorage moves below. The move
        // loop uses only the locals captured above (oldNode/newNode/ranges/acct),
        // so this reordering is behaviour-preserving; it also clears Slither's
        // reentrancy finding (the EpochStorage callees are Hub-registered
        // onlyContracts storage, but CEI ordering is the right discipline).
        publishingConvictionStorage.setPrimaryNodeData(accountId, newNode, currentEpoch);

        for (uint256 e = uint256(currentEpoch) + 1; e <= lastEpoch; e++) {
            uint96 amount = _amountForEpoch(ranges, acct.committedTRAC, lockEpochs, e);
            if (amount == 0) continue;
            // newNode is guaranteed non-zero by the guard above.
            if (oldNode != 0) {
                epochStorage.moveEpochPublishingAllocation(oldNode, newNode, e, amount);
            } else {
                // First designation of a PCA created with primaryNode == 0:
                // no prior node was seeded for these epochs, so credit new.
                epochStorage.addEpochPublishingAllocation(newNode, e, amount);
            }
        }

        emit PrimaryNodeChanged(accountId, oldNode, newNode, currentEpoch);
    }

    /// @dev OT-RFC-51 single source of truth for the per-epoch publishing
    ///      allocation schedule. Reconstructs the proration inputs PURELY
    ///      from STORED `Account` fields (not live `chronos.timeUntilNextEpoch`)
    ///      so the schedule is deterministic and identical whether called at
    ///      seeding time (`createAccount`) or at a later re-designation
    ///      (`setPrimaryNode`). Without this anchoring, a later
    ///      re-designation would recompute a different final-partial-epoch
    ///      amount and the `moveEpochPublishingAllocation` subtraction would
    ///      underflow.
    ///
    ///      Computed ONCE per call (the proration + the two chronos reads are
    ///      loop-invariant — they depend only on the stored `Account`, never on
    ///      the per-epoch cursor), then the seed / move loops index each epoch's
    ///      amount off the returned ranges via {_amountForEpoch}. This is the
    ///      gas-hoist of OT-RFC-51's first pass: `prorateActiveSink` +
    ///      `timestampForEpoch` + `epochLength` previously ran on every loop
    ///      iteration (O(lockDurationEpochs) redundant work) for a result that
    ///      does not change across the loop.
    function _scheduleFor(
        PublishingConvictionStorage.Account memory acct
    ) internal view returns (PublishingMathLib.ActiveSinkRange[3] memory ranges) {
        uint40 anchorEpoch = acct.createdAtEpoch;
        uint256 epochs = uint256(acct.lockDurationEpochs);
        // Time the account had remaining in its creation epoch, derived from
        // stored fields: (start of next epoch) - createdAtTimestamp.
        uint256 nextEpochStart = chronos.timestampForEpoch(uint256(anchorEpoch) + 1);
        uint256 timeRemainingInCurrentEpoch =
            nextEpochStart > uint256(acct.createdAtTimestamp)
                ? nextEpochStart - uint256(acct.createdAtTimestamp)
                : 0;

        ranges = PublishingMathLib.prorateActiveSink(
            acct.committedTRAC,
            anchorEpoch,
            epochs,
            chronos.epochLength(),
            timeRemainingInCurrentEpoch
        );
    }

    /// @dev OT-RFC-51 per-epoch reader over a precomputed {_scheduleFor}
    ///      result. PURE — no external reads — so the seed / move loops pay the
    ///      proration cost exactly once (in {_scheduleFor}) and only this cheap
    ///      branch per epoch. Returns the allocation credited to epoch `e`:
    ///        - createdAtEpoch              -> currentEpochAllocation (partial)
    ///        - createdAtEpoch+1 .. +(N-1)  -> baseTokensPerFullEpoch (each)
    ///        - createdAtEpoch+N            -> finalEpochAllocation (dust-corrected)
    ///      where N = lockDurationEpochs. Any other epoch returns 0.
    ///      Sum over [createdAtEpoch, createdAtEpoch+N] == committedTRAC.
    ///
    ///      The returned values are BYTE-IDENTICAL to the prior per-iteration
    ///      `_perEpochAmount(acct, e)` (partial-first = `ranges[0].tokenAmount`,
    ///      each full epoch = `committedTRAC / epochs`, final =
    ///      `ranges[2].tokenAmount`), so seed and move can never drift.
    function _amountForEpoch(
        PublishingMathLib.ActiveSinkRange[3] memory ranges,
        uint96 committedTRAC,
        uint256 epochs,
        uint256 e
    ) internal pure returns (uint96) {
        // ranges[0]: partial creation epoch (single epoch).
        if (ranges[0].tokenAmount > 0 && e == uint256(ranges[0].startEpoch)) {
            return ranges[0].tokenAmount;
        }
        // ranges[1]: full epochs [anchor+1, anchor+epochs-1]; the range's
        // tokenAmount is the SUM over those epochs, so expand per-epoch as
        // baseTokensPerFullEpoch = committedTRAC / epochs.
        if (
            ranges[1].tokenAmount > 0 &&
            e >= uint256(ranges[1].startEpoch) &&
            e <= uint256(ranges[1].endEpoch)
        ) {
            return uint96(uint256(committedTRAC) / epochs);
        }
        // ranges[2]: final partial epoch (dust-corrected) at anchor+epochs.
        if (ranges[2].tokenAmount > 0 && e == uint256(ranges[2].startEpoch)) {
            return ranges[2].tokenAmount;
        }
        return 0;
    }

    /**
     * @notice Settle elapsed windows then bump the persistent top-up
     *         buffer. NFT wrapper owns ownership validation; this
     *         function only enforces "amount > 0" and "not expired".
     *
     * @dev TRAC `transferFrom(owner → CSS vault)` happens on the NFT
     *      wrapper, not here. We only update accounting state.
     */
    function topUp(
        address /* owner */,
        uint256 accountId,
        uint96 amount
    ) external onlyConvictionNFT {
        if (amount == 0) revert InvalidAmount();

        PublishingConvictionStorage.Account memory acct =
            publishingConvictionStorage.getAccount(accountId);

        if (block.timestamp >= uint256(acct.expiresAtTimestamp)) {
            revert AccountExpired(accountId, acct.expiresAtEpoch);
        }

        // Bring a pre-10.0.8 account's emission schedule current (no-op for
        // accounts scheduled at creation).
        _scheduleRemaining(acct, accountId);

        publishingConvictionStorage.increaseTopUpBalance(accountId, amount);

        emit ToppedUp(accountId, amount, publishingConvictionStorage.topUpBalance(accountId));
    }

    // ============================================================
    //              Publishing-cost coverage (active sink)
    // ============================================================

    /**
     * @notice Charge a publishing agent's conviction allowance for
     *         `baseCost` and fund the published KA's epoch range from
     *         the escrowed TRAC sitting in the CSS vault.
     *
     * @dev Authorization (N28-fixed):
     *        - `onlyConvictionNFT`: this function may only be invoked by
     *          the NFT wrapper. KAV10 calls the NFT, the NFT validates
     *          KAV10 as the outer caller, and the NFT forwards here.
     *        - The publishing agent's accountId is resolved from PCS's
     *          `agentToAccountId` map; KAV10 cannot pass a victim's
     *          accountId.
     *
     *      Behavior (10.0.8):
     *        1. Reject if the publish's KA lifetime (`kaEpochs`) exceeds
     *           the account's `lockDurationEpochs`.
     *        2. Bring a pre-10.0.8 account's emission schedule current
     *           (no-op for accounts scheduled at creation).
     *        3. Compute `discountedCost = baseCost * (1 - discountBps/1e4)`.
     *        4. Spend order against the current window: base allowance
     *           first, then `topUpBalance` overflow. `windowSpent` is a
     *           pure BUDGET GATE — the base portion emits nothing here
     *           because that TRAC is already on the emission schedule.
     *        5. Emit ONLY the topUp-drawn overflow, forward over
     *           `lockDurationEpochs` from the current epoch (PCA money
     *           always emits on the lock-shaped schedule; `kaStartEpoch`
     *           no longer shapes emission and is kept for ABI stability).
     *
     *      Does NOT physically move TRAC; the escrowed amount is already
     *      in the CSS vault from `createAccount` / `topUp`. Returns the
     *      discounted amount for KAV10's internal accounting.
     */
    function coverPublishingCost(
        address publishingAgent,
        uint96 baseCost,
        uint40 /* kaStartEpoch */,
        uint40 kaEpochs
    ) external onlyConvictionNFT returns (uint96 discountedCost) {
        uint256 accountId = publishingConvictionStorage.agentToAccountId(publishingAgent);
        if (accountId == 0) revert NoConvictionAccount(publishingAgent);

        PublishingConvictionStorage.Account memory acct =
            publishingConvictionStorage.getAccount(accountId);

        if (block.timestamp >= uint256(acct.expiresAtTimestamp)) {
            revert AccountExpired(accountId, acct.expiresAtEpoch);
        }
        if (kaEpochs == 0 || kaEpochs > uint40(acct.lockDurationEpochs)) {
            revert InvalidConvictionKaEpochs(uint256(acct.lockDurationEpochs), uint256(kaEpochs));
        }

        // Bring a pre-10.0.8 account's emission schedule current BEFORE the
        // spend below mutates `windowSpent` — the schedule subtracts only
        // amounts that were emitted under the pre-10.0.8 active sink, and
        // this ordering is what keeps that subtraction exact. No-op for
        // accounts scheduled at creation. (`acct.lastSettledWindow` is
        // updated in memory, keeping the snapshot consistent with storage.)
        _scheduleRemaining(acct, accountId);

        uint40 currentEpoch = uint40(chronos.getCurrentEpoch());
        uint40 currentBillingWindow = _currentBillingWindow(acct);

        discountedCost = uint96(
            (uint256(baseCost) * (BPS_DENOMINATOR - uint256(acct.discountBps))) / BPS_DENOMINATOR
        );
        // Post-discount floor — mirror of the on-chain `tokenAmount > 0`
        // floor on the direct-spend branch (KAV10 10.1.1). Integer
        // truncation in the discount math collapses any
        // `baseCost * (BPS_DENOMINATOR - discountBps) < BPS_DENOMINATOR`
        // case (most concretely: `baseCost == 1` with any non-zero
        // discount on the 6-tier ladder) to `discountedCost == 0`, which
        // would skip both window-spent accounting AND the active-sink
        // reward distribution — i.e. a free conviction-discounted
        // publish. KAV10's base-amount floor only protects the
        // direct-spend branch; this is its conviction-branch twin.
        // Guard with `baseCost > 0` so the trivially-honest
        // `coverPublishingCost(_, 0, _, _)` shape (no path exercises it
        // today; defensive) stays a no-op instead of being inflated to 1.
        if (discountedCost == 0 && baseCost > 0) {
            discountedCost = 1;
        }

        uint96 baseAllowance = acct.committedTRAC / uint96(acct.lockDurationEpochs);
        uint96 spent = publishingConvictionStorage.windowSpent(accountId, currentBillingWindow);
        uint96 epochRemaining = spent < baseAllowance ? baseAllowance - spent : 0;

        uint96 drawnFromEpoch;
        uint96 drawnFromTopUp;

        if (discountedCost <= epochRemaining) {
            drawnFromEpoch = discountedCost;
        } else {
            drawnFromEpoch = epochRemaining;
            uint96 shortfall = discountedCost - epochRemaining;
            uint96 buffer = publishingConvictionStorage.topUpBalance(accountId);
            if (shortfall > buffer) {
                revert InsufficientAllowance(
                    accountId,
                    currentEpoch,
                    discountedCost,
                    epochRemaining + buffer
                );
            }
            drawnFromTopUp = shortfall;
            publishingConvictionStorage.decreaseTopUpBalance(accountId, shortfall);
        }

        if (drawnFromEpoch > 0) {
            publishingConvictionStorage.increaseWindowSpent(accountId, currentBillingWindow, drawnFromEpoch);
        }

        // 10.0.8: the base portion (`drawnFromEpoch`) emits NOTHING here —
        // that TRAC is already on the emission schedule written at
        // creation/migration, and `windowSpent` above is purely the budget
        // gate. Only the topUp-drawn overflow is new money for the pool; it
        // emits forward over the lock length from the current epoch,
        // mirroring the base schedule's shape (PCA money always emits on
        // the lock-shaped schedule, independent of the KA's lifetime).
        if (drawnFromTopUp > 0) {
            (address treasury, uint256 feeBps) = _treasuryParams();
            uint96 fee = _feeOf(drawnFromTopUp, feeBps);
            uint96 net = drawnFromTopUp - fee;
            if (net > 0) {
                _distributeProrated(net, currentEpoch, uint256(acct.lockDurationEpochs));
            }
            // PCS window/topUp writes (above) are already persisted, so
            // paying the treasury last keeps effects-before-interactions.
            _payTreasury(treasury, fee);
        }

        emit CostCovered(accountId, currentEpoch, baseCost, discountedCost, drawnFromEpoch, drawnFromTopUp);
    }

    /// @dev Mirrors `KnowledgeAssetsV10._distributeTokens` exactly so
    ///      conviction-funded reward curves match direct-spend curves.
    ///      Splits `amount` across `storageUnits + 1` chain epochs
    ///      starting at `firstEpoch`: the partial first epoch gets a
    ///      time-weighted slice, the middle full epochs each get the
    ///      base, and the partial tail epoch absorbs the remainder
    ///      (including any rounding dust).
    function _distributeProrated(
        uint96 amount,
        uint40 firstEpoch,
        uint256 storageUnits
    ) internal {
        uint256 epochLengthSec = chronos.epochLength();
        uint256 timeRemainingInCurrentEpoch = chronos.timeUntilNextEpoch();
        PublishingMathLib.ActiveSinkRange[3] memory ranges = PublishingMathLib.prorateActiveSink(
            amount,
            firstEpoch,
            storageUnits,
            epochLengthSec,
            timeRemainingInCurrentEpoch
        );

        for (uint256 i; i < ranges.length; i++) {
            if (ranges[i].tokenAmount == 0) continue;
            epochStorage.addTokensToEpochRange(
                STAKER_SHARD_ID,
                ranges[i].startEpoch,
                ranges[i].endEpoch,
                ranges[i].tokenAmount
            );
        }
    }

    // ============================================================
    //                  Protocol treasury fee
    // ============================================================

    /// @dev Snapshot the treasury config once per call so the per-window
    ///      loop in `_scheduleRemaining` (and `_finalSweep`) doesn't pay a
    ///      cross-contract read on every iteration. Returns
    ///      `(address(0), 0)` while the fee is disabled (no treasury
    ///      wired), which makes `_feeOf` a no-op and `_payTreasury` skip.
    function _treasuryParams() internal view returns (address treasury, uint256 bps) {
        treasury = parametersStorage.protocolTreasury();
        if (treasury == address(0)) return (address(0), 0);
        bps = uint256(parametersStorage.protocolTreasuryFee());
    }

    /// @dev Treasury fee (TRAC) for a single staker-bound `amount` given a
    ///      pre-read `bps`. `bps` is capped at
    ///      `ParametersStorage.MAX_PROTOCOL_TREASURY_FEE` (10%), so the
    ///      returned fee never exceeds `amount` and `amount - fee` cannot
    ///      underflow.
    function _feeOf(uint96 amount, uint256 bps) internal pure returns (uint96) {
        if (bps == 0) return 0;
        return uint96((uint256(amount) * bps) / BPS_DENOMINATOR);
    }

    /// @dev Pay an accumulated treasury `totalFee` out of the escrowed
    ///      conviction TRAC. MUST be the LAST statement in any function
    ///      that mutated PCS state: this `transferStake` is the only
    ///      external-call reentrancy surface on the permissionless
    ///      `settle()` path, and running it after the settlement cursor /
    ///      `fullySwept` flag are persisted makes any re-entry a no-op.
    function _payTreasury(address treasury, uint96 totalFee) internal {
        if (totalFee == 0 || treasury == address(0)) return;
        convictionStakingStorage.transferStake(treasury, totalFee);
    }

    /**
     * @notice Pay the protocol treasury its accrued emission pool
     *         (`TREASURY_SHARD_ID`) for the fully ELAPSED chain epochs
     *         `fromEpoch..toEpoch`. Permissionless — the recipient is
     *         hard-wired to `ParametersStorage.protocolTreasury`, so any
     *         caller can only ever move funds to the governance-configured
     *         address. Idempotent per epoch: EpochStorage's `distributed`
     *         counter tracks what has been paid, and only the remaining
     *         pool (`getEpochRemainingPool`) is transferred, so re-calls
     *         and overlapping ranges are safe no-ops.
     *
     * @dev  `toEpoch < currentEpoch` is required: the treasury collects an
     *       epoch only once it has fully elapsed, mirroring when stakers
     *       can claim that epoch's rewards — the treasury is never paid
     *       ahead of the stakers it is scheduled alongside. Solvency: every
     *       amount on the treasury shard was scheduled inside a completed
     *       mint (the wrapper funds the vault in the same transaction,
     *       right after the scheduling call), so by the time an epoch has
     *       elapsed the vault holds the backing TRAC. Effects before
     *       interactions: `payOutEpochTokens` persists `distributed` per
     *       epoch BEFORE the single `transferStake` at the end.
     */
    function collectTreasuryEmission(uint256 fromEpoch, uint256 toEpoch) external {
        address treasury = parametersStorage.protocolTreasury();
        if (treasury == address(0)) revert TreasuryNotSet();

        uint256 currentEpoch = chronos.getCurrentEpoch();
        if (fromEpoch > toEpoch || toEpoch >= currentEpoch) {
            revert InvalidCollectionRange(fromEpoch, toEpoch, currentEpoch);
        }

        uint96 total;
        for (uint256 epoch = fromEpoch; epoch <= toEpoch; epoch++) {
            uint96 amount = epochStorage.getEpochRemainingPool(TREASURY_SHARD_ID, epoch);
            if (amount == 0) continue;
            // `identityId = 0` — the treasury is not a node; `nodesPaidOut[0]`
            // is a dead-letter counter. `distributed[shard][epoch]` is the
            // idempotence source consumed by `getEpochRemainingPool` above.
            epochStorage.payOutEpochTokens(TREASURY_SHARD_ID, epoch, 0, amount);
            total += amount;
        }

        emit TreasuryEmissionCollected(fromEpoch, toEpoch, total);
        _payTreasury(treasury, total);
    }

    // ============================================================
    //          Lazy settlement (passive sink + final tail)
    // ============================================================

    /**
     * @notice Public settlement entry point. Permissionless: anyone
     *         (account owner, staker pool watcher, automation bot) can
     *         call it. Idempotent — subsequent calls after the post-expiry
     *         final sweep are no-ops.
     *
     * @dev Flow (10.0.8):
     *        - Writes the account's remaining base-budget emission
     *          schedule if it has not been written yet (only reachable
     *          for accounts created before 10.0.8 that the
     *          `migrateEmissionSchedule` batch has not covered — a
     *          public self-heal path). No-op otherwise.
     *        - Post-expiry: sweeps any leftover `topUpBalance` to the
     *          final chain epoch and sets `fullySwept = true`.
     *
     *      No `onlyConvictionNFT` gate — public on purpose. Unknown
     *      accounts revert. `fullySwept` accounts short-circuit before
     *      any work.
     */
    function settle(uint256 accountId) external {
        if (!publishingConvictionStorage.accountExists(accountId)) {
            revert UnknownAccount(accountId);
        }
        PublishingConvictionStorage.Account memory acct =
            publishingConvictionStorage.getAccount(accountId);
        if (acct.fullySwept) return;

        _scheduleRemaining(acct, accountId);

        if (block.timestamp >= uint256(acct.expiresAtTimestamp)) {
            _finalSweep(acct, accountId);
        }
    }

    /**
     * @notice One-time batched migration to the 10.0.8 deterministic
     *         emission schedule: writes the remaining schedule for every
     *         account in `accountIds` (accounts created before 10.0.8).
     *         Idempotent per account — already-scheduled accounts (including
     *         every account created at 10.0.8+) are skipped by the
     *         `lastSettledWindow == lockDurationEpochs` marker, so the batch
     *         can be safely re-run or split across transactions.
     *
     * @dev `onlyHubOwner` for release-day control of batch sizing/ordering;
     *      the underlying `_scheduleRemaining` is the same idempotent path
     *      the public `settle()` self-heal uses, so this gate is operational
     *      convenience, not a safety boundary. Reverts on an unknown id
     *      (owner-driven call — a typo should fail loudly, not skip).
     */
    function migrateEmissionSchedule(uint256[] calldata accountIds) external onlyHubOwner {
        for (uint256 i = 0; i < accountIds.length; i++) {
            uint256 accountId = accountIds[i];
            if (!publishingConvictionStorage.accountExists(accountId)) {
                revert UnknownAccount(accountId);
            }
            PublishingConvictionStorage.Account memory acct =
                publishingConvictionStorage.getAccount(accountId);
            _scheduleRemaining(acct, accountId);
        }
    }

    /// @notice Bring the account's emission schedule current from the NFT
    ///         wrapper's transfer hook (pre-10.0.8 accounts self-heal at
    ///         ownership change; post-expiry the topUp tail is flushed).
    ///         Restricted to the NFT.
    /// @dev    The agent allow-list is intentionally PRESERVED across transfer —
    ///         it travels with the PCA like the rest of the account's state. Use
    ///         the owner-gated `clearAgents` to reset it explicitly (a new owner
    ///         can drop inherited agents; an owner can wipe them before handing
    ///         the PCA over). `from`/`to` are unused internally — the wrapper
    ///         passes them so a future event extension needs no interface change.
    function onTransfer(
        uint256 accountId,
        address /* from */,
        address /* to */
    ) external onlyConvictionNFT {
        PublishingConvictionStorage.Account memory acct =
            publishingConvictionStorage.getAccount(accountId);
        if (acct.lockDurationEpochs != 0 && !acct.fullySwept) {
            _scheduleRemaining(acct, accountId);
            if (block.timestamp >= uint256(acct.expiresAtTimestamp)) {
                _finalSweep(acct, accountId);
            }
        }
    }

    /// @notice Internal helper: write the account's REMAINING base-budget
    ///         emission schedule to the staker pool — every not-yet-scheduled
    ///         window's `B − windowSpent[w]` (plus the `committedTRAC % lock`
    ///         dust on the last window), each spread forward over the
    ///         `lockDurationEpochs` epoch-lengths that follow that window.
    ///         Idempotent: `lastSettledWindow == lockDurationEpochs` is the
    ///         "schedule written" marker, set here in one shot.
    /// @dev    For accounts created at 10.0.8+ this runs at `createAccount`
    ///         (windowSpent all zero → schedules the full commitment). For
    ///         accounts created earlier it runs at `migrateEmissionSchedule`
    ///         or on their first touch; subtracting `windowSpent[w]` is exact
    ///         because those spent amounts were already emitted at spend time
    ///         under the pre-10.0.8 active sink (conservation per window:
    ///         scheduled (B − spent) + already-emitted (spent) == B).
    ///         Anchored purely on STORED account fields (never `block.timestamp`)
    ///         so the resulting schedule is identical whenever it is written.
    ///         Mutates `acct.lastSettledWindow` in memory so callers see a
    ///         consistent snapshot after the call.
    function _scheduleRemaining(
        PublishingConvictionStorage.Account memory acct,
        uint256 accountId
    ) internal {
        uint40 maxWindow = uint40(acct.lockDurationEpochs);
        uint40 fromWindow = uint40(acct.lastSettledWindow);
        if (fromWindow >= maxWindow) return;

        // Slither divide-before-multiply — the truncation is bounded to
        // (lockDurationEpochs − 1) wei and the dust is re-added below, so
        // the scheduled sum equals committedTRAC exactly.
        // slither-disable-next-line divide-before-multiply
        uint96 baseAllowance = acct.committedTRAC / uint96(acct.lockDurationEpochs);
        uint96 dust = acct.committedTRAC - baseAllowance * uint96(acct.lockDurationEpochs);

        uint96 scheduled;
        uint96 treasuryFee;

        uint256 epLen = chronos.epochLength();

        // Treasury fee on the base commitment: ASSESSED here (bps snapshot),
        // as a pure accounting split — `fee` schedules to the treasury shard
        // on the same forward curve as the staker `net`, and no TRAC moves
        // in this call. The frozen NFT wrapper funds the CSS vault only
        // AFTER the logic call ("forward-before-pull"), so a physical skim
        // here would draw on an empty vault at `createAccount` and revert
        // the moment a treasury is wired; the physical payout instead runs
        // per elapsed epoch via `collectTreasuryEmission`, strictly after
        // mint completes. While `protocolTreasury == address(0)` the split
        // is 100/0 and this account is grandfathered — wiring a treasury
        // later never reduces an already-written staker schedule.
        (, uint256 feeBps) = _treasuryParams();
        for (uint40 w = fromWindow; w < maxWindow; w++) {
            uint96 spent = publishingConvictionStorage.windowSpent(accountId, w);
            uint96 remainder = spent < baseAllowance ? baseAllowance - spent : 0;
            if (w == maxWindow - 1) {
                // The % dust rides the last window (destination-equivalent to
                // the legacy final-sweep dust, scheduled up front instead).
                remainder += dust;
            }
            if (remainder == 0) continue;
            uint96 fee = _feeOf(remainder, feeBps);
            uint96 net = remainder - fee; // fee floors, so net keeps the wei dust
            uint256 windowCloseTs = uint256(acct.createdAtTimestamp) + (uint256(w) + 1) * epLen;
            if (net > 0) {
                scheduled += net;
                _emitForwardFrom(STAKER_SHARD_ID, windowCloseTs, net, uint256(acct.lockDurationEpochs), epLen);
            }
            if (fee > 0) {
                treasuryFee += fee;
                _emitForwardFrom(TREASURY_SHARD_ID, windowCloseTs, fee, uint256(acct.lockDurationEpochs), epLen);
            }
        }

        acct.lastSettledWindow = uint16(maxWindow);
        publishingConvictionStorage.setLastSettledWindow(accountId, uint16(maxWindow));

        emit EmissionScheduled(accountId, fromWindow, maxWindow, scheduled, treasuryFee);
    }

    /// @dev Spread `amount` over the `lockEpochs` epoch-lengths starting at
    ///      timestamp `fromTs` (a billing-window close), prorated at chain-
    ///      epoch boundaries: partial first epoch (time to the next boundary),
    ///      full middle epochs, dust-corrected partial tail — the exact
    ///      3-range shape `PublishingMathLib.prorateActiveSink` produces, so
    ///      base-budget emission and the K_n allocation schedule share one
    ///      proration definition. Conservation: the ranges sum to `amount`
    ///      exactly (the tail absorbs rounding). `shardId` selects the
    ///      destination pool: `STAKER_SHARD_ID` for the net emission,
    ///      `TREASURY_SHARD_ID` for the base-commitment fee — both sides of
    ///      the `_scheduleRemaining` split ride the identical curve.
    function _emitForwardFrom(
        uint256 shardId,
        uint256 fromTs,
        uint96 amount,
        uint256 lockEpochs,
        uint256 epLen
    ) internal {
        uint40 anchorEpoch = uint40(chronos.epochAtTimestamp(fromTs));
        uint256 nextBoundary = chronos.timestampForEpoch(uint256(anchorEpoch) + 1);
        uint256 timeRemaining = nextBoundary > fromTs ? nextBoundary - fromTs : 0;

        PublishingMathLib.ActiveSinkRange[3] memory ranges = PublishingMathLib.prorateActiveSink(
            amount,
            anchorEpoch,
            lockEpochs,
            epLen,
            timeRemaining
        );

        for (uint256 i; i < ranges.length; i++) {
            if (ranges[i].tokenAmount == 0) continue;
            epochStorage.addTokensToEpochRange(
                shardId,
                uint256(ranges[i].startEpoch),
                uint256(ranges[i].endEpoch),
                ranges[i].tokenAmount
            );
        }
    }

    /// @notice Post-expiry final sweep. Assumes
    ///         `block.timestamp >= acct.expiresAtTimestamp`. 10.0.8: the
    ///         base budget and the `%` dust are fully covered by the
    ///         emission schedule (written at creation / migration / first
    ///         touch — `_scheduleRemaining` is called defensively here for
    ///         self-sufficiency), so only the leftover `topUpBalance` can
    ///         remain unaccounted. Sweeps it to the final chain epoch and
    ///         marks `fullySwept = true`.
    function _finalSweep(
        PublishingConvictionStorage.Account memory acct,
        uint256 accountId
    ) internal {
        if (acct.fullySwept) return;

        // Defensive self-sufficiency: a pre-10.0.8 account whose first-ever
        // touch is this final sweep still gets its full schedule written.
        // No-op for every already-scheduled account.
        _scheduleRemaining(acct, accountId);

        (address treasury, uint256 feeBps) = _treasuryParams();
        uint96 accruedFee;

        uint40 finalChainEpoch = uint40(
            chronos.epochAtTimestamp(uint256(acct.expiresAtTimestamp) - 1)
        );
        uint96 leftoverTopUp = publishingConvictionStorage.topUpBalance(accountId);
        if (leftoverTopUp > 0) {
            uint96 tailFee = _feeOf(leftoverTopUp, feeBps);
            accruedFee += tailFee;
            uint96 tailNet = leftoverTopUp - tailFee;
            if (tailNet > 0) {
                epochStorage.addTokensToEpochRange(
                    STAKER_SHARD_ID,
                    uint256(finalChainEpoch),
                    uint256(finalChainEpoch),
                    tailNet
                );
            }
            publishingConvictionStorage.clearTopUpBalance(accountId);
        }

        publishingConvictionStorage.setFullySwept(accountId, true);
        // `dustSwept` is 0 since 10.0.8 — the `%` dust is part of the
        // up-front emission schedule, not the final sweep. Event shape kept
        // for indexer compatibility.
        emit AccountFinalSwept(accountId, leftoverTopUp, 0);

        // All PCS state (topUp clear, fullySwept) is persisted;
        // pay the treasury last for `settle()` reentrancy safety.
        _payTreasury(treasury, accruedFee);
    }

    // ============================================================
    //                  Window-index helpers (views)
    // ============================================================

    /// @dev Internal: current billing-window index for `acct`. Anchored
    ///      at `acct.createdAtTimestamp`; window length matches
    ///      `Chronos.epochLength()`.
    function _currentBillingWindow(
        PublishingConvictionStorage.Account memory acct
    ) internal view returns (uint40) {
        if (block.timestamp <= uint256(acct.createdAtTimestamp)) return 0;
        return uint40(
            (block.timestamp - uint256(acct.createdAtTimestamp)) / chronos.epochLength()
        );
    }

    /// @notice Public view: current billing-window index, capped at
    ///         `lockDurationEpochs` (i.e. "no more active windows").
    function getCurrentBillingWindow(uint256 accountId) external view returns (uint40) {
        PublishingConvictionStorage.Account memory acct =
            publishingConvictionStorage.getAccount(accountId);
        uint40 maxWindow = uint40(acct.lockDurationEpochs);
        uint40 current = _currentBillingWindow(acct);
        return current < maxWindow ? current : maxWindow;
    }

    /// @dev Internal: chain-epoch range overlapping billing window `w`.
    function _windowChainEpochRange(
        PublishingConvictionStorage.Account memory acct,
        uint40 w
    ) internal view returns (uint40 startEp, uint40 endEp) {
        uint256 epLen = chronos.epochLength();
        uint256 winStartTs = uint256(acct.createdAtTimestamp) + uint256(w) * epLen;
        uint256 winEndTs = winStartTs + epLen - 1;
        startEp = uint40(chronos.epochAtTimestamp(winStartTs));
        endEp = uint40(chronos.epochAtTimestamp(winEndTs));
    }

    /// @notice Public view: chain-epoch range that billing-window `w`
    ///         of `accountId` overlaps. Useful for off-chain reporting.
    function getWindowChainEpochRange(uint256 accountId, uint40 w)
        external
        view
        returns (uint40 startEp, uint40 endEp)
    {
        PublishingConvictionStorage.Account memory acct =
            publishingConvictionStorage.getAccount(accountId);
        return _windowChainEpochRange(acct, w);
    }

    /// @notice Remaining allowance (base + topUp) for `accountId` in
    ///         a given chain `epoch`. Returns 0 outside the account's
    ///         active lifetime.
    function getRemainingAllowance(uint256 accountId, uint40 epoch) external view returns (uint96) {
        PublishingConvictionStorage.Account memory acct =
            publishingConvictionStorage.getAccount(accountId);
        if (epoch < acct.createdAtEpoch || epoch >= acct.expiresAtEpoch) {
            return 0;
        }
        uint256 epochStartTimestamp = chronos.timestampForEpoch(epoch);
        uint40 billingWindow;
        if (epochStartTimestamp <= uint256(acct.createdAtTimestamp)) {
            billingWindow = 0;
        } else {
            billingWindow = uint40(
                (epochStartTimestamp - uint256(acct.createdAtTimestamp)) / chronos.epochLength()
            );
        }
        uint96 baseAllowance = acct.committedTRAC / uint96(acct.lockDurationEpochs);
        uint96 spent = publishingConvictionStorage.windowSpent(accountId, billingWindow);
        uint96 epochRemaining = spent < baseAllowance ? baseAllowance - spent : 0;
        return epochRemaining + publishingConvictionStorage.topUpBalance(accountId);
    }

    // ============================================================
    //                  Agent management
    // ============================================================

    /// @notice Append `agent` to `accountId`. Cap, zero-address, and
    ///         already-registered checks are enforced here; PCS
    ///         performs the atomic write.
    /// @dev    Owner-validation lives on the NFT wrapper, which calls
    ///         this function with `owner` for symmetry with future
    ///         audit-friendly extensions. The argument is intentionally
    ///         unused here to avoid double-validating ownership across
    ///         contracts.
    function registerAgent(
        address /* owner */,
        uint256 accountId,
        address agent
    ) external onlyConvictionNFT {
        if (agent == address(0)) revert ZeroAgentAddress();

        uint256 cap = publishingConvictionStorage.maxAgentsPerAccount();
        if (publishingConvictionStorage.agentCount(accountId) >= cap) {
            revert AgentCapReached(accountId, cap);
        }

        publishingConvictionStorage.addAgent(accountId, agent);
        emit AgentRegistered(accountId, agent);
    }

    /// @notice Remove `agent` from `accountId`. PCS reverts if not
    ///         registered.
    function deregisterAgent(
        address /* owner */,
        uint256 accountId,
        address agent
    ) external onlyConvictionNFT {
        publishingConvictionStorage.removeAgent(accountId, agent);
        emit AgentDeregistered(accountId, agent);
    }

    /// @notice Clear ALL registered publishing agents for `accountId` in a single
    ///         call — the owner-gated bulk counterpart to the per-agent
    ///         `deregisterAgent`.
    /// @dev    PCA NFT transfers PRESERVE the allow-list (it travels with the
    ///         token; see `onTransfer`). This is the explicit reset: a new owner
    ///         can drop an inherited allow-list, or an owner can wipe it before
    ///         transferring the PCA to another party.
    function clearAgents(uint256 accountId) external onlyCurrentPcaOwner(accountId) {
        uint256 cleared = publishingConvictionStorage.agentCount(accountId);
        // slither-disable-next-line reentrancy-events -- the callee is the trusted
        // Hub-registered PublishingConvictionStorage (onlyContracts), state is
        // written there before this event, and no value is transferred.
        publishingConvictionStorage.clearAgents(accountId);
        emit AgentsCleared(accountId, msg.sender, cleared);
    }

    /// @notice Register MULTIPLE publishing agents for `accountId` in a single
    ///         transaction — the owner-gated bulk counterpart to the per-agent
    ///         `registerAgent`.
    /// @dev    Direct-to-logic owner action (like `clearAgents`): the NFT wrapper
    ///         is non-upgradeable and exposes no batch entry point. Each agent is
    ///         validated EXACTLY as the single `registerAgent` path — non-zero,
    ///         under the per-account cap (re-checked each iteration so the batch
    ///         stops at the cap), and not already registered (PCS reverts
    ///         AgentAlreadyRegistered, which also rejects in-array duplicates).
    ///         ALL-OR-NOTHING: any invalid entry reverts the whole batch. Emits
    ///         AgentRegistered per agent. Callee is the trusted Hub-registered
    ///         PublishingConvictionStorage (onlyContracts).
    // slither-disable-start reentrancy-events,calls-loop
    function registerAgents(uint256 accountId, address[] calldata agents)
        external
        onlyCurrentPcaOwner(accountId)
    {
        uint256 cap = publishingConvictionStorage.maxAgentsPerAccount();
        for (uint256 i = 0; i < agents.length; i++) {
            address agent = agents[i];
            if (agent == address(0)) revert ZeroAgentAddress();
            if (publishingConvictionStorage.agentCount(accountId) >= cap) {
                revert AgentCapReached(accountId, cap);
            }
            publishingConvictionStorage.addAgent(accountId, agent);
            emit AgentRegistered(accountId, agent);
        }
    }
    // slither-disable-end reentrancy-events,calls-loop

    // ============================================================
    //                  Discount tier ladder
    // ============================================================

    /// @notice Discrete 6-tier discount ladder. Tiers are evaluated
    ///         highest-first so the largest commit that qualifies is
    ///         selected.
    function getDiscountBps(uint96 committedTRAC) public pure returns (uint256) {
        return PublishingMathLib.discountBps(committedTRAC);
    }
}
