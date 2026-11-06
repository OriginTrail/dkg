// SPDX-License-Identifier: Apache-2.0

pragma solidity ^0.8.20;

import {INamed} from "./interfaces/INamed.sol";
import {IVersioned} from "./interfaces/IVersioned.sol";
import {IInitializable} from "./interfaces/IInitializable.sol";
import {IPublishingConvictionErrors} from "./interfaces/IPublishingConvictionErrors.sol";
import {IServiceSpendingErrors} from "./interfaces/IServiceSpendingErrors.sol";
import {ISubscriptionFunding} from "./interfaces/ISubscriptionFunding.sol";
import {ContractStatus} from "./abstract/ContractStatus.sol";
import {Chronos} from "./storage/Chronos.sol";
import {ParametersStorage} from "./storage/ParametersStorage.sol";
import {PublishingConvictionStorage} from "./storage/PublishingConvictionStorage.sol";
import {ServiceSubscriptionsStorage} from "./storage/ServiceSubscriptionsStorage.sol";
import {QueryInferenceStorage} from "./storage/QueryInferenceStorage.sol";
import {PublishingConviction} from "./PublishingConviction.sol";
import {SubscriptionLib} from "./libraries/SubscriptionLib.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {ECDSA} from "solady/src/utils/ECDSA.sol";

/**
 * @title ServiceSubscriptions
 * @notice Conviction Account service spending (OT-RFC-27, "NeuroSymbolic
 *         Marketplace"): the owner of a Conviction Account opts it in and adds
 *         buyers, each under a grant that the owner and the buyer both consent
 *         to. A buyer then funds subscriptions, one transaction each, from the
 *         account's existing allowance, and tops them up while they run.
 *
 * A subscription is for one chain epoch, the current one or the next, and a
 * buyer funds at most one subscription per epoch, from an account or, through
 * `ServiceSubscriptionsWallet`, from its wallet; both share one id per buyer
 * and epoch.
 *
 * A Conviction Account pays for a subscription as a wallet does (since 1.2.0).
 * A funded subscription moves no TRAC: `PublishingConviction.coverServiceCost`
 * spends the cost from the account's allowance exactly as a publish does (the
 * current billing window first, then the top-up buffer, at the account's
 * discount tier), and this contract books the whole cost in
 * `QueryInferenceStorage` under the subscription's epoch, as
 * `ServiceSubscriptionsWallet` books a wallet subscription's value: the epoch
 * in which the subscription's receipt value counts. The spend itself books
 * nothing to the staker pool, so the cost is counted once, in the
 * query/inference pool.
 *
 * Architecture (the pattern of `PublishingConviction`):
 *   - Stateless logic. Every byte of service-spending state lives in
 *     `ServiceSubscriptionsStorage` and `QueryInferenceStorage`; this contract
 *     holds only Hub-resolved references. `PublishingConvictionStorage`,
 *     `ServiceSubscriptionsStorage`, `QueryInferenceStorage`, `Chronos` and
 *     `ParametersStorage` are wired at `initialize()`. `PublishingConviction`
 *     and `DKGPublishingConvictionNFT` are resolved from the Hub on every call,
 *     so either can be re-registered.
 *   - It calls only the Hub, `PublishingConviction`,
 *     `PublishingConvictionStorage`, `ServiceSubscriptionsStorage`,
 *     `QueryInferenceStorage`, `Chronos`, `ParametersStorage`, the NFT's
 *     `ownerOf` and, as a staticcall before any state write, ERC-1271 wallets.
 *     It never calls the Token or the vault, and accepts no ETH. A funding
 *     needs `PublishingConviction` 10.2.0 or later, whose `coverServiceCost`
 *     books nothing to the staker pool.
 *
 * Gates:
 *   - Only the current NFT owner switches service spending, removes buyers,
 *     updates limits or advances the grant nonce, and the owner's consent to a
 *     grant is checked against the owner at the time of `addBuyer`. The opt-in
 *     and each grant record the owner who made them and fund only while that
 *     owner holds the account: a sale of the account NFT leaves both inert, and
 *     the new owner opts in and adds its buyers afresh (`setServiceSpending`
 *     says what an inherited opt-in does).
 *   - A subscription keeps the grant it was funded under: it takes requests,
 *     and top-ups, only until that grant ends, at its expiry or its revocation
 *     if sooner, whatever later grant the buyer gets. So adding a buyer again
 *     after a revocation or an expiry serves it only from its next subscription
 *     not yet funded, and a grant replaced while still live keeps its
 *     subscriptions open until its own expiry.
 *   - A grant needs the consent of both the owner and the buyer over one
 *     EIP-712 digest that carries the account's current nonce. A party consents
 *     by sending the transaction, or by a signature: ERC-1271 for an address
 *     with code, ECDSA with a low `s` for an EOA.
 *   - Only the buyer funds and tops up, as `msg.sender`, within the grant's one
 *     limit, the most a subscription may cost, its top-ups included, as stored
 *     at that block. Both service classes are allowed. A publishing agent
 *     registration never allows service spending, and a grant never allows
 *     publishing.
 *   - Every funding and top-up is refused while `QueryInferenceStorage` is
 *     paused, before its activation epoch and while that is unset, as wallet
 *     fundings are: the pool counts money from activation on, so a cost booked
 *     in an earlier epoch would never reach a pool. Every funding needs a
 *     non-zero session key.
 *   - Service spending refuses to start, and funding refuses to run, while a
 *     protocol treasury is wired: a service spend carries no treasury fee. So
 *     `ParametersStorage.protocolTreasury` must stay 0 wherever this contract
 *     runs: wiring one stops every Conviction Account funding and top-up, and
 *     the opt-in, until it is unset again. Wallet subscriptions take no fee and
 *     go on. `protocolTreasuryFee`, already set at 300 bps, takes effect only
 *     once a treasury is wired.
 *   - An account that `PublishingConviction` 10.0.8 or 10.1.0 scheduled in
 *     full cannot switch service spending on, and its spends are refused
 *     (`EmissionAlreadyScheduled`): its base allowance is already the staker
 *     pool's. The refusal covers the whole account, even a spend its top-up
 *     buffer alone would pay, though the buffer was never scheduled: so the
 *     accounts 10.0.8 scheduled, testnet's among them, get no services at
 *     all, and still publish.
 */
contract ServiceSubscriptions is
    INamed,
    IVersioned,
    ContractStatus,
    IInitializable,
    IPublishingConvictionErrors,
    IServiceSpendingErrors,
    ISubscriptionFunding
{
    string private constant _NAME = "ServiceSubscriptions";
    // Version history:
    //   1.0.0 — Conviction Account service spending (OT-RFC-27): the owner's
    //           opt-in, two-party consent to a grant with cost limits, the
    //           owner's limit updates and revocation, subscription funding
    //           through `PublishingConviction.coverServiceCost`, and the
    //           labels.
    //   1.1.0 — a subscription is for one epoch, the current one or the next,
    //           one per buyer and epoch; a grant holds one cost limit per
    //           subscription and an expiry; top-ups and upgrades within the
    //           subscription (`topUpFromAccount`); a non-zero session key; no
    //           funding or top-up while `QueryInferenceStorage` is paused; no
    //           funding or top-up of a subscription whose grant expires before
    //           the subscription starts.
    //   1.2.0 — a Conviction Account pays as a wallet does: each funding and
    //           top-up books its cost under the subscription's epoch
    //           (`QueryInferenceStorage.addAccountFunding`), and both are
    //           refused before the activation epoch. The labels are gone
    //           (`_labelBase`, `_labelTopUp`, their basis and cursor, the
    //           `ServiceEmissionLabelled` event, `LabelCapacityExceeded`, and
    //           the views `scheduledEmission`, `emissionSpan` and
    //           `baseLabelCapacity`), and with them the schedule cut-over the
    //           opt-in needed (`ExactScheduleFromUnset`). The opt-in refuses an
    //           account scheduled in full (`EmissionAlreadyScheduled`). A
    //           funded subscription records the nonce of its grant, whose end a
    //           later grant to the buyer does not move, and takes a top-up only
    //           while that grant is live. The opt-in and each grant record the
    //           owner who made them, and fund or top up nothing once another
    //           owner holds the account (`ServiceSpendingDisabled`,
    //           `GrantedByFormerOwner`).
    string private constant _VERSION = "1.2.0";

    uint256 public constant BPS_DENOMINATOR = 10_000;

    // EIP-712, built by hand as KnowledgeAssetsLifecycle builds its domain.
    bytes32 private constant _EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant _EIP712_NAME_HASH = keccak256(bytes("DKGServiceSubscriptions"));
    bytes32 private constant _EIP712_VERSION_HASH = keccak256(bytes("1"));
    bytes32 public constant BUYER_GRANT_TYPEHASH =
        keccak256("BuyerGrant(uint256 accountId,address buyer,uint96 maxCostPerEpoch,uint40 expiresAt,uint64 nonce)");
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
    ///         `BuyerGrant` message. The limit is in COST, TRAC wei spent from
    ///         the account's allowance after its discount.
    struct BuyerTerms {
        uint256 accountId;
        address buyer;
        uint96 maxCostPerEpoch; // the most one subscription may cost, its top-ups included
        uint40 expiresAt;
        uint64 nonce; // the account's current grant nonce
    }

    /// @notice A buyer's request to fund one subscription from an account.
    struct FundingRequest {
        uint256 accountId;
        uint256 epoch; // the subscription's epoch: the current one or the next
        address sessionKey; // the buyer's request-signing key; never zero
        bytes32 planDigest; // the buyer's commitment to its plan, opaque here
        // 1 to maxBudgetsPerSubscription, in strictly increasing serviceId.
        ServiceSubscriptionsStorage.ServiceBudget[] budgets;
    }

    // ============================================================
    //                  Hub-wired dependencies
    // ============================================================

    PublishingConvictionStorage public publishingConvictionStorage;
    ServiceSubscriptionsStorage public serviceSubscriptionsStorage;
    Chronos public chronos;
    ParametersStorage public parametersStorage;
    QueryInferenceStorage public queryInferenceStorage;

    // ============================================================
    //                          Events
    // ============================================================

    event ServiceSpendingSet(uint256 indexed accountId, bool enabled);
    /// @notice A new grant, with the terms both parties consented to.
    ///         `termsDigest` is the EIP-712 digest they consented over, and
    ///         `nonce` the account nonce it consumed.
    event BuyerAdded(
        uint256 indexed accountId,
        address indexed buyer,
        bytes32 termsDigest,
        uint96 maxCostPerEpoch,
        uint40 expiresAt,
        uint64 nonce
    );
    event BuyerRemoved(uint256 indexed accountId, address indexed buyer);
    /// @notice The owner replaced a grant's limit and expiry. Its usage and
    ///         nonce are unchanged.
    event BuyerLimitsUpdated(
        uint256 indexed accountId,
        address indexed buyer,
        uint96 maxCostPerEpoch,
        uint40 expiresAt
    );
    /// @notice The account's grant nonce moved: the next grant must carry
    ///         `nextNonce`, so terms signed at an older nonce can no longer add
    ///         a buyer.
    event GrantNonceAdvanced(uint256 indexed accountId, uint64 nextNonce);

    // ============================================================
    //                          Errors
    // ============================================================

    error NotAccountOwner(uint256 accountId, address caller);
    error ServiceSpendingDisabled(uint256 accountId);
    error ServiceSpendingUnchanged(uint256 accountId, bool enabled);
    error InvalidBuyerTerms(string reason);
    error InvalidGrantNonce(uint256 accountId, uint64 expected, uint64 provided);
    error ConsentMissing(address party);
    error InvalidConsentSignature(address party);
    error NotABuyer(uint256 accountId, address buyer);
    /// @notice The owner who consented to the grant no longer holds the
    ///         account: it funds nothing, and the current owner adds the buyer
    ///         afresh.
    error GrantedByFormerOwner(uint256 accountId, address buyer);
    error GrantRevoked(uint256 accountId, address buyer);
    /// @notice The grant has expired. A top-up also reverts with it once the
    ///         grant the subscription was funded under has ended, by its expiry
    ///         or its revocation, whatever later grant the buyer holds: the
    ///         subscription takes no request issued after that end.
    error GrantExpired(uint256 accountId, address buyer);
    /// @notice The grant expires at or before the start of the subscription,
    ///         which it could then never serve: no request issued in the
    ///         subscription would be from a live grant, and a subscription is
    ///         non-refundable. A top-up checks the grant the subscription was
    ///         funded under too.
    error GrantEndsBeforeSubscription(uint256 accountId, address buyer, uint40 expiresAt, uint40 startsAt);
    error BuyerLimitsUnchanged(uint256 accountId, address buyer);
    error LimitExceeded(string name, uint256 limit, uint256 attempted);
    error SpendMismatch(uint96 expectedCost, uint96 cost, uint40 expectedWindow, uint40 window);

    // solhint-disable-next-line no-empty-blocks
    constructor(address hubAddress) ContractStatus(hubAddress) {}

    /// @dev Wires the dependencies that are not looked up on every call. The
    ///      Hub reverts `ContractDoesNotExist` for a name it does not hold.
    function initialize() external onlyHub {
        publishingConvictionStorage = PublishingConvictionStorage(
            hub.getContractAddress("PublishingConvictionStorage")
        );
        serviceSubscriptionsStorage = ServiceSubscriptionsStorage(
            hub.getContractAddress("ServiceSubscriptionsStorage")
        );
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
     * @dev Switching on needs no protocol treasury wired, an unexpired account,
     *      and one that pays at use time: an account that
     *      `PublishingConviction` 10.0.8 or 10.1.0 scheduled in full
     *      (`lastSettledWindow` at the lock while it is live) reverts
     *      `EmissionAlreadyScheduled`, as each of its spends would. Switching
     *      off is a pause: grants are kept, and funded subscriptions run to
     *      their end. The opt-in records its owner and counts only while that
     *      owner holds the account: after a sale it reads as off, the new owner
     *      switches it on afresh, and the former owner's grants stay inert
     *      whatever the new owner switches.
     *
     *      An inherited opt-in, one an earlier owner made, reads as off, so a
     *      new owner cannot switch it off as such: `false` reverts
     *      `ServiceSpendingUnchanged`. Switching it on and then off clears it.
     *      A grant recorded for an owner applies again if the account returns
     *      to that owner, unless an owner in between revoked it, as long as
     *      that owner's opt-in was not overwritten in between; if it was, the
     *      grant applies again once that owner opts in again.
     */
    function setServiceSpending(uint256 accountId, bool enabled) external {
        _requireOwner(accountId);
        ServiceSubscriptionsStorage subs = serviceSubscriptionsStorage;
        ServiceSubscriptionsStorage.ServiceSpending memory current = subs.getServiceSpending(accountId);
        bool isOn = current.enabledAt != 0 && current.owner == msg.sender;

        if (enabled) {
            _requireNoTreasury();
            PublishingConvictionStorage.Account memory acct = publishingConvictionStorage.getAccount(accountId);
            if (block.timestamp >= uint256(acct.expiresAtTimestamp)) {
                revert AccountExpired(accountId, acct.expiresAtEpoch);
            }
            if (acct.lastSettledWindow >= acct.lockDurationEpochs) revert EmissionAlreadyScheduled(accountId);
            if (isOn) revert ServiceSpendingUnchanged(accountId, true);

            subs.setServiceSpending(
                accountId,
                ServiceSubscriptionsStorage.ServiceSpending({
                    enabledAt: SafeCast.toUint40(block.timestamp),
                    owner: msg.sender
                })
            );
        } else {
            if (!isOn) revert ServiceSpendingUnchanged(accountId, false);
            subs.setServiceSpending(
                accountId,
                ServiceSubscriptionsStorage.ServiceSpending({enabledAt: 0, owner: address(0)})
            );
        }

        emit ServiceSpendingSet(accountId, enabled);
    }

    /**
     * @notice Add `t.buyer` as a buyer on `t.accountId`, under a grant that the
     *         current owner and the buyer consent to over the same EIP-712
     *         digest (`hashGrant(t)`).
     * @dev Anyone may submit. A party consents by sending the transaction, in
     *      which case its signature argument must be empty, or by a signature
     *      over the digest. The grant replaces any earlier one of the same
     *      buyer and starts its usage from zero. The subscriptions funded under
     *      the earlier one keep its end, its expiry or its revocation if
     *      sooner, so a new grant never admits a request issued once the
     *      earlier one had ended; the subscriptions funded under this one
     *      follow it. So adding a buyer again after a revocation or an expiry
     *      restores its service only from its next subscription not yet funded:
     *      a subscription already funded keeps its ended grant and takes no
     *      request issued after that end, and no top-up, and the buyer funds no
     *      second subscription for that epoch. Replacing a live grant leaves
     *      the subscriptions funded under it open until its own expiry, which
     *      revoking the new grant does not bring forward. The grant records the
     *      owner who consented, and funds only while that owner holds the
     *      account. It consumes the account's nonce, so the same terms never
     *      add a buyer twice.
     */
    function addBuyer(
        BuyerTerms calldata t,
        bytes calldata ownerSignature,
        bytes calldata buyerSignature
    ) external {
        ServiceSubscriptionsStorage subs = serviceSubscriptionsStorage;
        address accountOwner = _requireSpendingOn(subs, t.accountId);

        if (t.buyer == address(0)) revert InvalidBuyerTerms("buyer");
        _validateLimits(
            ServiceSubscriptionsStorage.BuyerLimits({maxCostPerEpoch: t.maxCostPerEpoch, expiresAt: t.expiresAt})
        );

        uint64 expected = subs.grantNonce(t.accountId);
        if (t.nonce != expected) revert InvalidGrantNonce(t.accountId, expected, t.nonce);

        bytes32 digest = hashGrant(t);
        _requireConsent(accountOwner, digest, ownerSignature);
        _requireConsent(t.buyer, digest, buyerSignature);

        uint64 used = subs.consumeGrantNonce(t.accountId);
        subs.setGrant(
            t.accountId,
            t.buyer,
            ServiceSubscriptionsStorage.BuyerGrant({
                maxCostPerEpoch: t.maxCostPerEpoch,
                grantedAt: SafeCast.toUint40(block.timestamp),
                expiresAt: t.expiresAt,
                revokedAt: 0,
                nonce: used,
                owner: accountOwner
            })
        );

        emit BuyerAdded(t.accountId, t.buyer, digest, t.maxCostPerEpoch, t.expiresAt, used);
        emit GrantNonceAdvanced(t.accountId, used + 1);
    }

    /**
     * @notice Revoke `buyer`'s grant over `accountId`. Owner only.
     * @dev Immediate for new subscriptions; funded subscriptions are
     *      non-refundable and run to their end. A request issued under this
     *      grant from the revocation on is refused, also after a new grant to
     *      the same buyer, while one served before it lands until the epoch
     *      ends, so the revocation cannot withhold a seller's receipt. It also
     *      consumes the account's nonce, so terms signed but not yet submitted
     *      can no longer add a buyer. A new grant to the buyer afterwards
     *      serves it from its next subscription not yet funded: the
     *      subscriptions funded under this one take no request issued after the
     *      revocation, and no top-up.
     */
    function removeBuyer(uint256 accountId, address buyer) external {
        _requireOwner(accountId);
        ServiceSubscriptionsStorage subs = serviceSubscriptionsStorage;
        ServiceSubscriptionsStorage.BuyerGrant memory grant = subs.getGrant(accountId, buyer);
        if (grant.grantedAt == 0) revert NotABuyer(accountId, buyer);
        if (grant.revokedAt != 0) revert GrantRevoked(accountId, buyer);

        subs.setGrantRevokedAt(accountId, buyer, SafeCast.toUint40(block.timestamp));
        uint64 used = subs.consumeGrantNonce(accountId);

        emit BuyerRemoved(accountId, buyer);
        emit GrantNonceAdvanced(accountId, used + 1);
    }

    /**
     * @notice Replace the limit and the expiry of `buyer`'s live grant over
     *         `accountId`. Owner only, at any time, whether service spending is
     *         on or off.
     * @dev The limit bounds only what the owner lets the buyer spend, and
     *      obliges the buyer to nothing, so a change in either direction needs
     *      no consent from the buyer. The usage, `grantedAt`, the grant's nonce
     *      and the account's nonce stay as they are. A limit below a
     *      subscription's cost so far is allowed, and refuses every top-up of
     *      that subscription. An earlier `expiresAt` refuses, from then on, the
     *      requests of the subscriptions funded under this grant, as a
     *      revocation does. An expired grant is renewed only by a new
     *      `addBuyer`, so a later `expiresAt` here never revives one. Terms
     *      signed at the current nonce stay valid; an owner who tightens the
     *      limit and wants to rule them out also calls `advanceGrantNonce`.
     */
    function setBuyerLimits(
        uint256 accountId,
        address buyer,
        ServiceSubscriptionsStorage.BuyerLimits calldata limits
    ) external {
        _requireOwner(accountId);
        ServiceSubscriptionsStorage subs = serviceSubscriptionsStorage;
        ServiceSubscriptionsStorage.BuyerGrant memory grant = _liveGrant(subs, accountId, buyer, msg.sender);
        _validateLimits(limits);
        if (limits.maxCostPerEpoch == grant.maxCostPerEpoch && limits.expiresAt == grant.expiresAt) {
            revert BuyerLimitsUnchanged(accountId, buyer);
        }

        subs.setBuyerLimits(accountId, buyer, limits);

        emit BuyerLimitsUpdated(accountId, buyer, limits.maxCostPerEpoch, limits.expiresAt);
    }

    /// @notice Advance `accountId`'s grant nonce, so terms signed at the
    ///         current nonce and not yet submitted can no longer add a buyer.
    ///         Owner only.
    function advanceGrantNonce(uint256 accountId) external {
        _requireOwner(accountId);
        uint64 used = serviceSubscriptionsStorage.consumeGrantNonce(accountId);
        emit GrantNonceAdvanced(accountId, used + 1);
    }

    // ============================================================
    //                       Buyer actions
    // ============================================================

    /**
     * @notice Fund the subscription of `r.epoch` from `r.accountId`'s
     *         allowance, as the buyer (`msg.sender`). Atomic: every refusal
     *         reverts the whole transaction, so nothing is ever funded
     *         partially.
     * @dev The cheap, read-only refusals come first: the pause and the
     *      activation, the session key, the subscription's epoch, the opt-in
     *      and the grant, both made by the account's current owner, the grant
     *      still live when the subscription starts (a subscription funded ahead
     *      for the next epoch would otherwise serve nothing), the budgets, one
     *      subscription per buyer and epoch, and the grant's limit as stored at
     *      this block. A revoked grant funds nothing, so only the expiry can be
     *      checked ahead. Then `coverServiceCost` spends the cost (window
     *      allowance first, then the top-up buffer); a subscription funded
     *      ahead spends from the window the funding runs in. Last, the usage,
     *      the cost under the subscription's epoch and the subscription record
     *      are written. The record names the grant by its nonce: the
     *      subscription accepts requests issued before that grant ends, its
     *      expiry or its revocation, whatever later grant the buyer gets.
     *
     *      The subscription runs to the start of the next epoch, from the later
     *      of the block time and its epoch's start, which is never 0, and an id
     *      that already holds a record is refused, so the storage never
     *      receives a record that reads as absent nor a second record under one
     *      id.
     * @return subscriptionId `subscriptionIdOf(msg.sender, r.epoch)`.
     * @return cost The cost spent from the allowance.
     */
    function fundFromAccount(FundingRequest calldata r) external returns (bytes32 subscriptionId, uint96 cost) {
        ServiceSubscriptionsStorage subs = serviceSubscriptionsStorage;
        QueryInferenceStorage qis = queryInferenceStorage;
        address buyer = msg.sender;

        // 1. Funding is live, a session key, and the subscription of the
        //    current epoch or the next one.
        uint256 currentEpoch = SubscriptionLib.requireLive(qis, chronos);
        if (r.sessionKey == address(0)) revert ZeroSessionKey();
        (uint40 startsAt, uint40 endsAt) = SubscriptionLib.timesOf(chronos, r.epoch, currentEpoch);

        // 2. The opt-in and a live grant, both made by the account's current
        //    owner, the grant still live when the subscription starts.
        address accountOwner = _requireSpendingOn(subs, r.accountId);
        ServiceSubscriptionsStorage.BuyerGrant memory grant = _liveGrant(subs, r.accountId, buyer, accountOwner);
        _requireLiveAtStart(r.accountId, buyer, grant, startsAt);

        // 3. The budgets and their value.
        uint96 value = SubscriptionLib.fundingValue(r.budgets, subs.maxBudgetsPerSubscription());

        // 4. One subscription per buyer and epoch.
        subscriptionId = SubscriptionLib.subscriptionIdOf(buyer, r.epoch);
        if (subs.subscriptionExists(subscriptionId)) revert SubscriptionAlreadyFunded(subscriptionId);

        // 5. The cost at the account's tier, within the limit stored at this
        //    block.
        PublishingConvictionStorage.Account memory acct = publishingConvictionStorage.getAccount(r.accountId);
        cost = _discounted(value, acct.discountBps);
        if (cost > grant.maxCostPerEpoch) revert LimitExceeded("maxCostPerEpoch", grant.maxCostPerEpoch, cost);

        // 6. The spend.
        PublishingConviction.ServiceSpend memory spend = _spend(
            r.accountId,
            buyer,
            subscriptionId,
            value,
            cost,
            _currentBillingWindow(acct, chronos.epochLength())
        );

        // 7. The usage, and the cost under the subscription's epoch, as a
        //    wallet funding books its value.
        subs.recordUsage(r.accountId, buyer);
        qis.addAccountFunding(r.epoch, spend.cost);

        // 8. The record, which names the grant it is funded under.
        subs.createSubscription(
            subscriptionId,
            ServiceSubscriptionsStorage.Subscription({
                accountId: r.accountId,
                buyer: buyer,
                grantNonce: grant.nonce,
                sessionKey: r.sessionKey,
                epoch: SafeCast.toUint40(r.epoch),
                planDigest: r.planDigest,
                startsAt: startsAt,
                endsAt: endsAt,
                fundedEpoch: spend.epoch,
                fundedWindow: spend.window,
                discountBps: spend.discountBps,
                budgetCount: uint8(r.budgets.length),
                value: value,
                cost: spend.cost,
                spentFromWindow: spend.spentFromWindow,
                spentFromTopUp: spend.spentFromTopUp
            }),
            r.budgets
        );

        // 9.
        emit SubscriptionFunded(
            subscriptionId,
            r.accountId,
            buyer,
            r.epoch,
            r.sessionKey,
            r.planDigest,
            startsAt,
            endsAt,
            value,
            spend.cost,
            spend.discountBps,
            r.budgets
        );
    }

    /**
     * @notice Top up or upgrade a subscription funded from a Conviction
     *         Account, as the buyer that funded it: add value to its budgets,
     *         or add budgets. Atomic, as a funding is.
     * @dev Refused while paused or before the activation epoch, and unless the
     *      subscription was funded from an account by `msg.sender` and has not
     *      ended. An addition to a stored budget repeats its class and price
     *      cap, which never change within a subscription; a new budget is
     *      appended under the funding rules. The opt-in, a live grant to the
     *      buyer that does not expire before the subscription starts, and its
     *      limit are checked as for a funding, the limit against the
     *      subscription's cost with this top-up added.
     *
     *      The grant the subscription was funded under must be live too, and
     *      must not end before the subscription starts: it decides which of the
     *      subscription's requests count, so once it has ended no request
     *      issued after the top-up could use what the top-up buys. A later
     *      grant to the buyer does not reopen the subscription. After a
     *      revocation or an expiry, the buyer is served again only from its
     *      next subscription not yet funded, and refused here with
     *      `GrantExpired`. A grant replaced while still live keeps its
     *      subscription open, to requests and top-ups alike, until its own
     *      expiry (`ServiceSubscriptionsStorage.grantEnd`).
     *
     *      The spend and the cost under the subscription's epoch follow as for
     *      a funding, at the account's own tier; a top-up funds no new
     *      subscription, so the usage is unchanged, and the subscription keeps
     *      the grant it was funded under.
     * @return cost The cost spent from the allowance.
     */
    function topUpFromAccount(
        bytes32 subscriptionId,
        ServiceSubscriptionsStorage.ServiceBudget[] calldata additions,
        bytes32 planDigest
    ) external returns (uint96 cost) {
        ServiceSubscriptionsStorage subs = serviceSubscriptionsStorage;
        QueryInferenceStorage qis = queryInferenceStorage;
        address buyer = msg.sender;

        // 1. Funding is live, and the subscription is open to this top-up.
        SubscriptionLib.requireLive(qis, chronos);
        ServiceSubscriptionsStorage.Subscription memory s = subs.getSubscription(subscriptionId);
        SubscriptionLib.requireTopUpOpen(subscriptionId, s, buyer, true);

        // 2. The opt-in and a live grant, both made by the account's current
        //    owner, the grant still live when the subscription starts, and the
        //    grant the subscription was funded under live too.
        address accountOwner = _requireSpendingOn(subs, s.accountId);
        ServiceSubscriptionsStorage.BuyerGrant memory grant = _liveGrant(subs, s.accountId, buyer, accountOwner);
        _requireLiveAtStart(s.accountId, buyer, grant, s.startsAt);
        _requireFundedUnderLive(subs, s.accountId, buyer, s.grantNonce, s.startsAt);

        // 3. The additions, merged into the stored budgets.
        SubscriptionLib.TopUp memory t = SubscriptionLib.mergeTopUp(
            subs.getBudgets(subscriptionId),
            additions,
            subs.maxBudgetsPerSubscription(),
            s.value
        );

        // 4. The cost at the account's tier, and the subscription's cost with
        //    it within the limit stored at this block.
        PublishingConvictionStorage.Account memory acct = publishingConvictionStorage.getAccount(s.accountId);
        cost = _discounted(t.value, acct.discountBps);
        uint256 subscriptionCost = uint256(s.cost) + cost;
        if (subscriptionCost > grant.maxCostPerEpoch) {
            revert LimitExceeded("maxCostPerEpoch", grant.maxCostPerEpoch, subscriptionCost);
        }

        // 5. The spend.
        PublishingConviction.ServiceSpend memory spend = _spend(
            s.accountId,
            buyer,
            subscriptionId,
            t.value,
            cost,
            _currentBillingWindow(acct, chronos.epochLength())
        );

        // 6. The cost under the subscription's epoch, and the record.
        qis.addAccountFunding(s.epoch, spend.cost);
        subs.applyTopUp(
            subscriptionId,
            ServiceSubscriptionsStorage.TopUpAmounts({
                value: t.value,
                cost: spend.cost,
                spentFromWindow: spend.spentFromWindow,
                spentFromTopUp: spend.spentFromTopUp
            }),
            planDigest,
            t.added,
            t.appended
        );

        // 7.
        emit SubscriptionToppedUp(subscriptionId, s.accountId, buyer, t.value, spend.cost, planDigest, additions);
    }

    // ============================================================
    //                           Views
    // ============================================================

    /// @notice The EIP-712 domain separator: name `DKGServiceSubscriptions`,
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

    /// @notice The EIP-712 digest of `BuyerGrant` terms, which the owner and
    ///         the buyer consent to.
    function hashGrant(BuyerTerms calldata t) public view returns (bytes32 digest) {
        bytes32 structHash = keccak256(
            abi.encode(BUYER_GRANT_TYPEHASH, t.accountId, t.buyer, t.maxCostPerEpoch, t.expiresAt, t.nonce)
        );
        digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }

    /// @notice The id of the subscription `buyer` funds for `epoch`:
    ///         `keccak256(abi.encode(buyer, epoch))`, one per buyer and epoch,
    ///         for a subscription funded from an account or from a wallet.
    function subscriptionIdOf(address buyer, uint256 epoch) public pure returns (bytes32) {
        return SubscriptionLib.subscriptionIdOf(buyer, epoch);
    }

    /// @notice The cost of a budget value at the account's discount tier:
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
     * @return baseRemaining The window's base allowance not yet spent, and 0
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
    function _validateLimits(ServiceSubscriptionsStorage.BuyerLimits memory limits) internal view {
        if (limits.maxCostPerEpoch == 0) revert InvalidBuyerTerms("maxCostPerEpoch");
        if (limits.expiresAt <= block.timestamp) revert InvalidBuyerTerms("expiresAt");
    }

    /// @dev Service spending is on for `accountId`, switched on by its current
    ///      owner, which it returns. An opt-in another owner made reads as
    ///      off; an account that was never switched on is refused before its
    ///      owner is read.
    function _requireSpendingOn(
        ServiceSubscriptionsStorage subs,
        uint256 accountId
    ) internal view returns (address accountOwner) {
        ServiceSubscriptionsStorage.ServiceSpending memory s = subs.getServiceSpending(accountId);
        if (s.enabledAt != 0) accountOwner = _nft().ownerOf(accountId);
        if (s.enabledAt == 0 || s.owner != accountOwner) revert ServiceSpendingDisabled(accountId);
    }

    /// @dev A live grant exists, `accountOwner`, the account's current owner,
    ///      consented to it, and it is neither revoked nor expired.
    function _liveGrant(
        ServiceSubscriptionsStorage subs,
        uint256 accountId,
        address buyer,
        address accountOwner
    ) internal view returns (ServiceSubscriptionsStorage.BuyerGrant memory grant) {
        grant = subs.getGrant(accountId, buyer);
        if (grant.grantedAt == 0) revert NotABuyer(accountId, buyer);
        if (grant.owner != accountOwner) revert GrantedByFormerOwner(accountId, buyer);
        if (grant.revokedAt != 0) revert GrantRevoked(accountId, buyer);
        if (block.timestamp >= uint256(grant.expiresAt)) revert GrantExpired(accountId, buyer);
    }

    /// @dev The grant does not expire at or before the subscription's start. A
    ///      live grant has not expired at the block time, so this only ever
    ///      refuses a subscription that starts later: one funded ahead for the
    ///      next epoch, or topped up before it starts.
    function _requireLiveAtStart(
        uint256 accountId,
        address buyer,
        ServiceSubscriptionsStorage.BuyerGrant memory grant,
        uint40 startsAt
    ) internal pure {
        if (grant.expiresAt <= startsAt) {
            revert GrantEndsBeforeSubscription(accountId, buyer, grant.expiresAt, startsAt);
        }
    }

    /// @dev The grant to `buyer` that consumed `nonce`, the one a subscription
    ///      was funded under, has not ended and does not end at or before the
    ///      subscription's start, as `_liveGrant` and `_requireLiveAtStart`
    ///      check the current one: its end is when its subscription stops
    ///      taking requests. For the current grant that holds already; for one
    ///      a later grant replaced, it is the end it had then, its expiry or
    ///      its revocation if sooner. A revocation is never after the block
    ///      time, so the second check meets only an expiry.
    function _requireFundedUnderLive(
        ServiceSubscriptionsStorage subs,
        uint256 accountId,
        address buyer,
        uint64 nonce,
        uint40 startsAt
    ) internal view {
        uint40 end = subs.grantEnd(accountId, buyer, nonce);
        if (block.timestamp >= end) revert GrantExpired(accountId, buyer);
        if (end <= startsAt) revert GrantEndsBeforeSubscription(accountId, buyer, end, startsAt);
    }

    /**
     * @dev Spend `value` through `coverServiceCost`, which must return the cost
     *      and the window computed here, or the funding reverts
     *      `SpendMismatch`. The caller books `spend.cost`, the whole spend.
     */
    function _spend(
        uint256 accountId,
        address buyer,
        bytes32 subscriptionId,
        uint96 value,
        uint96 cost,
        uint40 window
    ) internal returns (PublishingConviction.ServiceSpend memory spend) {
        spend = _publishingConviction().coverServiceCost(accountId, buyer, subscriptionId, value);
        if (spend.cost != cost || spend.window != window) revert SpendMismatch(cost, spend.cost, window, spend.window);
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
    ///      `PublishingConviction` computes it for a spend.
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
