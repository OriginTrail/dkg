// SPDX-License-Identifier: Apache-2.0

pragma solidity ^0.8.20;

import {INamed} from "./interfaces/INamed.sol";
import {IVersioned} from "./interfaces/IVersioned.sol";
import {IInitializable} from "./interfaces/IInitializable.sol";
import {ISubscriptionFunding} from "./interfaces/ISubscriptionFunding.sol";
import {ContractStatus} from "./abstract/ContractStatus.sol";
import {Chronos} from "./storage/Chronos.sol";
import {ServiceSubscriptionsStorage} from "./storage/ServiceSubscriptionsStorage.sol";
import {QueryInferenceStorage} from "./storage/QueryInferenceStorage.sol";
import {SubscriptionLib} from "./libraries/SubscriptionLib.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

/**
 * @title ServiceSubscriptionsWallet
 * @notice Subscriptions funded from the buyer's wallet (OT-RFC-27,
 *         "NeuroSymbolic Marketplace"): a buyer pays for one subscription per
 *         transaction in TRAC, and tops it up while it runs.
 *
 * A subscription is for one chain epoch, the current one or the next, and a
 * buyer funds at most one subscription per epoch: wallet subscriptions and
 *  Conviction
 * Account subscriptions (`ServiceSubscriptions`) share one id per buyer and
 * epoch. The subscription is recorded in `ServiceSubscriptionsStorage` under
 * account 0, which no account has, with the same record, budgets and events as
 * an account's subscription, so sellers verify every subscription the same way.
 *
 * Money: the whole payment moves from the buyer into the vault
 * (`ConvictionStakingStorage`), with no protocol fee, whether or not a treasury
 * is wired: every subscription token enters the query/inference pool. It is
 * booked to `QueryInferenceStorage` under the subscription's epoch, the epoch
 * in which the subscription's receipt value counts. The payment is
 * non-refundable, and no TRAC is ever sent to a seller.
 *
 * Architecture: stateless logic, as `ServiceSubscriptions`, whose Conviction
 * Account paths it complements; the two contracts apply the same subscription
 * rules through `SubscriptionLib`. The Token, the vault,
 * `ServiceSubscriptionsStorage`, `QueryInferenceStorage` and `Chronos` are
 * wired at `initialize()`. Its only Token call is `transferFrom` from the buyer
 * to the vault, made after every storage write. It accepts no ETH.
 *
 * Gates: only the buyer that funded a subscription tops it up, and every
 * funding and top-up is refused while `QueryInferenceStorage` is paused, before
 * its activation epoch and while that is unset. Every funding needs a non-zero
 * session key.
 *
 * The session key. A wallet subscription's session key is fixed at its funding
 * and cannot be rotated or revoked on-chain: a wallet subscription has no grant
 * to revoke. Whoever holds a leaked key can sign the subscription's requests
 * for any seller, a node they run included, and so direct the subscription's
 * served value to it. The loss is bounded by that one subscription: its
 * receipts count for at most its budgets' funded value, top-ups included, and
 * the session key signs for no other subscription. Only the buyer tops a
 * subscription up, so it stops adding to it and funds its next subscription
 * under a new session key. (A Conviction Account subscription's key is fixed
 * too, but revoking its grant refuses every request issued after the
 * revocation.) This is a known limitation, accepted for testnet.
 */
contract ServiceSubscriptionsWallet is INamed, IVersioned, ContractStatus, IInitializable, ISubscriptionFunding {
    string private constant _NAME = "ServiceSubscriptionsWallet";
    // Version history:
    //   1.0.0 — wallet-funded subscriptions of one epoch, and their top-ups and
    //           upgrades (OT-RFC-27).
    string private constant _VERSION = "1.0.0";

    /// @notice A buyer's request to fund one subscription from its wallet: the
    ///         fields of an account's funding request, without the account.
    struct WalletFundingRequest {
        uint256 epoch; // the subscription's epoch: the current one or the next
        address sessionKey; // the buyer's request-signing key; never zero
        bytes32 planDigest; // the buyer's commitment to its plan, opaque here
        // 1 to maxBudgetsPerSubscription, in strictly increasing serviceId.
        ServiceSubscriptionsStorage.ServiceBudget[] budgets;
    }

    // ============================================================
    //                  Hub-wired dependencies
    // ============================================================

    IERC20 public tokenContract;
    /// @notice The vault, `ConvictionStakingStorage`, that receives every payment.
    address public stakingStorageAddress;
    ServiceSubscriptionsStorage public serviceSubscriptionsStorage;
    QueryInferenceStorage public queryInferenceStorage;
    Chronos public chronos;

    error TokenTransferFailed();

    // solhint-disable-next-line no-empty-blocks
    constructor(address hubAddress) ContractStatus(hubAddress) {}

    /// @dev Wires every dependency. The Hub reverts `ContractDoesNotExist` for
    ///      a name it does not hold.
    function initialize() external onlyHub {
        tokenContract = IERC20(hub.getContractAddress("Token"));
        stakingStorageAddress = hub.getContractAddress("ConvictionStakingStorage");
        serviceSubscriptionsStorage = ServiceSubscriptionsStorage(
            hub.getContractAddress("ServiceSubscriptionsStorage")
        );
        queryInferenceStorage = QueryInferenceStorage(hub.getContractAddress("QueryInferenceStorage"));
        chronos = Chronos(hub.getContractAddress("Chronos"));
    }

    function name() external pure virtual override returns (string memory) {
        return _NAME;
    }

    function version() external pure virtual override returns (string memory) {
        return _VERSION;
    }

    // ============================================================
    //                       Buyer actions
    // ============================================================

    /**
     * @notice Fund the subscription of `r.epoch` from the buyer's wallet, as
     *         `msg.sender`: the budgets' whole value moves into the vault.
     *         Atomic: every refusal reverts the whole transaction.
     * @dev In order: funding is live, the session key, the subscription's epoch
     *      (the current one or the next), the budgets and the value by the
     *      funding rules, and one subscription per buyer and epoch. Then the
     *      value is booked under the subscription's epoch, the record is
     *      written under account 0 with a cost equal to the value and no
     *      discount, window or spend, and last the payment is pulled. The buyer
     *      approves this contract for the value beforehand.
     * @return subscriptionId `ServiceSubscriptions.subscriptionIdOf(msg.sender, r.epoch)`.
     */
    function fundFromWallet(WalletFundingRequest calldata r) external returns (bytes32 subscriptionId) {
        ServiceSubscriptionsStorage subs = serviceSubscriptionsStorage;
        QueryInferenceStorage qis = queryInferenceStorage;
        address buyer = msg.sender;

        // 1. Funding is live, a session key, and the subscription of the
        //    current epoch or the next one.
        uint256 currentEpoch = SubscriptionLib.requireLive(qis, chronos);
        if (r.sessionKey == address(0)) revert ZeroSessionKey();
        (uint40 startsAt, uint40 endsAt) = SubscriptionLib.timesOf(chronos, r.epoch, currentEpoch);

        // 2. The budgets and their value.
        uint96 value = SubscriptionLib.fundingValue(r.budgets, subs.maxBudgetsPerSubscription());

        // 3. One subscription per buyer and epoch, shared with account
        // subscriptions.
        subscriptionId = SubscriptionLib.subscriptionIdOf(buyer, r.epoch);
        if (subs.subscriptionExists(subscriptionId)) revert SubscriptionAlreadyFunded(subscriptionId);

        // 4. The value under the subscription's epoch.
        qis.addWalletFunding(r.epoch, value);

        // 5. The record, under account 0.
        subs.createSubscription(
            subscriptionId,
            ServiceSubscriptionsStorage.Subscription({
                accountId: 0,
                buyer: buyer,
                grantNonce: 0,
                sessionKey: r.sessionKey,
                epoch: SafeCast.toUint40(r.epoch),
                planDigest: r.planDigest,
                startsAt: startsAt,
                endsAt: endsAt,
                fundedEpoch: SafeCast.toUint40(currentEpoch),
                fundedWindow: 0,
                discountBps: 0,
                budgetCount: uint8(r.budgets.length),
                value: value,
                cost: value,
                spentFromWindow: 0,
                spentFromTopUp: 0
            }),
            r.budgets
        );

        // 6. The payment, after every write.
        _pull(buyer, value);

        emit SubscriptionFunded(
            subscriptionId,
            0,
            buyer,
            r.epoch,
            r.sessionKey,
            r.planDigest,
            startsAt,
            endsAt,
            value,
            value,
            0,
            r.budgets
        );
    }

    /**
     * @notice Top up or upgrade a wallet-funded subscription, as the buyer that
     *         funded it: add value to its budgets, or add budgets. The added
     *         value moves into the vault.
     * @dev Refused unless funding is live, the subscription was funded from a
     *      wallet by `msg.sender`, and it has not ended. An addition to a
     *      stored budget repeats its class and price cap, which never change
     *      within a subscription; a new budget is appended under the funding
     *      rules. The added value is booked under the subscription's epoch, as
     *      the subscription's own value is.
     * @return value The value added, and paid.
     */
    function topUpFromWallet(
        bytes32 subscriptionId,
        ServiceSubscriptionsStorage.ServiceBudget[] calldata additions,
        bytes32 planDigest
    ) external returns (uint96 value) {
        ServiceSubscriptionsStorage subs = serviceSubscriptionsStorage;
        QueryInferenceStorage qis = queryInferenceStorage;
        address buyer = msg.sender;

        // 1. Funding is live, and the subscription is open to this top-up.
        SubscriptionLib.requireLive(qis, chronos);
        ServiceSubscriptionsStorage.Subscription memory s = subs.getSubscription(subscriptionId);
        SubscriptionLib.requireTopUpOpen(subscriptionId, s, buyer, false);

        // 2. The additions, merged into the stored budgets.
        SubscriptionLib.TopUp memory t = SubscriptionLib.mergeTopUp(
            subs.getBudgets(subscriptionId),
            additions,
            subs.maxBudgetsPerSubscription(),
            s.value
        );
        value = t.value;

        // 3. The value under the subscription's epoch, and the record.
        qis.addWalletFunding(s.epoch, value);
        subs.applyTopUp(
            subscriptionId,
            ServiceSubscriptionsStorage.TopUpAmounts({
                value: value,
                cost: value,
                spentFromWindow: 0,
                spentFromTopUp: 0
            }),
            planDigest,
            t.added,
            t.appended
        );

        // 4. The payment, after every write.
        _pull(buyer, value);

        emit SubscriptionToppedUp(subscriptionId, 0, buyer, value, value, planDigest, additions);
    }

    // ============================================================
    //                         Internal
    // ============================================================

    /// @dev Move `amount` from `from` into the vault. The Token reverts on a
    ///      short balance or allowance; a `false` return reverts here.
    function _pull(address from, uint96 amount) internal {
        if (!tokenContract.transferFrom(from, stakingStorageAddress, amount)) revert TokenTransferFailed();
    }
}
