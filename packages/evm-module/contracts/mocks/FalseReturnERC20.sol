// SPDX-License-Identifier: Apache-2.0

pragma solidity ^0.8.20;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract FalseReturnERC20 is ERC20 {
    bool public transferReturnsFalse;
    bool public transferFromReturnsFalse;

    constructor(string memory tokenName, string memory tokenSymbol) ERC20(tokenName, tokenSymbol) {}

    function setTransferReturnsFalse(bool value) external {
        transferReturnsFalse = value;
    }

    function setTransferFromReturnsFalse(bool value) external {
        transferFromReturnsFalse = value;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        if (transferReturnsFalse) {
            return false;
        }

        return super.transfer(to, amount);
    }

    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        if (transferFromReturnsFalse) {
            return false;
        }

        return super.transferFrom(from, to, amount);
    }
}
