// SPDX-License-Identifier: Apache-2.0

pragma solidity ^0.8.20;

import {PublishingConviction} from "../PublishingConviction.sol";

/// @title MockServiceSubscriptions
/// @notice Test-only stand-in for the contract the Hub names
///         `ServiceSubscriptions`, the only caller `PublishingConviction`'s
///         `coverServiceCost` admits. It forwards a spend and keeps the last
///         `ServiceSpend` returned, so tests can read the exact spend of the
///         transaction that made it.
contract MockServiceSubscriptions {
    PublishingConviction.ServiceSpend internal _lastSpend;

    function cover(
        address publishingConviction,
        uint256 accountId,
        address buyer,
        bytes32 subscriptionId,
        uint96 value
    ) external returns (PublishingConviction.ServiceSpend memory spend) {
        spend = PublishingConviction(publishingConviction).coverServiceCost(accountId, buyer, subscriptionId, value);
        _lastSpend = spend;
    }

    function lastSpend() external view returns (PublishingConviction.ServiceSpend memory) {
        return _lastSpend;
    }
}
