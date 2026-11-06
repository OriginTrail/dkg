// SPDX-License-Identifier: Apache-2.0

pragma solidity ^0.8.20;

import {ServiceSubscriptionsStorage} from "../storage/ServiceSubscriptionsStorage.sol";

/**
 * @title ISubscriptionFunding
 * @notice The events and errors of subscription funding (OT-RFC-27,
 *         "NeuroSymbolic Marketplace") that both funding contracts share:
 *         `ServiceSubscriptions`, which funds and tops up subscriptions from a
 *         Conviction Account's allowance, and `ServiceSubscriptionsWallet`,
 *         which funds and tops up subscriptions from the buyer's wallet.
 *
 *         A subscription is for one chain epoch. Both contracts record every
 *         subscription in `ServiceSubscriptionsStorage`, under one id per buyer
 *         and epoch, and emit the same events, so sellers read every
 *         subscription the same way. One declaration keeps both on the same
 *         selectors and topics, in the pattern of {IServiceSpendingErrors}.
 */
interface ISubscriptionFunding {
    /// @notice A subscription was funded: the subscription of `epoch`, from
    ///         `startsAt` to `endsAt`. `accountId` is 0 for a subscription
    ///         funded from a wallet, whose cost is its value. Sellers check
    ///         their line of the buyer's plan (`planDigest`) against this event
    ///         and the stored record.
    event SubscriptionFunded(
        bytes32 indexed subscriptionId,
        uint256 indexed accountId,
        address indexed buyer,
        uint256 epoch,
        address sessionKey,
        bytes32 planDigest,
        uint40 startsAt,
        uint40 endsAt,
        uint96 value,
        uint96 cost,
        uint16 discountBps,
        ServiceSubscriptionsStorage.ServiceBudget[] budgets
    );

    /// @notice A funded subscription was topped up: `value` more before the
    ///         discount, at `cost`, over `additions`, each adding to the stored
    ///         budget of its id or appended as a new one. `planDigest` replaces
    ///         the subscription's plan commitment.
    event SubscriptionToppedUp(
        bytes32 indexed subscriptionId,
        uint256 indexed accountId,
        address indexed buyer,
        uint96 value,
        uint96 cost,
        bytes32 planDigest,
        ServiceSubscriptionsStorage.ServiceBudget[] additions
    );

    /// @notice A request outside the funding rules; `reason` names the rule.
    error InvalidFundingRequest(string reason);
    /// @notice The buyer has already funded a subscription for this epoch.
    error SubscriptionAlreadyFunded(bytes32 subscriptionId);
    /// @notice The session key is the zero address: no request could ever be
    ///         proved signed by it.
    error ZeroSessionKey();
    /// @notice `QueryInferenceStorage` is paused.
    error QueryInferencePaused();
    /// @notice The current epoch is before the activation epoch, or that is
    ///         still unset (0).
    error QueryInferenceNotActive(uint40 activationEpoch, uint256 currentEpoch);
    error SubscriptionNotFound(bytes32 subscriptionId);
    error NotSubscriptionBuyer(bytes32 subscriptionId, address caller);
    /// @notice A top-up comes from the subscription's own source: a wallet
    ///         subscription (account 0) from a wallet, any other from its
    ///         account.
    error WrongFundingSource(bytes32 subscriptionId, uint256 accountId);
    error SubscriptionEnded(bytes32 subscriptionId, uint40 endsAt);
    /// @notice A top-up of a stored budget must repeat its class and price cap:
    ///         neither changes within a subscription.
    error BudgetTermsChanged(bytes32 serviceId);
}
