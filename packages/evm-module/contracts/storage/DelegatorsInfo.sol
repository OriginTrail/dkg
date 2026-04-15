// SPDX-License-Identifier: Apache-2.0

pragma solidity ^0.8.20;

import {StakingStorage} from "./StakingStorage.sol";
import {IInitializable} from "../interfaces/IInitializable.sol";
import {INamed} from "../interfaces/INamed.sol";
import {IVersioned} from "../interfaces/IVersioned.sol";
import {ContractStatus} from "../abstract/ContractStatus.sol";

contract DelegatorsInfo is INamed, IVersioned, ContractStatus, IInitializable {
    string private constant _NAME = "DelegatorsInfo";
    string private constant _VERSION = "1.0.0";

    // IdentityId => Delegators
    mapping(uint72 => address[]) public nodeDelegatorAddresses;
    // IdentityId => Delegator => Index
    mapping(uint72 => mapping(address => uint256)) public nodeDelegatorIndex;
    // IdentityId => Delegator => IsDelegator
    mapping(uint72 => mapping(address => bool)) public isDelegatorMap;
    // IdentityId => Delegator => LastClaimedEpoch
    mapping(uint72 => mapping(address => uint256)) public lastClaimedEpoch;
    // IdentityId => Delegator => RollingRewards
    mapping(uint72 => mapping(address => uint256)) public delegatorRollingRewards;
    // IdentityId => Epoch => OperatorFeeClaimed
    mapping(uint72 => mapping(uint256 => bool)) public isOperatorFeeClaimedForEpoch;
    // IdentityId => Epoch => Amount
    mapping(uint72 => mapping(uint256 => uint256)) public netNodeEpochRewards;
    // IdentityId => Epoch
    mapping(uint72 => uint256) public lastClaimedDelegatorsRewardsEpoch;
    // epoch => identityId => delegatorKey => rewards claimed status
    mapping(uint256 => mapping(uint72 => mapping(bytes32 => bool))) public hasDelegatorClaimedEpochRewards;
    // IdentityId => Delegator => HasEverDelegatedToNode
    mapping(uint72 => mapping(address => bool)) public hasEverDelegatedToNode;
    // IdentityId => Delegator => LastStakeHeldEpoch (the last epoch when delegator held stake, 0 if fully claimed)
    mapping(uint72 => mapping(address => uint256)) public lastStakeHeldEpoch;

    event DelegatorAdded(uint72 indexed identityId, address indexed delegator);
    event DelegatorRemoved(uint72 indexed identityId, address indexed delegator);
    event DelegatorLastClaimedEpochUpdated(
        uint72 indexed identityId,
        address indexed delegator,
        uint256 newLastClaimedEpoch
    );
    event DelegatorRollingRewardsUpdated(
        uint72 indexed identityId,
        address indexed delegator,
        uint256 amount,
        uint256 newTotalRollingRewards
    );
    event IsOperatorFeeClaimedForEpochUpdated(uint72 indexed identityId, uint256 indexed epoch, bool isClaimed);
    event NetNodeEpochRewardsSet(uint72 indexed identityId, uint256 indexed epoch, uint256 amount);
    event HasEverDelegatedToNodeUpdated(
        uint72 indexed identityId,
        address indexed delegator,
        bool hasEverDelegatedToNode
    );
    event LastStakeHeldEpochUpdated(uint72 indexed identityId, address indexed delegator, uint256 epoch);
    event HasDelegatorClaimedEpochRewardsUpdated(
        uint256 indexed epoch,
        uint72 indexed identityId,
        bytes32 indexed delegatorKey,
        bool claimed
    );

    // solhint-disable-next-line no-empty-blocks
    constructor(address hubAddress) ContractStatus(hubAddress) {}

    function initialize() external onlyHub {}

    function name() external pure virtual override returns (string memory) {
        return _NAME;
    }

    function version() external pure virtual override returns (string memory) {
        return _VERSION;
    }

    function addDelegator(uint72 identityId, address delegator) external onlyContracts {
        nodeDelegatorIndex[identityId][delegator] = nodeDelegatorAddresses[identityId].length;
        nodeDelegatorAddresses[identityId].push(delegator);
        isDelegatorMap[identityId][delegator] = true;

        emit DelegatorAdded(identityId, delegator);
    }

    function removeDelegator(uint72 identityId, address delegator) external onlyContracts {
        if (!isDelegatorMap[identityId][delegator]) {
            revert("Delegator not found");
        }

        uint256 indexToRemove = nodeDelegatorIndex[identityId][delegator];
        uint256 lastIndex = nodeDelegatorAddresses[identityId].length - 1;

        if (indexToRemove != lastIndex) {
            address lastDelegator = nodeDelegatorAddresses[identityId][lastIndex];
            nodeDelegatorAddresses[identityId][indexToRemove] = lastDelegator;
            nodeDelegatorIndex[identityId][lastDelegator] = indexToRemove;
        }

        nodeDelegatorAddresses[identityId].pop();
        delete nodeDelegatorIndex[identityId][delegator];
        delete isDelegatorMap[identityId][delegator];

        emit DelegatorRemoved(identityId, delegator);
    }

    function setLastClaimedEpoch(uint72 identityId, address delegator, uint256 epoch) external onlyContracts {
        lastClaimedEpoch[identityId][delegator] = epoch;
        emit DelegatorLastClaimedEpochUpdated(identityId, delegator, epoch);
    }

    function getLastClaimedEpoch(uint72 identityId, address delegator) external view returns (uint256) {
        return lastClaimedEpoch[identityId][delegator];
    }

    function setDelegatorRollingRewards(uint72 identityId, address delegator, uint256 amount) external onlyContracts {
        delegatorRollingRewards[identityId][delegator] = amount;
        emit DelegatorRollingRewardsUpdated(identityId, delegator, amount, amount);
    }

    function addDelegatorRollingRewards(uint72 identityId, address delegator, uint256 amount) external onlyContracts {
        delegatorRollingRewards[identityId][delegator] += amount;
        emit DelegatorRollingRewardsUpdated(
            identityId,
            delegator,
            amount,
            delegatorRollingRewards[identityId][delegator]
        );
    }

    function getDelegatorRollingRewards(uint72 identityId, address delegator) external view returns (uint256) {
        return delegatorRollingRewards[identityId][delegator];
    }

    function getDelegators(uint72 identityId) external view returns (address[] memory) {
        return nodeDelegatorAddresses[identityId];
    }

    function getDelegatorIndex(uint72 identityId, address delegator) external view returns (uint256) {
        return nodeDelegatorIndex[identityId][delegator];
    }

    function isNodeDelegator(uint72 identityId, address delegator) external view returns (bool) {
        return isDelegatorMap[identityId][delegator];
    }

    function setIsOperatorFeeClaimedForEpoch(uint72 identityId, uint256 epoch, bool isClaimed) external onlyContracts {
        isOperatorFeeClaimedForEpoch[identityId][epoch] = isClaimed;
        emit IsOperatorFeeClaimedForEpochUpdated(identityId, epoch, isClaimed);
    }

    function setNetNodeEpochRewards(uint72 identityId, uint256 epoch, uint256 amount) external onlyContracts {
        netNodeEpochRewards[identityId][epoch] = amount;
        emit NetNodeEpochRewardsSet(identityId, epoch, amount);
    }

    function getNetNodeEpochRewards(uint72 identityId, uint256 epoch) external view returns (uint256) {
        return netNodeEpochRewards[identityId][epoch];
    }

    function setHasDelegatorClaimedEpochRewards(
        uint256 epoch,
        uint72 identityId,
        bytes32 delegatorKey,
        bool claimed
    ) external onlyContracts {
        hasDelegatorClaimedEpochRewards[epoch][identityId][delegatorKey] = claimed;
        emit HasDelegatorClaimedEpochRewardsUpdated(epoch, identityId, delegatorKey, claimed);
    }

    function setHasEverDelegatedToNode(
        uint72 identityId,
        address delegator,
        bool _hasEverDelegatedToNode
    ) external onlyContracts {
        hasEverDelegatedToNode[identityId][delegator] = _hasEverDelegatedToNode;
        emit HasEverDelegatedToNodeUpdated(identityId, delegator, _hasEverDelegatedToNode);
    }

    function setLastStakeHeldEpoch(uint72 identityId, address delegator, uint256 epoch) external onlyContracts {
        lastStakeHeldEpoch[identityId][delegator] = epoch;
        emit LastStakeHeldEpochUpdated(identityId, delegator, epoch);
    }

    function getLastStakeHeldEpoch(uint72 identityId, address delegator) external view returns (uint256) {
        return lastStakeHeldEpoch[identityId][delegator];
    }

    function migrate(address[] memory newAddresses) external {
        StakingStorage ss = StakingStorage(hub.getContractAddress("StakingStorage"));
        for (uint256 i = 0; i < newAddresses.length; ) {
            bytes32 addressHash = keccak256(abi.encodePacked(newAddresses[i]));
            uint72[] memory delegatorNodes = ss.getDelegatorNodes(addressHash);
            for (uint256 j = 0; j < delegatorNodes.length; ) {
                if (isDelegatorMap[delegatorNodes[j]][newAddresses[i]]) {
                    unchecked {
                        j++;
                    }
                    continue;
                }
                nodeDelegatorIndex[delegatorNodes[j]][newAddresses[i]] = nodeDelegatorAddresses[delegatorNodes[j]]
                    .length;
                nodeDelegatorAddresses[delegatorNodes[j]].push(newAddresses[i]);
                isDelegatorMap[delegatorNodes[j]][newAddresses[i]] = true;

                emit DelegatorAdded(delegatorNodes[j], newAddresses[i]);

                unchecked {
                    j++;
                }
            }
            unchecked {
                i++;
            }
        }
    }
}
