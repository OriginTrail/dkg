// SPDX-License-Identifier: Apache-2.0

pragma solidity ^0.8.20;

import {INamed} from "../interfaces/INamed.sol";
import {IVersioned} from "../interfaces/IVersioned.sol";
import {IInitializable} from "../interfaces/IInitializable.sol";
import {HubDependent} from "../abstract/HubDependent.sol";

/**
 * @title PublishingConvictionStorage
 * @notice Single source of truth for V10 publisher conviction account state.
 *
 * Architecture (mirrors the V10 staking split — `ConvictionStakingStorage`
 * holds positions, `StakingV10` is stateless logic, `DKGStakingConvictionNFT`
 * is a thin ERC-721 wrapper):
 *
 *   - `PublishingConvictionStorage` (this contract) owns every byte of
 *     application state for publisher conviction accounts: the `Account`
 *     struct keyed by `accountId`, per-billing-window TRAC accounting
 *     (`windowSpent`), the persistent top-up buffer (`topUpBalance`), the
 *     agent registration tables, and the governance-tunable
 *     `maxAgentsPerAccount` cap.
 *
 *     This is a fresh-state contract: it ships EMPTY at deploy time
 *     and there is NO automated migration path that copies state out
 *     of the legacy combined `DKGPublishingConvictionNFT` v2.x. PCA
 *     accounts opened against the v2.x contract are NOT readable here
 *     after the upgrade. This is intentional and matches how the V10
 *     line has handled prior storage-split redeploys
 *     (`ProfileStorage`, `ParametersStorage`): network operators bump
 *     `chainResetMarker` in the network config so daemons auto-wipe
 *     their derived chain state on next start, the on-chain Hub
 *     re-points consumers (`KnowledgeAssetsV10`, `ContextGraphs`) at
 *     this contract, and the publisher fleet re-creates conviction
 *     accounts under the new wrapper. PR #650 ships the
 *     `chainResetMarker` bump alongside this storage contract; do
 *     NOT deploy the new PCA stack against a network without the
 *     accompanying marker bump. See `network/testnet.json` and the
 *     PR body's "Migration / fresh-state reset" section.
 *   - `PublishingConviction` (the new logic contract) holds zero
 *     application state — only Hub-resolved contract references and
 *     metadata. It reads/writes here via `onlyContracts`-gated mutators
 *     and runs every business rule (account creation, billing-window
 *     settlement, lazy passive-sink sweeps, post-expiry final sweep, and
 *     active-sink epoch distribution).
 *   - `DKGPublishingConvictionNFT` keeps only the ERC-721 surface
 *     (mint/burn, transfer hook, ownership checks), the
 *     `_nextAccountId` mint counter, and the publisher-facing TRAC
 *     `transferFrom` paths. Every state read/write goes through this
 *     storage contract.
 *
 * Storage independence (the architectural goal):
 *   - The logic contract can be redeployed without touching account or
 *     agent state — Hub re-registers the new logic address, the storage
 *     keeps every existing `accounts[id]`, `topUpBalance[id]`,
 *     `windowSpent[id][w]`, and agent registration intact.
 *   - The NFT wrapper can also be redeployed (e.g. ERC-721 metadata
 *     surface change), at the cost of resetting `_nextAccountId` —
 *     existing accounts keep their state but new mints would clash if
 *     the counter resets, so this is an upgrade path that requires care.
 *
 * State boundaries (what does NOT live here):
 *   - `_nextAccountId` — stays on the NFT wrapper because it is tightly
 *     coupled to ERC-721 mint ordering; the wrapper increments and
 *     supplies the new id to the logic contract on each `createAccount`
 *     forward (mirrors `DKGStakingConvictionNFT.nextTokenId`).
 *   - TRAC vault custody — TRAC sits in `ConvictionStakingStorage`
 *     (the V10 vault, post-v4.0.0 consolidation). This storage contract
 *     never holds TRAC and never moves it. The NFT wrapper drives
 *     `transferFrom(publisher → CSS)` directly on `createAccount` /
 *     `topUp`; this storage only updates the bookkeeping that controls
 *     how that escrowed TRAC eventually flows to staker pools via
 *     `EpochStorage.addTokensToEpochRange`.
 *
 * Caller gates:
 *   - Mutating functions are `onlyContracts` — only Hub-registered
 *     contracts (in practice `PublishingConviction`, with the NFT
 *     wrapper as a fallback for direct-write paths if ever needed) can
 *     invoke them.
 *   - `setMaxAgentsPerAccount` is `onlyHubOwner` because it is a
 *     governance-side parameter (mirrors `setStatus` / parameter
 *     setters on other V10 storage contracts).
 *
 * Invariants enforced inside this contract:
 *   - `agentToAccountId[agent] == accountId` iff
 *     `_isRegisteredAgent[accountId][agent] == true`. Agent register /
 *     deregister / clear-all paths flip both flags atomically so the
 *     two views never drift.
 *   - `_registeredAgents[accountId]` always equals the set of `agent`s
 *     for which `_isRegisteredAgent[accountId][agent] == true`. The
 *     swap-and-pop in `removeAgent` keeps the array in sync.
 */
contract PublishingConvictionStorage is INamed, IVersioned, HubDependent, IInitializable {
    string private constant _NAME = "PublishingConvictionStorage";
    // 1.0.0 — initial split-out from `DKGPublishingConvictionNFT` v2.0.0.
    //         Identical state shape; no semantic changes.
    // 10.0.3 — OT-RFC-51 "Publishing Allocation": `Account` gains
    //          `primaryNode` + `lastPrimaryNodeChangeEpoch`, with the
    //          `setPrimaryNodeData` onlyContracts setter.
    string private constant _VERSION = "10.0.3";

    /// @notice Default cap on registered agents per account, applied on
    ///         first `initialize()` so a fresh deploy has a sane bound
    ///         even before a HubOwner explicitly tunes it.
    uint256 internal constant _DEFAULT_MAX_AGENTS_PER_ACCOUNT = 100;

    // ============================================================
    //                     Account record
    // ============================================================
    //
    // Field semantics (mirrors the legacy v2.x struct exactly so account
    // state migrates 1:1 from the NFT):
    //   - committedTRAC          : original commit at creation. Never
    //                              changes after `createAccount`.
    //   - createdAtEpoch         : Chronos epoch the account was created
    //                              in (informational; not used for math).
    //   - expiresAtEpoch         : first chain epoch past the account's
    //                              lock (exclusive upper bound for
    //                              `getRemainingAllowance`).
    //   - createdAtTimestamp     : wall-clock anchor; billing windows
    //                              are computed relative to this.
    //   - expiresAtTimestamp     : `createdAtTimestamp +
    //                              lockDurationEpochs * epochLength`.
    //   - lockDurationEpochs     : number of billing windows the account
    //                              spans (also the number of base-budget
    //                              slices `committedTRAC` is divided into).
    //   - discountBps            : 6-tier discount fixed at creation;
    //                              top-ups do NOT change it.
    //   - lastSettledWindow      : next unsettled billing-window index
    //                              (exclusive of the highest already-swept
    //                              window). Drives the lazy-settlement loop.
    //   - fullySwept             : terminal flag. True once the post-expiry
    //                              final sweep has accounted leftover
    //                              top-up + dust to the staker pool. Acts
    //                              as a re-entry guard.
    struct Account {
        uint96 committedTRAC;
        uint40 createdAtEpoch;
        uint40 expiresAtEpoch;
        uint40 createdAtTimestamp;
        uint40 expiresAtTimestamp;
        uint16 lockDurationEpochs;
        uint16 discountBps;
        uint16 lastSettledWindow;
        bool fullySwept;
        // OT-RFC-51 "Publishing Allocation": the node this account's
        // committed PCA budget is credited to as publishing allocation
        // (K_n). `0` means no designated node (no allocation seeded).
        uint72 primaryNode; // designated node identityId; 0 = none
        // Rate-limit cursor for `setPrimaryNode`: re-designation is allowed
        // at most once per chain epoch (require currentEpoch > this value).
        uint40 lastPrimaryNodeChangeEpoch; // re-designation rate-limit cursor
    }

    // ============================================================
    //                       Events
    // ============================================================

    /// @notice Emitted when the governance-tunable agent cap changes.
    event MaxAgentsPerAccountUpdated(uint256 oldCap, uint256 newCap);

    // ============================================================
    //                        Errors
    // ============================================================

    error AccountAlreadyExists(uint256 accountId);
    error UnknownAccount(uint256 accountId);
    error AgentAlreadyRegistered(address agent, uint256 existingAccountId);
    error AgentNotRegistered(uint256 accountId, address agent);
    error TopUpUnderflow(uint256 accountId, uint96 amount, uint96 balance);

    // ============================================================
    //                       State
    // ============================================================

    mapping(uint256 => Account) public accounts;

    /// @notice Per-billing-window TRAC drawn against the current
    ///         account's base allowance. Second key is the billing-window
    ///         index (0-based, relative to `Account.createdAtTimestamp`);
    ///         it is NOT a chain-epoch number. The base allowance per
    ///         window is `committedTRAC / lockDurationEpochs`; a window's
    ///         entry is bounded by that value.
    mapping(uint256 => mapping(uint40 => uint96)) public windowSpent;

    /// @notice Persistent top-up buffer per account (NOT per-window).
    ///         Drained only when the current window's base allowance is
    ///         exhausted. Any non-zero balance at account expiry is swept
    ///         to the staker pool by the final-sweep path.
    mapping(uint256 => uint96) public topUpBalance;

    /// @notice Per-account agent enumeration. Kept as an array so the
    ///         transfer hook on the NFT wrapper can iterate and clear
    ///         every registration in one call. The agent-side reverse
    ///         map is `agentToAccountId`.
    mapping(uint256 => address[]) internal _registeredAgents;

    /// @notice Reverse map exposed publicly so external callers
    ///         (`KnowledgeAssetsV10`, `ContextGraphs`) can resolve a
    ///         publishing-agent address to its paying account id without
    ///         caller-supplied authorization. The "not registered"
    ///         sentinel is `0`, which is why `_nextAccountId` on the NFT
    ///         starts at 1.
    mapping(address => uint256) public agentToAccountId;

    /// @notice Membership index that lets `coverPublishingCost` /
    ///         `deregisterAgent` decide whether an `agent` is registered
    ///         under `accountId` in O(1) without scanning
    ///         `_registeredAgents[accountId]`.
    mapping(uint256 => mapping(address => bool)) internal _isRegisteredAgent;

    /// @notice Governance-tunable cap on `_registeredAgents[accountId].length`.
    ///         Initialized to `_DEFAULT_MAX_AGENTS_PER_ACCOUNT` on the
    ///         first `initialize()`; a HubOwner can retune via
    ///         `setMaxAgentsPerAccount`.
    uint256 public maxAgentsPerAccount;

    constructor(address hubAddress) HubDependent(hubAddress) {}

    /// @dev `initialize()` is idempotent across redeploys: the first call
    ///      seeds `maxAgentsPerAccount` to the default; subsequent calls
    ///      (e.g. post-upgrade) preserve whatever value the HubOwner has
    ///      tuned it to.
    function initialize() external onlyHub {
        if (maxAgentsPerAccount == 0) {
            maxAgentsPerAccount = _DEFAULT_MAX_AGENTS_PER_ACCOUNT;
        }
    }

    function name() external pure virtual override returns (string memory) {
        return _NAME;
    }

    function version() external pure virtual override returns (string memory) {
        return _VERSION;
    }

    // ============================================================
    //                  Account read helpers
    // ============================================================

    /// @notice Return the full `Account` record by id. Reverts if the
    ///         account has never been created (sentinel:
    ///         `lockDurationEpochs == 0` because every real account
    ///         carries at least one billing window).
    function getAccount(uint256 accountId) external view returns (Account memory) {
        Account memory a = accounts[accountId];
        if (a.lockDurationEpochs == 0) revert UnknownAccount(accountId);
        return a;
    }

    /// @notice Existence check used by callers that only need to know
    ///         whether an account record is populated (e.g. the public
    ///         `settle()` short-circuit). Returns `false` for any
    ///         accountId that has never been minted.
    function accountExists(uint256 accountId) external view returns (bool) {
        return accounts[accountId].lockDurationEpochs != 0;
    }

    // ============================================================
    //                  Account write helpers
    // ============================================================

    /// @notice Persist a brand-new `Account` record. Used by
    ///         `PublishingConviction.createAccount` after the NFT
    ///         wrapper has allocated `accountId` from its mint counter.
    ///         Reverts if a record at `accountId` already exists, so a
    ///         logic-side bug or replay cannot silently overwrite an
    ///         active account.
    function createAccount(uint256 accountId, Account calldata acct) external onlyContracts {
        if (accounts[accountId].lockDurationEpochs != 0) revert AccountAlreadyExists(accountId);
        accounts[accountId] = acct;
    }

    /// @notice Advance the lazy-settlement cursor. Caller (logic) is
    ///         responsible for never moving it past `lockDurationEpochs`.
    function setLastSettledWindow(uint256 accountId, uint16 w) external onlyContracts {
        accounts[accountId].lastSettledWindow = w;
    }

    /// @notice Mark the account as fully swept. Called once by the
    ///         post-expiry final-sweep path; subsequent settle calls
    ///         observe `fullySwept == true` and short-circuit.
    function setFullySwept(uint256 accountId, bool v) external onlyContracts {
        accounts[accountId].fullySwept = v;
    }

    /// @notice OT-RFC-51: persist the designated `primaryNode` and the
    ///         `lastPrimaryNodeChangeEpoch` rate-limit cursor. Logic-side
    ///         (`PublishingConviction.setPrimaryNode`) is responsible for
    ///         the once-per-epoch gate and for `nodeExists` validation;
    ///         storage just records.
    function setPrimaryNodeData(
        uint256 accountId,
        uint72 node,
        uint40 changeEpoch
    ) external onlyContracts {
        accounts[accountId].primaryNode = node;
        accounts[accountId].lastPrimaryNodeChangeEpoch = changeEpoch;
    }

    // ============================================================
    //                  Window-spent write helpers
    // ============================================================

    /// @notice Add `amount` to `windowSpent[accountId][w]`. Logic-side
    ///         callers are responsible for never exceeding the per-window
    ///         base allowance (`committedTRAC / lockDurationEpochs`); the
    ///         storage contract just records.
    function increaseWindowSpent(
        uint256 accountId,
        uint40 w,
        uint96 amount
    ) external onlyContracts {
        windowSpent[accountId][w] += amount;
    }

    // ============================================================
    //                  Top-up balance write helpers
    // ============================================================

    /// @notice Add to the persistent top-up buffer (publisher pays in
    ///         to extend allowance beyond the base budget).
    function increaseTopUpBalance(uint256 accountId, uint96 amount) external onlyContracts {
        topUpBalance[accountId] += amount;
    }

    /// @notice Drain `amount` from the top-up buffer. Reverts on
    ///         underflow so callers cannot silently overdraw — this is
    ///         a defensive guard; logic-side `coverPublishingCost`
    ///         already rejects insufficient-allowance combinations
    ///         with a richer error.
    function decreaseTopUpBalance(uint256 accountId, uint96 amount) external onlyContracts {
        uint96 bal = topUpBalance[accountId];
        if (amount > bal) revert TopUpUnderflow(accountId, amount, bal);
        unchecked {
            topUpBalance[accountId] = bal - amount;
        }
    }

    /// @notice Zero the top-up buffer in a single SSTORE; used by the
    ///         post-expiry final sweep before crediting the staker pool.
    function clearTopUpBalance(uint256 accountId) external onlyContracts {
        if (topUpBalance[accountId] != 0) {
            topUpBalance[accountId] = 0;
        }
    }

    // ============================================================
    //                  Agent registry helpers
    // ============================================================

    /// @notice Read the registered-agent array for an account. Returns
    ///         an empty array for unknown accounts so callers can
    ///         iterate safely on accounts that never registered an agent.
    function getRegisteredAgents(uint256 accountId) external view returns (address[] memory) {
        return _registeredAgents[accountId];
    }

    /// @notice O(1) membership check used by `coverPublishingCost` and
    ///         `deregisterAgent` to validate (accountId, agent) pairs
    ///         without scanning the array.
    function isRegisteredAgent(uint256 accountId, address agent) external view returns (bool) {
        return _isRegisteredAgent[accountId][agent];
    }

    /// @notice Number of agents registered under `accountId`. Useful for
    ///         the public `getAccountInfo` view on the NFT wrapper.
    function agentCount(uint256 accountId) external view returns (uint256) {
        return _registeredAgents[accountId].length;
    }

    /// @notice Append `agent` under `accountId`. Reverts if `agent` is
    ///         already registered anywhere (the reverse map is global —
    ///         a single agent address may pay for at most one account).
    ///         The cap (`maxAgentsPerAccount`) is enforced by the logic
    ///         contract, NOT here, because storage stays policy-free.
    function addAgent(uint256 accountId, address agent) external onlyContracts {
        if (agentToAccountId[agent] != 0) {
            revert AgentAlreadyRegistered(agent, agentToAccountId[agent]);
        }
        _registeredAgents[accountId].push(agent);
        _isRegisteredAgent[accountId][agent] = true;
        agentToAccountId[agent] = accountId;
    }

    /// @notice Remove `agent` from `accountId`. Reverts if not registered.
    ///         The array is compacted via swap-and-pop; the reverse map
    ///         and membership index are both cleared so the
    ///         agent address can be re-registered later (against the
    ///         same or a different account).
    function removeAgent(uint256 accountId, address agent) external onlyContracts {
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
    }

    /// @notice Bulk-clear every agent registration under `accountId`.
    ///         Used by the NFT wrapper's transfer hook so the new owner
    ///         starts with a clean agent slate (no inherited authorities
    ///         from the prior owner). Idempotent on accounts with no
    ///         registered agents.
    function clearAgents(uint256 accountId) external onlyContracts {
        address[] storage agents = _registeredAgents[accountId];
        uint256 len = agents.length;
        for (uint256 i; i < len; i++) {
            _isRegisteredAgent[accountId][agents[i]] = false;
            agentToAccountId[agents[i]] = 0;
        }
        if (len != 0) {
            delete _registeredAgents[accountId];
        }
    }

    // ============================================================
    //                  Governance — agent cap
    // ============================================================

    /// @notice Tune the per-account agent cap. `onlyContracts` here so
    ///         the NFT wrapper's `setMaxAgentsPerAccount` forwarder can
    ///         drive the write — the wrapper enforces the `onlyHubOwner`
    ///         user-facing gate. Direct PCS callers from outside the
    ///         Hub-registered contract set are rejected. Setting the
    ///         cap below an existing account's registered count does
    ///         NOT retroactively unregister anyone — it only blocks
    ///         further `addAgent` calls until the count drops.
    function setMaxAgentsPerAccount(uint256 cap) external onlyContracts {
        uint256 old = maxAgentsPerAccount;
        maxAgentsPerAccount = cap;
        emit MaxAgentsPerAccountUpdated(old, cap);
    }
}
