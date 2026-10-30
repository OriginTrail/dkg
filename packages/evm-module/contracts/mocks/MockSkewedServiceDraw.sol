// SPDX-License-Identifier: Apache-2.0

pragma solidity ^0.8.20;

import {PublishingConviction} from "../PublishingConviction.sol";

/// @title MockSkewedServiceDraw
/// @notice Test-only stand-in registered in the Hub as `PublishingConviction`,
///         so tests can show that `ServiceSubscriptions` refuses a draw that
///         does not match the cost and the billing window it computed itself
///         (`DrawMismatch`). It returns the undiscounted value as the cost and
///         a settable window, and draws nothing.
contract MockSkewedServiceDraw {
    uint40 public window;

    function setWindow(uint40 w) external {
        window = w;
    }

    function settle(uint256) external {}

    function coverServiceCost(
        uint256,
        address,
        bytes32,
        uint96 value
    ) external view returns (PublishingConviction.ServiceDraw memory d) {
        d.cost = value;
        d.drawnFromWindow = value;
        d.window = window;
        d.epoch = 1;
    }
}
