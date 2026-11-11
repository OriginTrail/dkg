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
 *     rule it keeps itself is that a token id holds one record: a second
 *     write is refused (`WithdrawalRecorded`), so a record is paid once.
 *   - Every field has a view, and the carries a narrow setter beside the
 *     writes the ledger makes (`setWithdrawal` and `deleteWithdrawal` write a
 *     record with its carries): `addRewardCarry` adds one to a recorded token
 *     id, once per slot it points at and at most 32, as
 *     `ConvictionStakingStorage` keeps a position's carries, so no slot is
 *     paid twice and a claim stays bounded, and `clearRewardCarries` removes
 *     them. `setWithdrawal` with no carries writes a record alone. So a later
 *     logic version reads and writes all of this state without a new
 *     storage, which would start empty.
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
    //           (`StakingV10` 10.1.0). Every field has a view, the carries by
    //           count and index too (`rewardCarryCount`, `rewardCarryAt`), and
    //           the carries a narrow setter (`addRewardCarry`,
    //           `clearRewardCarries`).
    string private constant _VERSION = "1.0.0";

    /// @dev The most carries a record takes through `addRewardCarry`: the
    ///      bound `ConvictionStakingStorage.MAX_REWARD_CARRIES` puts on a
    ///      position's, whose carries a withdrawal records.
    uint256 internal constant _MAX_REWARD_CARRIES = 32;

    /// @notice A withdrawn position's claim on the epoch that was in progress
    ///         at its withdrawal.
    struct Withdrawal {
        address staker; // the address the withdrawal paid, which the claim pays
        uint72 identityId; // the node the position was on
        uint40 epoch; // the epoch in progress at the withdrawal; 0 = no record
    }

    /// @notice The token id already holds a record.
    error WithdrawalRecorded(uint256 tokenId);
    /// @notice The token id holds no record, so it takes no carry.
    error WithdrawalNotRecorded(uint256 tokenId);
    /// @notice The record holds 32 carries already, the most a position holds
    ///         (`ConvictionStakingStorage.MAX_REWARD_CARRIES`).
    error RewardCarriesFull(uint256 tokenId);

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

    /// @notice Add carry `c` to `tokenId`'s record, once: a carry that points
    ///         at the same node, epoch and delegator key as one the record
    ///         holds is not added again, as `ConvictionStakingStorage` keeps a
    ///         position's carries.
    /// @dev    It refuses a token id with no record (`WithdrawalNotRecorded`),
    ///         so no carry outlives its record into a later one, and a record
    ///         that holds 32 carries, the most a position holds
    ///         (`RewardCarriesFull`). The caller keeps the carry's epoch at the
    ///         record's or before it, as a withdrawal does: the claim waits for
    ///         the record's epoch alone to end, so a later epoch could be split
    ///         before it had ended. `setWithdrawal` remains the normal path.
    function addRewardCarry(uint256 tokenId, ConvictionStakingStorage.RewardCarry calldata c) external onlyContracts {
        if (_withdrawals[tokenId].epoch == 0) revert WithdrawalNotRecorded(tokenId);
        ConvictionStakingStorage.RewardCarry[] storage list = _carries[tokenId];
        uint256 n = list.length;
        for (uint256 i; i < n; i++) {
            ConvictionStakingStorage.RewardCarry storage held = list[i];
            if (held.identityId == c.identityId && held.epoch == c.epoch && held.delegatorKey == c.delegatorKey) {
                return;
            }
        }
        if (n >= _MAX_REWARD_CARRIES) revert RewardCarriesFull(tokenId);
        list.push(c);
    }

    /// @notice Remove every carry of `tokenId`'s record; the record stays.
    function clearRewardCarries(uint256 tokenId) external onlyContracts {
        delete _carries[tokenId];
    }

    /// @notice A token id's record and its carries; an epoch of 0 when it
    ///         has none.
    function getWithdrawal(
        uint256 tokenId
    ) external view returns (Withdrawal memory w, ConvictionStakingStorage.RewardCarry[] memory carries) {
        return (_withdrawals[tokenId], _carries[tokenId]);
    }

    /// @notice How many carries `tokenId`'s record holds.
    function rewardCarryCount(uint256 tokenId) external view returns (uint256) {
        return _carries[tokenId].length;
    }

    /// @notice Carry `index` of `tokenId`'s record. Reverts past its carries.
    function rewardCarryAt(
        uint256 tokenId,
        uint256 index
    ) external view returns (ConvictionStakingStorage.RewardCarry memory) {
        return _carries[tokenId][index];
    }
}
