// SPDX-License-Identifier: Apache-2.0

pragma solidity ^0.8.20;

/**
 * @title IPublishingConvictionErrors
 * @notice Single source of truth for the publishing-conviction "cannot pay
 *         via this account right now" errors.
 *
 *         These are declared here — rather than locally on
 *         {PublishingConviction} — because more than one contract must agree
 *         on their selectors:
 *
 *           - {PublishingConviction} REVERTS with them inside
 *             `coverPublishingCost` when an account cannot fund a publish.
 *           - {KnowledgeAssetsLifecycle} CATCHES them by selector and falls
 *             through to direct spend instead of bricking the publisher
 *             (consent-free agent-registration DoS fix).
 *
 *         Keeping a single declaration makes the compiler enforce that the
 *         catch side and the revert side never drift: renaming or re-typing
 *         an error here breaks both call sites at compile time, so the
 *         fall-through can never be silently disabled.
 */
interface IPublishingConvictionErrors {
    /// @notice The resolved conviction account cannot cover the (discounted)
    ///         cost for `epoch` — its base allowance plus top-up buffer fall
    ///         short of `required`.
    error InsufficientAllowance(uint256 accountId, uint40 epoch, uint96 required, uint96 available);

    /// @notice The conviction account is past `expiresAtEpoch` and can no
    ///         longer fund publishes.
    error AccountExpired(uint256 accountId, uint40 expiresAtEpoch);
}
