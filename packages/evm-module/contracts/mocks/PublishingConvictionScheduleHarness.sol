// SPDX-License-Identifier: Apache-2.0

pragma solidity ^0.8.20;

import {PublishingConviction} from "../PublishingConviction.sol";
import {PublishingConvictionStorage} from "../storage/PublishingConvictionStorage.sol";

/// @title PublishingConvictionScheduleHarness
/// @notice Test-only: makes an account one that PublishingConviction 10.0.8 or
///         10.1.0 scheduled. Those builds booked every billing window's unused
///         budget up front, at creation or at an older account's first touch,
///         and left `lastSettledWindow` at the lock; `scheduleInFull` does the
///         same through the contract's own per-window booking. Registered in
///         the Hub under its own name, so its storage writes pass
///         `onlyContracts`, and initialized through `Hub.forwardCall`.
contract PublishingConvictionScheduleHarness is PublishingConviction {
    // solhint-disable-next-line no-empty-blocks
    constructor(address hubAddress) PublishingConviction(hubAddress) {}

    /// @notice Book every window not yet booked, closed or not, and move the
    ///         cursor to the lock, as the 10.0.8 schedule did.
    function scheduleInFull(uint256 accountId) external {
        PublishingConvictionStorage.Account memory acct = publishingConvictionStorage.getAccount(accountId);
        _bookWindows(acct, accountId, uint40(acct.lockDurationEpochs));
    }
}
