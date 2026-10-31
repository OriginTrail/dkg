// SPDX-License-Identifier: Apache-2.0

pragma solidity ^0.8.20;

import {INamed} from "../interfaces/INamed.sol";
import {IVersioned} from "../interfaces/IVersioned.sol";
import {IInitializable} from "../interfaces/IInitializable.sol";
import {HubDependent} from "../abstract/HubDependent.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

/**
 * @title ConvictionServiceStorage
 * @notice State store for service plan periods (OT-RFC-27, "NeuroSymbolic
 *         Marketplace"). The owner of a Conviction Account opts it in and
 *         assigns bounded plan-funding authority to buyer keys, and each buyer
 *         key funds plan periods from the account's existing allowance. A
 *         period funded from an account moves no TRAC: its cost is drawn from
 *         the account's allowance and booked as due in the query/inference
 *         pool (`QueryInferenceStorage`), as a wallet period's value is. A
 *         buyer key may also fund periods from its wallet; those are recorded
 *         here too, under account 0, which no account has. A plan period is
 *         one chain epoch.
 *
 * Architecture (the pattern of `PublishingConvictionStorage`):
 *   - This contract holds every byte of service-spending state: the opt-in
 *     switch per account, the assignments and the periods counted under
 *     them, and the period records with their buckets, which top-ups grow.
 *     It never holds or moves TRAC; the money due is in
 *     `QueryInferenceStorage`.
 *   - It is policy-free. Every mutator is `onlyContracts` (any Hub-registered
 *     contract, and the Hub owner), and the logic contracts enforce every
 *     business rule (ownership, consent, the cost limit) before they write. The one rule it keeps itself is the integrity of its period
 *     records: each id is written once, a written record always reads as
 *     existing (`createSubscription`), and only a written record is topped
 *     up, at the indexes of its buckets (`applyTopUp`). Business events come
 *     from the logic contracts; this contract emits events only for its own
 *     parameters.
 *   - The parameter setters are `onlyHub`, so governance reaches them through
 *     `Hub.forwardCall` (the Hub owner may also call them directly).
 *
 * Fresh state: the contract ships empty and is never upgraded in place. A
 * replacement starts empty, so the storage layout matters to audits and
 * indexers rather than to migrations. The declaration order of the state
 * below IS the layout: slot 0 packs the inherited `hub` with
 * `maxBucketsPerPeriod` (21 of 32 bytes); slots 1 to 6 and 13 to 15 hold the
 * mappings in order, at the slots 1.0.0 and 1.1.0 gave them; slots 7 to 12,
 * where 1.1.0 kept the service labels, stay empty.
 */
contract ConvictionServiceStorage is INamed, IVersioned, HubDependent, IInitializable {
    string private constant _NAME = "ConvictionServiceStorage";
    // Version history:
    //   1.0.0 — Conviction Account service spending: opt-ins, assignments,
    //           usage, labels, and period records with their buckets.
    //   1.1.0 — a plan period is one epoch; an assignment holds one cost
    //           limit per period and an expiry, and its usage counts periods
    //           only; `maxPeriodSeconds` is gone; top-ups of a recorded period
    //           (`applyTopUp`); one bucket read by index (`getBucket`). The
    //           mapping slots are unchanged.
    //   1.2.0 — no service labels: a Conviction Account period's cost is booked
    //           as due in `QueryInferenceStorage`. Removed with the labels are
    //           their state and views (`serviceSpent`, `baseLabel`,
    //           `topUpLabel`, `labelCursor`, `epochServiceLabel`,
    //           `accountServiceLabelTotal`, `serviceLabel`, `accountLabel`),
    //           their mutators, and the schedule cut-over `exactScheduleFrom`,
    //           which only the labels read. Slots 7 to 12 stay empty
    //           (`_retiredLabelSlots`), so every remaining mapping keeps its
    //           slot; `maxBucketsPerPeriod` moves to offset 20 of slot 0.
    string private constant _VERSION = "1.2.0";

    uint8 internal constant _DEFAULT_MAX_BUCKETS_PER_PERIOD = 16;
    uint8 internal constant _BUCKETS_PER_PERIOD_UPPER_BOUND = 32;

    /// @notice Service class of an inference bucket; its units are tokens.
    uint8 public constant CLASS_INFERENCE = 1;
    /// @notice Service class of a knowledge query bucket; its units are query units.
    uint8 public constant CLASS_QUERY = 2;

    // ============================================================
    //                          Records
    // ============================================================

    /// @notice A buyer key's authority over one account: the most it may draw
    ///         for one period, in COST (TRAC wei drawn from the account's
    ///         allowance after its discount), until it expires.
    struct Assignment {
        uint96 maxCostPerPeriod; // the period's cost, its top-ups included
        uint40 assignedAt; // 0 = no assignment
        uint40 expiresAt;
        uint40 revokedAt; // 0 = not revoked
        uint64 nonce; // the account nonce this assignment consumed
    }

    /// @notice The two limits of an assignment. `setAssignmentCaps` writes
    ///         them and nothing else.
    struct AssignmentCaps {
        uint96 maxCostPerPeriod;
        uint40 expiresAt;
    }

    /// @notice What an assignee has funded under its assignment.
    struct Usage {
        uint32 periods; // periods funded since assignedAt; top-ups fund none
    }

    /// @notice One funded plan period: one chain epoch.
    struct Subscription {
        uint256 accountId; // 0 = funded from the buyer key's wallet
        address assignee; // the buyer key that funded it
        address sessionKey; // the buyer's request-signing key; the funding contracts refuse zero
        bytes32 periodId; // the period's epoch; the id is keccak256(abi.encode(assignee, periodId))
        bytes32 planDigest; // the buyer's commitment to its plan, opaque here; a top-up replaces it
        uint40 periodStart; // the later of the funding's block time and the epoch's start; 0 = no record
        uint40 periodEnd; // the start of the next epoch
        uint40 fundedEpoch; // the epoch the funding ran in
        uint40 fundedWindow; // the account's billing window drawn; 0 for a wallet period
        uint16 discountBps; // 0 for a wallet period
        uint8 bucketCount;
        uint96 value; // sum of the bucket values, before the discount
        uint96 cost; // drawn from the allowance; the value for a wallet period
        uint96 drawnFromWindow;
        uint96 drawnFromTopUp;
    }

    /// @notice One service bucket of a funded period.
    struct Bucket {
        bytes32 bucketId; // a canonical model or service
        uint8 serviceClass; // CLASS_INFERENCE or CLASS_QUERY
        uint96 value; // the funded bucket value before the discount, TRAC wei
        uint96 maxAskWeiPerUnit; // the buyer's price cap per unit
    }

    /// @notice What a top-up adds to a period record: its value, its cost and
    ///         the cost's split between the window allowance and the top-up
    ///         buffer (both 0 for a wallet period).
    struct TopUpAmounts {
        uint96 value;
        uint96 cost;
        uint96 drawnFromWindow;
        uint96 drawnFromTopUp;
    }

    // ============================================================
    //                    Events (parameters only)
    // ============================================================

    event MaxBucketsPerPeriodSet(uint8 oldValue, uint8 newValue);

    // ============================================================
    //                          Errors
    // ============================================================

    error InvalidParameter(string name);
    /// @notice The id already holds a period record or buckets.
    error SubscriptionExists(bytes32 subscriptionId);
    /// @notice The period record has a `periodStart` of 0, so it would read as
    ///         absent.
    error ZeroPeriodStart(bytes32 subscriptionId);
    /// @notice The id holds no period record.
    error SubscriptionNotFound(bytes32 subscriptionId);
    /// @notice A top-up names more stored buckets than the period has.
    error BucketTopUpOutOfRange(bytes32 subscriptionId, uint256 count, uint256 bucketCount);

    // ============================================================
    //          State (the declaration order is the layout)
    // ============================================================

    /// @notice The most buckets one funded period may carry, its top-ups
    ///         included.
    uint8 public maxBucketsPerPeriod;

    /// @notice accountId => when the owner switched service spending on; 0 = off.
    mapping(uint256 => uint40) public serviceSpendingEnabledAt;
    /// @notice accountId => the nonce the next assignment must carry.
    mapping(uint256 => uint64) public assignmentNonce;
    /// @dev accountId => assignee => assignment.
    mapping(uint256 => mapping(address => Assignment)) internal _assignments;
    /// @dev accountId => assignee => what it has funded under its assignment.
    mapping(uint256 => mapping(address => Usage)) internal _usage;
    /// @dev accountId => every assignee ever listed, append-only, each once.
    mapping(uint256 => address[]) internal _assignees;
    /// @dev accountId => assignee => membership index for `_assignees`.
    mapping(uint256 => mapping(address => bool)) internal _listed;
    /// @dev Slots 7 to 12: where 1.1.0 kept the service labels and the window
    ///      draws they were based on. Never written since 1.2.0; held empty so
    ///      the period records keep slots 13 to 15.
    uint256[6] private _retiredLabelSlots;
    /// @dev subscriptionId => funded period record.
    mapping(bytes32 => Subscription) internal _subscriptions;
    /// @dev subscriptionId => the period's buckets, in funding order.
    mapping(bytes32 => Bucket[]) internal _buckets;
    /// @dev accountId => period ids, in funding order.
    mapping(uint256 => bytes32[]) internal _accountSubscriptions;

    constructor(address hubAddress) HubDependent(hubAddress) {}

    /// @dev Idempotent across redeploys: seeds each parameter's default only
    ///      while it is unset, so a value governance has tuned survives a
    ///      re-initialization.
    function initialize() external onlyHub {
        if (maxBucketsPerPeriod == 0) {
            maxBucketsPerPeriod = _DEFAULT_MAX_BUCKETS_PER_PERIOD;
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

    /// @notice Set the most buckets per period, from 1 to 32.
    function setMaxBucketsPerPeriod(uint8 value) external onlyHub {
        if (value == 0 || value > _BUCKETS_PER_PERIOD_UPPER_BOUND) revert InvalidParameter("maxBucketsPerPeriod");
        uint8 old = maxBucketsPerPeriod;
        maxBucketsPerPeriod = value;
        emit MaxBucketsPerPeriodSet(old, value);
    }

    // ============================================================
    //                   Mutators (onlyContracts)
    // ============================================================

    /// @notice Record when service spending was switched on, or 0 for off.
    function setServiceSpendingEnabledAt(uint256 accountId, uint40 at) external onlyContracts {
        serviceSpendingEnabledAt[accountId] = at;
    }

    /// @notice Return the account's current assignment nonce and advance it.
    function consumeAssignmentNonce(uint256 accountId) external onlyContracts returns (uint64 used) {
        used = assignmentNonce[accountId];
        assignmentNonce[accountId] = used + 1;
    }

    /// @notice Store an assignment, list its assignee once, and reset the
    ///         assignee's usage: a new assignment is new terms both parties
    ///         signed, so its usage counts from nothing.
    function setAssignment(uint256 accountId, address assignee, Assignment calldata a) external onlyContracts {
        _assignments[accountId][assignee] = a;
        if (!_listed[accountId][assignee]) {
            _listed[accountId][assignee] = true;
            _assignees[accountId].push(assignee);
        }
        delete _usage[accountId][assignee];
    }

    /// @notice Record the revocation time of an assignment.
    function setAssignmentRevokedAt(uint256 accountId, address assignee, uint40 at) external onlyContracts {
        _assignments[accountId][assignee].revokedAt = at;
    }

    /// @notice Overwrite the two limits of a stored assignment and nothing
    ///         else: `assignedAt`, `revokedAt`, `nonce`, the assignee list and
    ///         the usage stay as they are.
    function setAssignmentCaps(
        uint256 accountId,
        address assignee,
        AssignmentCaps calldata c
    ) external onlyContracts {
        Assignment storage a = _assignments[accountId][assignee];
        a.maxCostPerPeriod = c.maxCostPerPeriod;
        a.expiresAt = c.expiresAt;
    }

    /// @notice Count a funded period against its assignee.
    function recordUsage(uint256 accountId, address assignee) external onlyContracts {
        _usage[accountId][assignee].periods += 1;
    }

    /// @notice Record a funded period and its buckets, in the given order, and
    ///         append its id to the account's list.
    /// @dev    A record exists exactly when its `periodStart` is non-zero, so
    ///         this refuses a record with a `periodStart` of 0, which would read
    ///         as absent and could be written again (`ZeroPeriodStart`), and an
    ///         id that already holds a record or buckets (`SubscriptionExists`),
    ///         whose second write would append its buckets to the first's and
    ///         list the id twice. The storage checks both itself because every
    ///         Hub-registered contract can call it, and it is never upgraded in
    ///         place.
    function createSubscription(
        bytes32 subscriptionId,
        Subscription calldata s,
        Bucket[] calldata buckets
    ) external onlyContracts {
        if (s.periodStart == 0) revert ZeroPeriodStart(subscriptionId);
        Bucket[] storage stored = _buckets[subscriptionId];
        if (_subscriptions[subscriptionId].periodStart != 0 || stored.length != 0) {
            revert SubscriptionExists(subscriptionId);
        }
        _subscriptions[subscriptionId] = s;
        for (uint256 i; i < buckets.length; i++) {
            stored.push(buckets[i]);
        }
        _accountSubscriptions[s.accountId].push(subscriptionId);
    }

    /// @notice Top up a recorded period: add `added[i]` to the value of its
    ///         stored bucket `i`, append `appended` after its stored buckets,
    ///         add `t` to its value, cost and draw split, and replace its plan
    ///         commitment.
    /// @dev    It refuses an id with no record (`SubscriptionNotFound`), whose
    ///         buckets would then belong to no period, and more entries in
    ///         `added` than the period has buckets (`BucketTopUpOutOfRange`).
    ///         Appending keeps every stored bucket at its index, which claims
    ///         are keyed by. The sums are checked, so an overflow reverts.
    function applyTopUp(
        bytes32 subscriptionId,
        TopUpAmounts calldata t,
        bytes32 planDigest,
        uint96[] calldata added,
        Bucket[] calldata appended
    ) external onlyContracts {
        Subscription storage s = _subscriptions[subscriptionId];
        if (s.periodStart == 0) revert SubscriptionNotFound(subscriptionId);
        Bucket[] storage stored = _buckets[subscriptionId];
        uint256 n = stored.length;
        if (added.length > n) revert BucketTopUpOutOfRange(subscriptionId, added.length, n);

        for (uint256 i; i < added.length; i++) {
            if (added[i] != 0) stored[i].value += added[i];
        }
        if (appended.length != 0) {
            for (uint256 i; i < appended.length; i++) {
                stored.push(appended[i]);
            }
            s.bucketCount = SafeCast.toUint8(stored.length);
        }

        s.value += t.value;
        s.cost += t.cost;
        if (t.drawnFromWindow != 0 || t.drawnFromTopUp != 0) {
            s.drawnFromWindow += t.drawnFromWindow;
            s.drawnFromTopUp += t.drawnFromTopUp;
        }
        s.planDigest = planDigest;
    }

    // ============================================================
    //                           Views
    // ============================================================

    function getAssignment(uint256 accountId, address assignee) external view returns (Assignment memory) {
        return _assignments[accountId][assignee];
    }

    function getUsage(uint256 accountId, address assignee) external view returns (Usage memory) {
        return _usage[accountId][assignee];
    }

    /// @notice True when the assignment exists, is not revoked and has not
    ///         expired at the current block time.
    function isAssignmentActive(uint256 accountId, address assignee) external view returns (bool) {
        Assignment storage a = _assignments[accountId][assignee];
        return a.assignedAt != 0 && a.revokedAt == 0 && block.timestamp < a.expiresAt;
    }

    function assigneeCount(uint256 accountId) external view returns (uint256) {
        return _assignees[accountId].length;
    }

    function assigneeAt(uint256 accountId, uint256 index) external view returns (address) {
        return _assignees[accountId][index];
    }

    function subscriptionExists(bytes32 subscriptionId) external view returns (bool) {
        return _subscriptions[subscriptionId].periodStart != 0;
    }

    function getSubscription(bytes32 subscriptionId) external view returns (Subscription memory) {
        return _subscriptions[subscriptionId];
    }

    function getBuckets(bytes32 subscriptionId) external view returns (Bucket[] memory) {
        return _buckets[subscriptionId];
    }

    /// @notice The period's bucket at `index`, its funding order. Reverts for
    ///         an index at or past the period's bucket count.
    function getBucket(bytes32 subscriptionId, uint256 index) external view returns (Bucket memory) {
        return _buckets[subscriptionId][index];
    }

    function accountSubscriptionCount(uint256 accountId) external view returns (uint256) {
        return _accountSubscriptions[accountId].length;
    }

    function accountSubscriptionAt(uint256 accountId, uint256 index) external view returns (bytes32) {
        return _accountSubscriptions[accountId][index];
    }
}
