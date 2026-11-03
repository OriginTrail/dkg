// SPDX-License-Identifier: Apache-2.0

pragma solidity ^0.8.20;

import {INamed} from "../interfaces/INamed.sol";
import {IVersioned} from "../interfaces/IVersioned.sol";
import {HubDependent} from "../abstract/HubDependent.sol";
import {ConvictionStakingStorage} from "./ConvictionStakingStorage.sol";

/**
 * @title ConvictionWithdrawalStorage
 * @notice What a withdrawn conviction position leaves to claim of the epoch
 *         that was in progress at its withdrawal. `StakingV10.withdraw`
 *         claims every epoch that has ended and deletes the position, but
 *         the position also scored in the epoch in progress, and that score
 *         counts in its node's total for the epoch. The record here keeps
 *         what `StakingV10.claimWithdrawnEpoch` needs to pay the position's
 *         share of that epoch, once it has ended, to the staker the
 *         withdrawal paid.
 *
 * What it holds, per withdrawn token id: the staker, the node and the epoch,
 * and that epoch's reward carries (`ConvictionStakingStorage.RewardCarry`),
 * the position's scores on the nodes it left earlier in the epoch by a
 * redelegation, or under a relock. The position's own score is the
 * `RandomSamplingStorage` delegator score of the node, the epoch and the key
 * `bytes32(tokenId)`, which the withdrawal settled.
 *
 * Architecture (the pattern of the other storages):
 *   - It is policy-free. Every mutator is `onlyContracts` (any Hub-registered
 *     contract, and the Hub owner): `StakingV10Ledger` writes a record at a
 *     withdrawal and deletes it at its claim, both for `StakingV10`. The one
 *     rule it keeps itself is
 *     that a token id holds one record: a second write is refused
 *     (`WithdrawalRecorded`), so a record is paid once.
 *   - It holds no TRAC: the claim pays from the vault,
 *     `ConvictionStakingStorage`. It emits no events; `StakingV10` emits
 *     them.
 *
 * Fresh state: the contract ships empty and is never upgraded in place. The
 * declaration order of the state below IS the layout: slot 0 the inherited
 * `hub`, slot 1 the records, slot 2 their carries.
 */
contract ConvictionWithdrawalStorage is INamed, IVersioned, HubDependent {
    string private constant _NAME = "ConvictionWithdrawalStorage";
    // Version history:
    //   1.0.0 — the epoch in progress at a withdrawal, kept for its claim
    //           (`StakingV10` 10.1.0).
    string private constant _VERSION = "1.0.0";

    /// @notice A withdrawn position's claim on the epoch that was in progress
    ///         at its withdrawal.
    struct Withdrawal {
        address staker; // the address the withdrawal paid, which the claim pays
        uint72 identityId; // the node the position was on
        uint40 epoch; // the epoch in progress at the withdrawal; 0 = no record
    }

    /// @notice The token id already holds a record.
    error WithdrawalRecorded(uint256 tokenId);

    /// @dev tokenId => its record.
    mapping(uint256 => Withdrawal) internal _withdrawals;
    /// @dev tokenId => the reward carries of the record's epoch.
    mapping(uint256 => ConvictionStakingStorage.RewardCarry[]) internal _carries;

    constructor(address hubAddress) HubDependent(hubAddress) {}

    function name() external pure virtual override returns (string memory) {
        return _NAME;
    }

    function version() external pure virtual override returns (string memory) {
        return _VERSION;
    }

    /// @notice Record what a withdrawn position leaves to claim of the epoch
    ///         in progress: `w`, and the carries of that epoch.
    function setWithdrawal(
        uint256 tokenId,
        Withdrawal calldata w,
        ConvictionStakingStorage.RewardCarry[] calldata carries
    ) external onlyContracts {
        Withdrawal storage stored = _withdrawals[tokenId];
        if (stored.epoch != 0) revert WithdrawalRecorded(tokenId);
        _withdrawals[tokenId] = w;
        ConvictionStakingStorage.RewardCarry[] storage list = _carries[tokenId];
        for (uint256 i; i < carries.length; i++) {
            list.push(carries[i]);
        }
    }

    /// @notice Delete a record and its carries: it has been claimed.
    function deleteWithdrawal(uint256 tokenId) external onlyContracts {
        delete _withdrawals[tokenId];
        delete _carries[tokenId];
    }

    /// @notice A token id's record and its carries; an epoch of 0 when it
    ///         has none.
    function getWithdrawal(
        uint256 tokenId
    ) external view returns (Withdrawal memory w, ConvictionStakingStorage.RewardCarry[] memory carries) {
        return (_withdrawals[tokenId], _carries[tokenId]);
    }
}
