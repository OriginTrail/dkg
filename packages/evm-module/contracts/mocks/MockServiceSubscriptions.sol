// SPDX-License-Identifier: Apache-2.0

pragma solidity ^0.8.20;

import {PublishingConviction} from "../PublishingConviction.sol";

/// @title MockServiceSubscriptions
/// @notice Test-only stand-in for the contract the Hub names
///         `ServiceSubscriptions`, the only caller `PublishingConviction`'s
///         `coverServiceCost` admits. It forwards a draw and keeps the last
///         `ServiceDraw` returned, so tests can read the exact draw of the
///         transaction that made it.
contract MockServiceSubscriptions {
    PublishingConviction.ServiceDraw internal _lastDraw;

    function cover(
        address publishingConviction,
        uint256 accountId,
        address assignee,
        bytes32 subscriptionId,
        uint96 value
    ) external returns (PublishingConviction.ServiceDraw memory d) {
        d = PublishingConviction(publishingConviction).coverServiceCost(accountId, assignee, subscriptionId, value);
        _lastDraw = d;
    }

    function lastDraw() external view returns (PublishingConviction.ServiceDraw memory) {
        return _lastDraw;
    }
}
