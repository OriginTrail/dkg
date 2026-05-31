// SPDX-License-Identifier: Apache-2.0

pragma solidity ^0.8.20;

import {HubDependent} from "../abstract/HubDependent.sol";
import {INamed} from "../interfaces/INamed.sol";
import {IVersioned} from "../interfaces/IVersioned.sol";

contract WhitelistStorage is INamed, IVersioned, HubDependent {
    string private constant _NAME = "WhitelistStorage";
    string private constant _VERSION = "10.0.2";

    event AddressWhitelisted(address indexed addr);
    event AddressBlacklisted(address indexed addr);
    event WhitelistEnabled();
    event WhitelistDisabled();

    bool public whitelistingEnabled;

    mapping(address => bool) public whitelisted;

    constructor(address hubAddress) HubDependent(hubAddress) {
        whitelistingEnabled = false;
    }

    function name() external pure virtual override returns (string memory) {
        return _NAME;
    }

    function version() external pure virtual override returns (string memory) {
        return _VERSION;
    }

    function whitelistAddress(address addr) external onlyHub {
        whitelisted[addr] = true;

        emit AddressWhitelisted(addr);
    }

    function blacklistAddress(address addr) external onlyHub {
        whitelisted[addr] = false;

        emit AddressBlacklisted(addr);
    }

    function enableWhitelist() external onlyHub {
        whitelistingEnabled = true;

        emit WhitelistEnabled();
    }

    function disableWhitelist() external onlyHub {
        whitelistingEnabled = false;

        emit WhitelistDisabled();
    }
}
