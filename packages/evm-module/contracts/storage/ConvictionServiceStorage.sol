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
 *     switch per account and the owner who switched it on, the assignments,
 *     each with the owner who consented to it, and the periods counted under
 *     them, the end of each assignment a new one replaced, and the period
 *     records with their buckets, which top-ups grow. A period record names
 *     the assignment it was funded under by its nonce, so the period keeps
 *     that assignment's end whatever later assignment its buyer key gets.
 *     It never holds or moves TRAC; the money due is in
 *     `QueryInferenceStorage`.
 *   - It is policy-free. Every mutator is `onlyContracts` (any Hub-registered
 *     contract, and the Hub owner), and the logic contracts enforce every
 *     business rule (ownership, consent, the cost limit) before they write.
 *     The one rule it keeps itself is the integrity of its period records:
 *     each id is created once (`createSubscription`), a written record always
 *     reads as existing (`createSubscription`, `setSubscription`), and only a
 *     written record takes buckets or a top-up, at the indexes of its buckets
 *     (`applyTopUp`, `setBucket`, `appendBucket`). Business events come from
 *     the logic contracts; this contract emits events only for its own
 *     parameters.
 *   - Every field has a view, and every field the logic contracts write has
 *     a narrow setter that writes that field alone, beside the writes they
 *     make today (`setAssignment` and `createSubscription` write several
 *     fields at once). So a later logic version reads and writes all of this
 *     state without a new storage, which would start empty.
 *   - The parameter setters are `onlyHub`, so governance reaches them through
 *     `Hub.forwardCall` (the Hub owner may also call them directly).
 *
 * Fresh state: the contract ships empty and is never upgraded in place. A
 * replacement starts empty, so the storage layout matters to audits and
 * indexers rather than to migrations. The declaration order of the state
 * below IS the layout: slot 0 packs the inherited `hub` with
 * `maxBucketsPerPeriod` (21 of 32 bytes); slots 1 to 6 and 13 to 15 hold the
 * mappings in order, at the slots 1.0.0 and 1.1.0 gave them; slots 7 to 12,
 * where 1.1.0 kept the service labels, stay empty; slot 16, last, holds the
 * ends of replaced assignments.
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
    //           A period records the nonce of the assignment it is funded
    //           under (`Subscription.assignmentNonce`, beside the assignee),
    //           and a new assignment keeps the end of the one it replaces
    //           (`assignmentEnd`, slot 16), so a period keeps the assignment
    //           it was funded under. The opt-in records the owner who switched
    //           it on (`getServiceSpending`, slot 1, where
    //           `serviceSpendingEnabledAt` was) and an assignment the owner who
    //           consented to it (`Assignment.owner`, beside its nonce), so
    //           neither outlives a sale of the account. Every field has a view
    //           and a narrow setter beside the writes the logic makes:
    //           `isAssigneeListed`, `replacedAssignmentEnd` and
    //           `storedBucketCount`; `setAssignmentRecord`,
    //           `setReplacedAssignmentEnd`, `listAssignee`, `setUsage`,
    //           `setSubscription`, `setBucket`, `appendBucket` and
    //           `appendAccountSubscription`.
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

    /// @notice An account's opt-in to service spending. It counts only while
    ///         the owner who switched it on holds the account.
    struct ServiceSpending {
        uint40 enabledAt; // when it was switched on; 0 = off
        address owner; // the account's owner who switched it on
    }

    /// @notice A buyer key's authority over one account: the most it may draw
    ///         for one period, in COST (TRAC wei drawn from the account's
    ///         allowance after its discount), until it expires. It funds only
    ///         while the owner who consented to it holds the account.
    struct Assignment {
        uint96 maxCostPerPeriod; // the period's cost, its top-ups included
        uint40 assignedAt; // 0 = no assignment
        uint40 expiresAt;
        uint40 revokedAt; // 0 = not revoked
        uint64 nonce; // the account nonce this assignment consumed
        address owner; // the account's owner who consented to it
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
        uint64 assignmentNonce; // the nonce of the assignment it was funded under; unused for a wallet period
        address sessionKey; // the buyer's request-signing key; the funding contracts refuse zero
        uint40 epoch; // the period's epoch; the id is keccak256(abi.encode(assignee, epoch))
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

    /// @dev accountId => its opt-in to service spending.
    mapping(uint256 => ServiceSpending) internal _serviceSpending;
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
    /// @dev accountId => assignee => assignment nonce => when that assignment
    ///      ended or ends, its expiry or its revocation if sooner, kept when a
    ///      new assignment of the assignee replaced it, for the periods funded
    ///      under it. `setAssignment` writes it then, and
    ///      `setReplacedAssignmentEnd` alone.
    mapping(uint256 => mapping(address => mapping(uint64 => uint40))) internal _replacedAssignmentEnd;

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

    /// @notice Record an account's opt-in: when service spending was switched
    ///         on and the owner who switched it on, or 0 for off.
    function setServiceSpending(uint256 accountId, ServiceSpending calldata s) external onlyContracts {
        _serviceSpending[accountId] = s;
    }

    /// @notice Return the account's current assignment nonce and advance it.
    function consumeAssignmentNonce(uint256 accountId) external onlyContracts returns (uint64 used) {
        used = assignmentNonce[accountId];
        assignmentNonce[accountId] = used + 1;
    }

    /// @notice Store an assignment, list its assignee once, and reset the
    ///         assignee's usage: a new assignment is new terms both parties
    ///         signed, so its usage counts from nothing. The assignment it
    ///         replaces keeps its end (`assignmentEnd`), for the periods funded
    ///         under it: a new assignment never reopens a time in which the old
    ///         one had ended.
    function setAssignment(uint256 accountId, address assignee, Assignment calldata a) external onlyContracts {
        Assignment storage replaced = _assignments[accountId][assignee];
        if (replaced.assignedAt != 0) {
            _replacedAssignmentEnd[accountId][assignee][replaced.nonce] = _endOf(replaced);
        }
        _assignments[accountId][assignee] = a;
        _list(accountId, assignee);
        delete _usage[accountId][assignee];
    }

    /// @notice Record the revocation time of an assignment.
    function setAssignmentRevokedAt(uint256 accountId, address assignee, uint40 at) external onlyContracts {
        _assignments[accountId][assignee].revokedAt = at;
    }

    /// @notice Overwrite the two limits of a stored assignment and nothing
    ///         else: `assignedAt`, `revokedAt`, `nonce`, `owner`, the assignee
    ///         list and the usage stay as they are.
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
    //            Narrow setters (onlyContracts), one field each
    // ============================================================

    /// @notice Store `a` as `assignee`'s assignment over `accountId`, and
    ///         nothing else: unlike `setAssignment`, it keeps no end for the
    ///         assignment it overwrites, lists no assignee and leaves the
    ///         usage as it is.
    function setAssignmentRecord(uint256 accountId, address assignee, Assignment calldata a) external onlyContracts {
        _assignments[accountId][assignee] = a;
    }

    /// @notice Set the end kept for `assignee`'s assignment over `accountId`
    ///         that consumed `nonce`, the end `assignmentEnd` reads once a
    ///         later assignment has replaced it.
    function setReplacedAssignmentEnd(
        uint256 accountId,
        address assignee,
        uint64 nonce,
        uint40 end
    ) external onlyContracts {
        _replacedAssignmentEnd[accountId][assignee][nonce] = end;
    }

    /// @notice List `assignee` under `accountId`, once, as `setAssignment`
    ///         lists it: an assignee already listed keeps its place.
    function listAssignee(uint256 accountId, address assignee) external onlyContracts {
        _list(accountId, assignee);
    }

    /// @notice Set what `assignee` has funded under its assignment over
    ///         `accountId`, which `recordUsage` counts and `setAssignment`
    ///         resets.
    function setUsage(uint256 accountId, address assignee, Usage calldata u) external onlyContracts {
        _usage[accountId][assignee] = u;
    }

    /// @notice Overwrite a recorded period's record, and nothing else: its
    ///         buckets and its place in the account's list stay as they are.
    /// @dev    It refuses an id with no record (`SubscriptionNotFound`), so a
    ///         record is still created only by `createSubscription`, and a
    ///         record with a `periodStart` of 0 (`ZeroPeriodStart`), which
    ///         would read as absent.
    function setSubscription(bytes32 subscriptionId, Subscription calldata s) external onlyContracts {
        _requireRecorded(subscriptionId);
        if (s.periodStart == 0) revert ZeroPeriodStart(subscriptionId);
        _subscriptions[subscriptionId] = s;
    }

    /// @notice Overwrite bucket `index` of a recorded period. It refuses an id
    ///         with no record (`SubscriptionNotFound`), and reverts past the
    ///         period's stored buckets, as `getBucket` does.
    function setBucket(bytes32 subscriptionId, uint256 index, Bucket calldata b) external onlyContracts {
        _requireRecorded(subscriptionId);
        _buckets[subscriptionId][index] = b;
    }

    /// @notice Append a bucket after a recorded period's stored ones, so
    ///         every stored bucket keeps its index. It refuses an id with no
    ///         record (`SubscriptionNotFound`). The record's `bucketCount` is
    ///         the record's own, set with it (`setSubscription`).
    function appendBucket(bytes32 subscriptionId, Bucket calldata b) external onlyContracts {
        _requireRecorded(subscriptionId);
        _buckets[subscriptionId].push(b);
    }

    /// @notice Append a recorded period's id to `accountId`'s list, as
    ///         `createSubscription` appends it. It refuses an id with no
    ///         record (`SubscriptionNotFound`).
    function appendAccountSubscription(uint256 accountId, bytes32 subscriptionId) external onlyContracts {
        _requireRecorded(subscriptionId);
        _accountSubscriptions[accountId].push(subscriptionId);
    }

    // ============================================================
    //                           Views
    // ============================================================

    /// @notice An account's opt-in, and the owner who made it; it counts only
    ///         while that owner holds the account.
    function getServiceSpending(uint256 accountId) external view returns (ServiceSpending memory) {
        return _serviceSpending[accountId];
    }

    function getAssignment(uint256 accountId, address assignee) external view returns (Assignment memory) {
        return _assignments[accountId][assignee];
    }

    function getUsage(uint256 accountId, address assignee) external view returns (Usage memory) {
        return _usage[accountId][assignee];
    }

    /// @notice True when the assignment exists, is not revoked and has not
    ///         expired at the current block time. It does not read the
    ///         account's owner: an assignment funds only while the owner who
    ///         consented to it (`Assignment.owner`) holds the account.
    function isAssignmentActive(uint256 accountId, address assignee) external view returns (bool) {
        Assignment storage a = _assignments[accountId][assignee];
        return a.assignedAt != 0 && a.revokedAt == 0 && block.timestamp < a.expiresAt;
    }

    /// @notice When the assignment of `assignee` over `accountId` that
    ///         consumed `nonce` ended or ends: its expiry, or its revocation
    ///         if sooner. For the current assignment its terms as they stand;
    ///         for one a later assignment replaced, the end it had then. 0 if
    ///         no assignment of `assignee` consumed `nonce`.
    function assignmentEnd(uint256 accountId, address assignee, uint64 nonce) external view returns (uint40) {
        Assignment storage a = _assignments[accountId][assignee];
        if (a.assignedAt != 0 && a.nonce == nonce) return _endOf(a);
        return _replacedAssignmentEnd[accountId][assignee][nonce];
    }

    /// @notice The end kept for `assignee`'s assignment over `accountId` that
    ///         consumed `nonce`, as stored when a later assignment replaced it
    ///         or `setReplacedAssignmentEnd` set it; 0 if none was kept.
    ///         `assignmentEnd` reads the current assignment instead where its
    ///         nonce is `nonce`.
    function replacedAssignmentEnd(uint256 accountId, address assignee, uint64 nonce) external view returns (uint40) {
        return _replacedAssignmentEnd[accountId][assignee][nonce];
    }

    function assigneeCount(uint256 accountId) external view returns (uint256) {
        return _assignees[accountId].length;
    }

    function assigneeAt(uint256 accountId, uint256 index) external view returns (address) {
        return _assignees[accountId][index];
    }

    /// @notice Whether `assignee` is listed under `accountId`, among
    ///         `assigneeAt`'s entries.
    function isAssigneeListed(uint256 accountId, address assignee) external view returns (bool) {
        return _listed[accountId][assignee];
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

    /// @notice How many buckets are stored for a period. A record written by
    ///         `createSubscription` and `applyTopUp` has the same
    ///         `bucketCount`.
    function storedBucketCount(bytes32 subscriptionId) external view returns (uint256) {
        return _buckets[subscriptionId].length;
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

    // ============================================================
    //                         Internal
    // ============================================================

    /// @dev List `assignee` under `accountId` unless it is listed already.
    function _list(uint256 accountId, address assignee) internal {
        if (!_listed[accountId][assignee]) {
            _listed[accountId][assignee] = true;
            _assignees[accountId].push(assignee);
        }
    }

    /// @dev The id holds a period record.
    function _requireRecorded(bytes32 subscriptionId) internal view {
        if (_subscriptions[subscriptionId].periodStart == 0) revert SubscriptionNotFound(subscriptionId);
    }

    /// @dev An assignment's end: its expiry, or its revocation if that is
    ///      sooner. `ServiceSubscriptions.revoke` does not check the expiry,
    ///      so a revocation can come after it.
    function _endOf(Assignment storage a) internal view returns (uint40 end) {
        end = a.expiresAt;
        uint40 revokedAt = a.revokedAt;
        if (revokedAt != 0 && revokedAt < end) end = revokedAt;
    }
}
