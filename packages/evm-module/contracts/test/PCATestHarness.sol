// SPDX-License-Identifier: Apache-2.0

pragma solidity ^0.8.20;

import {PublishingConvictionAccount} from "../PublishingConvictionAccount.sol";

/**
 * @dev Test-only harness that exposes internal balance mutation for testing
 * closeAccount happy path. Not deployed to production networks.
 */
contract PCATestHarness is PublishingConvictionAccount {
    constructor(address hubAddress) PublishingConvictionAccount(hubAddress) {}

    function name() public pure override returns (string memory) {
        return "PCATestHarness";
    }

    /**
     * @dev Zeroes out both balances on an account so closeAccount can be tested.
     * Only usable in test environments.
     */
    function __test_drainBalances(uint256 accountId) external {
        Account storage acct = _accounts[accountId];
        acct.lockedBalance = 0;
        acct.topUpBalance = 0;
    }
}
