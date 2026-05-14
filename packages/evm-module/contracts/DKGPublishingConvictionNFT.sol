// SPDX-License-Identifier: Apache-2.0

pragma solidity ^0.8.20;

import {INamed} from "./interfaces/INamed.sol";
import {IVersioned} from "./interfaces/IVersioned.sol";
import {IInitializable} from "./interfaces/IInitializable.sol";
import {HubDependent} from "./abstract/HubDependent.sol";
import {Chronos} from "./storage/Chronos.sol";
import {EpochStorage} from "./storage/EpochStorage.sol";
import {ParametersStorage} from "./storage/ParametersStorage.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC721Enumerable} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721Enumerable.sol";

/**
 * @title DKGPublishingConvictionNFT
 * @notice Publisher conviction accounts as transferable ERC-721 NFTs.
 *
 * V10 lazy-settlement model:
 *   - At `createAccount`, `committedTRAC` is moved from the publisher to the
 *     V10 TRAC vault (`ConvictionStakingStorage`) and held in escrow. The
 *     contract NEVER holds TRAC; it stores accounting only.
 *   - Each account lifetime is divided into `lockDurationEpochs` billing
 *     windows of length `Chronos.epochLength()`, anchored at
 *     `createdAtTimestamp`. Per-window base budget is
 *     `B = committedTRAC / lockDurationEpochs`.
 *   - The base budget for window `w` flows out via two sinks:
 *       1. ACTIVE: each publish through `coverPublishingCost` distributes
 *          its `discountedCost` across the published KC's epoch range via
 *          `EpochStorage.addTokensToEpochRange`. The base portion drawn is
 *          tracked in `windowSpent[accountId][w]`, capped at `B`.
 *       2. PASSIVE: at the end of window `w`, the unspent remainder
 *          `B - windowSpent[w]` is swept to the staker reward pool for the
 *          chain epochs that window overlaps. Settlement is lazy: triggered
 *          by the next `coverPublishingCost`, `topUp`, ERC-721 transfer, or
 *          an explicit public `settle(accountId)` call.
 *   - `topUpBalance[accountId]` is a separate prepaid usage buffer beyond the
 *     base budget. It is drawn only when the current window's base allowance
 *     is exhausted. Any leftover `topUpBalance` at account expiry is swept
 *     to the staker pool (final chain epoch) via the same `settle()` path.
 *   - Invariant: over a full account lifetime, the total TRAC accounted to
 *     the staker pool equals `committedTRAC + sum(topUps)`. Any
 *     `committedTRAC % lockDurationEpochs` dust is swept on the final
 *     settle alongside the topUp tail.
 *   - Discount tier is fixed by `committedTRAC` at creation (6-tier ladder,
 *     0%-75%). topUp does NOT change the tier or extend expiry.
 *   - `coverPublishingCost` is callable only by `KnowledgeAssetsV10` and
 *     receives the publishing agent (the outer tx's msg.sender) rather than
 *     a caller-supplied accountId. The NFT auto-resolves the paying account
 *     via `agentToAccountId`, which closes N28 (a trusted caller could
 *     otherwise pass a victim's accountId and drain their allowance). It
 *     also enforces `kcEpochs <= lockDurationEpochs` for the conviction
 *     branch.
 *   - Agents are tracked per account with a governance-configurable cap, and
 *     the reverse map `agentToAccountId` is public so callers can
 *     auto-resolve the paying account without caller-supplied authorization.
 */
contract DKGPublishingConvictionNFT is INamed, IVersioned, HubDependent, IInitializable, ERC721Enumerable {
    string private constant _NAME = "DKGPublishingConvictionNFT";
    string private constant _VERSION = "2.0.0";

    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant STAKER_SHARD_ID = 1;

    struct Account {
        uint96 committedTRAC;
        uint40 createdAtEpoch;
        uint40 expiresAtEpoch; // first disallowed chain epoch (exclusive upper bound)
        uint40 createdAtTimestamp;
        uint40 expiresAtTimestamp; // createdAtTimestamp + lockDurationEpochs * epochLength
        uint16 lockDurationEpochs;
        uint16 discountBps;    // fixed at creation
        // ---- Lazy-settlement cursor (V10 lazy-settlement model) ----
        /// @dev Next unsettled billing-window index (exclusive of the highest
        ///      settled window). 0 = nothing settled yet;
        ///      `lockDurationEpochs` = all base windows settled.
        uint16 lastSettledWindow;
        /// @dev True after the post-expiry `settle()` has swept all remaining
        ///      base remainder, leftover `topUpBalance`, and any
        ///      `committedTRAC % lockDurationEpochs` dust into the staker
        ///      pool. Re-entry guard for the final-sweep branch.
        bool fullySwept;
    }

    IERC20 public tokenContract;
    /// @notice v4.0.0 — V10 TRAC vault address. Resolves to
    ///         `ConvictionStakingStorage`, the post-consolidation custodian.
    ///         Field name retained for storage layout stability across the
    ///         legacy `stakingStorageAddress` slot.
    address public stakingStorageAddress;
    EpochStorage public epochStorage;
    Chronos public chronos;
    ParametersStorage public parametersStorage;

    uint256 private _nextAccountId;

    mapping(uint256 => Account) public accounts;
    /// @notice Per-billing-window spent amount counted against the
    ///         `committedTRAC / lockDurationEpochs`
    /// base allowance. Billing windows are fixed-size `Chronos.epochLength()`
    /// intervals anchored at `createdAtTimestamp`, so accounts created mid-chain
    /// epoch still get a full lock duration in wall-clock time.
    ///
    /// IMPORTANT: the second key is the billing-window index (0-based, relative
    /// to the account's `createdAtTimestamp`), NOT a chain-epoch number. Use
    /// `getCurrentBillingWindow(accountId)` to translate "now" to a window
    /// index for off-chain reads. The chain-epoch context for each draw is
    /// surfaced in the `CostCovered`/`WindowSettled` events.
    ///
    /// `coverPublishingCost` updates this before touching `topUpBalance`.
    mapping(uint256 => mapping(uint40 => uint96)) public windowSpent;
    /// @notice Persistent top-up buffer per account (NOT per-epoch). Drained
    /// only after the current-epoch base allowance is exhausted.
    mapping(uint256 => uint96) public topUpBalance;

    mapping(uint256 => address[]) private _registeredAgents;
    /// @dev `accountId == 0` is the "not registered" sentinel (_nextAccountId starts at 1).
    mapping(address => uint256) public agentToAccountId;
    mapping(uint256 => mapping(address => bool)) private _isRegisteredAgent;

    uint256 public maxAgentsPerAccount;

    // --- Events ---

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
    /// @notice Emitted for each elapsed billing window that gets swept to
    ///         the staker pool via the passive sink during lazy settlement.
    event WindowSettled(
        uint256 indexed accountId,
        uint40 indexed windowIndex,
        uint40 startChainEpoch,
        uint40 endChainEpoch,
        uint96 remainderSwept
    );
    /// @notice Emitted once per account, when the post-expiry final sweep
    ///         finishes (base remainder + topUp buffer + dust all accounted).
    event AccountFinalSwept(
        uint256 indexed accountId,
        uint96 topUpSwept,
        uint96 dustSwept
    );

    // --- Errors ---

    error ZeroAddressDependency(string name);
    error NoConvictionAccount(address publishingAgent);
    error OnlyKnowledgeAssetsV10(address caller);
    error NotAccountOwner(uint256 accountId, address caller);
    error InsufficientAllowance(uint256 accountId, uint40 epoch, uint96 required, uint96 available);
    error AccountExpired(uint256 accountId, uint40 expiresAtEpoch);
    error InvalidAmount();
    error ZeroAgentAddress();
    error AgentAlreadyRegistered(address agent, uint256 existingAccountId);
    error AgentNotRegistered(uint256 accountId, address agent);
    error AgentCapReached(uint256 accountId, uint256 cap);
    error TokenTransferFailed();
    error InvalidPublishingConvictionEpochs(uint256 configuredEpochs);
    /// @notice `kcEpochs` was 0 or exceeded the account's `lockDurationEpochs`.
    error InvalidConvictionKcEpochs(uint256 lockDurationEpochs, uint256 kcEpochs);
    error AccountAlreadyFullySettled(uint256 accountId);

    constructor(address hubAddress) HubDependent(hubAddress) ERC721("DKG Publishing Conviction", "DKGPC") {}

    function initialize() public onlyHub {
        address token = hub.getContractAddress("Token");
        if (token == address(0)) revert ZeroAddressDependency("Token");
        tokenContract = IERC20(token);

        // v4.0.0 — TRAC vault moved from StakingStorage to CSS. Field
        // name kept for storage layout stability.
        address vault = hub.getContractAddress("ConvictionStakingStorage");
        if (vault == address(0)) revert ZeroAddressDependency("ConvictionStakingStorage");
        stakingStorageAddress = vault;

        address es = hub.getContractAddress("EpochStorageV8");
        if (es == address(0)) revert ZeroAddressDependency("EpochStorageV8");
        epochStorage = EpochStorage(es);

        address ch = hub.getContractAddress("Chronos");
        if (ch == address(0)) revert ZeroAddressDependency("Chronos");
        chronos = Chronos(ch);

        address params = hub.getContractAddress("ParametersStorage");
        if (params == address(0)) revert ZeroAddressDependency("ParametersStorage");
        parametersStorage = ParametersStorage(params);

        // accountId == 0 is the "not registered" sentinel for agentToAccountId.
        if (_nextAccountId == 0) _nextAccountId = 1;
        if (maxAgentsPerAccount == 0) maxAgentsPerAccount = 100;
    }

    function name() public pure virtual override(INamed, ERC721) returns (string memory) {
        return _NAME;
    }

    function version() external pure virtual returns (string memory) {
        return _VERSION;
    }

    // ========================================================================
    // Account Lifecycle
    // ========================================================================

    /**
     * @notice Create a new publisher conviction account.
     *
     * TRAC flow (fail-closed; any sub-call revert reverts the whole tx):
     *   1. `committedTRAC` is pulled from msg.sender directly into the CSS
     *      vault, where it sits in escrow against the account's billing
     *      windows.
     *   2. Accounting state (Account struct) is written, with
     *      `lastSettledWindow = 0` and `fullySwept = false`.
     *   3. An ERC-721 token is minted to msg.sender.
     *
     * The committed amount is NOT distributed to the staker pool upfront —
     * it flows out lazily, window by window, through `coverPublishingCost`
     * (active sink) and `_settleElapsed` (passive sink). The contract NEVER
     * holds TRAC. Discount tier is fixed at creation.
     */
    function createAccount(uint96 committedTRAC) external returns (uint256 accountId) {
        if (committedTRAC == 0) revert InvalidAmount();

        accountId = _nextAccountId++;
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

        accounts[accountId] = Account({
            committedTRAC: committedTRAC,
            createdAtEpoch: currentEpoch,
            expiresAtEpoch: expiresAtEpoch,
            createdAtTimestamp: createdAtTimestamp,
            expiresAtTimestamp: expiresAtTimestamp,
            lockDurationEpochs: lockDurationEpochs,
            discountBps: discountBps,
            lastSettledWindow: 0,
            fullySwept: false
        });

        _mint(msg.sender, accountId);

        // Direct publisher -> CSS vault transfer. Contract never holds TRAC.
        // The TRAC sits in escrow against this account's billing windows and
        // is accounted to the staker pool lazily via active/passive sinks.
        if (!tokenContract.transferFrom(msg.sender, stakingStorageAddress, committedTRAC)) {
            revert TokenTransferFailed();
        }

        emit AccountCreated(accountId, msg.sender, committedTRAC, discountBps, currentEpoch, expiresAtEpoch);
    }

    /**
     * @notice Add TRAC to an existing account's persistent top-up balance.
     *
     * TRAC flows publisher -> CSS vault directly and remains in escrow as a
     * prepaid usage buffer. The amount is NOT distributed to the staker
     * pool upfront; it only flows out either:
     *   (a) on a future `coverPublishingCost` whose base allowance is
     *       exhausted in the current window (active sink), or
     *   (b) at expiry via `settle()` which sweeps any leftover buffer to
     *       the staker pool (final chain epoch).
     *
     * `topUp` lazily settles any elapsed windows first so the new buffer
     * accounting starts from a consistent state. Does NOT extend expiry or
     * change the discount tier.
     */
    function topUp(uint256 accountId, uint96 amount) external {
        _requireOwner(accountId);
        if (amount == 0) revert InvalidAmount();

        Account storage acct = accounts[accountId];
        if (block.timestamp >= acct.expiresAtTimestamp) {
            revert AccountExpired(accountId, acct.expiresAtEpoch);
        }

        _settleElapsed(acct, accountId);

        topUpBalance[accountId] += amount;

        if (!tokenContract.transferFrom(msg.sender, stakingStorageAddress, amount)) {
            revert TokenTransferFailed();
        }

        emit ToppedUp(accountId, amount, topUpBalance[accountId]);
    }

    // ========================================================================
    // Publishing Cost Coverage
    // ========================================================================

    /**
     * @notice Deduct the discounted publishing cost from the account bound to
     *         `publishingAgent` and fund the published KC's epoch range from
     *         escrow. Callable ONLY by KnowledgeAssetsV10.
     *
     * N28 fix: the caller does NOT pass an `accountId`. It passes the outer
     * transaction's `msg.sender` (the publishing agent). The NFT resolves the
     * paying account via the on-chain `agentToAccountId` reverse map. This
     * removes the victim-account-drain vector where a trusted caller could
     * pass any account id.
     *
     * The function is further gated to `KnowledgeAssetsV10` (resolved lazily
     * from Hub on every call). Any other Hub-registered contract reverts with
     * `OnlyKnowledgeAssetsV10`. KAV10 is trusted to pass its own `msg.sender`
     * as the publishing agent, so a malicious EOA going through KAV10 can
     * only drain its own conviction account.
     *
     * Flow:
     *   1. Reject if the publish's KC lifetime (`kcEpochs`) exceeds the
     *      account's `lockDurationEpochs`.
     *   2. Lazily settle any elapsed (closed) billing windows: for each
     *      window `w` between `lastSettledWindow` and the previous window,
     *      sweep `B - windowSpent[w]` (where `B = committedTRAC /
     *      lockDurationEpochs`) into the staker pool for the chain epochs
     *      that window overlaps.
     *   3. Compute `discountedCost = baseCost * (1 - discountBps/1e4)`.
     *   4. Spend order against the current window's budget:
     *      (a) base allowance `B - windowSpent[currentWindow]` first; only
     *          this portion increments `windowSpent`,
     *      (b) `topUpBalance` overflow if (a) is exhausted.
     *   5. Distribute the full `discountedCost` (= base draw + topUp draw)
     *      across the KC's epoch range `[kcStartEpoch, kcStartEpoch +
     *      kcEpochs - 1]` via `EpochStorage.addTokensToEpochRange` — this
     *      is the active sink that funds the KC's lifetime in the staker
     *      reward pool.
     *
     * Does NOT physically move TRAC — TRAC already sits in the CSS vault
     * from `createAccount` / `topUp`; this function only updates the
     * `EpochStorage` accounting that determines per-epoch staker rewards.
     * Returns the discounted amount for KAV10's internal accounting.
     */
    function coverPublishingCost(
        address publishingAgent,
        uint96 baseCost,
        uint40 kcStartEpoch,
        uint40 kcEpochs
    ) external returns (uint96 discountedCost) {
        address kav10 = hub.getContractAddress("KnowledgeAssetsV10");
        if (msg.sender != kav10) revert OnlyKnowledgeAssetsV10(msg.sender);

        uint256 accountId = agentToAccountId[publishingAgent];
        if (accountId == 0) revert NoConvictionAccount(publishingAgent);

        Account storage acct = accounts[accountId];

        if (block.timestamp >= acct.expiresAtTimestamp) {
            revert AccountExpired(accountId, acct.expiresAtEpoch);
        }
        if (kcEpochs == 0 || kcEpochs > uint40(acct.lockDurationEpochs)) {
            revert InvalidConvictionKcEpochs(uint256(acct.lockDurationEpochs), uint256(kcEpochs));
        }

        _settleElapsed(acct, accountId);

        uint40 currentEpoch = uint40(chronos.getCurrentEpoch());
        uint40 currentBillingWindow = _currentBillingWindow(acct);

        discountedCost = uint96(
            (uint256(baseCost) * (BPS_DENOMINATOR - uint256(acct.discountBps))) / BPS_DENOMINATOR
        );

        uint96 baseAllowance = acct.committedTRAC / uint96(acct.lockDurationEpochs);
        uint96 spent = windowSpent[accountId][currentBillingWindow];
        uint96 epochRemaining = spent < baseAllowance ? baseAllowance - spent : 0;

        uint96 drawnFromEpoch;
        uint96 drawnFromTopUp;

        if (discountedCost <= epochRemaining) {
            drawnFromEpoch = discountedCost;
        } else {
            drawnFromEpoch = epochRemaining;
            uint96 shortfall = discountedCost - epochRemaining;
            uint96 buffer = topUpBalance[accountId];
            if (shortfall > buffer) {
                revert InsufficientAllowance(
                    accountId,
                    currentEpoch,
                    discountedCost,
                    epochRemaining + buffer
                );
            }
            drawnFromTopUp = shortfall;
            topUpBalance[accountId] = buffer - shortfall;
        }

        if (drawnFromEpoch > 0) {
            windowSpent[accountId][currentBillingWindow] = spent + drawnFromEpoch;
        }

        // Active sink: fund the KC's epoch range with the discounted cost.
        // MUST mirror `KnowledgeAssetsV10._distributeTokens` semantics so that
        // the conviction-funded and direct-spend reward curves are identical
        // (modulo the conviction discount). Concretely: prorate the current
        // (partial) chain epoch by `timeUntilNextEpoch / epochLength` and
        // push the leftover into a final (partial) epoch at
        // `currentEpoch + kcEpochs` — funding `kcEpochs + 1` chain epochs in
        // total. Equal-split across `kcEpochs` only would underfund the tail
        // and overfund the current epoch on mid-epoch publishes (Codex
        // round-1 finding on PR #470).
        uint96 distributed = drawnFromEpoch + drawnFromTopUp;
        if (distributed > 0) {
            _distributeProrated(distributed, kcStartEpoch, uint256(kcEpochs));
        }

        emit CostCovered(accountId, currentEpoch, baseCost, discountedCost, drawnFromEpoch, drawnFromTopUp);
    }

    /// @dev Mirrors `KnowledgeAssetsV10._distributeTokens`. Splits `amount`
    ///      across `storageUnits + 1` chain epochs starting at `firstEpoch`:
    ///      - `firstEpoch` (partial) gets `base * timeUntilNextEpoch /
    ///        epochLength` where `base = amount / storageUnits`,
    ///      - middle `[firstEpoch+1 .. firstEpoch + storageUnits - 1]` each
    ///        gets `base`,
    ///      - `firstEpoch + storageUnits` (partial tail) gets the rest
    ///        (`base - currentEpochAllocation`) plus any rounding dust.
    ///      Assumes `storageUnits > 0` (caller validates `kcEpochs > 0`).
    function _distributeProrated(
        uint96 amount,
        uint40 firstEpoch,
        uint256 storageUnits
    ) internal {
        uint256 epochLengthSec = chronos.epochLength();
        uint256 timeRemainingInCurrentEpoch = chronos.timeUntilNextEpoch();
        uint96 baseTokensPerFullEpoch = uint96(uint256(amount) / storageUnits);
        uint96 currentEpochAllocation = uint96(
            (uint256(baseTokensPerFullEpoch) * timeRemainingInCurrentEpoch) / epochLengthSec
        );
        uint96 finalEpochAllocation = baseTokensPerFullEpoch - currentEpochAllocation;
        uint256 numberOfFullEpochs = storageUnits - 1;
        uint96 totalTokensForFullEpochs = uint96(uint256(baseTokensPerFullEpoch) * numberOfFullEpochs);

        uint96 totalAllocated = currentEpochAllocation + totalTokensForFullEpochs + finalEpochAllocation;
        if (totalAllocated < amount) {
            finalEpochAllocation += (amount - totalAllocated);
        }

        if (currentEpochAllocation > 0) {
            epochStorage.addTokensToEpochRange(
                STAKER_SHARD_ID,
                firstEpoch,
                firstEpoch,
                currentEpochAllocation
            );
        }

        if (numberOfFullEpochs > 0 && totalTokensForFullEpochs > 0) {
            epochStorage.addTokensToEpochRange(
                STAKER_SHARD_ID,
                firstEpoch + 1,
                firstEpoch + uint40(numberOfFullEpochs),
                totalTokensForFullEpochs
            );
        }

        if (finalEpochAllocation > 0) {
            epochStorage.addTokensToEpochRange(
                STAKER_SHARD_ID,
                firstEpoch + uint40(storageUnits),
                firstEpoch + uint40(storageUnits),
                finalEpochAllocation
            );
        }
    }

    // ========================================================================
    // Lazy Settlement (passive sink + post-expiry tail)
    // ========================================================================

    /**
     * @notice Publicly callable lazy settlement.
     *
     * - Pre-expiry: sweeps every elapsed billing window's unspent base
     *   remainder (`B - windowSpent[w]`) into the staker pool for the chain
     *   epochs that window overlaps.
     * - Post-expiry: in addition to the above, finalises the last window,
     *   sweeps any leftover `topUpBalance`, and sweeps the
     *   `committedTRAC % lockDurationEpochs` dust to the final chain epoch
     *   of the account lifetime. Sets `fullySwept = true` so subsequent
     *   calls are no-ops.
     *
     * Anyone can call it (stakers have an incentive to flush pending
     * sweeps; the account owner can flush before transferring; etc.).
     */
    function settle(uint256 accountId) external {
        _requireExists(accountId);
        Account storage acct = accounts[accountId];
        if (acct.fullySwept) return;

        _settleElapsed(acct, accountId);

        if (block.timestamp >= acct.expiresAtTimestamp) {
            _finalSweep(acct, accountId);
        }
    }

    /// @notice Internal helper: sweep all CLOSED windows up to the current
    ///         window into the staker pool. Idempotent and gas-bounded by
    ///         `lockDurationEpochs - lastSettledWindow`.
    function _settleElapsed(Account storage acct, uint256 accountId) internal {
        uint40 currentWindow = _currentBillingWindow(acct);
        uint40 maxWindow = uint40(acct.lockDurationEpochs);
        uint40 stopAt = currentWindow < maxWindow ? currentWindow : maxWindow;

        if (acct.lastSettledWindow >= stopAt) return;

        uint96 baseAllowance = acct.committedTRAC / uint96(acct.lockDurationEpochs);

        for (uint40 w = acct.lastSettledWindow; w < stopAt; w++) {
            uint96 spent = windowSpent[accountId][w];
            uint96 remainder = spent < baseAllowance ? baseAllowance - spent : 0;
            (uint40 startEp, uint40 endEp) = _windowChainEpochRange(acct, w);
            if (remainder > 0) {
                _sweepWindowProrated(acct, w, startEp, endEp, remainder);
            }
            emit WindowSettled(accountId, w, startEp, endEp, remainder);
        }

        acct.lastSettledWindow = uint16(stopAt);
    }

    /// @dev Distribute `amount` across the chain-epoch range `[startEp,
    ///      endEp]` that billing window `w` of `acct` overlaps,
    ///      proportional to the wall-clock seconds each chain epoch
    ///      shares with the window. Equal-split via a single
    ///      `addTokensToEpochRange(startEp, endEp, amount)` would
    ///      distort rewards for windows that straddle two chain epochs
    ///      by only a few seconds (Codex round-1 finding on PR #470).
    function _sweepWindowProrated(
        Account storage acct,
        uint40 w,
        uint40 startEp,
        uint40 endEp,
        uint96 amount
    ) internal {
        if (startEp == endEp) {
            epochStorage.addTokensToEpochRange(
                STAKER_SHARD_ID,
                uint256(startEp),
                uint256(endEp),
                amount
            );
            return;
        }
        // A billing window is exactly `epochLength()` long (same as a chain
        // epoch), so it can overlap AT MOST two chain epochs — the window
        // either fits within one, or it straddles exactly one boundary.
        uint256 epochLengthSec = chronos.epochLength();
        uint256 winStartTs = uint256(acct.createdAtTimestamp) + uint256(w) * epochLengthSec;
        uint256 boundaryTs = chronos.timestampForEpoch(uint256(endEp));
        uint256 startOverlap = boundaryTs - winStartTs;
        uint96 startAllocation = uint96((uint256(amount) * startOverlap) / epochLengthSec);
        uint96 endAllocation = amount - startAllocation;
        if (startAllocation > 0) {
            epochStorage.addTokensToEpochRange(
                STAKER_SHARD_ID,
                uint256(startEp),
                uint256(startEp),
                startAllocation
            );
        }
        if (endAllocation > 0) {
            epochStorage.addTokensToEpochRange(
                STAKER_SHARD_ID,
                uint256(endEp),
                uint256(endEp),
                endAllocation
            );
        }
    }

    /// @notice Internal helper: post-expiry final sweep. Assumes
    ///         `block.timestamp >= acct.expiresAtTimestamp`.
    function _finalSweep(Account storage acct, uint256 accountId) internal {
        if (acct.fullySwept) return;

        uint40 maxWindow = uint40(acct.lockDurationEpochs);
        uint96 baseAllowance = acct.committedTRAC / uint96(acct.lockDurationEpochs);

        // Settle any windows that `_settleElapsed` left for the final one
        // (e.g. the window containing `expiresAtTimestamp` itself).
        for (uint40 w = acct.lastSettledWindow; w < maxWindow; w++) {
            uint96 spent = windowSpent[accountId][w];
            uint96 remainder = spent < baseAllowance ? baseAllowance - spent : 0;
            (uint40 startEp, uint40 endEp) = _windowChainEpochRange(acct, w);
            if (remainder > 0) {
                _sweepWindowProrated(acct, w, startEp, endEp, remainder);
            }
            emit WindowSettled(accountId, w, startEp, endEp, remainder);
        }
        acct.lastSettledWindow = uint16(maxWindow);

        // Sweep dust (committedTRAC - baseAllowance * lockDurationEpochs)
        // and any remaining topUpBalance to the final chain epoch of the
        // account lifetime.
        uint40 finalChainEpoch = uint40(
            chronos.epochAtTimestamp(uint256(acct.expiresAtTimestamp) - 1)
        );
        uint96 dust = acct.committedTRAC - baseAllowance * uint96(acct.lockDurationEpochs);
        uint96 leftoverTopUp = topUpBalance[accountId];
        uint96 tailSweep = dust + leftoverTopUp;
        if (tailSweep > 0) {
            epochStorage.addTokensToEpochRange(
                STAKER_SHARD_ID,
                uint256(finalChainEpoch),
                uint256(finalChainEpoch),
                tailSweep
            );
        }
        if (leftoverTopUp > 0) {
            topUpBalance[accountId] = 0;
        }

        acct.fullySwept = true;
        emit AccountFinalSwept(accountId, leftoverTopUp, dust);
    }

    /// @notice Current billing-window index. Windows are length
    ///         `Chronos.epochLength()` and anchored at `createdAtTimestamp`.
    function _currentBillingWindow(Account storage acct) internal view returns (uint40) {
        if (block.timestamp <= uint256(acct.createdAtTimestamp)) return 0;
        return uint40(
            (block.timestamp - uint256(acct.createdAtTimestamp)) / chronos.epochLength()
        );
    }

    /// @notice Public view: current billing-window index for `accountId`.
    /// @dev Use this to translate "now" into the second key of
    ///      `windowSpent[accountId][...]`. Reverts if the account does not
    ///      exist (consistent with other view helpers). Returns
    ///      `lockDurationEpochs` once the account has fully expired (the
    ///      first index past the last billable window) so callers can
    ///      detect "no more active windows" without overflowing.
    function getCurrentBillingWindow(uint256 accountId) external view returns (uint40) {
        _requireExists(accountId);
        Account storage acct = accounts[accountId];
        uint40 maxWindow = uint40(acct.lockDurationEpochs);
        uint40 current = _currentBillingWindow(acct);
        return current < maxWindow ? current : maxWindow;
    }

    /// @notice Map billing-window index `w` to the inclusive chain-epoch
    ///         range it overlaps. A single billing window of length
    ///         `epochLength()` overlaps either 1 or 2 chain epochs
    ///         depending on alignment with `createdAtTimestamp`.
    function _windowChainEpochRange(
        Account storage acct,
        uint40 w
    ) internal view returns (uint40 startEp, uint40 endEp) {
        uint256 epLen = chronos.epochLength();
        uint256 winStartTs = uint256(acct.createdAtTimestamp) + uint256(w) * epLen;
        uint256 winEndTs = winStartTs + epLen - 1;
        startEp = uint40(chronos.epochAtTimestamp(winStartTs));
        endEp = uint40(chronos.epochAtTimestamp(winEndTs));
    }

    /// @notice Public view: chain-epoch range that billing-window `w` of
    ///         `accountId` overlaps. Useful for off-chain reporting (e.g.
    ///         "this window will pay stakers across epochs X..Y").
    function getWindowChainEpochRange(uint256 accountId, uint40 w)
        external
        view
        returns (uint40 startEp, uint40 endEp)
    {
        _requireExists(accountId);
        Account storage acct = accounts[accountId];
        return _windowChainEpochRange(acct, w);
    }

    // ========================================================================
    // Agent Management
    // ========================================================================

    function registerAgent(uint256 accountId, address agent) external {
        _requireOwner(accountId);
        if (agent == address(0)) revert ZeroAgentAddress();
        if (agentToAccountId[agent] != 0) {
            revert AgentAlreadyRegistered(agent, agentToAccountId[agent]);
        }
        if (_registeredAgents[accountId].length >= maxAgentsPerAccount) {
            revert AgentCapReached(accountId, maxAgentsPerAccount);
        }

        _registeredAgents[accountId].push(agent);
        _isRegisteredAgent[accountId][agent] = true;
        agentToAccountId[agent] = accountId;

        emit AgentRegistered(accountId, agent);
    }

    function deregisterAgent(uint256 accountId, address agent) external {
        _requireOwner(accountId);
        if (!_isRegisteredAgent[accountId][agent]) {
            revert AgentNotRegistered(accountId, agent);
        }

        _isRegisteredAgent[accountId][agent] = false;
        agentToAccountId[agent] = 0;

        address[] storage agents = _registeredAgents[accountId];
        uint256 len = agents.length;
        for (uint256 i; i < len; i++) {
            if (agents[i] == agent) {
                agents[i] = agents[len - 1];
                agents.pop();
                break;
            }
        }

        emit AgentDeregistered(accountId, agent);
    }

    function getRegisteredAgents(uint256 accountId) external view returns (address[] memory) {
        return _registeredAgents[accountId];
    }

    function isAgent(uint256 accountId, address agent) external view returns (bool) {
        return _isRegisteredAgent[accountId][agent];
    }

    // ========================================================================
    // Governance
    // ========================================================================

    function setMaxAgentsPerAccount(uint256 cap) external onlyHubOwner {
        maxAgentsPerAccount = cap;
    }

    // ========================================================================
    // View Functions
    // ========================================================================

    /// @notice Discrete 6-tier discount ladder (published-docs version).
    ///         Tiers are evaluated highest-first so the largest commit that
    ///         qualifies is selected.
    function getDiscountBps(uint96 committedTRAC) public pure returns (uint256) {
        if (committedTRAC >= 1_000_000 ether) return 7500; // 75%
        if (committedTRAC >= 500_000 ether)   return 5000; // 50%
        if (committedTRAC >= 250_000 ether)   return 4000; // 40%
        if (committedTRAC >= 100_000 ether)   return 3000; // 30%
        if (committedTRAC >= 50_000 ether)    return 2000; // 20%
        if (committedTRAC >= 25_000 ether)    return 1000; // 10%
        return 0;
    }

    function getDiscount(uint256 accountId) external view returns (uint256) {
        _requireExists(accountId);
        return accounts[accountId].discountBps;
    }

    function getDiscountedCost(uint256 accountId, uint96 baseCost) external view returns (uint96) {
        _requireExists(accountId);
        uint256 bps = accounts[accountId].discountBps;
        return uint96((uint256(baseCost) * (BPS_DENOMINATOR - bps)) / BPS_DENOMINATOR);
    }

    function getAccountInfo(uint256 accountId) external view returns (
        address owner_,
        uint96 committedTRAC,
        uint96 baseEpochAllowance,
        uint40 createdAtEpoch,
        uint40 expiresAtEpoch,
        uint40 createdAtTimestamp,
        uint40 expiresAtTimestamp,
        uint16 discountBps,
        uint96 topUpBuffer,
        uint256 agentCount,
        uint16 lastSettledWindow,
        bool fullySwept
    ) {
        _requireExists(accountId);
        Account storage acct = accounts[accountId];
        return (
            ownerOf(accountId),
            acct.committedTRAC,
            acct.committedTRAC / uint96(acct.lockDurationEpochs),
            acct.createdAtEpoch,
            acct.expiresAtEpoch,
            acct.createdAtTimestamp,
            acct.expiresAtTimestamp,
            acct.discountBps,
            topUpBalance[accountId],
            _registeredAgents[accountId].length,
            acct.lastSettledWindow,
            acct.fullySwept
        );
    }

    function getRemainingAllowance(uint256 accountId, uint40 epoch) external view returns (uint96) {
        _requireExists(accountId);
        Account storage acct = accounts[accountId];
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
        uint96 spent = windowSpent[accountId][billingWindow];
        uint96 epochRemaining = spent < baseAllowance ? baseAllowance - spent : 0;
        return epochRemaining + topUpBalance[accountId];
    }

    // ========================================================================
    // Internal
    // ========================================================================

    function _requireExists(uint256 accountId) internal view {
        _requireOwned(accountId);
    }

    function _requireOwner(uint256 accountId) internal view {
        _requireExists(accountId);
        if (ownerOf(accountId) != msg.sender) {
            revert NotAccountOwner(accountId, msg.sender);
        }
    }

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
        address from = super._update(to, tokenId, auth);

        // Owner-to-owner transfer: flush pending lazy settlement so the
        // outgoing owner's window accounting is final, then clear agent
        // registrations so the new owner starts with a clean agent slate.
        // Skipped on mint/burn (from == 0 || to == 0).
        if (from != address(0) && to != address(0) && from != to) {
            Account storage acct = accounts[tokenId];
            // `acct.lockDurationEpochs == 0` would mean the struct isn't
            // populated (defensive — `_mint` is always followed by
            // struct write in `createAccount`, but a future `_safeMint`
            // path could reorder).
            if (acct.lockDurationEpochs != 0 && !acct.fullySwept) {
                _settleElapsed(acct, tokenId);
                if (block.timestamp >= acct.expiresAtTimestamp) {
                    _finalSweep(acct, tokenId);
                }
            }

            address[] storage agents = _registeredAgents[tokenId];
            uint256 len = agents.length;
            for (uint256 i; i < len; i++) {
                _isRegisteredAgent[tokenId][agents[i]] = false;
                agentToAccountId[agents[i]] = 0;
            }
            delete _registeredAgents[tokenId];
        }

        return from;
    }
}
