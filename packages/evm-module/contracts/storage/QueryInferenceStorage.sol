// SPDX-License-Identifier: Apache-2.0

pragma solidity ^0.8.20;

import {INamed} from "../interfaces/INamed.sol";
import {IVersioned} from "../interfaces/IVersioned.sol";
import {IInitializable} from "../interfaces/IInitializable.sol";
import {HubDependent} from "../abstract/HubDependent.sol";
import {Chronos} from "./Chronos.sol";

/**
 * @title QueryInferenceStorage
 * @notice State store of the query/inference reward pool of OT-RFC-27
 *         ("NeuroSymbolic Marketplace"): the subscription-funded pool that
 *         counted receipt value and stake-weighted receipt value (QIF)
 *         distribute among Core Nodes, kept apart from the publishing-funded
 *         staker pool in `EpochStorage`.
 *
 * What it holds:
 *   - The money funded per epoch. A subscription is for one epoch, and its
 *     money joins the pool of that epoch. `walletFunding(e)` is the value of
 *     the wallet-funded subscriptions of `e` and their top-ups, and
 *     `accountFunding(e)` the cost that the Conviction Account subscriptions of
 *     `e` and their top-ups spent from the accounts' allowances. Both are
 *     booked when the subscription is paid for: a Conviction Account pays as a
 *     wallet does.
 *   - The QIF inputs per epoch and per node, each epoch's λ, how much of each
 *     budget is used, and the request replay bitmap.
 *   - The parameters: the activation epoch, the batch bounds, the pause switch
 *     and λ.
 *
 * The settlement logic (`QueryInferenceSettlement`) writes the counts and the
 * replay bitmap, and the requests it verifies are signed under an EIP-712
 * domain whose verifying contract is this storage, so a logic upgrade keeps
 * both the signatures and the bitmap.
 *
 * Architecture (the pattern of `ServiceSubscriptionsStorage`):
 *   - It never holds or moves TRAC. Every subscription token sits in the vault
 *     (`ConvictionStakingStorage`) with all other V10 TRAC; this contract only
 *     accounts for it.
 *   - It is policy-free. Every mutator is `onlyContracts` (any Hub-registered
 *     contract, and the Hub owner), and the logic contracts enforce every
 *     business rule before they write. The one rule it keeps itself is that an
 *     epoch that has ended takes no write to its money or its QIF inputs, so
 *     everything a reward claim reads from an ended epoch is final. Business
 *     events come from the logic contracts; this contract emits events only
 *     for its parameters.
 *   - Every field has a view, and every field the logic contracts write has a
 *     narrow setter that writes that field alone, beside `countReceipts`, which
 *     writes several at once, so a later logic version reads and writes all of
 *     this state without a new storage, which would start empty. The setters
 *     keep the storage's own rules: an ended epoch takes no write, and a nonce
 *     bit, once set, is never cleared. `countReceipts` remains the normal path:
 *     a writer that calls a narrow setter keeps in step the fields its NatSpec
 *     names.
 *   - The parameter setters are `onlyHub`, so governance reaches them through
 *     `Hub.forwardCall` (the Hub owner may also call them directly). The current
 *     epoch is read from the Hub's `Chronos` at the call, so no reference is
 *     stored.
 *
 * Activation: `activationEpoch` is the first epoch whose rewards include this
 * pool, and the first in which subscriptions can be funded from a wallet. It is
 * set once, to the current epoch or a later one, never to an epoch that has
 * already ended, and only once the Hub's `QueryInferenceSettlement` and
 * `StakingV10` both read this storage, so every claim from activation on pays
 * the pool. Until it is set and reached, the logic contracts refuse every
 * wallet funding and top-up and every receipt batch, so no epoch that may
 * already have been claimed changes.
 *
 * Fresh state: the contract ships empty and is never upgraded in place. A
 * replacement starts empty, under its own address, so the storage layout
 * matters to indexers rather than to migrations, and requests signed against
 * this address stay bound to it. The declaration order of the state below IS
 * the layout:
 *   - slot 0 packs the inherited `hub` with the activation epoch, the pause
 *     switch, the batch bounds and λ (31 of 32 bytes);
 *   - slots 1 to 6 the mappings, in order.
 *
 * Replacing it needs a migration, which no deploy step runs. A replacement
 * starts empty, and `StakingV10` takes the activation epoch from the storage
 * its settlement uses, so at the swap:
 *   - every node-epoch before the replacement's activation that no claim has
 *     split yet is split without its share of this pool, which stays in the
 *     vault for good;
 *   - money funded for epochs in which no node has served value yet, whether
 *     they have ended or not, stays here, unpaid;
 *   - requests signed for this address do not verify against another.
 * A migration claims every position first (`StakingV10.claimFor`), swaps at an
 * epoch boundary, and books that money into the replacement
 * (`addWalletFunding`, `addAccountFunding`). The pause is no substitute: claims
 * go on while paused.
 */
contract QueryInferenceStorage is INamed, IVersioned, HubDependent, IInitializable {
    string private constant _NAME = "QueryInferenceStorage";
    string private constant _VERSION = "1.0.0";

    /// @notice The denominator of `lambdaBps`: 10,000 is λ = 1.
    uint16 public constant BPS_DENOMINATOR = 10_000;

    uint16 internal constant _DEFAULT_MAX_ITEMS_PER_BATCH = 256;
    uint8 internal constant _DEFAULT_MAX_GROUPS_PER_BATCH = 32;

    uint16 internal constant _ITEMS_PER_BATCH_UPPER_BOUND = 1024;

    // ============================================================
    //                          Records
    // ============================================================

    /// @notice An epoch's totals over all nodes: `totalServed` is OT-RFC-27's
    ///         ΣR and `totalWeighted` its ΣQueryInferenceScore. `lambdaBps` is
    ///         the epoch's λ, taken from the parameter when its first value
    ///         counts and fixed from then on.
    struct EpochTotals {
        uint120 totalServed;
        uint120 totalWeighted;
        uint16 lambdaBps;
    }

    /// @notice A node's value in one epoch, in OT-RFC-27's terms: `servedValue`
    ///         is R, its counted receipt value after the discount, and
    ///         `weightedValue` is QueryInferenceScore, R at the stake factor.
    struct NodeEpoch {
        uint128 servedValue;
        uint128 weightedValue;
    }

    // ============================================================
    //                    Events (parameters only)
    // ============================================================

    event ActivationEpochSet(uint40 epoch);
    event MaxItemsPerBatchSet(uint16 oldValue, uint16 newValue);
    event MaxGroupsPerBatchSet(uint8 oldValue, uint8 newValue);
    event PausedSet(bool paused);
    event LambdaBpsSet(uint16 oldValue, uint16 newValue);

    // ============================================================
    //                          Errors
    // ============================================================

    error InvalidParameter(string name);
    error ActivationEpochAlreadySet(uint40 current);
    /// @notice The pool cannot be activated yet: `reader`, the Hub's
    ///         `QueryInferenceSettlement` or its `StakingV10`, is missing or
    ///         does not read this storage. Every epoch from activation on pays
    ///         the pool through `StakingV10`'s claims, so both come first: a
    ///         `StakingV10` that does not read the pool, as before 10.1.0,
    ///         splits each epoch without it, and that share stays in the vault
    ///         for good.
    error PoolNotWired(string reader);
    /// @notice `epoch` has ended: its money and its QIF inputs are final.
    error EpochEnded(uint256 epoch, uint256 currentEpoch);

    // ============================================================
    //          State (the declaration order is the layout)
    // ============================================================

    // Slot 0, after the inherited `hub`.
    /// @notice The first epoch whose rewards include this pool, and the first
    ///         in which subscriptions can be funded. Set once; 0 means unset.
    uint40 public activationEpoch;
    /// @notice While true, no subscription is funded or topped up, and no
    ///         receipt is batched. Claims go on.
    bool public paused;
    /// @notice The most receipt groups one batch may carry.
    uint8 public maxGroupsPerBatch;
    /// @notice The most receipt items one batch may carry.
    uint16 public maxItemsPerBatch;
    /// @notice λ, in basis points, for every epoch in which no value has
    ///         counted yet. An epoch's own λ is in its totals.
    uint16 public lambdaBps;

    // Slots 1 to 6.
    /// @notice epoch => the wallet-funded value of that epoch's subscriptions.
    mapping(uint256 => uint96) public walletFunding;
    /// @notice epoch => the Conviction Account cost of that epoch's
    ///         subscriptions: what they and their top-ups spent from the
    ///         accounts' allowances. `ServiceSubscriptions` books it; no other
    ///         contract does.
    mapping(uint256 => uint96) public accountFunding;
    /// @dev epoch => ΣR, ΣQueryInferenceScore and λ.
    mapping(uint256 => EpochTotals) internal _epochTotals;
    /// @dev identityId => epoch => R and QueryInferenceScore.
    mapping(uint72 => mapping(uint256 => NodeEpoch)) internal _nodeEpoch;
    /// @dev subscriptionId => budgetIndex => the face value of the receipts
    ///      counted in the budget, over all sellers.
    mapping(bytes32 => mapping(uint8 => uint96)) internal _budgetUsed;
    /// @dev subscriptionId => seller identityId => nonce >> 8 => 256 used-nonce bits.
    mapping(bytes32 => mapping(uint72 => mapping(uint64 => uint256))) internal _nonceBitmap;

    constructor(address hubAddress) HubDependent(hubAddress) {}

    /// @dev Idempotent across redeploys: seeds each bound's default only while
    ///      it is unset, so a value governance has tuned survives a
    ///      re-initialization. λ has no default: 0 is a valid value, and the
    ///      deployment sets it.
    function initialize() external onlyHub {
        if (maxItemsPerBatch == 0) {
            maxItemsPerBatch = _DEFAULT_MAX_ITEMS_PER_BATCH;
        }
        if (maxGroupsPerBatch == 0) {
            maxGroupsPerBatch = _DEFAULT_MAX_GROUPS_PER_BATCH;
        }
    }

    function name() external pure virtual override returns (string memory) {
        return _NAME;
    }

    function version() external pure virtual override returns (string memory) {
        return _VERSION;
    }

    // ============================================================
    //               Parameters (onlyHub: Hub.forwardCall)
    // ============================================================

    /**
     * @notice Set the activation epoch, once, to the current epoch or a later
     *         one, never to an epoch that has already ended: no epoch at or
     *         after it can have been claimed.
     * @dev    Refused (`PoolNotWired`) until every contract that pays the pool
     *         reads this storage: the Hub holds a `QueryInferenceSettlement`
     *         over it, and a `StakingV10` whose `queryInferenceStorage()`,
     *         which 10.1.0 added, names it. A `StakingV10` without that view,
     *         such as 10.0.4, or one that reverts, is not ready.
     */
    function setActivationEpoch(uint40 epoch) external onlyHub {
        uint40 current = activationEpoch;
        if (current != 0) revert ActivationEpochAlreadySet(current);
        if (epoch == 0 || epoch < _currentEpoch()) revert InvalidParameter("activationEpoch");
        if (!_readsThisPool("QueryInferenceSettlement")) revert PoolNotWired("QueryInferenceSettlement");
        if (!_readsThisPool("StakingV10")) revert PoolNotWired("StakingV10");
        activationEpoch = epoch;
        emit ActivationEpochSet(epoch);
    }

    /// @notice Set the most items per batch, from 1 to 1,024.
    function setMaxItemsPerBatch(uint16 value) external onlyHub {
        if (value == 0 || value > _ITEMS_PER_BATCH_UPPER_BOUND) revert InvalidParameter("maxItemsPerBatch");
        uint16 old = maxItemsPerBatch;
        maxItemsPerBatch = value;
        emit MaxItemsPerBatchSet(old, value);
    }

    /// @notice Set the most groups per batch, from 1 to 255.
    function setMaxGroupsPerBatch(uint8 value) external onlyHub {
        if (value == 0) revert InvalidParameter("maxGroupsPerBatch");
        uint8 old = maxGroupsPerBatch;
        maxGroupsPerBatch = value;
        emit MaxGroupsPerBatchSet(old, value);
    }

    /// @notice Switch the pause on or off. While it is on, no subscription is
    ///         funded or topped up, from a wallet or from a Conviction Account
    ///         alike, and no receipt is batched; claims go on. With the
    ///         settlement removed from the Hub, the emergency switch
    ///         (`StakingV10.queryInferenceSettlement`), only the pause stops
    ///         the funding.
    function setPaused(bool value) external onlyHub {
        paused = value;
        emit PausedSet(value);
    }

    /**
     * @notice Set λ, from 0 to 10,000 basis points.
     * @dev    An epoch takes λ once, when its first value counts
     *         (`countReceipts`), and keeps it. So a change applies to every
     *         epoch in which no value has counted yet, the current one
     *         included, and moves no epoch that is being paid or still to be.
     */
    function setLambdaBps(uint16 value) external onlyHub {
        if (value > BPS_DENOMINATOR) revert InvalidParameter("lambdaBps");
        uint16 old = lambdaBps;
        lambdaBps = value;
        emit LambdaBpsSet(old, value);
    }

    // ============================================================
    //                   Mutators (onlyContracts)
    // ============================================================

    /// @notice Book `amount` of wallet-funded value in `epoch`. It refuses an
    ///         epoch that has ended (`EpochEnded`).
    function addWalletFunding(uint256 epoch, uint96 amount) external onlyContracts {
        _requireNotEnded(epoch);
        walletFunding[epoch] += amount;
    }

    /// @notice Book `amount` of Conviction Account cost in `epoch`, as
    ///         `addWalletFunding` books wallet-funded value.
    function addAccountFunding(uint256 epoch, uint96 amount) external onlyContracts {
        _requireNotEnded(epoch);
        accountFunding[epoch] += amount;
    }

    /// @notice Mark the nonces of `bits` used, in word `word` of `seller`'s
    ///         requests in a subscription: bit i is nonce `word × 256 + i`. A
    ///         bit, once set, is never cleared.
    function useNonces(bytes32 subscriptionId, uint72 seller, uint64 word, uint256 bits) external onlyContracts {
        _nonceBitmap[subscriptionId][seller][word] |= bits;
    }

    /// @notice Count a group of receipts: `counted` of face value is added to
    ///         what the budget has used, and `servedValue` and `weightedValue`
    ///         join the node's and the epoch's totals in `epoch`. The first
    ///         value to count in an epoch fixes its λ.
    /// @dev    It refuses an epoch that has ended (`EpochEnded`). The sums are
    ///         checked.
    function countReceipts(
        bytes32 subscriptionId,
        uint8 budgetIndex,
        uint72 seller,
        uint256 epoch,
        uint96 counted,
        uint96 servedValue,
        uint96 weightedValue
    ) external onlyContracts {
        _requireNotEnded(epoch);
        _budgetUsed[subscriptionId][budgetIndex] += counted;

        NodeEpoch storage n = _nodeEpoch[seller][epoch];
        n.servedValue += servedValue;
        n.weightedValue += weightedValue;

        EpochTotals storage t = _epochTotals[epoch];
        if (t.totalServed == 0) t.lambdaBps = lambdaBps;
        t.totalServed += servedValue;
        t.totalWeighted += weightedValue;
    }

    // ============================================================
    //            Narrow setters (onlyContracts), one field each
    //
    // `countReceipts` remains the normal path: it keeps related fields in step.
    // A setter here writes its own field and leaves the others, so a later logic
    // version can ship without a new storage, and its caller keeps in step the
    // fields its NatSpec names.
    // ============================================================

    /// @notice Set the face value counted in a budget over all sellers, which
    ///         `countReceipts` adds to.
    /// @dev    The caller keeps it at most the budget's value: a batch reads
    ///         what the budget has left as the value less this.
    function setBudgetUsed(bytes32 subscriptionId, uint8 budgetIndex, uint96 value) external onlyContracts {
        _budgetUsed[subscriptionId][budgetIndex] = value;
    }

    /// @notice Set a node's R and QueryInferenceScore in `epoch`, which
    ///         `countReceipts` adds to. It refuses an epoch that has ended
    ///         (`EpochEnded`).
    /// @dev    The caller keeps in step the epoch's totals (`setEpochTotals`),
    ///         the sums of its nodes' `servedValue` and `weightedValue`, and a
    ///         node's `weightedValue` at most its `servedValue`, as the stake
    ///         factor leaves it. The node's gross is a share of the pool by
    ///         these over the totals, so totals below the sums pay out more
    ///         than the pool.
    function setNodeEpoch(uint72 identityId, uint256 epoch, NodeEpoch calldata n) external onlyContracts {
        _requireNotEnded(epoch);
        _nodeEpoch[identityId][epoch] = n;
    }

    /// @notice Set `epoch`'s ΣR, ΣQueryInferenceScore and λ, which
    ///         `countReceipts` writes. It refuses an epoch that has ended
    ///         (`EpochEnded`), and a λ above 10,000 basis points, at which no
    ///         gross of the epoch could be read.
    /// @dev    The caller keeps them the sums of the epoch's nodes'
    ///         `servedValue` and `weightedValue` (`setNodeEpoch`), and the pool
    ///         reads `totalServed`: 0 rolls the epoch's money forward, anything
    ///         else makes it part of the pool.
    function setEpochTotals(uint256 epoch, EpochTotals calldata t) external onlyContracts {
        _requireNotEnded(epoch);
        if (t.lambdaBps > BPS_DENOMINATOR) revert InvalidParameter("lambdaBps");
        _epochTotals[epoch] = t;
    }

    // ============================================================
    //                           Views
    // ============================================================

    /// @notice The money funded for `epoch`: the wallet-funded value and the
    ///         Conviction Account cost.
    function fundingIn(uint256 epoch) external view returns (uint96 wallet, uint96 account) {
        return (walletFunding[epoch], accountFunding[epoch]);
    }

    /// @notice What a funding or a top-up checks, in one call: the activation
    ///         epoch and the pause switch.
    function fundingState() external view returns (uint40 activation, bool isPaused) {
        return (activationEpoch, paused);
    }

    /// @notice What a receipt batch checks, in one call: the activation epoch,
    ///         the pause switch and the batch bounds.
    function batchState()
        external
        view
        returns (uint40 activation, bool isPaused, uint8 maxGroups, uint16 maxItems)
    {
        return (activationEpoch, paused, maxGroupsPerBatch, maxItemsPerBatch);
    }

    function getEpochTotals(uint256 epoch) external view returns (EpochTotals memory) {
        return _epochTotals[epoch];
    }

    function getNodeEpoch(uint72 identityId, uint256 epoch) external view returns (NodeEpoch memory) {
        return _nodeEpoch[identityId][epoch];
    }

    /// @notice The face value counted in a budget, over all sellers.
    function budgetUsed(bytes32 subscriptionId, uint8 budgetIndex) external view returns (uint96) {
        return _budgetUsed[subscriptionId][budgetIndex];
    }

    /// @notice The used-nonce bits of nonces `word × 256` to `word × 256 + 255`
    ///         of `identityId`'s requests in a subscription.
    function nonceWord(bytes32 subscriptionId, uint72 identityId, uint64 word) external view returns (uint256) {
        return _nonceBitmap[subscriptionId][identityId][word];
    }

    // ============================================================
    //                         Internal
    // ============================================================

    function _requireNotEnded(uint256 epoch) internal view {
        uint256 current = _currentEpoch();
        if (epoch < current) revert EpochEnded(epoch, current);
    }

    function _currentEpoch() internal view returns (uint256) {
        return Chronos(hub.getContractAddress("Chronos")).getCurrentEpoch();
    }

    /// @dev Whether the contract the Hub holds as `contractName` reads this
    ///      storage: its `queryInferenceStorage()` names it. A name the Hub does
    ///      not hold, a contract without the view, and one that reverts or names
    ///      anything else, do not.
    function _readsThisPool(string memory contractName) internal view returns (bool) {
        if (!hub.isContract(contractName)) return false;
        // solhint-disable-next-line avoid-low-level-calls
        (bool ok, bytes memory answer) = hub.getContractAddress(contractName).staticcall(
            abi.encodeWithSignature("queryInferenceStorage()")
        );
        return ok && answer.length >= 32 && abi.decode(answer, (uint256)) == uint256(uint160(address(this)));
    }
}
