// SPDX-License-Identifier: Apache-2.0

pragma solidity ^0.8.20;

/**
 * @title IConvictionServiceErrors
 * @notice Errors of Conviction Account service spending (OT-RFC-27) that more
 *         than one contract reverts with: {PublishingConviction}, inside
 *         `coverServiceCost`, and the `ServiceSubscriptions` logic that calls
 *         it and checks the same conditions first.
 *
 *         One declaration makes the compiler keep both sides on the same
 *         selectors, in the pattern of {IPublishingConvictionErrors}.
 */
interface IConvictionServiceErrors {
    /// @notice `ParametersStorage.protocolTreasury()` is non-zero, so service
    ///         spending is paused. A service draw carries no treasury fee and
    ///         must move no TRAC: its whole cost is booked to the
    ///         query/inference pool.
    error ServiceFundingPausedTreasuryWired(address treasury);

    /// @notice `coverServiceCost` was called with a value of 0.
    error ZeroServiceValue();

    /// @notice PublishingConviction 10.0.8 or 10.1.0 booked the account's
    ///         whole base budget to the staker pool up front
    ///         (`lastSettledWindow == lockDurationEpochs` while its lock is
    ///         live), so its allowance cannot pay for services: the money
    ///         would be counted in the staker pool and in the query/inference
    ///         pool alike. It still publishes.
    error EmissionAlreadyScheduled(uint256 accountId);
}
