// SPDX-License-Identifier: Apache-2.0

pragma solidity ^0.8.20;

import {Paymaster} from "./Paymaster.sol";
import {ContractStatus} from "../abstract/ContractStatus.sol";
import {INamed} from "../interfaces/INamed.sol";
import {IVersioned} from "../interfaces/IVersioned.sol";

contract PaymasterManager is INamed, IVersioned, ContractStatus {
    string private constant _NAME = "PaymasterManager";
    string private constant _VERSION = "1.0.0";

    event PaymasterDeployed(address indexed deployer, address indexed paymasterAddress);

    mapping(address => bool) public validPaymasters;
    mapping(address => address[]) public deployedPaymasters;

    constructor(address hubAddress) ContractStatus(hubAddress) {}

    function name() public pure virtual returns (string memory) {
        return _NAME;
    }

    function version() external pure virtual returns (string memory) {
        return _VERSION;
    }

    function deployPaymaster() external {
        address paymasterAddress = address(new Paymaster(address(hub)));

        validPaymasters[paymasterAddress] = true;
        deployedPaymasters[msg.sender].push(paymasterAddress);

        emit PaymasterDeployed(msg.sender, paymasterAddress);
    }
}
