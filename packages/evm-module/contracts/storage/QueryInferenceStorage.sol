// SPDX-License-Identifier: Apache-2.0

pragma solidity ^0.8.20;

import {INamed} from "../interfaces/INamed.sol";
import {IVersioned} from "../interfaces/IVersioned.sol";
import {IInitializable} from "../interfaces/IInitializable.sol";
import {HubDependent} from "../abstract/HubDependent.sol";
import {Chronos} from "./Chronos.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

/**
 * @title QueryInferenceStorage
 * @notice State store of the query/inference reward pool of OT-RFC-27
 *         ("NeuroSymbolic Marketplace"): the subscription-funded pool that
 *         finalized receipt value and stake-weighted receipt value (QIF)
 *         distribute among Core Nodes, kept apart from the publishing-funded
 *         staker pool in `EpochStorage`.
 *
 * What it holds:
 *   - The money due per epoch. A plan period is one epoch, and its money
 *     joins the pool of its due epoch, the epoch after it. That epoch holds
 *     the period's batch deadline, `periodEnd` plus the receipt grace of the
 *     period's epoch, because the grace is kept below the epoch length, and
 *     its claims are finalized in it, so it is the epoch in which the
 *     period's receipt value counts. `walletDue(e)` is the value of
 *     wallet-funded periods and their top-ups due in `e`.
 *   - The pool carried forward from epochs with no finalized value
 *     (`carry`), and `closedThrough`, the last epoch whose inputs are frozen.
 *   - Each closed epoch's frozen inputs, the QIF inputs per epoch and per
 *     node, the claims per bucket and per seller, and the request replay
 *     bitmap.
 *   - The parameters: the activation epoch, the receipt grace schedule, the
 *     batch and close bounds, the pause switch and the λ schedule.
 *
 * The settlement logic (`QueryInferenceSettlement`) writes the claims, the
 * replay bitmap, the QIF inputs and the closes, and the requests it verifies
 * are signed under an EIP-712 domain whose verifying contract is this
 * storage, so a logic upgrade keeps both the signatures and the bitmap.
 *
 * Architecture (the pattern of `ConvictionServiceStorage`):
 *   - It never holds or moves TRAC. Every subscription token sits in the vault
 *     (`ConvictionStakingStorage`) with all other V10 TRAC; this contract only
 *     accounts for it.
 *   - It is policy-free. Every mutator is `onlyContracts` (any Hub-registered
 *     contract, and the Hub owner), and the logic contracts enforce every
 *     business rule before they write. The one rule it keeps itself is that
 *     money is never booked into an epoch that has closed, whose inputs are
 *     frozen. Business events come from the logic contracts; this contract
 *     emits events only for its parameters.
 *   - The parameter setters are `onlyHub`, so governance reaches them through
 *     `Hub.forwardCall` (the Hub owner may also call them directly). The
 *     setters that need the current epoch or the epoch length read them from
 *     the Hub's `Chronos` at the call, so no reference is stored.
 *
 * Activation: `activationEpoch` is the first epoch whose rewards include this
 * pool, and the first in which periods can be funded from a wallet. It is set
 * once, to the current epoch or a later one, never to an epoch that has
 * already ended. Until it is set and reached, the logic contracts refuse every
 * wallet funding and top-up, every receipt batch and every finalization, so no
 * epoch that may already have been claimed changes. Epochs close from it on,
 * in order.
 *
 * Fresh state: the contract ships empty and is never upgraded in place. A
 * replacement starts empty, under its own address, so the storage layout
 * matters to audits and indexers rather than to migrations, and requests
 * signed against this address stay bound to it. The declaration order of the
 * state below IS the layout:
 *   - slot 0 packs the inherited `hub` with the activation epoch, the receipt
 *     grace, the pause switch and the group and close bounds (32 of 32 bytes);
 *   - slot 1 the item bound, the λ schedule and the scheduled receipt grace
 *     (20 of 32 bytes);
 *   - slot 2 `closedThrough`, slot 3 `carry`;
 *   - slots 4 to 10 the mappings, in order.
 */
contract QueryInferenceStorage is INamed, IVersioned, HubDependent, IInitializable {
    string private constant _NAME = "QueryInferenceStorage";
    string private constant _VERSION = "1.0.0";

    /// @notice The denominator of `lambdaBps`: 10,000 is λ = 1.
    uint16 public constant BPS_DENOMINATOR = 10_000;

    uint32 internal constant _DEFAULT_RECEIPT_GRACE_SECONDS = 1 hours;
    uint16 internal constant _DEFAULT_MAX_ITEMS_PER_BATCH = 256;
    uint8 internal constant _DEFAULT_MAX_GROUPS_PER_BATCH = 32;
    uint8 internal constant _DEFAULT_MAX_CLOSE_STEPS_PER_CLAIM = 32;

    uint16 internal constant _ITEMS_PER_BATCH_UPPER_BOUND = 1024;

    // ============================================================
    //                          Records
    // ============================================================

    /// @notice The inputs of an epoch, frozen when it closes, beside its
    ///         totals (`getEpochTotals`), which no write reaches once it has
    ///         closed.
    struct EpochClose {
        uint96 pool; // the query/inference pool the epoch's nodes share
        uint96 label; // what the publishing pool gave up to Conviction Account labels; no close writes it yet
        uint16 lambdaBps; // λ in force in the epoch
        bool closed;
    }

    /// @notice An epoch's totals over all nodes: ΣR and ΣQueryInferenceScore.
    struct EpochTotals {
        uint128 sumR;
        uint128 sumScore;
    }

    /// @notice A node's finalized receipt value R and its stake-weighted value
    ///         QueryInferenceScore, counted in one epoch.
    struct NodeEpoch {
        uint128 r;
        uint128 score;
    }

    /// @notice One seller's claims in one bucket: claimed value, the same
    ///         weighted by the stake factor captured at each batch, and
    ///         whether it has been finalized.
    struct SellerClaim {
        uint96 claimed;
        uint96 weighted;
        bool finalized;
    }

    // ============================================================
    //                    Events (parameters only)
    // ============================================================

    event ActivationEpochSet(uint40 epoch);
    /// @notice The receipt grace becomes `value` for the periods of
    ///         `fromEpoch` on.
    event ReceiptGraceSecondsSet(uint32 value, uint256 fromEpoch);
    event MaxItemsPerBatchSet(uint16 oldValue, uint16 newValue);
    event MaxGroupsPerBatchSet(uint8 oldValue, uint8 newValue);
    event MaxCloseStepsPerClaimSet(uint8 oldValue, uint8 newValue);
    event PausedSet(bool paused);
    /// @notice λ becomes `value` from `fromEpoch` on.
    event LambdaBpsSet(uint16 value, uint256 fromEpoch);

    // ============================================================
    //                          Errors
    // ============================================================

    error InvalidParameter(string name);
    error ActivationEpochAlreadySet(uint40 current);
    /// @notice `epoch` is closed: its inputs are frozen and take no booking.
    error EpochClosed(uint256 epoch, uint256 closedThrough);
    /// @notice The λ scheduled from `fromEpoch` is in force, but an epoch
    ///         before it from activation on is still open. Folding the value
    ///         in now would change that epoch's λ, so the epochs up to
    ///         `fromEpoch − 1` are to be closed first.
    error LambdaScheduleAheadOfCloses(uint256 closedThrough, uint256 fromEpoch);
    /// @notice The receipt grace scheduled from `fromEpoch` took effect in the
    ///         current epoch, while the periods of the epoch before it, whose
    ///         claims are finalized now, still take the grace before it. A
    ///         change waits for the next epoch.
    error ReceiptGraceScheduleInUse(uint256 fromEpoch);
    /// @notice The claim is finalized: it takes no more value, and is not
    ///         finalized again.
    error ClaimFinalized(bytes32 subscriptionId, uint8 bucketIndex, uint72 seller);
    /// @notice Epochs close one at a time, in order, from activation on.
    error CloseOutOfOrder(uint256 epoch, uint256 closedThrough);

    // ============================================================
    //          State (the declaration order is the layout)
    // ============================================================

    // Slot 0, after the inherited `hub`.
    /// @notice The first epoch whose rewards include this pool, and the first
    ///         in which periods can be funded. Set once; 0 means unset.
    uint40 public activationEpoch;
    /// @notice The time after a period's end, or its Conviction Account
    ///         assignment's end, within which receipt batches still land, for
    ///         the periods of epochs before `nextReceiptGraceFromEpoch` (all
    ///         epochs while that is 0). Always below the epoch length.
    uint32 public receiptGraceSeconds;
    /// @notice While true, no period is funded or topped up, and no receipt is
    ///         batched or finalized. Closes and claims go on.
    bool public paused;
    /// @notice The most receipt groups one batch may carry.
    uint8 public maxGroupsPerBatch;
    /// @notice The most epochs one reward claim closes on its way.
    uint8 public maxCloseStepsPerClaim;

    // Slot 1.
    /// @notice The most receipt items one batch may carry.
    uint16 public maxItemsPerBatch;
    /// @notice λ, in basis points, for epochs before `nextLambdaFromEpoch`
    ///         (all epochs while that is 0).
    uint16 public lambdaBps;
    /// @notice λ, in basis points, from `nextLambdaFromEpoch` on.
    uint16 public nextLambdaBps;
    /// @notice The epoch from which `nextLambdaBps` is in force; 0 = none.
    uint40 public nextLambdaFromEpoch;
    /// @notice The receipt grace of the periods of epochs from
    ///         `nextReceiptGraceFromEpoch` on.
    uint32 public nextReceiptGraceSeconds;
    /// @notice The first epoch whose periods take `nextReceiptGraceSeconds`;
    ///         0 = none.
    uint40 public nextReceiptGraceFromEpoch;

    // Slots 2 and 3.
    /// @notice The last epoch whose inputs are frozen. It starts at
    ///         `activationEpoch − 1`: epochs before activation never close.
    uint256 public closedThrough;
    /// @notice The pool carried forward from closed epochs in which no node
    ///         finalized receipt value.
    uint96 public carry;

    // Slots 4 to 10.
    /// @notice epoch => wallet-funded value due in that epoch.
    mapping(uint256 => uint96) public walletDue;
    /// @dev epoch => the inputs frozen at its close.
    mapping(uint256 => EpochClose) internal _epochClose;
    /// @dev epoch => ΣR and ΣQueryInferenceScore.
    mapping(uint256 => EpochTotals) internal _epochTotals;
    /// @dev identityId => epoch => R and QueryInferenceScore.
    mapping(uint72 => mapping(uint256 => NodeEpoch)) internal _nodeEpoch;
    /// @dev subscriptionId => bucketIndex => the value claimed in the bucket,
    ///      over all sellers. A bucket needs no close time: every period of an
    ///      epoch shares one batch deadline, and its claims are finalized only
    ///      in the epoch after it.
    mapping(bytes32 => mapping(uint8 => uint128)) internal _bucketClaimed;
    /// @dev subscriptionId => bucketIndex => seller identityId => its claim.
    mapping(bytes32 => mapping(uint8 => mapping(uint72 => SellerClaim))) internal _sellerClaim;
    /// @dev subscriptionId => seller identityId => nonce >> 8 => 256 used-nonce bits.
    mapping(bytes32 => mapping(uint72 => mapping(uint64 => uint256))) internal _nonceBitmap;

    constructor(address hubAddress) HubDependent(hubAddress) {}

    /// @dev Idempotent across redeploys: seeds each bound's default only while
    ///      it is unset, so a value governance has tuned survives a
    ///      re-initialization. The default grace, 1 hour, is below the epoch
    ///      length of every network this storage deploys to (1 day and more).
    ///      λ has no default: 0 is a valid value, and the deployment sets it.
    function initialize() external onlyHub {
        if (receiptGraceSeconds == 0) {
            receiptGraceSeconds = _DEFAULT_RECEIPT_GRACE_SECONDS;
        }
        if (maxItemsPerBatch == 0) {
            maxItemsPerBatch = _DEFAULT_MAX_ITEMS_PER_BATCH;
        }
        if (maxGroupsPerBatch == 0) {
            maxGroupsPerBatch = _DEFAULT_MAX_GROUPS_PER_BATCH;
        }
        if (maxCloseStepsPerClaim == 0) {
            maxCloseStepsPerClaim = _DEFAULT_MAX_CLOSE_STEPS_PER_CLAIM;
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
     *         after it can have been claimed. `closedThrough` starts at the
     *         epoch before it.
     */
    function setActivationEpoch(uint40 epoch) external onlyHub {
        uint40 current = activationEpoch;
        if (current != 0) revert ActivationEpochAlreadySet(current);
        if (epoch == 0 || epoch < _chronos().getCurrentEpoch()) revert InvalidParameter("activationEpoch");
        activationEpoch = epoch;
        closedThrough = epoch - 1;
        emit ActivationEpochSet(epoch);
    }

    /**
     * @notice Set the receipt grace, from 1 second to less than one epoch, so
     *         a period's batch deadline always falls in the epoch after it,
     *         its due epoch. A change moves no money already booked.
     * @dev    A period of epoch e takes the grace of e
     *         (`receiptGraceSecondsAt(e)`). A change made during epoch c
     *         applies to the periods of c + 1 on, as a change to λ applies
     *         from the next epoch, so a period's deadline is settled before
     *         it starts, and no change moves the deadline of a period whose
     *         claims are being finalized: its batches could otherwise land
     *         again after some of its claims were finalized. While no epoch
     *         from activation on has started (activation unset, or still
     *         ahead), no batch lands yet, and the change applies at once.
     *
     *         Two values are kept, as for λ: `receiptGraceSeconds` before
     *         `nextReceiptGraceFromEpoch`, and `nextReceiptGraceSeconds` from
     *         it on. A change made once the scheduled value is in force first
     *         folds it into `receiptGraceSeconds`. In the epoch where it took
     *         effect, the periods of the epoch before still take the older
     *         value while their claims are finalized, so a change then is
     *         refused (`ReceiptGraceScheduleInUse`) and goes through from the
     *         next epoch on.
     */
    function setReceiptGraceSeconds(uint32 value) external onlyHub {
        Chronos chronos = _chronos();
        if (value == 0 || value >= chronos.epochLength()) revert InvalidParameter("receiptGraceSeconds");
        uint256 current = chronos.getCurrentEpoch();
        uint256 activation = activationEpoch;
        if (activation == 0 || current < activation) {
            receiptGraceSeconds = value;
            emit ReceiptGraceSecondsSet(value, current);
            return;
        }

        uint256 from = nextReceiptGraceFromEpoch;
        if (from != 0 && current >= from) {
            if (current == from) revert ReceiptGraceScheduleInUse(from);
            receiptGraceSeconds = nextReceiptGraceSeconds;
        }
        nextReceiptGraceSeconds = value;
        nextReceiptGraceFromEpoch = SafeCast.toUint40(current + 1);
        emit ReceiptGraceSecondsSet(value, current + 1);
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

    /// @notice Set the most epochs one claim closes, from 1 to 255.
    function setMaxCloseStepsPerClaim(uint8 value) external onlyHub {
        if (value == 0) revert InvalidParameter("maxCloseStepsPerClaim");
        uint8 old = maxCloseStepsPerClaim;
        maxCloseStepsPerClaim = value;
        emit MaxCloseStepsPerClaimSet(old, value);
    }

    /// @notice Switch the pause on or off.
    function setPaused(bool value) external onlyHub {
        paused = value;
        emit PausedSet(value);
    }

    /**
     * @notice Set λ, from 0 to 10,000 basis points.
     * @dev    A change made during epoch c applies from c + 1, so the λ of an
     *         epoch is settled before it starts. While no epoch from activation
     *         on has started (activation unset, or still ahead), no epoch uses
     *         λ yet, and the change applies at once.
     *
     *         Only two values are kept: `lambdaBps` before
     *         `nextLambdaFromEpoch`, and `nextLambdaBps` from it on. A change
     *         made once the scheduled value is in force first folds it into
     *         `lambdaBps`. That would hand every epoch before
     *         `nextLambdaFromEpoch` the new base value, so it is refused while
     *         any of them, from activation on, is still open
     *         (`LambdaScheduleAheadOfCloses`); closing them first clears it.
     */
    function setLambdaBps(uint16 value) external onlyHub {
        if (value > BPS_DENOMINATOR) revert InvalidParameter("lambdaBps");
        uint256 current = _chronos().getCurrentEpoch();
        uint256 activation = activationEpoch;
        if (activation == 0 || current < activation) {
            lambdaBps = value;
            emit LambdaBpsSet(value, current);
            return;
        }

        uint256 from = nextLambdaFromEpoch;
        if (from != 0 && current >= from) {
            uint256 closed = closedThrough;
            if (closed + 1 < from) revert LambdaScheduleAheadOfCloses(closed, from);
            lambdaBps = nextLambdaBps;
        }
        nextLambdaBps = value;
        nextLambdaFromEpoch = SafeCast.toUint40(current + 1);
        emit LambdaBpsSet(value, current + 1);
    }

    // ============================================================
    //                   Mutators (onlyContracts)
    // ============================================================

    /// @notice Book `amount` of wallet-funded value as due in `epoch`.
    function addWalletDue(uint256 epoch, uint96 amount) external onlyContracts {
        _requireOpen(epoch);
        walletDue[epoch] += amount;
    }

    /// @notice Mark the nonces of `bits` used, in word `word` of `seller`'s
    ///         requests in a period: bit i is nonce `word × 256 + i`. A bit,
    ///         once set, is never cleared.
    function useNonces(bytes32 subscriptionId, uint72 seller, uint64 word, uint256 bits) external onlyContracts {
        _nonceBitmap[subscriptionId][seller][word] |= bits;
    }

    /// @notice Add `value` of claimed receipt value, `weighted` of it weighted
    ///         by the stake factor, to `seller`'s claim in a bucket, and
    ///         `value` to the bucket's total over all sellers.
    /// @dev    A finalized claim takes no more (`ClaimFinalized`), so a
    ///         finalized value never moves. The sums are checked, so an
    ///         overflow reverts.
    function addClaim(
        bytes32 subscriptionId,
        uint8 bucketIndex,
        uint72 seller,
        uint96 value,
        uint96 weighted
    ) external onlyContracts {
        SellerClaim storage c = _sellerClaim[subscriptionId][bucketIndex][seller];
        if (c.finalized) revert ClaimFinalized(subscriptionId, bucketIndex, seller);
        c.claimed += value;
        c.weighted += weighted;
        _bucketClaimed[subscriptionId][bucketIndex] += value;
    }

    /// @notice Finalize `seller`'s claim in a bucket, once, counting `value`
    ///         of finalized receipt value (R) and `score` of stake-weighted
    ///         value (QueryInferenceScore) in `epoch`, for the node and in the
    ///         epoch's totals.
    /// @dev    It refuses a closed epoch, whose inputs are frozen, and a claim
    ///         already finalized (`ClaimFinalized`). The sums are checked.
    function finalizeClaim(
        bytes32 subscriptionId,
        uint8 bucketIndex,
        uint72 seller,
        uint256 epoch,
        uint96 value,
        uint96 score
    ) external onlyContracts {
        _requireOpen(epoch);
        SellerClaim storage c = _sellerClaim[subscriptionId][bucketIndex][seller];
        if (c.finalized) revert ClaimFinalized(subscriptionId, bucketIndex, seller);
        c.finalized = true;

        NodeEpoch storage n = _nodeEpoch[seller][epoch];
        n.r += value;
        n.score += score;
        EpochTotals storage t = _epochTotals[epoch];
        t.sumR += value;
        t.sumScore += score;
    }

    /// @notice Close `epoch`: freeze its pool and its λ, make it the last
    ///         closed epoch, and set the carry to `carryOut`.
    /// @dev    Epochs close one at a time, in order from the activation epoch,
    ///         so `epoch` is the one after `closedThrough`, and nothing closes
    ///         while the activation epoch is unset (`CloseOutOfOrder`). The
    ///         record's `label` stays 0.
    function closeEpoch(uint256 epoch, uint96 pool, uint16 lambda, uint96 carryOut) external onlyContracts {
        uint256 closed = closedThrough;
        if (activationEpoch == 0 || epoch != closed + 1) revert CloseOutOfOrder(epoch, closed);
        _epochClose[epoch] = EpochClose({pool: pool, label: 0, lambdaBps: lambda, closed: true});
        closedThrough = epoch;
        carry = carryOut;
    }

    // ============================================================
    //                           Views
    // ============================================================

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

    /// @notice What a close reads, in one call: the activation epoch, the last
    ///         closed epoch, the carry and the close bound of a claim.
    function closeState()
        external
        view
        returns (uint40 activation, uint256 closed, uint96 carried, uint8 maxSteps)
    {
        return (activationEpoch, closedThrough, carry, maxCloseStepsPerClaim);
    }

    /// @notice λ in basis points for `epoch`, by the schedule. Exact for every
    ///         epoch that is still to close.
    function lambdaBpsAt(uint256 epoch) external view returns (uint16) {
        uint256 from = nextLambdaFromEpoch;
        return from != 0 && epoch >= from ? nextLambdaBps : lambdaBps;
    }

    /// @notice The receipt grace of the periods of `epoch`, by the schedule:
    ///         their batch deadline is the epoch's end plus this grace, or the
    ///         end of a Conviction Account assignment that ends sooner plus
    ///         it. Exact for the periods of the previous epoch, the current
    ///         one and every later one; the batches and claims of older
    ///         periods are past.
    function receiptGraceSecondsAt(uint256 epoch) external view returns (uint32) {
        uint256 from = nextReceiptGraceFromEpoch;
        return from != 0 && epoch >= from ? nextReceiptGraceSeconds : receiptGraceSeconds;
    }

    function getEpochClose(uint256 epoch) external view returns (EpochClose memory) {
        return _epochClose[epoch];
    }

    function getEpochTotals(uint256 epoch) external view returns (EpochTotals memory) {
        return _epochTotals[epoch];
    }

    function getNodeEpoch(uint72 identityId, uint256 epoch) external view returns (NodeEpoch memory) {
        return _nodeEpoch[identityId][epoch];
    }

    /// @notice The value claimed in a bucket, over all sellers.
    function bucketClaimed(bytes32 subscriptionId, uint8 bucketIndex) external view returns (uint128) {
        return _bucketClaimed[subscriptionId][bucketIndex];
    }

    function getSellerClaim(
        bytes32 subscriptionId,
        uint8 bucketIndex,
        uint72 identityId
    ) external view returns (SellerClaim memory) {
        return _sellerClaim[subscriptionId][bucketIndex][identityId];
    }

    /// @notice The used-nonce bits of nonces `word × 256` to `word × 256 + 255`
    ///         of `identityId`'s requests in a period.
    function nonceWord(bytes32 subscriptionId, uint72 identityId, uint64 word) external view returns (uint256) {
        return _nonceBitmap[subscriptionId][identityId][word];
    }

    // ============================================================
    //                         Internal
    // ============================================================

    function _requireOpen(uint256 epoch) internal view {
        uint256 closed = closedThrough;
        if (epoch <= closed) revert EpochClosed(epoch, closed);
    }

    function _chronos() internal view returns (Chronos) {
        return Chronos(hub.getContractAddress("Chronos"));
    }
}
