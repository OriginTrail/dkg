// SPDX-License-Identifier: Apache-2.0

pragma solidity ^0.8.20;

import {DelegatorsInfo} from "../storage/DelegatorsInfo.sol";
import {ContractStatus} from "../abstract/ContractStatus.sol";


// V8 DelegatorsInfo: same fields as V10 except no delegatorLockEpochs / delegatorLockStartEpoch.
// Public mappings generate getter functions; getDelegators() is an explicit view returning address[].
interface IOldDelegatorsInfo {
    function getDelegators(uint72 identityId) external view returns (address[] memory);
    function isDelegatorMap(uint72 identityId, address delegator) external view returns (bool);
    function nodeDelegatorIndex(uint72 identityId, address delegator) external view returns (uint256);
    function lastClaimedEpoch(uint72 identityId, address delegator) external view returns (uint256);
    function delegatorRollingRewards(uint72 identityId, address delegator) external view returns (uint256);
    function isOperatorFeeClaimedForEpoch(uint72 identityId, uint256 epoch) external view returns (bool);
    function netNodeEpochRewards(uint72 identityId, uint256 epoch) external view returns (uint256);
    function lastClaimedDelegatorsRewardsEpoch(uint72 identityId) external view returns (uint256);
    function hasDelegatorClaimedEpochRewards(
        uint256 epoch,
        uint72 identityId,
        bytes32 delegatorKey
    ) external view returns (bool);
    function hasEverDelegatedToNode(uint72 identityId, address delegator) external view returns (bool);
    function lastStakeHeldEpoch(uint72 identityId, address delegator) external view returns (uint256);
}

/// @title MigratorV10Staking
/// @notice Copies DelegatorsInfo state from V8 (no conviction lock fields) to V10 (with conviction
///         lock fields). The V10 DelegatorsInfo is a fresh deployment with empty state; this
///         contract reads from the old instance and writes into the new one.
///
/// IMPORTANT: This contract must be registered in the Hub (hub.setContractAddress) BEFORE calling
/// any migration function, because the new DelegatorsInfo setters carry `onlyContracts` modifiers
/// that restrict callers to Hub-registered contracts.
contract MigratorV10Staking is ContractStatus {
    IOldDelegatorsInfo public oldDelegatorsInfo;
    DelegatorsInfo public newDelegatorsInfo;

    constructor(address hubAddress) ContractStatus(hubAddress) {}

    modifier onlyOwnerOrMultiSigOwner() {
        _checkOwnerOrMultiSigOwner();
        _;
    }

    function setOldDelegatorsInfo(address _oldDelegatorsInfo) external onlyOwnerOrMultiSigOwner {
        require(_oldDelegatorsInfo != address(0), "Zero address");
        oldDelegatorsInfo = IOldDelegatorsInfo(_oldDelegatorsInfo);
    }

    function setNewDelegatorsInfo(address _newDelegatorsInfo) external onlyOwnerOrMultiSigOwner {
        require(_newDelegatorsInfo != address(0), "Zero address");
        newDelegatorsInfo = DelegatorsInfo(_newDelegatorsInfo);
    }

    /// @notice Migrate all delegator-level and epoch-scoped state for a single node.
    ///         Conviction lock fields (delegatorLockEpochs, delegatorLockStartEpoch) default to 0.
    /// @param identityId  The node's identity ID
    /// @param startEpoch  First epoch (inclusive) for epoch-scoped data
    /// @param endEpoch    Last epoch (inclusive) for epoch-scoped data
    function migrateNode(uint72 identityId, uint256 startEpoch, uint256 endEpoch) external onlyOwnerOrMultiSigOwner {
        address[] memory delegators = oldDelegatorsInfo.getDelegators(identityId);

        for (uint256 i = 0; i < delegators.length; ) {
            address delegator = delegators[i];

            if (!newDelegatorsInfo.isDelegatorMap(identityId, delegator)) {
                newDelegatorsInfo.addDelegator(identityId, delegator);
            }

            uint256 claimed = oldDelegatorsInfo.lastClaimedEpoch(identityId, delegator);
            if (claimed != 0) {
                newDelegatorsInfo.setLastClaimedEpoch(identityId, delegator, claimed);
            }

            uint256 rolling = oldDelegatorsInfo.delegatorRollingRewards(identityId, delegator);
            if (rolling != 0) {
                newDelegatorsInfo.setDelegatorRollingRewards(identityId, delegator, rolling);
            }

            bool everDelegated = oldDelegatorsInfo.hasEverDelegatedToNode(identityId, delegator);
            if (everDelegated) {
                newDelegatorsInfo.setHasEverDelegatedToNode(identityId, delegator, true);
            }

            uint256 lastHeld = oldDelegatorsInfo.lastStakeHeldEpoch(identityId, delegator);
            if (lastHeld != 0) {
                newDelegatorsInfo.setLastStakeHeldEpoch(identityId, delegator, lastHeld);
            }

            unchecked {
                i++;
            }
        }

        uint256 lastClaimedDelegators = oldDelegatorsInfo.lastClaimedDelegatorsRewardsEpoch(identityId);
        if (lastClaimedDelegators != 0) {
            newDelegatorsInfo.setLastClaimedDelegatorsRewardsEpoch(identityId, lastClaimedDelegators);
        }

        for (uint256 epoch = startEpoch; epoch <= endEpoch; ) {
            bool feeClaimed = oldDelegatorsInfo.isOperatorFeeClaimedForEpoch(identityId, epoch);
            if (feeClaimed) {
                newDelegatorsInfo.setIsOperatorFeeClaimedForEpoch(identityId, epoch, true);
            }

            uint256 rewards = oldDelegatorsInfo.netNodeEpochRewards(identityId, epoch);
            if (rewards != 0) {
                newDelegatorsInfo.setNetNodeEpochRewards(identityId, epoch, rewards);
            }

            unchecked {
                epoch++;
            }
        }
    }

    /// @notice Migrate hasDelegatorClaimedEpochRewards for a batch of delegators in a single epoch.
    ///         Separated from migrateNode because the mapping is keyed by (epoch, identityId, delegatorKey)
    ///         and cannot be iterated on-chain.
    /// @param epoch       The epoch to migrate claim status for
    /// @param identityId  The node's identity ID
    /// @param delegators  Delegator addresses whose claim flags should be copied
    function migrateEpochRewardsClaimed(
        uint256 epoch,
        uint72 identityId,
        address[] calldata delegators
    ) external onlyOwnerOrMultiSigOwner {
        for (uint256 i = 0; i < delegators.length; ) {
            bytes32 delegatorKey = keccak256(abi.encodePacked(delegators[i]));

            bool claimed = oldDelegatorsInfo.hasDelegatorClaimedEpochRewards(epoch, identityId, delegatorKey);
            if (claimed) {
                newDelegatorsInfo.setHasDelegatorClaimedEpochRewards(epoch, identityId, delegatorKey, true);
            }

            unchecked {
                i++;
            }
        }
    }

    function _checkOwnerOrMultiSigOwner() internal view virtual {
        address hubOwner = hub.owner();
        require(
            msg.sender == hubOwner || msg.sender == address(hub),
            "Only Hub Owner or Hub can call"
        );
    }
}
