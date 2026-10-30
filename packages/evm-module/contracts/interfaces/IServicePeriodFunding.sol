// SPDX-License-Identifier: Apache-2.0

pragma solidity ^0.8.20;

/**
 * @title IServicePeriodFunding
 * @notice The bucket shape, events and errors of plan-period funding
 *         (OT-RFC-27, "NeuroSymbolic Marketplace") that both funding
 *         contracts share: `ServiceSubscriptions`, which funds and tops up
 *         periods from a Conviction Account's allowance, and
 *         `ServiceSubscriptionsWallet`, which funds and tops up periods from
 *         the buyer key's wallet.
 *
 *         A plan period is one chain epoch. Both contracts record every period
 *         in `ConvictionServiceStorage`, under one id per buyer key and epoch,
 *         and emit the same events, so sellers read every period the same way.
 *         One declaration keeps both on the same selectors and topics, in the
 *         pattern of {IConvictionServiceErrors}.
 */
interface IServicePeriodFunding {
    /// @notice One service bucket of a funding or a top-up.
    struct BucketInput {
        bytes32 bucketId; // a canonical model or service
        uint8 serviceClass; // 1 = inference (units: tokens), 2 = query (units: query units)
        uint96 value; // the funded bucket value before the discount, TRAC wei
        uint96 maxAskWeiPerUnit; // the buyer's price cap per unit
    }

    /// @notice A plan period was funded: the period of `epoch`, from
    ///         `periodStart` to `periodEnd`. `accountId` is 0 for a period
    ///         funded from a wallet, whose cost is its value. Sellers verify
    ///         their plan line against this event and the stored record.
    event PeriodFunded(
        bytes32 indexed subscriptionId,
        uint256 indexed accountId,
        address indexed assignee,
        uint256 epoch,
        address sessionKey,
        bytes32 planDigest,
        uint40 periodStart,
        uint40 periodEnd,
        uint96 value,
        uint96 cost,
        uint16 discountBps,
        BucketInput[] buckets
    );

    /// @notice A funded period was topped up: `value` more before the
    ///         discount, at `cost`, over `additions`, each adding to the stored
    ///         bucket of its id or appended as a new one. `planDigest` replaces
    ///         the period's plan commitment.
    event PeriodToppedUp(
        bytes32 indexed subscriptionId,
        uint256 indexed accountId,
        address indexed assignee,
        uint96 value,
        uint96 cost,
        bytes32 planDigest,
        BucketInput[] additions
    );

    /// @notice A request outside the funding rules; `reason` names the rule.
    error InvalidFundingRequest(string reason);
    /// @notice The buyer key has already funded a period for this epoch.
    error PeriodAlreadyFunded(bytes32 subscriptionId);
    /// @notice The session key is the zero address: no request could ever be
    ///         proved signed by it.
    error ZeroSessionKey();
    /// @notice `QueryInferenceStorage` is paused.
    error QueryInferencePaused();
    /// @notice The current epoch is before the activation epoch, or that is
    ///         still unset (0).
    error QueryInferenceNotActive(uint40 activationEpoch, uint256 currentEpoch);
    error PeriodNotFound(bytes32 subscriptionId);
    error NotPeriodBuyer(bytes32 subscriptionId, address caller);
    /// @notice A top-up comes from the period's own source: a wallet period
    ///         (account 0) from a wallet, any other from its account.
    error WrongFundingSource(bytes32 subscriptionId, uint256 accountId);
    error PeriodEnded(bytes32 subscriptionId, uint40 periodEnd);
    /// @notice A top-up of a stored bucket must repeat its class and price
    ///         cap: neither changes within a period.
    error BucketTermsChanged(bytes32 bucketId);
}
