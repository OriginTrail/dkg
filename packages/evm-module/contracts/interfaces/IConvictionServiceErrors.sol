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
    ///         spending is paused. A service draw must move no TRAC, and the
    ///         top-up path would skim the treasury fee with `transferStake`;
    ///         an account scheduled while a treasury is wired also emits net
    ///         of a fee that no storage records, which the label basis cannot
    ///         rebuild.
    error ServiceFundingPausedTreasuryWired(address treasury);

    /// @notice `coverServiceCost` was called with a value of 0.
    error ZeroServiceValue();
}
