// SPDX-License-Identifier: Apache-2.0

pragma solidity ^0.8.20;

import {INamed} from "./interfaces/INamed.sol";
import {IVersioned} from "./interfaces/IVersioned.sol";
import {IInitializable} from "./interfaces/IInitializable.sol";
import {HubDependent} from "./abstract/HubDependent.sol";
import {PublishingMathLib} from "./libraries/PublishingMathLib.sol";
import {PublishingConviction} from "./PublishingConviction.sol";
import {PublishingConvictionStorage} from "./storage/PublishingConvictionStorage.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC721Enumerable} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721Enumerable.sol";

/**
 * @title DKGPublishingConvictionNFT
 * @notice Thin ERC-721 wrapper over publisher conviction accounts.
 *
 * V10 split-contract architecture (mirrors the staking-side
 * `DKGStakingConvictionNFT` / `StakingV10` / `ConvictionStakingStorage`
 * trio):
 *   - This wrapper is a dumb ERC-721 ownership receipt: it mints/burns
 *     tokens, validates ownership on mutating calls, drives the
 *     publisher-facing TRAC `transferFrom`s, and forwards every
 *     business action to `PublishingConviction`.
 *   - All account / window / agent state lives on
 *     `PublishingConvictionStorage`.
 *   - All business logic (account creation, lazy passive-sink
 *     settlement, post-expiry final sweep, active-sink epoch
 *     distribution, agent management, transfer-hook agent clear)
 *     lives on `PublishingConviction`. The logic address is resolved
 *     lazily from Hub so it can be re-registered without touching this
 *     wrapper.
 *
 * Wrapper-level state (intentional):
 *   - `_nextAccountId`: monotonic mint counter, tightly coupled to
 *     ERC-721 mint ordering. Mirrors `DKGStakingConvictionNFT.nextTokenId`.
 *   - Hub-resolved contract refs (storage, token, vault) are loaded
 *     once at `initialize()`; they are metadata, not application state.
 *
 * TRAC custody:
 *   - The wrapper NEVER holds TRAC. `createAccount` / `topUp` move TRAC
 *     directly from the publisher into the V10 vault
 *     (`ConvictionStakingStorage`) via `transferFrom`. The publisher
 *     therefore approves THIS wrapper as the spender (matching the
 *     legacy v2.x UX so existing integrations keep working).
 *   - `coverPublishingCost` does NOT physically move TRAC; it only
 *     updates `EpochStorage` accounting. The escrowed TRAC is already
 *     in the vault from `createAccount` / `topUp`.
 *
 * Public surface stability (selector-compatible with v2.x):
 *   - The legacy `accounts(uint256)` auto-getter is preserved as an
 *     explicit forwarder over the storage contract's auto-generated
 *     `accounts` mapping getter — INCLUDING the legacy zero-tuple
 *     return for an unknown `accountId` (it does NOT revert; use
 *     `getAccount` for the fail-closed variant). See the function
 *     NatSpec on `accounts(uint256)` below.
 *   - `agentToAccountId(address)`, `topUpBalance(uint256)`,
 *     `windowSpent(uint256, uint40)`, `maxAgentsPerAccount()` are kept
 *     on the wrapper as forwarders so `IDKGPublishingConvictionNFT`,
 *     `KnowledgeAssetsV10`, and `ContextGraphs` need no changes.
 *
 * Deliberate breaks in the v2.x → v3.0.0 wrapper bump:
 *   - PCA state-change events (`AccountCreated`, `ToppedUp`,
 *     `CostCovered`, `WindowSettled`, `AccountFinalSwept`,
 *     `AgentRegistered`, `AgentDeregistered`) are emitted by
 *     `PublishingConviction` (the logic contract), NOT by this
 *     wrapper. Off-chain consumers that subscribe to PCA state
 *     changes MUST listen to the `PublishingConviction` address
 *     (resolved from Hub at `getContractAddress("PublishingConviction")`),
 *     not this contract's address. This is the architectural
 *     invariant of the V10 split: the logic contract owns business
 *     semantics, including events. The 3.0.0 major version bump is
 *     the deliberate signal of this break — do NOT add wrapper-side
 *     re-emission to "preserve compatibility"; the canonical
 *     listening address is the logic contract.
 *   - The wrapper still emits ERC-721 events (`Transfer`,
 *     `Approval`, `ApprovalForAll`) from its own address, exactly
 *     as a normal NFT does — those are NOT moved.
 */
contract DKGPublishingConvictionNFT is INamed, IVersioned, HubDependent, IInitializable, ERC721Enumerable {
    string private constant _NAME = "DKGPublishingConvictionNFT";
    // Version history:
    //   2.0.0 — legacy stateful NFT (state + logic on this contract).
    //   3.0.0 — V10 storage/logic split. State migrates to
    //           `PublishingConvictionStorage`; business logic moves to
    //           `PublishingConviction`. The wrapper is now ERC-721 +
    //           mint counter + TRAC-pull only. Public selectors are
    //           preserved so `IDKGPublishingConvictionNFT` consumers
    //           (`KnowledgeAssetsV10`, `ContextGraphs`) need no changes.
    //   10.0.3 — OT-RFC-51 "Publishing Allocation": `createAccount` gains a
    //           `primaryNode` argument forwarded to the logic contract, and a
    //           new owner-gated `setPrimaryNode` forwarder is added.
    string private constant _VERSION = "10.0.3";

    uint256 public constant BPS_DENOMINATOR = 10_000;

    // ============================================================
    //                  Hub-wired dependencies
    // ============================================================

    /// @dev Reserved slot from the first v3 split draft where the logic
    ///      reference was cached. The public `publishingConviction()`
    ///      getter below now resolves Hub lazily.
    PublishingConviction private __reservedPublishingConviction;

    /// @notice V10 application-state store. Read directly for the
    ///         selector-stable public view forwarders below.
    PublishingConvictionStorage public publishingConvictionStorage;

    /// @notice TRAC ERC-20 reference; the publisher approves this
    ///         wrapper to pull TRAC into the vault on
    ///         `createAccount` / `topUp`.
    IERC20 public tokenContract;

    /// @notice V10 TRAC vault target. Resolves to
    ///         `ConvictionStakingStorage`, the post-v4.0.0
    ///         consolidation custodian. Field name retained for
    ///         storage layout stability across the legacy
    ///         `stakingStorageAddress` slot.
    address public stakingStorageAddress;

    // ============================================================
    //                       Mint counter
    // ============================================================

    /// @notice Monotonic account-id counter. The first mint produces
    ///         accountId 1 — accountId 0 is reserved as the "not
    ///         registered" sentinel for `agentToAccountId`. Initialized
    ///         to 1 on first `initialize()`; persists across redeploys
    ///         of the wrapper because Hub re-registration runs
    ///         `initialize()` and the `_nextAccountId == 0` guard
    ///         short-circuits.
    uint256 private _nextAccountId;

    // ============================================================
    //                          Errors
    // ============================================================

    error ZeroAddressDependency(string name);
    error OnlyKnowledgeAssetsV10(address caller);
    error NotAccountOwner(uint256 accountId, address caller);
    /// @notice OT-RFC-51 defense-in-depth: `setPrimaryNode` called with `newNode == 0`.
    error ZeroPrimaryNode();
    error InvalidAmount();
    error TokenTransferFailed();

    constructor(
        address hubAddress
    ) HubDependent(hubAddress) ERC721("DKG Publishing Conviction", "DKGPC") {}

    function initialize() public onlyHub {
        address store = hub.getContractAddress("PublishingConvictionStorage");
        if (store == address(0)) revert ZeroAddressDependency("PublishingConvictionStorage");
        publishingConvictionStorage = PublishingConvictionStorage(store);

        address token = hub.getContractAddress("Token");
        if (token == address(0)) revert ZeroAddressDependency("Token");
        tokenContract = IERC20(token);

        address vault = hub.getContractAddress("ConvictionStakingStorage");
        if (vault == address(0)) revert ZeroAddressDependency("ConvictionStakingStorage");
        stakingStorageAddress = vault;

        if (_nextAccountId == 0) _nextAccountId = 1;
    }

    function name() public pure virtual override(INamed, ERC721) returns (string memory) {
        return _NAME;
    }

    function version() external pure virtual returns (string memory) {
        return _VERSION;
    }

    /// @notice Current Hub-registered publishing-conviction logic.
    /// @dev    Kept as a selector-stable getter, but intentionally does a
    ///         lazy Hub lookup so logic-only upgrades do not require
    ///         reinitializing this wrapper.
    function publishingConviction() public view returns (PublishingConviction) {
        return _publishingConviction();
    }

    // ========================================================================
    //                  Account lifecycle entry points
    // ========================================================================

    /**
     * @notice Mint a new conviction-account NFT to the caller and
     *         transfer `committedTRAC` into the V10 vault.
     *
     * @dev    CEI ordering with `_mint` last:
     *           1. Allocate `accountId` from the wrapper's mint counter.
     *           2. Forward to `PublishingConviction.createAccount` which
     *              persists the `Account` record on PCS and emits
     *              `AccountCreated`. Logic-side parameter validation
     *              runs here, BEFORE any funds move.
     *           3. Pull TRAC from publisher to the V10 vault. The
     *              wrapper holds NO TRAC — this is a direct
     *              `transferFrom(publisher, ConvictionStakingStorage,
     *              committedTRAC)`.
     *           4. `_mint(msg.sender, accountId)` LAST. The wrapper
     *              never observes a half-built (NFT-without-Account
     *              -or-funding) state.
     *
     *         `_mint` (not `_safeMint`) is intentional: contract
     *         publishers without `IERC721Receiver` (DAO treasuries,
     *         relayer/factory wrappers, etc.) are part of the
     *         supported caller set.
     *
     *         The forward-before-pull order means a logic-side revert
     *         does not move funds. The whole tx reverts atomically on
     *         any failure path — the NFT is never minted without TRAC
     *         backing it and a recorded `Account` row.
     */
    function createAccount(uint96 committedTRAC, uint72 primaryNode) external returns (uint256 accountId) {
        if (committedTRAC == 0) revert InvalidAmount();

        accountId = _nextAccountId++;

        _publishingConviction().createAccount(msg.sender, accountId, committedTRAC, primaryNode);

        // Direct publisher -> CSS vault transfer. Contract never holds TRAC.
        // The TRAC sits in escrow against this account's billing windows and
        // is accounted to the staker pool lazily via active/passive sinks.
        if (!tokenContract.transferFrom(msg.sender, stakingStorageAddress, committedTRAC)) {
            revert TokenTransferFailed();
        }

        _mint(msg.sender, accountId);
    }

    /**
     * @notice Add TRAC to an existing account's persistent top-up
     *         buffer.
     *
     * @dev    The wrapper owns ownership validation and the TRAC pull;
     *         the logic contract enforces "amount > 0" and "not
     *         expired", and triggers lazy settlement before crediting
     *         the buffer. Order of operations matches `createAccount`:
     *         logic update first, TRAC pull last so a logic-side
     *         revert does not move funds.
     */
    function topUp(uint256 accountId, uint96 amount) external {
        _requireOwner(accountId);

        _publishingConviction().topUp(msg.sender, accountId, amount);

        if (!tokenContract.transferFrom(msg.sender, stakingStorageAddress, amount)) {
            revert TokenTransferFailed();
        }
    }

    /**
     * @notice OT-RFC-51: re-designate the primary node that this account's
     *         committed publishing allocation is credited to. Owner-gated
     *         here; the logic contract enforces the once-per-epoch rate
     *         limit and `nodeExists` validation for the new node, and moves
     *         future-epoch allocation net-zero on K_total.
     */
    function setPrimaryNode(uint256 accountId, uint72 newNode) external {
        _requireOwner(accountId);
        // OT-RFC-51 defense-in-depth: there is no clear-designation semantic.
        // The logic contract also rejects this; guard here so a 0 can never
        // reach it (see PublishingConviction.ZeroPrimaryNode).
        if (newNode == 0) revert ZeroPrimaryNode();
        _publishingConviction().setPrimaryNode(accountId, newNode);
    }

    // ========================================================================
    //                  KAV10-driven cost coverage
    // ========================================================================

    /**
     * @notice Charge a publishing agent's allowance for `baseCost` and
     *         distribute `discountedCost` over the published KC's
     *         epoch range. Callable ONLY by `KnowledgeAssetsV10`.
     *
     * @dev    The KAV10 gate lives here (not on the logic contract) so
     *         the logic contract's caller gate can stay
     *         `onlyConvictionNFT` and consistent with every other
     *         NFT-driven entry point. KAV10 calls THIS contract; we
     *         validate and forward.
     */
    function coverPublishingCost(
        address publishingAgent,
        uint96 baseCost,
        uint40 kcStartEpoch,
        uint40 kcEpochs
    ) external returns (uint96 discountedCost) {
        address kav10 = hub.getContractAddress("KnowledgeAssetsLifecycle");
        if (msg.sender != kav10) revert OnlyKnowledgeAssetsV10(msg.sender);

        return _publishingConviction().coverPublishingCost(publishingAgent, baseCost, kcStartEpoch, kcEpochs);
    }

    /// @notice Permissionless lazy-settlement entry point.
    /// @dev    Pure forwarder — the logic contract handles existence
    ///         and `fullySwept` short-circuit checks.
    function settle(uint256 accountId) external {
        _publishingConviction().settle(accountId);
    }

    // ========================================================================
    //                  Agent management entry points
    // ========================================================================

    function registerAgent(uint256 accountId, address agent) external {
        _requireOwner(accountId);
        _publishingConviction().registerAgent(msg.sender, accountId, agent);
    }

    function deregisterAgent(uint256 accountId, address agent) external {
        _requireOwner(accountId);
        _publishingConviction().deregisterAgent(msg.sender, accountId, agent);
    }

    // ========================================================================
    //                  Governance forwarders
    // ========================================================================

    /// @notice Tune the per-account agent registration cap.
    /// @dev    Selector-stable forwarder for `setMaxAgentsPerAccount`.
    ///         The `onlyHubOwner` gate is enforced HERE because PCS's
    ///         own `setMaxAgentsPerAccount` is gated `onlyContracts`
    ///         (so this forwarder, a Hub-registered contract, may
    ///         drive the write). Without the gate on the wrapper, any
    ///         externally-owned account could re-tune the cap.
    function setMaxAgentsPerAccount(uint256 cap) external onlyHubOwner {
        publishingConvictionStorage.setMaxAgentsPerAccount(cap);
    }

    // ========================================================================
    //              Selector-stable view forwarders
    // ========================================================================
    //
    // These functions preserve the public selectors that v2.x exposed via
    // public mappings / variables. `IDKGPublishingConvictionNFT` callers
    // (`KnowledgeAssetsV10`, `ContextGraphs`, off-chain indexers) keep
    // working unchanged. Each forwarder is a pure read against PCS.

    /// @notice Conviction-account record by id. Selector-compatible
    ///         with the legacy v2.x `accounts` public mapping AND
    ///         behavior-compatible with it: returns the all-zero
    ///         tuple for an unknown / unminted `accountId` instead
    ///         of reverting. Indexers and existence-probe callers
    ///         that read the legacy mapping continue to work
    ///         unchanged. Use `getAccount(accountId)` (forwarded
    ///         from `PublishingConvictionStorage`) for the
    ///         fail-closed variant that reverts `UnknownAccount`.
    ///
    ///         Implemented by forwarding to the storage contract's
    ///         auto-generated `accounts(accountId)` mapping getter,
    ///         not `getAccount(accountId)`, precisely so the unknown-
    ///         id branch keeps the legacy zero-tuple semantic. Codex
    ///         round 3 review on PR #650 flagged the prior
    ///         `getAccount(...)` forwarder as an observable behavior
    ///         break vs the legacy public mapping; this regression
    ///         is locked in by `accounts(unknown id) returns zero
    ///         tuple` in `DKGPublishingConvictionNFT.test.ts`.
    function accounts(uint256 accountId) external view returns (
        uint96 committedTRAC,
        uint40 createdAtEpoch,
        uint40 expiresAtEpoch,
        uint40 createdAtTimestamp,
        uint40 expiresAtTimestamp,
        uint16 lockDurationEpochs,
        uint16 discountBps,
        uint16 lastSettledWindow,
        bool fullySwept,
        uint72 primaryNode,
        uint40 lastPrimaryNodeChangeEpoch
    ) {
        return publishingConvictionStorage.accounts(accountId);
    }

    /// @notice Per-billing-window TRAC drawn against the base
    ///         allowance. Selector-compatible with the legacy
    ///         `windowSpent` public mapping.
    function windowSpent(uint256 accountId, uint40 w) external view returns (uint96) {
        return publishingConvictionStorage.windowSpent(accountId, w);
    }

    /// @notice Persistent top-up buffer for `accountId`.
    function topUpBalance(uint256 accountId) external view returns (uint96) {
        return publishingConvictionStorage.topUpBalance(accountId);
    }

    /// @notice Reverse map: account id paying for a given agent (0 if
    ///         not registered). Selector-compatible.
    function agentToAccountId(address agent) external view returns (uint256) {
        return publishingConvictionStorage.agentToAccountId(agent);
    }

    /// @notice Governance-tunable cap on registered agents per account.
    function maxAgentsPerAccount() external view returns (uint256) {
        return publishingConvictionStorage.maxAgentsPerAccount();
    }

    /// @notice Enumerate every registered agent for `accountId`.
    function getRegisteredAgents(uint256 accountId) external view returns (address[] memory) {
        return publishingConvictionStorage.getRegisteredAgents(accountId);
    }

    /// @notice Membership check used by off-chain integrations.
    function isAgent(uint256 accountId, address agent) external view returns (bool) {
        return publishingConvictionStorage.isRegisteredAgent(accountId, agent);
    }

    /// @notice Discrete 6-tier discount ladder. Selector-compatible
    ///         wrapper read over the shared publishing math helper.
    function getDiscountBps(uint96 committedTRAC) public pure returns (uint256) {
        return PublishingMathLib.discountBps(committedTRAC);
    }

    /// @notice Discount basis points fixed at creation for `accountId`.
    function getDiscount(uint256 accountId) external view returns (uint256) {
        return publishingConvictionStorage.getAccount(accountId).discountBps;
    }

    /// @notice Discounted cost preview for a given account + base cost.
    function getDiscountedCost(uint256 accountId, uint96 baseCost) external view returns (uint96) {
        uint256 bps = publishingConvictionStorage.getAccount(accountId).discountBps;
        return uint96((uint256(baseCost) * (BPS_DENOMINATOR - bps)) / BPS_DENOMINATOR);
    }

    /// @notice Aggregate read combining account fields, top-up balance,
    ///         and agent count into one tuple. Selector-stable.
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
        PublishingConvictionStorage.Account memory a =
            publishingConvictionStorage.getAccount(accountId);
        return (
            ownerOf(accountId),
            a.committedTRAC,
            a.committedTRAC / uint96(a.lockDurationEpochs),
            a.createdAtEpoch,
            a.expiresAtEpoch,
            a.createdAtTimestamp,
            a.expiresAtTimestamp,
            a.discountBps,
            publishingConvictionStorage.topUpBalance(accountId),
            publishingConvictionStorage.agentCount(accountId),
            a.lastSettledWindow,
            a.fullySwept
        );
    }

    /// @notice Remaining base + topUp allowance for `accountId` in
    ///         chain `epoch`. Forwards to the logic contract's view.
    function getRemainingAllowance(uint256 accountId, uint40 epoch) external view returns (uint96) {
        return _publishingConviction().getRemainingAllowance(accountId, epoch);
    }

    /// @notice Current billing-window index for `accountId`.
    function getCurrentBillingWindow(uint256 accountId) external view returns (uint40) {
        return _publishingConviction().getCurrentBillingWindow(accountId);
    }

    /// @notice Chain-epoch range for billing window `w`.
    function getWindowChainEpochRange(uint256 accountId, uint40 w)
        external
        view
        returns (uint40 startEp, uint40 endEp)
    {
        return _publishingConviction().getWindowChainEpochRange(accountId, w);
    }

    // ========================================================================
    //                  ERC-721 overrides
    // ========================================================================

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

    /// @dev Owner-to-owner transfer hook: forward to the logic contract
    ///      so it can flush pending lazy settlement and clear every
    ///      agent registration. Skipped on mint/burn (`from == 0` or
    ///      `to == 0`). Mint case: the storage record is populated AFTER
    ///      `_mint` returns by `createAccount`, so the hook would have
    ///      no Account to settle anyway.
    function _update(
        address to,
        uint256 tokenId,
        address auth
    ) internal virtual override(ERC721Enumerable) returns (address) {
        address from = super._update(to, tokenId, auth);

        if (from != address(0) && to != address(0) && from != to) {
            _publishingConviction().onTransfer(tokenId, from, to);
        }

        return from;
    }

    // ========================================================================
    //                  Internal
    // ========================================================================

    function _publishingConviction() internal view returns (PublishingConviction) {
        address logic = hub.getContractAddress("PublishingConviction");
        if (logic == address(0)) revert ZeroAddressDependency("PublishingConviction");
        return PublishingConviction(logic);
    }

    function _requireOwner(uint256 accountId) internal view {
        if (_ownerOf(accountId) == address(0)) {
            // Match OZ's `ERC721NonexistentToken` revert by relying on
            // `_requireOwned` so callers see the same surface across
            // legacy and split implementations.
            _requireOwned(accountId);
        }
        if (ownerOf(accountId) != msg.sender) {
            revert NotAccountOwner(accountId, msg.sender);
        }
    }
}
