// SPDX-License-Identifier: Apache-2.0

pragma solidity ^0.8.20;

import {HubDependent} from "./abstract/HubDependent.sol";
import {ICustodian} from "./interfaces/ICustodian.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract Guardian is HubDependent {
    event TokenTransferred(address indexed custodian, uint256 amount);
    event MisplacedEtherWithdrawn(address indexed custodian, uint256 amount);
    event MisplacedERC20Withdrawn(address indexed custodian, address tokenContract, uint256 amount);

    error ZeroAddressCustodian();
    error CustodianNotAContract(address custodian);
    error CustodianWithoutOwnersFunction(address custodian);
    error CustodianHasNoOwners(address custodian);
    error TokenTransferFailed();
    error EtherTransferFailed();
    error InvalidTokenContract(address tokenContractAddress);

    IERC20 public tokenContract;

    // solhint-disable-next-line no-empty-blocks
    constructor(address hubAddress) HubDependent(hubAddress) {}

    function initialize() public virtual onlyHub {
        tokenContract = IERC20(hub.getContractAddress("Token"));
    }

    function transferTokens(address payable custodian) external onlyHub {
        if (custodian == address(0)) {
            revert ZeroAddressCustodian();
        }

        uint256 contractSize;
        assembly {
            contractSize := extcodesize(custodian)
        }
        if (contractSize == 0) {
            revert CustodianNotAContract(custodian);
        }

        ICustodian custodianContract = ICustodian(custodian);
        bool hasOwnersFunction = false;
        try custodianContract.getOwners() returns (address[] memory owners) {
            hasOwnersFunction = true;
            if (owners.length == 0) {
                revert CustodianHasNoOwners(custodian);
            }
        } catch {
            // getOwners reverted (e.g. not ICustodian); hasOwnersFunction stays false.
        }
        if (!hasOwnersFunction) {
            revert CustodianWithoutOwnersFunction(custodian);
        }

        uint256 balanceTransferred = tokenContract.balanceOf(address(this));
        bool transactionResult = tokenContract.transfer(custodian, balanceTransferred);

        if (!transactionResult) {
            revert TokenTransferFailed();
        }

        emit TokenTransferred(custodian, balanceTransferred);
    }

    function withdrawMisplacedEther() external onlyHub {
        uint256 balance = address(this).balance;
        if (balance > 0) {
            (bool success, ) = msg.sender.call{value: balance}("");
            if (!success) {
                revert EtherTransferFailed();
            }
        }
        emit MisplacedEtherWithdrawn(msg.sender, balance);
    }

    function withdrawMisplacedTokens(address tokenContractAddress) external onlyHub {
        if (tokenContractAddress == address(tokenContract)) {
            revert InvalidTokenContract(tokenContractAddress);
        }
        IERC20 misplacedTokensContract = IERC20(tokenContractAddress);

        uint256 balance = misplacedTokensContract.balanceOf(address(this));
        if (balance > 0) {
            bool transactionResult = misplacedTokensContract.transfer(msg.sender, balance);
            if (!transactionResult) {
                revert TokenTransferFailed();
            }
        }
        emit MisplacedERC20Withdrawn(msg.sender, tokenContractAddress, balance);
    }
}
