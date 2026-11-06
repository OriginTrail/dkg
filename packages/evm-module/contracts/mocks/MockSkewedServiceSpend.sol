// SPDX-License-Identifier: Apache-2.0

pragma solidity ^0.8.20;

import {PublishingConviction} from "../PublishingConviction.sol";

/// @title MockSkewedServiceSpend
/// @notice Test-only stand-in registered in the Hub as `PublishingConviction`,
///         so tests can show that `ServiceSubscriptions` refuses a spend that
///         does not match the cost and the billing window it computed itself
///         (`SpendMismatch`). It returns the undiscounted value as the cost and
///         a settable window, and spends nothing.
contract MockSkewedServiceSpend {
    uint40 public window;

    function setWindow(uint40 w) external {
        window = w;
    }

    function coverServiceCost(
        uint256,
        address,
        bytes32,
        uint96 value
    ) external view returns (PublishingConviction.ServiceSpend memory spend) {
        spend.cost = value;
        spend.spentFromWindow = value;
        spend.window = window;
        spend.epoch = 1;
    }
}
