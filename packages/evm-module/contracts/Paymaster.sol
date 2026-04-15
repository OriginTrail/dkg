// SPDX-License-Identifier: Apache-2.0

pragma solidity ^0.8.20;

import {Hub} from "./storage/Hub.sol";
import {TokenLib} from "./libraries/TokenLib.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract Paymaster is Ownable(msg.sender) {
    error NotAllowed();

    Hub public hub;
    IERC20 public tokenContract;

    mapping(address => bool) public allowedAddresses;

    modifier onlyAllowed() {
        if (!allowedAddresses[msg.sender]) {
            revert NotAllowed();
        }
        _;
    }

    constructor(address hubAddress) {
        hub = Hub(hubAddress);
        tokenContract = IERC20(hub.getContractAddress("Token"));
    }

    function addAllowedAddress(address _address) external onlyOwner {
        allowedAddresses[_address] = true;
    }

    function removeAllowedAddress(address _address) external onlyOwner {
        allowedAddresses[_address] = false;
    }

    function fundPaymaster(uint256 amount) external {
        IERC20 token = tokenContract;

        if (amount == 0) {
            revert TokenLib.ZeroTokenAmount();
        }

        if (token.allowance(msg.sender, address(this)) < amount) {
            revert TokenLib.TooLowAllowance(address(token), token.allowance(msg.sender, address(this)), amount);
        }

        if (token.balanceOf(msg.sender) < amount) {
            revert TokenLib.TooLowBalance(address(token), token.balanceOf(msg.sender), amount);
        }

        if (!tokenContract.transferFrom(msg.sender, address(this), amount)) {
            revert TokenLib.TransferFailed();
        }
    }

    function withdraw(address recipient, uint256 amount) external onlyOwner {
        _transferTokens(recipient, amount);
    }

    function coverCost(uint256 amount) external onlyAllowed {
        _transferTokens(hub.getContractAddress("StakingStorage"), amount);
    }

    function _transferTokens(address to, uint256 amount) internal {
        if (amount == 0) {
            revert TokenLib.ZeroTokenAmount();
        }

        IERC20 token = tokenContract;

        if (token.balanceOf(address(this)) < amount) {
            revert TokenLib.TooLowBalance(address(token), token.balanceOf(address(this)), amount);
        }

        if (!token.transfer(to, amount)) {
            revert TokenLib.TransferFailed();
        }
    }
}
