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
import {ConvictionScheduleLib} from "./libraries/ConvictionScheduleLib.sol";
import {PublishingMathLib} from "./libraries/PublishingMathLib.sol";
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
 * A funded period moves no TRAC. `PublishingConviction.coverServiceCost`
 * draws the cost from the account's allowance exactly as a publish does (the
 * current billing window first, then the top-up buffer, at the account's
 * discount tier), and this contract records the cost as service-labelled
 * emission against the account's own scheduled staker emission:
 *   - the part drawn from the window allowance is labelled against the base
 *     schedule written at account creation, nearest epochs first from the
 *     current epoch, and never above what the account emits in an epoch;
 *   - the part drawn from the top-up buffer is labelled as exactly the
 *     forward emission that draw credited.
 * The labels say which part of each epoch's staker emission services funded.
 * They change no payout by themselves.
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
 *     paused, and every funding needs a non-zero session key.
 *   - Service spending refuses to start, and funding refuses to run, while a
 *     protocol treasury is wired: an account scheduled while a treasury is
 *     wired emits to stakers net of a fee no storage records, which the label
 *     basis could not rebuild.
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
    //           or top-up while `QueryInferenceStorage` is paused.
    string private constant _VERSION = "1.1.0";

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
    /// @notice `amount` of a period's cost was labelled as service-funded
    ///         emission in epochs `fromEpoch` to `toEpoch`: against the base
    ///         schedule, or, when `fromTopUp`, as the top-up overflow's own
    ///         emission.
    event ServiceEmissionLabelled(
        uint256 indexed accountId,
        uint40 fromEpoch,
        uint40 toEpoch,
        uint96 amount,
        bytes32 indexed subscriptionId,
        bool fromTopUp
    );

    // ============================================================
    //                          Errors
    // ============================================================

    error NotAccountOwner(uint256 accountId, address caller);
    error ServiceSpendingDisabled(uint256 accountId);
    error ServiceSpendingUnchanged(uint256 accountId, bool enabled);
    error ExactScheduleFromUnset();
    error InvalidAssignmentTerms(string reason);
    error InvalidAssignmentNonce(uint256 accountId, uint64 expected, uint64 provided);
    error ConsentMissing(address party);
    error InvalidConsentSignature(address party);
    error NotAssigned(uint256 accountId, address assignee);
    error AssignmentRevoked(uint256 accountId, address assignee);
    error AssignmentExpired(uint256 accountId, address assignee);
    error CapsUnchanged(uint256 accountId, address assignee);
    error CapExceeded(string cap, uint256 limit, uint256 attempted);
    error LabelCapacityExceeded(uint256 accountId, uint96 unplaced);
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
     * @dev Switching on needs the schedule cut-over to be set, no protocol
     *      treasury wired and an unexpired account. It first brings the
     *      account's emission schedule current through the permissionless
     *      `PublishingConviction.settle`, which writes the schedule of an
     *      account created before scheduling at creation existed, so a
     *      schedule always exists before a service draw. For an unexpired
     *      account whose schedule is written (`lastSettledWindow` at the lock,
     *      the marker `settle` itself checks), `settle` changes nothing, and
     *      the call is skipped.
     *      Switching off is a pause: assignments are kept, and funded periods
     *      run to their end.
     */
    function setServiceSpending(uint256 accountId, bool enabled) external {
        _requireOwner(accountId);
        ConvictionServiceStorage css = convictionServiceStorage;
        bool isOn = css.serviceSpendingEnabledAt(accountId) != 0;

        if (enabled) {
            if (css.exactScheduleFrom() == 0) revert ExactScheduleFromUnset();
            _requireNoTreasury();
            PublishingConvictionStorage.Account memory acct = publishingConvictionStorage.getAccount(accountId);
            if (block.timestamp >= uint256(acct.expiresAtTimestamp)) {
                revert AccountExpired(accountId, acct.expiresAtEpoch);
            }
            if (isOn) revert ServiceSpendingUnchanged(accountId, true);

            if (acct.lastSettledWindow < acct.lockDurationEpochs) _publishingConviction().settle(accountId);
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
     * @dev The cheap, read-only refusals come first: the pause, the session
     *      key, the period's epoch, the opt-in and the assignment, the
     *      buckets, one period per buyer key and epoch, and the assignment's
     *      limit as stored at this block. Then `coverServiceCost` draws the
     *      cost (window allowance first, then the top-up buffer) and the cost
     *      is labelled: the window part against the account's base schedule,
     *      nearest epochs first from the current epoch, the top-up part as the
     *      emission its draw made. A period funded ahead draws and labels from
     *      the window and the epoch the funding runs in. Last, the usage and
     *      the period record are written.
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
        address assignee = msg.sender;

        // 1. Not paused, a session key, and the period of the current epoch or
        //    the next one.
        ServicePeriodLib.requireNotPaused(queryInferenceStorage);
        if (r.sessionKey == address(0)) revert ZeroSessionKey();
        (uint40 periodStart, uint40 periodEnd) = ServicePeriodLib.periodOf(
            chronos,
            r.epoch,
            chronos.getCurrentEpoch()
        );

        // 2. The opt-in and a live assignment.
        if (css.serviceSpendingEnabledAt(r.accountId) == 0) revert ServiceSpendingDisabled(r.accountId);
        ConvictionServiceStorage.Assignment memory a = _liveAssignment(css, r.accountId, assignee);

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

        // 6. The draw and its labels.
        uint256 epLen = chronos.epochLength();
        PublishingConviction.ServiceDraw memory d = _drawAndLabel(
            css,
            r.accountId,
            assignee,
            subscriptionId,
            value,
            cost,
            _currentBillingWindow(acct, epLen),
            acct,
            epLen
        );

        // 7. The usage.
        css.recordUsage(r.accountId, assignee);

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
     * @dev Refused while paused, and unless the period was funded from an
     *      account by `msg.sender` and has not ended. An addition to a stored
     *      bucket repeats its class and price cap, which never change within a
     *      period; a new bucket is appended under the funding rules. The
     *      opt-in, a live assignment and its limit are checked as for a
     *      funding, the limit against the period's cost with this top-up
     *      added. The draw and the labels follow as for a funding, at the
     *      account's own tier; a top-up funds no new period, so the usage is
     *      unchanged.
     * @return cost The cost drawn from the allowance.
     */
    function topUpFromConviction(
        bytes32 subscriptionId,
        BucketInput[] calldata additions,
        bytes32 planDigest
    ) external returns (uint96 cost) {
        ConvictionServiceStorage css = convictionServiceStorage;
        address assignee = msg.sender;

        // 1. Not paused, and the period is open to this top-up.
        ServicePeriodLib.requireNotPaused(queryInferenceStorage);
        ConvictionServiceStorage.Subscription memory s = css.getSubscription(subscriptionId);
        ServicePeriodLib.requireTopUpOpen(subscriptionId, s, assignee, true);

        // 2. The opt-in and a live assignment.
        if (css.serviceSpendingEnabledAt(s.accountId) == 0) revert ServiceSpendingDisabled(s.accountId);
        ConvictionServiceStorage.Assignment memory a = _liveAssignment(css, s.accountId, assignee);

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

        // 5. The draw and its labels.
        uint256 epLen = chronos.epochLength();
        PublishingConviction.ServiceDraw memory d = _drawAndLabel(
            css,
            s.accountId,
            assignee,
            subscriptionId,
            t.value,
            cost,
            _currentBillingWindow(acct, epLen),
            acct,
            epLen
        );

        // 6. The record.
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

    /// @notice S(epoch): the account's scheduled staker emission in `epoch`,
    ///         as the labels count it (exact for an account created at or after
    ///         the cut-over, a lower bound for an older one). Reverts
    ///         `ExactScheduleFromUnset` until the cut-over is set.
    function scheduledEmission(uint256 accountId, uint256 epoch) external view returns (uint96) {
        PublishingConvictionStorage.Account memory acct = publishingConvictionStorage.getAccount(accountId);
        return ConvictionScheduleLib.emissionAt(
            _basis(convictionServiceStorage, accountId, acct, chronos.epochLength()),
            epoch
        );
    }

    /// @notice The epochs the account's base schedule emits in:
    ///         [anchor, anchor + 2·lock − 1], where the anchor is the epoch in
    ///         which its first billing window closes.
    function emissionSpan(uint256 accountId) external view returns (uint256 firstEpoch, uint256 lastEpoch) {
        PublishingConvictionStorage.Account memory acct = publishingConvictionStorage.getAccount(accountId);
        (firstEpoch, ) = _anchor(acct, chronos.epochLength());
        lastEpoch = firstEpoch + 2 * uint256(acct.lockDurationEpochs) - 1;
    }

    /// @notice The base label capacity left from the current epoch to the end
    ///         of the span: what the account's base schedule can still label.
    ///         Reverts `ExactScheduleFromUnset` until the cut-over is set.
    function baseLabelCapacity(uint256 accountId) external view returns (uint96) {
        ConvictionServiceStorage css = convictionServiceStorage;
        PublishingConvictionStorage.Account memory acct = publishingConvictionStorage.getAccount(accountId);
        ConvictionScheduleLib.Basis memory b = _basis(css, accountId, acct, chronos.epochLength());
        uint256 last = ConvictionScheduleLib.lastEpoch(b);
        uint256 capacity;
        for (
            uint256 e = _max(
                _max(css.labelCursor(accountId), chronos.getCurrentEpoch()),
                ConvictionScheduleLib.firstEpoch(b)
            );
            e <= last;
            e++
        ) {
            uint96 s = ConvictionScheduleLib.emissionAt(b, e);
            uint96 labelled = css.baseLabel(accountId, e);
            if (s > labelled) capacity += s - labelled;
        }
        return SafeCast.toUint96(capacity);
    }

    // ============================================================
    //                          Labels
    // ============================================================

    /**
     * @dev Label `amount`, the window-allowance part of a draw, against the
     *      account's base schedule: from the first epoch that may still have
     *      capacity (the cursor), the current epoch or the first epoch of the
     *      span, whichever is latest, each epoch taking at most what the
     *      account emits there less what is already labelled. The cursor moves
     *      to the first epoch that still has capacity, or past the last one
     *      scanned; epochs before it are past or full, and their capacity
     *      cannot grow, so the loop runs at most 2·lock times. Not enough
     *      capacity reverts `LabelCapacityExceeded`, and with it the funding.
     */
    function _labelBase(
        ConvictionServiceStorage css,
        uint256 accountId,
        PublishingConvictionStorage.Account memory acct,
        uint256 epLen,
        uint96 amount,
        uint40 epoch,
        bytes32 subscriptionId
    ) internal {
        if (amount == 0) return;

        ConvictionScheduleLib.Basis memory b = _basis(css, accountId, acct, epLen);
        uint256 last = ConvictionScheduleLib.lastEpoch(b);
        uint256 oldCursor = css.labelCursor(accountId);
        uint256 e = _max(_max(oldCursor, epoch), ConvictionScheduleLib.firstEpoch(b));

        uint96 remaining = amount;
        uint256 firstLabelled;
        uint256 lastLabelled;
        bool partlyFilled;
        while (remaining > 0 && e <= last) {
            uint96 s = ConvictionScheduleLib.emissionAt(b, e);
            uint96 labelled = css.baseLabel(accountId, e);
            if (s > labelled) {
                uint96 capacity = s - labelled;
                uint96 take = capacity < remaining ? capacity : remaining;
                css.addBaseLabel(accountId, e, take);
                remaining -= take;
                if (firstLabelled == 0) firstLabelled = e;
                lastLabelled = e;
                // Only the epoch that absorbs the end of `amount` can keep
                // capacity: every earlier one gave all it had.
                partlyFilled = take < capacity;
            }
            e++;
        }
        if (remaining > 0) revert LabelCapacityExceeded(accountId, remaining);

        uint256 cursor = partlyFilled ? lastLabelled : e;
        if (cursor != oldCursor) css.setLabelCursor(accountId, cursor);

        emit ServiceEmissionLabelled(
            accountId,
            uint40(firstLabelled),
            uint40(lastLabelled),
            amount,
            subscriptionId,
            false
        );
    }

    /**
     * @dev Label the top-up part of a draw as exactly the emission it made:
     *      each of the draw's staker-pool ranges, spread evenly over its
     *      epochs. The division is exact: the full-epoch range holds
     *      `base × (lock − 1)` over `lock − 1` epochs, and the other two are
     *      single epochs. EpochStorage adds its shard-wide division remainder
     *      on top, so every epoch's credit is at least its label.
     */
    function _labelTopUp(
        ConvictionServiceStorage css,
        uint256 accountId,
        PublishingConviction.ServiceDraw memory d,
        bytes32 subscriptionId
    ) internal {
        if (d.drawnFromTopUp == 0) return;

        uint256 fromEpoch = type(uint256).max;
        uint256 toEpoch;
        for (uint256 i; i < 3; i++) {
            PublishingMathLib.ActiveSinkRange memory range = d.topUpRanges[i];
            if (range.tokenAmount == 0) continue;
            uint256 start = range.startEpoch;
            uint256 end = range.endEpoch;
            uint96 perEpoch = uint96(uint256(range.tokenAmount) / (end - start + 1));
            for (uint256 e = start; e <= end; e++) {
                css.addTopUpLabel(accountId, e, perEpoch);
            }
            if (start < fromEpoch) fromEpoch = start;
            if (end > toEpoch) toEpoch = end;
        }

        emit ServiceEmissionLabelled(
            accountId,
            uint40(fromEpoch),
            uint40(toEpoch),
            d.drawnFromTopUp,
            subscriptionId,
            true
        );
    }

    /**
     * @dev The labels' basis: the account's scheduled emission per epoch,
     *      rebuilt from its stored terms. Each billing window w carries an
     *      amount R_w that the schedule spreads over the `lock` epoch lengths
     *      after the window closes:
     *        - created at or after the cut-over, the whole schedule was
     *          written at creation and R_w is the window budget B, exactly;
     *        - created earlier, a window that closed by the cut-over may have
     *          been swept as a single-epoch credit and gets 0, and any other
     *          window gets B less what publishing drew from it, a lower bound
     *          of the amount its schedule spreads;
     *        - the last window also carries the `committed mod lock` dust.
     *
     *      For an older account each R_w is then rounded down to a multiple
     *      of the lock, so that S is a lower bound in every epoch and not only
     *      in total. A window's credits are cur = floor(q·tr/E) in its first
     *      epoch, q = floor(R/L) in each full epoch, and q − cur + (R mod L) in
     *      its last. The first two never exceed those of a larger amount, but
     *      the last does when a smaller amount has the larger remainder: a
     *      window scheduled with 12 wei over a lock of 12, which publishing
     *      later lowers to 11, would otherwise count 11 wei in a last epoch
     *      that holds 1. With R mod L = 0 the last credit, q − cur, grows
     *      with q, so it never exceeds the scheduled one. The rounding gives
     *      up fewer than `lock` wei per window.
     */
    function _basis(
        ConvictionServiceStorage css,
        uint256 accountId,
        PublishingConvictionStorage.Account memory acct,
        uint256 epLen
    ) internal view returns (ConvictionScheduleLib.Basis memory) {
        uint256 cutOver = css.exactScheduleFrom();
        if (cutOver == 0) revert ExactScheduleFromUnset();

        uint256 lock = uint256(acct.lockDurationEpochs);
        (uint256 anchor, uint256 timeRemaining) = _anchor(acct, epLen);

        uint96 windowBudget = acct.committedTRAC / uint96(lock);
        uint96 dust = acct.committedTRAC - windowBudget * uint96(lock);
        uint256 createdAt = uint256(acct.createdAtTimestamp);
        bool exact = createdAt >= cutOver;

        uint96[] memory amounts = new uint96[](lock);
        for (uint256 w; w < lock; w++) {
            uint96 amount;
            if (exact) {
                amount = windowBudget;
            } else if (createdAt + (w + 1) * epLen > cutOver) {
                uint96 spent = publishingConvictionStorage.windowSpent(accountId, uint40(w));
                uint96 serviced = css.serviceSpent(accountId, uint40(w));
                uint96 published = spent > serviced ? spent - serviced : 0;
                amount = windowBudget > published ? windowBudget - published : 0;
            }
            if (w == lock - 1) amount += dust;
            if (!exact) amount -= amount % uint96(lock);
            amounts[w] = amount;
        }

        return ConvictionScheduleLib.build(anchor, lock, epLen, timeRemaining, amounts);
    }

    /// @dev The epoch in which the account's first billing window closes, and
    ///      the time left in that epoch after the close. Chronos epochs have a
    ///      fixed length, so every later window closes `w` epochs on with the
    ///      same time left.
    function _anchor(
        PublishingConvictionStorage.Account memory acct,
        uint256 epLen
    ) internal view returns (uint256 anchor, uint256 timeRemaining) {
        uint256 firstClose = uint256(acct.createdAtTimestamp) + epLen;
        anchor = chronos.epochAtTimestamp(firstClose);
        timeRemaining = chronos.timestampForEpoch(anchor + 1) - firstClose;
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

    /**
     * @dev Draw `value` through `coverServiceCost`, which must return the cost
     *      and the window computed here, then record the window part of the
     *      draw and label the cost. The window part is recorded before the
     *      labels: the label basis of an account from before the cut-over
     *      reads it.
     */
    function _drawAndLabel(
        ConvictionServiceStorage css,
        uint256 accountId,
        address assignee,
        bytes32 subscriptionId,
        uint96 value,
        uint96 cost,
        uint40 window,
        PublishingConvictionStorage.Account memory acct,
        uint256 epLen
    ) internal returns (PublishingConviction.ServiceDraw memory d) {
        d = _publishingConviction().coverServiceCost(accountId, assignee, subscriptionId, value);
        if (d.cost != cost || d.window != window) revert DrawMismatch(cost, d.cost, window, d.window);

        if (d.drawnFromWindow > 0) {
            css.increaseServiceSpent(accountId, d.window, d.drawnFromWindow);
        }
        _labelBase(css, accountId, acct, epLen, d.drawnFromWindow, d.epoch, subscriptionId);
        _labelTopUp(css, accountId, d, subscriptionId);
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

    function _max(uint256 a, uint256 b) internal pure returns (uint256) {
        return a > b ? a : b;
    }
}
