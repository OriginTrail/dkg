// SPDX-License-Identifier: Apache-2.0

pragma solidity ^0.8.20;

import {INamed} from "./interfaces/INamed.sol";
import {IVersioned} from "./interfaces/IVersioned.sol";
import {IInitializable} from "./interfaces/IInitializable.sol";
import {IPublishingConvictionErrors} from "./interfaces/IPublishingConvictionErrors.sol";
import {IConvictionServiceErrors} from "./interfaces/IConvictionServiceErrors.sol";
import {IServicePeriodFunding} from "./interfaces/IServicePeriodFunding.sol";
import {ContractStatus} from "./abstract/ContractStatus.sol";
import {Chronos} from "./storage/Chronos.sol";
import {ParametersStorage} from "./storage/ParametersStorage.sol";
import {PublishingConvictionStorage} from "./storage/PublishingConvictionStorage.sol";
import {ConvictionServiceStorage} from "./storage/ConvictionServiceStorage.sol";
import {QueryInferenceStorage} from "./storage/QueryInferenceStorage.sol";
import {PublishingConviction} from "./PublishingConviction.sol";
import {ServicePeriodLib} from "./libraries/ServicePeriodLib.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {ECDSA} from "solady/src/utils/ECDSA.sol";

/**
 * @title ServiceSubscriptions
 * @notice Conviction Account service spending (OT-RFC-27, "NeuroSymbolic
 *         Marketplace"): the owner of a Conviction Account opts it in and
 *         assigns bounded plan-funding authority to a buyer key, with that
 *         key's signed consent; the buyer key then funds service plan
 *         periods, one transaction each, from the account's existing
 *         allowance, and tops them up within the period.
 *
 * A plan period is one chain epoch, the current one or the next, and a buyer
 * key funds at most one period per epoch, from an account or, through
 * `ServiceSubscriptionsWallet`, from its wallet; both share one id per buyer
 * key and epoch.
 *
 * A Conviction Account pays for a period as a wallet does (since 1.2.0). A
 * funded period moves no TRAC: `PublishingConviction.coverServiceCost` draws
 * the cost from the account's allowance exactly as a publish does (the
 * current billing window first, then the top-up buffer, at the account's
 * discount tier), and this contract books the whole cost in
 * `QueryInferenceStorage` as due in the epoch after the period, as
 * `ServiceSubscriptionsWallet` books a wallet period's value: the epoch in
 * which the period's receipt value counts. The draw itself books nothing to
 * the staker pool, so the cost is counted once, in the query/inference pool.
 *
 * Architecture (the pattern of `PublishingConviction`):
 *   - Stateless logic. Every byte of service-spending state lives in
 *     `ConvictionServiceStorage` and `QueryInferenceStorage`; this contract
 *     holds only Hub-resolved references. `PublishingConvictionStorage`,
 *     `ConvictionServiceStorage`, `QueryInferenceStorage`, `Chronos` and
 *     `ParametersStorage` are wired at `initialize()`. `PublishingConviction`
 *     and `DKGPublishingConvictionNFT` are resolved from the Hub on every
 *     call, so either can be re-registered.
 *   - It calls only the Hub, `PublishingConviction`, the two account
 *     storages, `QueryInferenceStorage`, `Chronos`, `ParametersStorage`, the
 *     NFT's `ownerOf` and, as a staticcall before any state write, ERC-1271
 *     wallets. It never calls the Token or the vault, and accepts no ETH.
 *     A funding needs `PublishingConviction` 10.2.0 or later, whose
 *     `coverServiceCost` books nothing to the staker pool.
 *
 * Gates:
 *   - Only the current NFT owner switches service spending, revokes, updates
 *     caps or advances the assignment nonce, and the owner's consent to an
 *     assignment is checked against the owner at the time of `assign`.
 *   - An assignment needs the consent of both the owner and the assignee over
 *     one EIP-712 digest that carries the account's current nonce. A party
 *     consents by sending the transaction, or by a signature: ERC-1271 for an
 *     address with code, ECDSA with a low `s` for an EOA.
 *   - Only the assignee funds and tops up, as `msg.sender`, within the
 *     assignment's one limit, the most a period may cost, its top-ups
 *     included, as stored at that block. Both service classes are allowed. A
 *     publishing agent registration never grants service spending, and an
 *     assignment never grants publishing.
 *   - Every funding and top-up is refused while `QueryInferenceStorage` is
 *     paused, before its activation epoch and while that is unset, as wallet
 *     fundings are: epochs close from activation on, so a cost due in an
 *     earlier epoch would never reach a pool. Every funding needs a non-zero
 *     session key.
 *   - Service spending refuses to start, and funding refuses to run, while a
 *     protocol treasury is wired: a service draw carries no treasury fee.
 *   - An account that `PublishingConviction` 10.0.8 or 10.1.0 scheduled in
 *     full cannot switch service spending on, and its draws are refused
 *     (`EmissionAlreadyScheduled`): its base allowance is already the staker
 *     pool's.
 */
contract ServiceSubscriptions is
    INamed,
    IVersioned,
    ContractStatus,
    IInitializable,
    IPublishingConvictionErrors,
    IConvictionServiceErrors,
    IServicePeriodFunding
{
    string private constant _NAME = "ServiceSubscriptions";
    // Version history:
    //   1.0.0 — Conviction Account service spending (OT-RFC-27): the owner's
    //           opt-in, two-party consent to an assignment with cost caps, the
    //           owner's cap updates and revocation, period funding through
    //           `PublishingConviction.coverServiceCost`, and the labels.
    //   1.1.0 — a period is one epoch, the current one or the next, one per
    //           buyer key and epoch; an assignment holds one cost limit per
    //           period and an expiry; top-ups and upgrades within the period
    //           (`topUpFromConviction`); a non-zero session key; no funding
    //           or top-up while `QueryInferenceStorage` is paused; no funding
    //           or top-up of a period whose assignment expires before the
    //           period starts.
    //   1.2.0 — a Conviction Account pays as a wallet does: each funding and
    //           top-up books its cost as due in the epoch after the period
    //           (`QueryInferenceStorage.addConvictionDue`), and both are
    //           refused before the activation epoch. The labels are gone
    //           (`_labelBase`, `_labelTopUp`, their basis and cursor, the
    //           `ServiceEmissionLabelled` event, `LabelCapacityExceeded`, and
    //           the views `scheduledEmission`, `emissionSpan` and
    //           `baseLabelCapacity`), and with them the schedule cut-over the
    //           opt-in needed (`ExactScheduleFromUnset`). The opt-in refuses an
    //           account scheduled in full (`EmissionAlreadyScheduled`).
    string private constant _VERSION = "1.2.0";

    uint256 public constant BPS_DENOMINATOR = 10_000;

    // EIP-712, built by hand as KnowledgeAssetsLifecycle builds its domain.
    bytes32 private constant _EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant _EIP712_NAME_HASH = keccak256(bytes("DKGConvictionServices"));
    bytes32 private constant _EIP712_VERSION_HASH = keccak256(bytes("1"));
    bytes32 public constant SERVICE_ASSIGNMENT_TYPEHASH =
        keccak256("ServiceAssignment(uint256 accountId,address assignee,uint96 maxCostPerPeriod,uint40 expiresAt,uint64 nonce)");
    /// @dev `bytes4(keccak256("isValidSignature(bytes32,bytes)"))`.
    bytes4 private constant _ERC1271_MAGIC_VALUE = 0x1626ba7e;
    /// @dev floor(secp256k1n / 2). An EOA signature with a larger `s` is the
    ///      malleated twin of a low-`s` one and is refused; solady's recovery
    ///      does not check this itself.
    uint256 private constant _SECP256K1_HALF_N = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;

    // ============================================================
    //                          Inputs
    // ============================================================

    /// @notice The terms both parties consent to. They are the EIP-712
    ///         `ServiceAssignment` message. The limit is in COST, TRAC wei
    ///         drawn from the account's allowance after its discount.
    struct AssignmentTerms {
        uint256 accountId;
        address assignee;
        uint96 maxCostPerPeriod; // the most one period may cost, its top-ups included
        uint40 expiresAt;
        uint64 nonce; // the account's current assignment nonce
    }

    /// @notice A buyer key's request to fund one plan period from an account.
    ///         The buckets have the shape `IServicePeriodFunding.BucketInput`.
    struct FundingRequest {
        uint256 accountId;
        uint256 epoch; // the period's epoch: the current one or the next
        address sessionKey; // the buyer's request-signing key; never zero
        bytes32 planDigest; // the buyer's commitment to its plan, opaque here
        BucketInput[] buckets; // 1 to maxBucketsPerPeriod, strictly increasing bucketId
    }

    // ============================================================
    //                  Hub-wired dependencies
    // ============================================================

    PublishingConvictionStorage public publishingConvictionStorage;
    ConvictionServiceStorage public convictionServiceStorage;
    Chronos public chronos;
    ParametersStorage public parametersStorage;
    QueryInferenceStorage public queryInferenceStorage;

    // ============================================================
    //                          Events
    // ============================================================

    event ServiceSpendingSet(uint256 indexed accountId, bool enabled);
    /// @notice A new assignment, with the terms both parties consented to.
    ///         `termsDigest` is the EIP-712 digest they consented over, and
    ///         `nonce` the account nonce it consumed.
    event ServiceAssigned(
        uint256 indexed accountId,
        address indexed assignee,
        bytes32 termsDigest,
        uint96 maxCostPerPeriod,
        uint40 expiresAt,
        uint64 nonce
    );
    event ServiceRevoked(uint256 indexed accountId, address indexed assignee);
    /// @notice The owner replaced an assignment's limit and expiry. Its usage
    ///         and nonce are unchanged.
    event CapsUpdated(
        uint256 indexed accountId,
        address indexed assignee,
        uint96 maxCostPerPeriod,
        uint40 expiresAt
    );
    /// @notice The account's assignment nonce moved: the next assignment must
    ///         carry `nextNonce`, so terms signed at an older nonce no longer
    ///         assign.
    event AssignmentNonceAdvanced(uint256 indexed accountId, uint64 nextNonce);

    // ============================================================
    //                          Errors
    // ============================================================

    error NotAccountOwner(uint256 accountId, address caller);
    error ServiceSpendingDisabled(uint256 accountId);
    error ServiceSpendingUnchanged(uint256 accountId, bool enabled);
    error InvalidAssignmentTerms(string reason);
    error InvalidAssignmentNonce(uint256 accountId, uint64 expected, uint64 provided);
    error ConsentMissing(address party);
    error InvalidConsentSignature(address party);
    error NotAssigned(uint256 accountId, address assignee);
    error AssignmentRevoked(uint256 accountId, address assignee);
    error AssignmentExpired(uint256 accountId, address assignee);
    /// @notice The assignment expires at or before the start of the period,
    ///         which it could then never serve: no request issued in the
    ///         period would be from a live assignment, and a period is
    ///         non-refundable.
    error AssignmentEndsBeforePeriod(uint256 accountId, address assignee, uint40 expiresAt, uint40 periodStart);
    error CapsUnchanged(uint256 accountId, address assignee);
    error CapExceeded(string cap, uint256 limit, uint256 attempted);
    error DrawMismatch(uint96 expectedCost, uint96 cost, uint40 expectedWindow, uint40 window);

    // solhint-disable-next-line no-empty-blocks
    constructor(address hubAddress) ContractStatus(hubAddress) {}

    /// @dev Wires the dependencies that are not looked up on every call. The
    ///      Hub reverts `ContractDoesNotExist` for a name it does not hold.
    function initialize() external onlyHub {
        publishingConvictionStorage = PublishingConvictionStorage(
            hub.getContractAddress("PublishingConvictionStorage")
        );
        convictionServiceStorage = ConvictionServiceStorage(hub.getContractAddress("ConvictionServiceStorage"));
        chronos = Chronos(hub.getContractAddress("Chronos"));
        parametersStorage = ParametersStorage(hub.getContractAddress("ParametersStorage"));
        queryInferenceStorage = QueryInferenceStorage(hub.getContractAddress("QueryInferenceStorage"));
    }

    function name() external pure virtual override returns (string memory) {
        return _NAME;
    }

    function version() external pure virtual override returns (string memory) {
        return _VERSION;
    }

    // ============================================================
    //                       Owner actions
    // ============================================================

    /**
     * @notice Switch service spending on or off for `accountId`. Owner only.
     * @dev Switching on needs no protocol treasury wired, an unexpired
     *      account, and one that pays at use time: an account that
     *      `PublishingConviction` 10.0.8 or 10.1.0 scheduled in full
     *      (`lastSettledWindow` at the lock while it is live) reverts
     *      `EmissionAlreadyScheduled`, as each of its draws would.
     *      Switching off is a pause: assignments are kept, and funded periods
     *      run to their end.
     */
    function setServiceSpending(uint256 accountId, bool enabled) external {
        _requireOwner(accountId);
        ConvictionServiceStorage css = convictionServiceStorage;
        bool isOn = css.serviceSpendingEnabledAt(accountId) != 0;

        if (enabled) {
            _requireNoTreasury();
            PublishingConvictionStorage.Account memory acct = publishingConvictionStorage.getAccount(accountId);
            if (block.timestamp >= uint256(acct.expiresAtTimestamp)) {
                revert AccountExpired(accountId, acct.expiresAtEpoch);
            }
            if (acct.lastSettledWindow >= acct.lockDurationEpochs) revert EmissionAlreadyScheduled(accountId);
            if (isOn) revert ServiceSpendingUnchanged(accountId, true);

            css.setServiceSpendingEnabledAt(accountId, SafeCast.toUint40(block.timestamp));
        } else {
            if (!isOn) revert ServiceSpendingUnchanged(accountId, false);
            css.setServiceSpendingEnabledAt(accountId, 0);
        }

        emit ServiceSpendingSet(accountId, enabled);
    }

    /**
     * @notice Assign bounded plan-funding authority over `t.accountId` to
     *         `t.assignee`, with the consent of the current owner and of the
     *         assignee over the same EIP-712 digest (`hashAssignment(t)`).
     * @dev Anyone may submit. A party consents by sending the transaction, in
     *      which case its signature argument must be empty, or by a signature
     *      over the digest. The assignment replaces any earlier one of the
     *      same assignee and starts its usage from zero. It consumes the
     *      account's nonce, so the same terms never assign twice.
     */
    function assign(
        AssignmentTerms calldata t,
        bytes calldata ownerSignature,
        bytes calldata assigneeSignature
    ) external {
        ConvictionServiceStorage css = convictionServiceStorage;
        if (css.serviceSpendingEnabledAt(t.accountId) == 0) revert ServiceSpendingDisabled(t.accountId);

        if (t.assignee == address(0)) revert InvalidAssignmentTerms("assignee");
        _validateCaps(
            ConvictionServiceStorage.AssignmentCaps({maxCostPerPeriod: t.maxCostPerPeriod, expiresAt: t.expiresAt})
        );

        uint64 expected = css.assignmentNonce(t.accountId);
        if (t.nonce != expected) revert InvalidAssignmentNonce(t.accountId, expected, t.nonce);

        bytes32 digest = hashAssignment(t);
        _requireConsent(_nft().ownerOf(t.accountId), digest, ownerSignature);
        _requireConsent(t.assignee, digest, assigneeSignature);

        uint64 used = css.consumeAssignmentNonce(t.accountId);
        css.setAssignment(
            t.accountId,
            t.assignee,
            ConvictionServiceStorage.Assignment({
                maxCostPerPeriod: t.maxCostPerPeriod,
                assignedAt: SafeCast.toUint40(block.timestamp),
                expiresAt: t.expiresAt,
                revokedAt: 0,
                nonce: used
            })
        );

        emit ServiceAssigned(t.accountId, t.assignee, digest, t.maxCostPerPeriod, t.expiresAt, used);
        emit AssignmentNonceAdvanced(t.accountId, used + 1);
    }

    /**
     * @notice Revoke `assignee`'s assignment over `accountId`. Owner only.
     * @dev Immediate for new periods; funded periods are non-refundable and
     *      run to their end. It also consumes the account's nonce, so terms
     *      signed but not yet submitted no longer assign.
     */
    function revoke(uint256 accountId, address assignee) external {
        _requireOwner(accountId);
        ConvictionServiceStorage css = convictionServiceStorage;
        ConvictionServiceStorage.Assignment memory a = css.getAssignment(accountId, assignee);
        if (a.assignedAt == 0) revert NotAssigned(accountId, assignee);
        if (a.revokedAt != 0) revert AssignmentRevoked(accountId, assignee);

        css.setAssignmentRevokedAt(accountId, assignee, SafeCast.toUint40(block.timestamp));
        uint64 used = css.consumeAssignmentNonce(accountId);

        emit ServiceRevoked(accountId, assignee);
        emit AssignmentNonceAdvanced(accountId, used + 1);
    }

    /**
     * @notice Replace the limit and the expiry of `assignee`'s live assignment
     *         over `accountId`. Owner only, at any time, whether service
     *         spending is on or off.
     * @dev The limit bounds only what the owner lets the buyer key draw, and
     *      obliges the buyer to nothing, so a change in either direction needs
     *      no consent from the assignee. The usage, `assignedAt`, the
     *      assignment's nonce and the account's nonce stay as they are. A
     *      limit below a period's cost so far is allowed, and refuses every
     *      top-up of that period. An expired assignment is renewed only by a
     *      new `assign`, so a later `expiresAt` here never revives one. Terms
     *      signed at the current nonce stay valid; an owner who tightens the
     *      limit and wants to rule them out also calls
     *      `advanceAssignmentNonce`.
     */
    function updateAssignmentCaps(
        uint256 accountId,
        address assignee,
        ConvictionServiceStorage.AssignmentCaps calldata caps
    ) external {
        _requireOwner(accountId);
        ConvictionServiceStorage css = convictionServiceStorage;
        ConvictionServiceStorage.Assignment memory a = _liveAssignment(css, accountId, assignee);
        _validateCaps(caps);
        if (caps.maxCostPerPeriod == a.maxCostPerPeriod && caps.expiresAt == a.expiresAt) {
            revert CapsUnchanged(accountId, assignee);
        }

        css.setAssignmentCaps(accountId, assignee, caps);

        emit CapsUpdated(accountId, assignee, caps.maxCostPerPeriod, caps.expiresAt);
    }

    /// @notice Advance `accountId`'s assignment nonce, so terms signed at the
    ///         current nonce and not yet submitted no longer assign. Owner only.
    function advanceAssignmentNonce(uint256 accountId) external {
        _requireOwner(accountId);
        uint64 used = convictionServiceStorage.consumeAssignmentNonce(accountId);
        emit AssignmentNonceAdvanced(accountId, used + 1);
    }

    // ============================================================
    //                       Buyer actions
    // ============================================================

    /**
     * @notice Fund the plan period of `r.epoch` from `r.accountId`'s
     *         allowance, as the assignee (`msg.sender`). Atomic: every refusal
     *         reverts the whole transaction, so nothing is ever funded
     *         partially.
     * @dev The cheap, read-only refusals come first: the pause and the
     *      activation, the session key, the period's epoch, the opt-in and the
     *      assignment, which must not expire before the period starts (a
     *      period funded ahead for the next epoch would otherwise serve
     *      nothing), the buckets, one period per buyer key and epoch, and the
     *      assignment's limit as stored at this block. A revoked assignment
     *      funds nothing, so only the expiry can be checked ahead. Then
     *      `coverServiceCost` draws the cost (window allowance first, then the
     *      top-up buffer); a period funded ahead draws from the window the
     *      funding runs in. Last, the usage, the cost due in the epoch after
     *      the period and the period record are written.
     *
     *      The period runs to the start of the next epoch, from the later of
     *      the block time and its epoch's start, which is never 0, and an id
     *      that already holds a record is refused, so the storage never
     *      receives a record that reads as absent nor a second record under
     *      one id.
     * @return subscriptionId `subscriptionIdOf(msg.sender, r.epoch)`.
     * @return cost The cost drawn from the allowance.
     */
    function fundFromConviction(FundingRequest calldata r) external returns (bytes32 subscriptionId, uint96 cost) {
        ConvictionServiceStorage css = convictionServiceStorage;
        QueryInferenceStorage qis = queryInferenceStorage;
        address assignee = msg.sender;

        // 1. Funding is live, a session key, and the period of the current
        //    epoch or the next one.
        uint256 currentEpoch = ServicePeriodLib.requireLive(qis, chronos);
        if (r.sessionKey == address(0)) revert ZeroSessionKey();
        (uint40 periodStart, uint40 periodEnd) = ServicePeriodLib.periodOf(chronos, r.epoch, currentEpoch);

        // 2. The opt-in and a live assignment, still live when the period
        //    starts.
        if (css.serviceSpendingEnabledAt(r.accountId) == 0) revert ServiceSpendingDisabled(r.accountId);
        ConvictionServiceStorage.Assignment memory a = _liveAssignment(css, r.accountId, assignee);
        _requireLiveAtStart(r.accountId, assignee, a, periodStart);

        // 3. The buckets and their value.
        (ConvictionServiceStorage.Bucket[] memory buckets, uint96 value) = ServicePeriodLib.fundingBuckets(
            r.buckets,
            css.maxBucketsPerPeriod()
        );

        // 4. One period per buyer key and epoch.
        subscriptionId = ServicePeriodLib.subscriptionIdOf(assignee, r.epoch);
        if (css.subscriptionExists(subscriptionId)) revert PeriodAlreadyFunded(subscriptionId);

        // 5. The cost at the account's tier, within the limit stored at this
        //    block.
        PublishingConvictionStorage.Account memory acct = publishingConvictionStorage.getAccount(r.accountId);
        cost = _discounted(value, acct.discountBps);
        if (cost > a.maxCostPerPeriod) revert CapExceeded("maxCostPerPeriod", a.maxCostPerPeriod, cost);

        // 6. The draw.
        PublishingConviction.ServiceDraw memory d = _draw(
            r.accountId,
            assignee,
            subscriptionId,
            value,
            cost,
            _currentBillingWindow(acct, chronos.epochLength())
        );

        // 7. The usage, and the cost due in the epoch after the period, as a
        //    wallet funding books its value.
        css.recordUsage(r.accountId, assignee);
        qis.addConvictionDue(r.epoch + 1, d.cost);

        // 8. The record. The period id is the period's epoch.
        css.createSubscription(
            subscriptionId,
            ConvictionServiceStorage.Subscription({
                accountId: r.accountId,
                assignee: assignee,
                sessionKey: r.sessionKey,
                periodId: bytes32(r.epoch),
                planDigest: r.planDigest,
                periodStart: periodStart,
                periodEnd: periodEnd,
                fundedEpoch: d.epoch,
                fundedWindow: d.window,
                discountBps: d.discountBps,
                bucketCount: uint8(buckets.length),
                value: value,
                cost: d.cost,
                drawnFromWindow: d.drawnFromWindow,
                drawnFromTopUp: d.drawnFromTopUp
            }),
            buckets
        );

        // 9.
        emit PeriodFunded(
            subscriptionId,
            r.accountId,
            assignee,
            r.epoch,
            r.sessionKey,
            r.planDigest,
            periodStart,
            periodEnd,
            value,
            d.cost,
            d.discountBps,
            r.buckets
        );
    }

    /**
     * @notice Top up or upgrade a period funded from a Conviction Account, as
     *         the buyer key that funded it: add value to its buckets, or add
     *         buckets. Atomic, as a funding is.
     * @dev Refused while paused or before the activation epoch, and unless the
     *      period was funded from an account by `msg.sender` and has not
     *      ended. An addition to a stored bucket repeats its class and price
     *      cap, which never change within a period; a new bucket is appended
     *      under the funding rules. The opt-in, a live assignment that does not
     *      expire before the period starts, and its limit are checked as for a
     *      funding, the limit against the period's cost with this top-up added.
     *      The draw and the cost due in the epoch after the period follow as
     *      for a funding, at the account's own tier; a top-up funds no new
     *      period, so the usage is unchanged.
     * @return cost The cost drawn from the allowance.
     */
    function topUpFromConviction(
        bytes32 subscriptionId,
        BucketInput[] calldata additions,
        bytes32 planDigest
    ) external returns (uint96 cost) {
        ConvictionServiceStorage css = convictionServiceStorage;
        QueryInferenceStorage qis = queryInferenceStorage;
        address assignee = msg.sender;

        // 1. Funding is live, and the period is open to this top-up.
        ServicePeriodLib.requireLive(qis, chronos);
        ConvictionServiceStorage.Subscription memory s = css.getSubscription(subscriptionId);
        ServicePeriodLib.requireTopUpOpen(subscriptionId, s, assignee, true);

        // 2. The opt-in and a live assignment, still live when the period
        //    starts.
        if (css.serviceSpendingEnabledAt(s.accountId) == 0) revert ServiceSpendingDisabled(s.accountId);
        ConvictionServiceStorage.Assignment memory a = _liveAssignment(css, s.accountId, assignee);
        _requireLiveAtStart(s.accountId, assignee, a, s.periodStart);

        // 3. The additions, merged into the stored buckets.
        ServicePeriodLib.TopUp memory t = ServicePeriodLib.mergeTopUp(
            css.getBuckets(subscriptionId),
            additions,
            css.maxBucketsPerPeriod(),
            s.value
        );

        // 4. The cost at the account's tier, and the period's cost with it
        //    within the limit stored at this block.
        PublishingConvictionStorage.Account memory acct = publishingConvictionStorage.getAccount(s.accountId);
        cost = _discounted(t.value, acct.discountBps);
        uint256 periodCost = uint256(s.cost) + cost;
        if (periodCost > a.maxCostPerPeriod) revert CapExceeded("maxCostPerPeriod", a.maxCostPerPeriod, periodCost);

        // 5. The draw.
        PublishingConviction.ServiceDraw memory d = _draw(
            s.accountId,
            assignee,
            subscriptionId,
            t.value,
            cost,
            _currentBillingWindow(acct, chronos.epochLength())
        );

        // 6. The cost due in the epoch after the period, and the record.
        qis.addConvictionDue(ServicePeriodLib.epochOf(s) + 1, d.cost);
        css.applyTopUp(
            subscriptionId,
            ConvictionServiceStorage.TopUpAmounts({
                value: t.value,
                cost: d.cost,
                drawnFromWindow: d.drawnFromWindow,
                drawnFromTopUp: d.drawnFromTopUp
            }),
            planDigest,
            t.added,
            t.appended
        );

        // 7.
        emit PeriodToppedUp(subscriptionId, s.accountId, assignee, t.value, d.cost, planDigest, additions);
    }

    // ============================================================
    //                           Views
    // ============================================================

    /// @notice The EIP-712 domain separator: name `DKGConvictionServices`,
    ///         version `1`, this chain and this contract.
    function domainSeparator() public view returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    _EIP712_DOMAIN_TYPEHASH,
                    _EIP712_NAME_HASH,
                    _EIP712_VERSION_HASH,
                    block.chainid,
                    address(this)
                )
            );
    }

    /// @notice The EIP-712 digest of `ServiceAssignment` terms, which the
    ///         owner and the assignee consent to.
    function hashAssignment(AssignmentTerms calldata t) public view returns (bytes32 digest) {
        bytes32 structHash = keccak256(
            abi.encode(SERVICE_ASSIGNMENT_TYPEHASH, t.accountId, t.assignee, t.maxCostPerPeriod, t.expiresAt, t.nonce)
        );
        digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }

    /// @notice The id of the period `assignee` funds for `epoch`:
    ///         `keccak256(abi.encode(assignee, epoch))`, one per buyer key and
    ///         epoch, for a period funded from an account or from a wallet.
    function subscriptionIdOf(address assignee, uint256 epoch) public pure returns (bytes32) {
        return ServicePeriodLib.subscriptionIdOf(assignee, epoch);
    }

    /// @notice The cost of a bucket value at the account's discount tier:
    ///         `value × (10000 − discountBps) / 10000`, at least 1 wei for a
    ///         non-zero value, as publishing computes it.
    function previewCost(uint256 accountId, uint96 value) public view returns (uint96 cost, uint16 discountBps) {
        discountBps = publishingConvictionStorage.getAccount(accountId).discountBps;
        cost = _discounted(value, discountBps);
    }

    /**
     * @notice The account's allowance in the billing window that contains the
     *         block time.
     * @return window The billing window of `block.timestamp`, capped at the
     *         lock (the number of windows).
     * @return baseRemaining The window's base allowance not yet drawn, and 0
     *         once the account has expired.
     * @return topUpBuffer The top-up buffer.
     * @return expired Whether the account has expired.
     * @dev Unlike `PublishingConviction.getRemainingAllowance`, it does not map
     *      the start of a chain epoch to a billing window: for an account
     *      created mid-epoch that start can lie in the previous window.
     */
    function currentWindowAllowance(
        uint256 accountId
    ) external view returns (uint40 window, uint96 baseRemaining, uint96 topUpBuffer, bool expired) {
        PublishingConvictionStorage pcs = publishingConvictionStorage;
        PublishingConvictionStorage.Account memory acct = pcs.getAccount(accountId);
        uint40 lock = uint40(acct.lockDurationEpochs);
        window = _currentBillingWindow(acct, chronos.epochLength());
        if (window > lock) window = lock;
        expired = block.timestamp >= uint256(acct.expiresAtTimestamp);
        if (!expired) {
            uint96 baseAllowance = acct.committedTRAC / uint96(lock);
            uint96 spent = pcs.windowSpent(accountId, window);
            baseRemaining = spent < baseAllowance ? baseAllowance - spent : 0;
        }
        topUpBuffer = pcs.topUpBalance(accountId);
    }

    // ============================================================
    //                         Internal
    // ============================================================

    /// @dev A limit above 0, and an expiry after the block time.
    function _validateCaps(ConvictionServiceStorage.AssignmentCaps memory c) internal view {
        if (c.maxCostPerPeriod == 0) revert InvalidAssignmentTerms("maxCostPerPeriod");
        if (c.expiresAt <= block.timestamp) revert InvalidAssignmentTerms("expiresAt");
    }

    /// @dev A live assignment exists, is not revoked and has not expired.
    function _liveAssignment(
        ConvictionServiceStorage css,
        uint256 accountId,
        address assignee
    ) internal view returns (ConvictionServiceStorage.Assignment memory a) {
        a = css.getAssignment(accountId, assignee);
        if (a.assignedAt == 0) revert NotAssigned(accountId, assignee);
        if (a.revokedAt != 0) revert AssignmentRevoked(accountId, assignee);
        if (block.timestamp >= uint256(a.expiresAt)) revert AssignmentExpired(accountId, assignee);
    }

    /// @dev The assignment does not expire at or before the period's start. A
    ///      live assignment has not expired at the block time, so this only
    ///      ever refuses a period that starts later: one funded ahead for the
    ///      next epoch, or topped up before it starts.
    function _requireLiveAtStart(
        uint256 accountId,
        address assignee,
        ConvictionServiceStorage.Assignment memory a,
        uint40 periodStart
    ) internal pure {
        if (a.expiresAt <= periodStart) {
            revert AssignmentEndsBeforePeriod(accountId, assignee, a.expiresAt, periodStart);
        }
    }

    /**
     * @dev Draw `value` through `coverServiceCost`, which must return the cost
     *      and the window computed here, or the funding reverts
     *      `DrawMismatch`. The caller books `d.cost`, the whole draw.
     */
    function _draw(
        uint256 accountId,
        address assignee,
        bytes32 subscriptionId,
        uint96 value,
        uint96 cost,
        uint40 window
    ) internal returns (PublishingConviction.ServiceDraw memory d) {
        d = _publishingConviction().coverServiceCost(accountId, assignee, subscriptionId, value);
        if (d.cost != cost || d.window != window) revert DrawMismatch(cost, d.cost, window, d.window);
    }

    /**
     * @dev Consent of `party` to `digest`, in exactly one of two ways: by
     *      sending the transaction, with an empty signature, or by signing.
     *      An address with code answers ERC-1271 in a staticcall, and a revert
     *      or any other answer than the magic value is a bad signature. An EOA
     *      signature, 65 bytes `(r, s, v)` or 64 bytes `(r, vs)`, must recover
     *      to `party` with a low `s`.
     */
    function _requireConsent(address party, bytes32 digest, bytes calldata signature) internal view {
        if (msg.sender == party) {
            if (signature.length != 0) revert InvalidConsentSignature(party);
            return;
        }
        if (signature.length == 0) revert ConsentMissing(party);
        bool valid = party.code.length != 0
            ? _isValidERC1271Signature(party, digest, signature)
            : _isValidEOASignature(party, digest, signature);
        if (!valid) revert InvalidConsentSignature(party);
    }

    function _isValidERC1271Signature(
        address party,
        bytes32 digest,
        bytes calldata signature
    ) internal view returns (bool) {
        (bool success, bytes memory result) = party.staticcall(
            abi.encodeCall(IERC1271.isValidSignature, (digest, signature))
        );
        return success && result.length >= 32 && abi.decode(result, (bytes32)) == bytes32(_ERC1271_MAGIC_VALUE);
    }

    function _isValidEOASignature(address party, bytes32 digest, bytes calldata signature) internal view returns (bool) {
        uint256 s;
        if (signature.length == 65) {
            s = uint256(bytes32(signature[32:64]));
        } else if (signature.length == 64) {
            s = uint256(bytes32(signature[32:64])) & ((uint256(1) << 255) - 1);
        } else {
            return false;
        }
        if (s > _SECP256K1_HALF_N) return false;
        address recovered = ECDSA.tryRecoverCalldata(digest, signature);
        return recovered != address(0) && recovered == party;
    }

    function _requireOwner(uint256 accountId) internal view {
        if (_nft().ownerOf(accountId) != msg.sender) revert NotAccountOwner(accountId, msg.sender);
    }

    function _requireNoTreasury() internal view {
        address treasury = parametersStorage.protocolTreasury();
        if (treasury != address(0)) revert ServiceFundingPausedTreasuryWired(treasury);
    }

    function _discounted(uint96 value, uint16 discountBps) internal pure returns (uint96 cost) {
        cost = uint96((uint256(value) * (BPS_DENOMINATOR - uint256(discountBps))) / BPS_DENOMINATOR);
        if (cost == 0 && value > 0) cost = 1;
    }

    /// @dev The billing window of the block time, uncapped, as
    ///      `PublishingConviction` computes it for a draw.
    function _currentBillingWindow(
        PublishingConvictionStorage.Account memory acct,
        uint256 epLen
    ) internal view returns (uint40) {
        if (block.timestamp <= uint256(acct.createdAtTimestamp)) return 0;
        return uint40((block.timestamp - uint256(acct.createdAtTimestamp)) / epLen);
    }

    function _nft() internal view returns (IERC721) {
        return IERC721(hub.getContractAddress("DKGPublishingConvictionNFT"));
    }

    function _publishingConviction() internal view returns (PublishingConviction) {
        return PublishingConviction(hub.getContractAddress("PublishingConviction"));
    }
}
