// SPDX-License-Identifier: Apache-2.0

pragma solidity ^0.8.20;

interface IPaymaster {
    function addAllowedAddress(address _address) external;

    function removeAllowedAddress(address _address) external;

    function fundPaymaster(uint256 amount) external;

    function coverCost(uint256 amount) external;
}
