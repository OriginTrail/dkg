// SPDX-License-Identifier: Apache-2.0

pragma solidity ^0.8.20;

import {INamed} from "../interfaces/INamed.sol";
import {IVersioned} from "../interfaces/IVersioned.sol";
import {IInitializable} from "../interfaces/IInitializable.sol";
import {HubDependent} from "../abstract/HubDependent.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

/**
 * @title ServiceSubscriptionsStorage
 * @notice State store for subscriptions (OT-RFC-27, "NeuroSymbolic
 *         Marketplace"). The owner of a Conviction Account opts it in and adds
 *         buyers under grants, and each buyer funds subscriptions from the
 *         account's existing allowance. A subscription funded from an account
 *         moves no TRAC: its cost is spent from the account's allowance and
 *         booked in the query/inference pool (`QueryInferenceStorage`), as a
 *         wallet subscription's value is. A buyer may also fund subscriptions
 *         from its wallet; those are recorded here too, under account 0, which
 *         no account has. A subscription is for one chain epoch.
 *
 * Architecture (the pattern of `PublishingConvictionStorage`):
 *   - This contract holds every byte of service-spending state: the opt-in
 *     switch per account and the owner who switched it on, the grants, each
 *     with the owner who consented to it, and the subscriptions counted under
 *     them, the end of each grant a new one replaced, and the subscription
 *     records with their budgets, which top-ups grow. A subscription record
 *     names the grant it was funded under by its nonce, so the subscription
 *     keeps that grant's end whatever later grant its buyer gets. It never
 *     holds or moves TRAC; the money is booked in `QueryInferenceStorage`.
 *   - It is policy-free. Every mutator is `onlyContracts` (any Hub-registered
 *     contract, and the Hub owner), and the logic contracts enforce every
 *     business rule (ownership, consent, the cost limit) before they write. The
 *     one rule it keeps itself is the integrity of its subscription records:
 *     each id is created once (`createSubscription`), a written record always
 *     reads as existing (`createSubscription`, `setSubscription`), and only a
 *     written record takes budgets or a top-up, at the indexes of its budgets
 *     (`applyTopUp`, `setBudget`, `appendBudget`). Business events come from
 *     the logic contracts; this contract emits events only for its own
 *     parameters.
 *   - Every field has a view, and every field the logic contracts write has a
 *     narrow setter that writes that field alone, beside the writes they make
 *     today (`setGrant` and `createSubscription` write several fields at once).
 *     So a later logic version reads and writes all of this state without a new
 *     storage, which would start empty. The writes of several fields remain the
 *     normal path: a writer that calls a narrow setter keeps in step the fields
 *     its NatSpec names.
 *   - The parameter setters are `onlyHub`, so governance reaches them through
 *     `Hub.forwardCall` (the Hub owner may also call them directly).
 *
 * Fresh state: the contract ships empty and is never upgraded in place. A
 * replacement starts empty, so the storage layout matters to indexers rather
 * than to migrations. The declaration order of the state below IS the layout:
 * slot 0 packs the inherited `hub` with `maxBudgetsPerSubscription` (21 of 32
 * bytes); slots 1 to 6 and 13 to 15 hold the mappings in order, at the slots
 * 1.0.0 and 1.1.0 gave them; slots 7 to 12, where 1.1.0 kept the service
 * labels, stay empty; slot 16, last, holds the ends of replaced grants.
 */
contract ServiceSubscriptionsStorage is INamed, IVersioned, HubDependent, IInitializable {
    string private constant _NAME = "ServiceSubscriptionsStorage";
    // Version history:
    //   1.0.0 — Conviction Account service spending: opt-ins, grants, usage,
    //           labels, and subscription records with their budgets.
    //   1.1.0 — a subscription is for one epoch; a grant holds one cost limit
    //           per subscription and an expiry, and its usage counts
    //           subscriptions only; `maxPeriodSeconds` is gone; top-ups of a
    //           recorded subscription (`applyTopUp`); one budget read by index
    //           (`getBudget`). The mapping slots are unchanged.
    //   1.2.0 — no service labels: a Conviction Account subscription's cost is
    //           booked in `QueryInferenceStorage`. Removed with the labels are
    //           their state and views (`serviceSpent`, `baseLabel`,
    //           `topUpLabel`, `labelCursor`, `epochServiceLabel`,
    //           `accountServiceLabelTotal`, `serviceLabel`, `accountLabel`),
    //           their mutators, and the schedule cut-over `exactScheduleFrom`,
    //           which only the labels read. Slots 7 to 12 stay empty
    //           (`_retiredLabelSlots`), so every remaining mapping keeps its
    //           slot; `maxBudgetsPerSubscription` moves to offset 20 of slot 0.
    //           A subscription records the nonce of the grant it is funded
    //           under (`Subscription.grantNonce`, beside the buyer), and a new
    //           grant keeps the end of the one it replaces (`grantEnd`, slot
    //           16), so a subscription keeps the grant it was funded under. The
    //           opt-in records the owner who switched it on
    //           (`getServiceSpending`, slot 1, where `serviceSpendingEnabledAt`
    //           was) and a grant the owner who consented to it
    //           (`BuyerGrant.owner`, beside its nonce), so neither outlives a
    //           sale of the account. Every field has a view and a narrow setter
    //           beside the writes the logic makes: `isBuyerListed`,
    //           `replacedGrantEnd` and `storedBudgetCount`; `setGrantRecord`,
    //           `setReplacedGrantEnd`, `listBuyer`, `setUsage`,
    //           `setSubscription`, `setBudget`, `appendBudget` and
    //           `appendAccountSubscription`.
    string private constant _VERSION = "1.2.0";

    uint8 internal constant _DEFAULT_MAX_BUDGETS_PER_SUBSCRIPTION = 16;
    uint8 internal constant _BUDGETS_PER_SUBSCRIPTION_UPPER_BOUND = 32;

    /// @notice Service class of an inference budget; its units are tokens.
    uint8 public constant CLASS_INFERENCE = 1;
    /// @notice Service class of a knowledge query budget; its units are query
    /// units.
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

    /// @notice An account owner's permission for one buyer: the most it may
    ///         spend on one subscription, in COST (TRAC wei spent from the
    ///         account's allowance after its discount), and until when. It
    ///         funds only while the owner who consented to it holds the
    ///         account.
    struct BuyerGrant {
        uint96 maxCostPerEpoch; // the most one subscription may cost, its top-ups included
        uint40 grantedAt; // 0 = no grant
        uint40 expiresAt;
        uint40 revokedAt; // 0 = not revoked
        uint64 nonce; // the account nonce this grant consumed
        address owner; // the account's owner who consented to it
    }

    /// @notice The limit and the expiry of a grant. `setBuyerLimits` writes
    ///         them and nothing else.
    struct BuyerLimits {
        uint96 maxCostPerEpoch;
        uint40 expiresAt;
    }

    /// @notice What a buyer has funded under its grant.
    struct Usage {
        uint32 subscriptions; // subscriptions funded since grantedAt; top-ups fund none
    }

    /// @notice One funded subscription, for one chain epoch.
    struct Subscription {
        uint256 accountId; // 0 = funded from the buyer's wallet
        address buyer; // the buyer that funded it
        uint64 grantNonce; // the nonce of the grant it was funded under; unused for a wallet subscription
        address sessionKey; // the buyer's request-signing key; the funding contracts refuse zero
        uint40 epoch; // the subscription's epoch; the id is keccak256(abi.encode(buyer, epoch))
        bytes32 planDigest; // the buyer's commitment to its plan, opaque here; a top-up replaces it
        uint40 startsAt; // the later of the funding's block time and the epoch's start; 0 = no record
        uint40 endsAt; // the start of the next epoch
        uint40 fundedEpoch; // the epoch the funding ran in
        uint40 fundedWindow; // the account's billing window spent; 0 for a wallet subscription
        uint16 discountBps; // 0 for a wallet subscription
        uint8 budgetCount;
        uint96 value; // sum of the budget values, before the discount
        uint96 cost; // spent from the allowance; the value for a wallet subscription
        uint96 spentFromWindow;
        uint96 spentFromTopUp;
    }

    /// @notice One service budget of a funded subscription.
    struct ServiceBudget {
        bytes32 serviceId; // a canonical model or service
        uint8 serviceClass; // CLASS_INFERENCE or CLASS_QUERY
        uint96 value; // the funded budget value before the discount, TRAC wei
        uint96 maxPricePerUnit; // the buyer's price cap per unit
    }

    /// @notice What a top-up adds to a subscription record: its value, its cost
    ///         and the cost's split between the window allowance and the top-up
    ///         buffer (both 0 for a wallet subscription).
    struct TopUpAmounts {
        uint96 value;
        uint96 cost;
        uint96 spentFromWindow;
        uint96 spentFromTopUp;
    }

    // ============================================================
    //                    Events (parameters only)
    // ============================================================

    event MaxBudgetsPerSubscriptionSet(uint8 oldValue, uint8 newValue);

    // ============================================================
    //                          Errors
    // ============================================================

    error InvalidParameter(string name);
    /// @notice The id already holds a subscription record or budgets.
    error SubscriptionExists(bytes32 subscriptionId);
    /// @notice The subscription record has a `startsAt` of 0, so it would read
    ///         as absent.
    error ZeroSubscriptionStart(bytes32 subscriptionId);
    /// @notice The id holds no subscription record.
    error SubscriptionNotFound(bytes32 subscriptionId);
    /// @notice A top-up names more stored budgets than the subscription has.
    error BudgetTopUpOutOfRange(bytes32 subscriptionId, uint256 count, uint256 budgetCount);

    // ============================================================
    //          State (the declaration order is the layout)
    // ============================================================

    /// @notice The most budgets one funded subscription may carry, its top-ups
    ///         included.
    uint8 public maxBudgetsPerSubscription;

    /// @dev accountId => its opt-in to service spending.
    mapping(uint256 => ServiceSpending) internal _serviceSpending;
    /// @notice accountId => the nonce the next grant must carry.
    mapping(uint256 => uint64) public grantNonce;
    /// @dev accountId => buyer => grant.
    mapping(uint256 => mapping(address => BuyerGrant)) internal _grants;
    /// @dev accountId => buyer => what it has funded under its grant.
    mapping(uint256 => mapping(address => Usage)) internal _usage;
    /// @dev accountId => every buyer ever listed, append-only, each once.
    mapping(uint256 => address[]) internal _buyers;
    /// @dev accountId => buyer => membership index for `_buyers`.
    mapping(uint256 => mapping(address => bool)) internal _listed;
    /// @dev Slots 7 to 12: where 1.1.0 kept the service labels and the window
    ///      spends they were based on. Never written since 1.2.0; held empty so
    ///      the subscription records keep slots 13 to 15.
    uint256[6] private _retiredLabelSlots;
    /// @dev subscriptionId => funded subscription record.
    mapping(bytes32 => Subscription) internal _subscriptions;
    /// @dev subscriptionId => the subscription's budgets, in funding order.
    mapping(bytes32 => ServiceBudget[]) internal _budgets;
    /// @dev accountId => subscription ids, in funding order.
    mapping(uint256 => bytes32[]) internal _accountSubscriptions;
    /// @dev accountId => buyer => grant nonce => when that grant ended or ends,
    ///      its expiry or its revocation if sooner, kept when a new grant to
    ///      the buyer replaced it, for the subscriptions funded under it.
    ///      `setGrant` writes it then, and `setReplacedGrantEnd` alone.
    mapping(uint256 => mapping(address => mapping(uint64 => uint40))) internal _replacedGrantEnd;

    constructor(address hubAddress) HubDependent(hubAddress) {}

    /// @dev Idempotent across redeploys: seeds each parameter's default only
    ///      while it is unset, so a value governance has tuned survives a
    ///      re-initialization.
    function initialize() external onlyHub {
        if (maxBudgetsPerSubscription == 0) {
            maxBudgetsPerSubscription = _DEFAULT_MAX_BUDGETS_PER_SUBSCRIPTION;
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

    /// @notice Set the most budgets per subscription, from 1 to 32.
    function setMaxBudgetsPerSubscription(uint8 value) external onlyHub {
        if (value == 0 || value > _BUDGETS_PER_SUBSCRIPTION_UPPER_BOUND) {
            revert InvalidParameter("maxBudgetsPerSubscription");
        }
        uint8 old = maxBudgetsPerSubscription;
        maxBudgetsPerSubscription = value;
        emit MaxBudgetsPerSubscriptionSet(old, value);
    }

    // ============================================================
    //                   Mutators (onlyContracts)
    // ============================================================

    /// @notice Record an account's opt-in: when service spending was switched
    ///         on and the owner who switched it on, or 0 for off.
    function setServiceSpending(uint256 accountId, ServiceSpending calldata s) external onlyContracts {
        _serviceSpending[accountId] = s;
    }

    /// @notice Return the account's current grant nonce and advance it.
    function consumeGrantNonce(uint256 accountId) external onlyContracts returns (uint64 used) {
        used = grantNonce[accountId];
        grantNonce[accountId] = used + 1;
    }

    /// @notice Store a grant, list its buyer once, and reset the buyer's usage:
    ///         a new grant is new terms both parties signed, so its usage
    ///         counts from nothing. The grant it replaces keeps its end
    ///         (`grantEnd`), for the subscriptions funded under it: a new grant
    ///         never reopens a time in which the old one had ended.
    function setGrant(uint256 accountId, address buyer, BuyerGrant calldata grant) external onlyContracts {
        BuyerGrant storage replaced = _grants[accountId][buyer];
        if (replaced.grantedAt != 0) {
            _replacedGrantEnd[accountId][buyer][replaced.nonce] = _endOf(replaced);
        }
        _grants[accountId][buyer] = grant;
        _list(accountId, buyer);
        delete _usage[accountId][buyer];
    }

    /// @notice Record the revocation time of a grant.
    function setGrantRevokedAt(uint256 accountId, address buyer, uint40 at) external onlyContracts {
        _grants[accountId][buyer].revokedAt = at;
    }

    /// @notice Overwrite the limit and the expiry of a stored grant and nothing
    ///         else: `grantedAt`, `revokedAt`, `nonce`, `owner`, the buyer list
    ///         and the usage stay as they are.
    function setBuyerLimits(
        uint256 accountId,
        address buyer,
        BuyerLimits calldata limits
    ) external onlyContracts {
        BuyerGrant storage grant = _grants[accountId][buyer];
        grant.maxCostPerEpoch = limits.maxCostPerEpoch;
        grant.expiresAt = limits.expiresAt;
    }

    /// @notice Count a funded subscription against its buyer.
    function recordUsage(uint256 accountId, address buyer) external onlyContracts {
        _usage[accountId][buyer].subscriptions += 1;
    }

    /// @notice Record a funded subscription and its budgets, in the given
    ///         order, and append its id to the account's list.
    /// @dev    A record exists exactly when its `startsAt` is non-zero, so this
    ///         refuses a record with a `startsAt` of 0, which would read as
    ///         absent and could be written again (`ZeroSubscriptionStart`), and
    ///         an id that already holds a record or budgets
    ///         (`SubscriptionExists`), whose second write would append its
    ///         budgets to the first's and list the id twice. The storage checks
    ///         both itself because every Hub-registered contract can call it,
    ///         and it is never upgraded in place.
    function createSubscription(
        bytes32 subscriptionId,
        Subscription calldata s,
        ServiceBudget[] calldata budgets
    ) external onlyContracts {
        if (s.startsAt == 0) revert ZeroSubscriptionStart(subscriptionId);
        ServiceBudget[] storage stored = _budgets[subscriptionId];
        if (_subscriptions[subscriptionId].startsAt != 0 || stored.length != 0) {
            revert SubscriptionExists(subscriptionId);
        }
        _subscriptions[subscriptionId] = s;
        for (uint256 i; i < budgets.length; i++) {
            stored.push(budgets[i]);
        }
        _accountSubscriptions[s.accountId].push(subscriptionId);
    }

    /// @notice Top up a recorded subscription: add `added[i]` to the value of
    ///         its stored budget `i`, append `appended` after its stored
    ///         budgets, add `t` to its value, cost and spend split, and replace
    ///         its plan commitment.
    /// @dev    It refuses an id with no record (`SubscriptionNotFound`), whose
    ///         budgets would then belong to no subscription, and more entries
    ///         in `added` than the subscription has budgets
    ///         (`BudgetTopUpOutOfRange`). Appending keeps every stored budget
    ///         at its index, which receipt groups and `budgetUsed` are keyed
    ///         by. The sums are checked, so an overflow reverts.
    function applyTopUp(
        bytes32 subscriptionId,
        TopUpAmounts calldata t,
        bytes32 planDigest,
        uint96[] calldata added,
        ServiceBudget[] calldata appended
    ) external onlyContracts {
        Subscription storage s = _subscriptions[subscriptionId];
        if (s.startsAt == 0) revert SubscriptionNotFound(subscriptionId);
        ServiceBudget[] storage stored = _budgets[subscriptionId];
        uint256 n = stored.length;
        if (added.length > n) revert BudgetTopUpOutOfRange(subscriptionId, added.length, n);

        for (uint256 i; i < added.length; i++) {
            if (added[i] != 0) stored[i].value += added[i];
        }
        if (appended.length != 0) {
            for (uint256 i; i < appended.length; i++) {
                stored.push(appended[i]);
            }
            s.budgetCount = SafeCast.toUint8(stored.length);
        }

        s.value += t.value;
        s.cost += t.cost;
        if (t.spentFromWindow != 0 || t.spentFromTopUp != 0) {
            s.spentFromWindow += t.spentFromWindow;
            s.spentFromTopUp += t.spentFromTopUp;
        }
        s.planDigest = planDigest;
    }

    // ============================================================
    //            Narrow setters (onlyContracts), one field each
    //
    // `setGrant`, `recordUsage`, `createSubscription` and `applyTopUp` remain
    // the normal path: they keep related fields in step. A setter here writes
    // its own field and leaves the others, so a later logic version can ship
    // without a new storage, and its caller keeps in step the fields its
    // NatSpec names.
    // ============================================================

    /// @notice Store `grant` as `buyer`'s grant over `accountId`, and nothing
    ///         else: unlike `setGrant`, it keeps no end for the grant it
    ///         overwrites, lists no buyer and leaves the usage as it is.
    /// @dev    The caller keeps in step what `setGrant` does here: the end of
    ///         the grant it overwrites (`setReplacedGrantEnd`), without which
    ///         `grantEnd` reads 0 for that nonce and the subscriptions funded
    ///         under it take no request; the list (`listBuyer`); and the usage,
    ///         which counts from nothing under new terms (`setUsage`).
    ///         `setGrant` remains the normal path.
    function setGrantRecord(uint256 accountId, address buyer, BuyerGrant calldata grant) external onlyContracts {
        _grants[accountId][buyer] = grant;
    }

    /// @notice Set the end kept for `buyer`'s grant over `accountId` that
    ///         consumed `nonce`, the end `grantEnd` reads once a later grant
    ///         has replaced it.
    /// @dev    The caller keeps it the end that grant had, which the
    ///         subscriptions funded under it are held to, and it counts only
    ///         for a `nonce` other than the current grant's. `setGrant` keeps
    ///         it, and remains the normal path.
    function setReplacedGrantEnd(
        uint256 accountId,
        address buyer,
        uint64 nonce,
        uint40 end
    ) external onlyContracts {
        _replacedGrantEnd[accountId][buyer][nonce] = end;
    }

    /// @notice List `buyer` under `accountId`, once, as `setGrant` lists it: a
    ///         buyer already listed keeps its place.
    function listBuyer(uint256 accountId, address buyer) external onlyContracts {
        _list(accountId, buyer);
    }

    /// @notice Set what `buyer` has funded under its grant over `accountId`,
    ///         which `recordUsage` counts and `setGrant` resets.
    /// @dev    The caller keeps `subscriptions` the count of subscriptions
    ///         funded under the current grant. `recordUsage` and `setGrant`
    ///         remain the normal path.
    function setUsage(uint256 accountId, address buyer, Usage calldata u) external onlyContracts {
        _usage[accountId][buyer] = u;
    }

    /// @notice Overwrite a recorded subscription's record, and nothing else:
    ///         its budgets and its place in the account's list stay as they
    ///         are.
    /// @dev    It refuses an id with no record (`SubscriptionNotFound`), so a
    ///         record is still created only by `createSubscription`, and a
    ///         record with a `startsAt` of 0 (`ZeroSubscriptionStart`), which
    ///         would read as absent. The caller keeps in step what the record
    ///         repeats: `budgetCount` with the stored budgets
    ///         (`storedBudgetCount`, `appendBudget`), `value` with the sum of
    ///         their values (`setBudget`, `appendBudget`), `cost` with
    ///         `spentFromWindow + spentFromTopUp`, or with `value` for a wallet
    ///         subscription, `accountId` with the account's list
    ///         (`appendAccountSubscription`), and `buyer` and `epoch` with the
    ///         id, keccak256(abi.encode(buyer, epoch)). The money booked is
    ///         `QueryInferenceStorage`'s, and does not follow.
    ///         `createSubscription` and `applyTopUp` remain the normal path.
    function setSubscription(bytes32 subscriptionId, Subscription calldata s) external onlyContracts {
        _requireRecorded(subscriptionId);
        if (s.startsAt == 0) revert ZeroSubscriptionStart(subscriptionId);
        _subscriptions[subscriptionId] = s;
    }

    /// @notice Overwrite budget `index` of a recorded subscription. It refuses
    ///         an id with no record (`SubscriptionNotFound`), and reverts past
    ///         the subscription's stored budgets, as `getBudget` does.
    /// @dev    The caller keeps in step the record's `value`, the sum of the
    ///         budgets' values (`setSubscription`). What a budget has used is
    ///         kept by its index (`QueryInferenceStorage`), so a budget in use
    ///         keeps its `serviceId` and a value of at least what it has used.
    ///         `applyTopUp` remains the normal path.
    function setBudget(bytes32 subscriptionId, uint256 index, ServiceBudget calldata b) external onlyContracts {
        _requireRecorded(subscriptionId);
        _budgets[subscriptionId][index] = b;
    }

    /// @notice Append a budget after a recorded subscription's stored ones, so
    ///         every stored budget keeps its index. It refuses an id with no
    ///         record (`SubscriptionNotFound`).
    /// @dev    The caller keeps in step the record's `budgetCount` and `value`
    ///         (`setSubscription`). Until it does, `storedBudgetCount` reads
    ///         one more than `getSubscription(...).budgetCount`, and
    ///         `QueryInferenceSettlement` refuses the new budget as unknown.
    ///         `applyTopUp` writes all three, and remains the normal path.
    function appendBudget(bytes32 subscriptionId, ServiceBudget calldata b) external onlyContracts {
        _requireRecorded(subscriptionId);
        _budgets[subscriptionId].push(b);
    }

    /// @notice Append a recorded subscription's id to `accountId`'s list, as
    ///         `createSubscription` appends it. It refuses an id with no record
    ///         (`SubscriptionNotFound`).
    /// @dev    The caller keeps the list in step with the records: an id
    ///         belongs under its record's `accountId`, once, and neither is
    ///         checked here. `createSubscription` remains the normal path.
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

    function getGrant(uint256 accountId, address buyer) external view returns (BuyerGrant memory) {
        return _grants[accountId][buyer];
    }

    function getUsage(uint256 accountId, address buyer) external view returns (Usage memory) {
        return _usage[accountId][buyer];
    }

    /// @notice True when the grant exists, is not revoked and has not expired
    ///         at the current block time. It does not read the account's owner:
    ///         a grant funds only while the owner who consented to it
    ///         (`BuyerGrant.owner`) holds the account.
    function isGrantActive(uint256 accountId, address buyer) external view returns (bool) {
        BuyerGrant storage grant = _grants[accountId][buyer];
        return grant.grantedAt != 0 && grant.revokedAt == 0 && block.timestamp < grant.expiresAt;
    }

    /// @notice When the grant to `buyer` over `accountId` that consumed `nonce`
    ///         ended or ends: its expiry, or its revocation if sooner. For the
    ///         current grant its terms as they stand; for one a later grant
    ///         replaced, the end it had then. 0 if no grant to `buyer` consumed
    ///         `nonce`.
    function grantEnd(uint256 accountId, address buyer, uint64 nonce) external view returns (uint40) {
        BuyerGrant storage grant = _grants[accountId][buyer];
        if (grant.grantedAt != 0 && grant.nonce == nonce) return _endOf(grant);
        return _replacedGrantEnd[accountId][buyer][nonce];
    }

    /// @notice The end kept for `buyer`'s grant over `accountId` that consumed
    ///         `nonce`, as stored when a later grant replaced it or
    ///         `setReplacedGrantEnd` set it; 0 if none was kept. `grantEnd`
    ///         reads the current grant instead where its nonce is `nonce`.
    function replacedGrantEnd(uint256 accountId, address buyer, uint64 nonce) external view returns (uint40) {
        return _replacedGrantEnd[accountId][buyer][nonce];
    }

    function buyerCount(uint256 accountId) external view returns (uint256) {
        return _buyers[accountId].length;
    }

    function buyerAt(uint256 accountId, uint256 index) external view returns (address) {
        return _buyers[accountId][index];
    }

    /// @notice Whether `buyer` is listed under `accountId`, among `buyerAt`'s
    ///         entries.
    function isBuyerListed(uint256 accountId, address buyer) external view returns (bool) {
        return _listed[accountId][buyer];
    }

    function subscriptionExists(bytes32 subscriptionId) external view returns (bool) {
        return _subscriptions[subscriptionId].startsAt != 0;
    }

    function getSubscription(bytes32 subscriptionId) external view returns (Subscription memory) {
        return _subscriptions[subscriptionId];
    }

    function getBudgets(bytes32 subscriptionId) external view returns (ServiceBudget[] memory) {
        return _budgets[subscriptionId];
    }

    /// @notice How many budgets are stored for a subscription. A record written
    ///         by `createSubscription` and `applyTopUp` has the same
    ///         `budgetCount`.
    function storedBudgetCount(bytes32 subscriptionId) external view returns (uint256) {
        return _budgets[subscriptionId].length;
    }

    /// @notice The subscription's budget at `index`, its funding order. Reverts
    ///         for an index at or past the subscription's budget count.
    function getBudget(bytes32 subscriptionId, uint256 index) external view returns (ServiceBudget memory) {
        return _budgets[subscriptionId][index];
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

    /// @dev List `buyer` under `accountId` unless it is listed already.
    function _list(uint256 accountId, address buyer) internal {
        if (!_listed[accountId][buyer]) {
            _listed[accountId][buyer] = true;
            _buyers[accountId].push(buyer);
        }
    }

    /// @dev The id holds a subscription record.
    function _requireRecorded(bytes32 subscriptionId) internal view {
        if (_subscriptions[subscriptionId].startsAt == 0) revert SubscriptionNotFound(subscriptionId);
    }

    /// @dev A grant's end: its expiry, or its revocation if that is sooner.
    ///      `ServiceSubscriptions.removeBuyer` does not check the expiry, so a
    ///      revocation can come after it.
    function _endOf(BuyerGrant storage grant) internal view returns (uint40 end) {
        end = grant.expiresAt;
        uint40 revokedAt = grant.revokedAt;
        if (revokedAt != 0 && revokedAt < end) end = revokedAt;
    }
}
