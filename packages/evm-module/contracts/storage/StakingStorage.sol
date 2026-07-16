// SPDX-License-Identifier: Apache-2.0

pragma solidity ^0.8.20;

import {Guardian} from "../Guardian.sol";
import {StakingLib} from "../libraries/StakingLib.sol";
import {INamed} from "../interfaces/INamed.sol";
import {IVersioned} from "../interfaces/IVersioned.sol";
import {EnumerableSetLib} from "solady/src/utils/EnumerableSetLib.sol";

contract StakingStorage is INamed, IVersioned, Guardian {
    using EnumerableSetLib for EnumerableSetLib.Uint256Set;

    string private constant _NAME = "StakingStorage";
    string private constant _VERSION = "10.0.2";

    event TotalStakeUpdated(uint96 totalStake);
    event NodeStakeUpdated(uint72 indexed identityId, uint96 stake);
    event NodeRewardIndexUpdated(uint72 indexed identityId, uint256 rewardIndex);
    event NodeCumulativeEarnedRewardsUpdated(uint72 indexed identityId, uint96 cumulativeEarnedRewards);
    event NodeCumulativePaidOutRewardsUpdated(uint72 indexed identityId, uint96 cumulativePaidOutRewards);
    event DelegatorCountUpdated(uint72 indexed identityId, uint256 delegatorsCount);
    event OperatorFeeBalanceUpdated(uint72 indexed identityId, uint96 feeBalance);
    event OperatorFeeCumulativeEarnedRewardsUpdated(uint72 indexed identityId, uint96 cumulativeFeeEarnedRewards);
    event OperatorFeeCumulativePaidOutRewardsUpdated(uint72 indexed identityId, uint96 cumulativeFeePaidOutRewards);
    event DelegatorBaseStakeUpdated(uint72 indexed identityId, bytes32 indexed delegatorKey, uint96 stakeBase);
    event DelegatorIndexedStakeUpdated(uint72 indexed identityId, bytes32 indexed delegatorKey, uint96 stakeIndexed);
    event DelegatorLastRewardIndexUpdated(uint72 indexed identityId, bytes32 indexed delegatorKey, uint256 lastIndex);
    event DelegatorCumulativeEarnedRewardsUpdated(
        uint72 indexed identityId,
        bytes32 indexed delegatorKey,
        uint96 cumulativeEarnedRewards
    );
    event DelegatorCumulativePaidOutRewardsUpdated(
        uint72 indexed identityId,
        bytes32 indexed delegatorKey,
        uint96 cumulativePaidOutRewards
    );
    event DelegatorWithdrawalRequestCreated(
        uint72 indexed identityId,
        bytes32 indexed delegatorKey,
        uint96 amount,
        uint96 indexedOutAmount,
        uint256 timestamp
    );
    event DelegatorWithdrawalRequestDeleted(uint72 indexed identityId, bytes32 indexed delegatorKey);
    event OperatorFeeWithdrawalRequestCreated(
        uint72 indexed identityId,
        uint96 amount,
        uint96 indexedOutAmount,
        uint256 timestamp
    );
    event OperatorFeeWithdrawalRequestDeleted(uint72 indexed identityId);
    event StakedTokensTransferred(address indexed receiver, uint96 amount);

    uint96 private _totalStake;

    mapping(uint72 => StakingLib.NodeData) public nodes;
    mapping(uint72 => mapping(bytes32 => StakingLib.DelegatorData)) public delegators;
    mapping(uint72 => mapping(bytes32 => StakingLib.StakeWithdrawalRequest)) public withdrawals;
    mapping(uint72 => StakingLib.StakeWithdrawalRequest) public operatorFeeWithdrawals;

    mapping(bytes32 => EnumerableSetLib.Uint256Set) private delegatorNodes;

    // solhint-disable-next-line no-empty-blocks
    constructor(address hubAddress) Guardian(hubAddress) {}

    function name() external pure virtual override returns (string memory) {
        return _NAME;
    }

    function version() external pure virtual override returns (string memory) {
        return _VERSION;
    }

    // -----------------------------------------------------------------------------------------------------------------
    // Global Stake Operations
    // -----------------------------------------------------------------------------------------------------------------

    function getTotalStake() external view returns (uint96) {
        return _totalStake;
    }

    function setTotalStake(uint96 newTotalStake) external onlyContracts {
        _totalStake = newTotalStake;

        emit TotalStakeUpdated(newTotalStake);
    }

    function increaseTotalStake(uint96 addedStake) external onlyContracts {
        _totalStake += addedStake;

        emit TotalStakeUpdated(_totalStake);
    }

    function decreaseTotalStake(uint96 removedStake) external onlyContracts {
        _totalStake -= removedStake;

        emit TotalStakeUpdated(_totalStake);
    }

    // -----------------------------------------------------------------------------------------------------------------
    // Nodes Staking Data Operations
    // -----------------------------------------------------------------------------------------------------------------

    function setNodeStakeInfo(uint72 identityId, uint96 stake, uint256 rewardIndex) external onlyContracts {
        StakingLib.NodeData storage node = nodes[identityId];

        node.stake = stake;
        node.rewardIndex = rewardIndex;

        emit NodeStakeUpdated(identityId, stake);
        emit NodeRewardIndexUpdated(identityId, rewardIndex);
    }

    function getNodeData(
        uint72 identityId
    ) external view returns (uint96, uint256, uint96, uint96, uint96, uint96, uint96, uint256) {
        StakingLib.NodeData memory node = nodes[identityId];
        return (
            node.stake,
            node.rewardIndex,
            node.cumulativeEarnedRewards,
            node.cumulativePaidOutRewards,
            node.operatorFeeBalance,
            node.operatorFeeCumulativeEarnedRewards,
            node.operatorFeeCumulativePaidOutRewards,
            node.delegatorCount
        );
    }

    function getNodeStakeInfo(uint72 identityId) external view returns (uint96, uint256) {
        StakingLib.NodeData memory node = nodes[identityId];
        return (node.stake, node.rewardIndex);
    }

    function getNodeRewardsInfo(uint72 identityId) external view returns (uint96, uint96, uint96) {
        StakingLib.NodeData memory node = nodes[identityId];
        return (
            node.stake,
            node.cumulativeEarnedRewards - node.cumulativePaidOutRewards,
            node.cumulativePaidOutRewards
        );
    }

    function getNodeOperatorFeesInfo(uint72 identityId) external view returns (uint96, uint96, uint96) {
        StakingLib.NodeData memory node = nodes[identityId];
        return (
            node.operatorFeeBalance,
            node.operatorFeeCumulativeEarnedRewards - node.operatorFeeCumulativePaidOutRewards,
            node.operatorFeeCumulativePaidOutRewards
        );
    }

    function setNodeStake(uint72 identityId, uint96 newNodeStake) external onlyContracts {
        nodes[identityId].stake = newNodeStake;

        emit NodeStakeUpdated(identityId, newNodeStake);
    }

    function increaseNodeStake(uint72 identityId, uint96 addedNodeStake) external onlyContracts {
        nodes[identityId].stake += addedNodeStake;

        emit NodeStakeUpdated(identityId, nodes[identityId].stake);
    }

    function decreaseNodeStake(uint72 identityId, uint96 removedNodeStake) external onlyContracts {
        nodes[identityId].stake -= removedNodeStake;

        emit NodeStakeUpdated(identityId, nodes[identityId].stake);
    }

    function getNodeStake(uint72 identityId) external view returns (uint96) {
        return nodes[identityId].stake;
    }

    function setNodeRewardIndex(uint72 identityId, uint256 newIndex) external onlyContracts {
        nodes[identityId].rewardIndex = newIndex;

        emit NodeRewardIndexUpdated(identityId, newIndex);
    }

    function increaseNodeRewardIndex(uint72 identityId, uint256 addedIndex) external onlyContracts {
        nodes[identityId].rewardIndex += addedIndex;

        emit NodeRewardIndexUpdated(identityId, nodes[identityId].rewardIndex);
    }

    function getNodeRewardIndex(uint72 identityId) external view returns (uint256) {
        return nodes[identityId].rewardIndex;
    }

    function getNodeCumulativeEarnedRewards(uint72 identityId) external view returns (uint96) {
        return nodes[identityId].cumulativeEarnedRewards;
    }

    function setNodeCumulativeEarnedRewards(uint72 identityId, uint96 newEarnedRewards) external onlyContracts {
        nodes[identityId].cumulativeEarnedRewards = newEarnedRewards;

        emit NodeCumulativeEarnedRewardsUpdated(identityId, newEarnedRewards);
    }

    function addNodeCumulativeEarnedRewards(uint72 identityId, uint96 addedRewards) external onlyContracts {
        nodes[identityId].cumulativeEarnedRewards += addedRewards;

        emit NodeCumulativeEarnedRewardsUpdated(identityId, nodes[identityId].cumulativeEarnedRewards);
    }

    function getNodeCumulativePaidOutRewards(uint72 identityId) external view returns (uint96) {
        return nodes[identityId].cumulativePaidOutRewards;
    }

    function setNodeCumulativePaidOutRewards(uint72 identityId, uint96 newPaidOutRewards) external onlyContracts {
        nodes[identityId].cumulativePaidOutRewards = newPaidOutRewards;

        emit NodeCumulativePaidOutRewardsUpdated(identityId, newPaidOutRewards);
    }

    function addNodeCumulativePaidOutRewards(uint72 identityId, uint96 addedRewards) external onlyContracts {
        nodes[identityId].cumulativePaidOutRewards += addedRewards;

        emit NodeCumulativePaidOutRewardsUpdated(identityId, nodes[identityId].cumulativePaidOutRewards);
    }

    function setOperatorFeeBalance(uint72 identityId, uint96 newBalance) external onlyContracts {
        nodes[identityId].operatorFeeBalance = newBalance;

        emit OperatorFeeBalanceUpdated(identityId, newBalance);
    }

    function increaseOperatorFeeBalance(uint72 identityId, uint96 addedFee) external onlyContracts {
        nodes[identityId].operatorFeeBalance += addedFee;

        emit OperatorFeeBalanceUpdated(identityId, nodes[identityId].operatorFeeBalance);
    }

    function decreaseOperatorFeeBalance(uint72 identityId, uint96 removedFee) external onlyContracts {
        nodes[identityId].operatorFeeBalance -= removedFee;

        emit OperatorFeeBalanceUpdated(identityId, nodes[identityId].operatorFeeBalance);
    }

    function getOperatorFeeBalance(uint72 identityId) external view returns (uint96) {
        return nodes[identityId].operatorFeeBalance;
    }

    function setOperatorFeeCumulativeEarnedRewards(uint72 identityId, uint96 amount) external onlyContracts {
        nodes[identityId].operatorFeeCumulativeEarnedRewards = amount;

        emit OperatorFeeCumulativeEarnedRewardsUpdated(identityId, amount);
    }

    function addOperatorFeeCumulativeEarnedRewards(uint72 identityId, uint96 amount) external onlyContracts {
        nodes[identityId].operatorFeeCumulativeEarnedRewards += amount;

        emit OperatorFeeCumulativeEarnedRewardsUpdated(
            identityId,
            nodes[identityId].operatorFeeCumulativeEarnedRewards
        );
    }

    function getOperatorFeeCumulativeEarnedRewards(uint72 identityId) external view returns (uint96) {
        return nodes[identityId].operatorFeeCumulativeEarnedRewards;
    }

    function setOperatorFeeCumulativePaidOutRewards(uint72 identityId, uint96 amount) external onlyContracts {
        nodes[identityId].operatorFeeCumulativePaidOutRewards = amount;

        emit OperatorFeeCumulativePaidOutRewardsUpdated(identityId, amount);
    }

    function addOperatorFeeCumulativePaidOutRewards(uint72 identityId, uint96 amount) external onlyContracts {
        nodes[identityId].operatorFeeCumulativePaidOutRewards += amount;

        emit OperatorFeeCumulativePaidOutRewardsUpdated(
            identityId,
            nodes[identityId].operatorFeeCumulativePaidOutRewards
        );
    }

    function getOperatorFeeCumulativePaidOutRewards(uint72 identityId) external view returns (uint96) {
        return nodes[identityId].operatorFeeCumulativePaidOutRewards;
    }

    function setDelegatorCount(uint72 identityId, uint256 delegatorCount) external onlyContracts {
        nodes[identityId].delegatorCount = delegatorCount;

        emit DelegatorCountUpdated(identityId, delegatorCount);
    }

    function getDelegatorCount(uint72 identityId) external view returns (uint256) {
        return nodes[identityId].delegatorCount;
    }

    // -----------------------------------------------------------------------------------------------------------------
    // Delegators Stake Data Operations
    // -----------------------------------------------------------------------------------------------------------------

    function setDelegatorStakeInfo(
        uint72 identityId,
        bytes32 delegatorKey,
        uint96 stakeBase,
        uint96 stakeRewardIndexed
    ) external onlyContracts {
        StakingLib.DelegatorData storage delegator = delegators[identityId][delegatorKey];

        bool wasActive = (delegator.stakeBase > 0 || delegator.stakeRewardIndexed > 0);

        delegator.stakeBase = stakeBase;
        delegator.stakeRewardIndexed = stakeRewardIndexed;

        bool isActive = (stakeBase > 0 || stakeRewardIndexed > 0);

        _updateDelegatorActivity(identityId, delegatorKey, wasActive, isActive);

        emit DelegatorBaseStakeUpdated(identityId, delegatorKey, stakeBase);
        emit DelegatorIndexedStakeUpdated(identityId, delegatorKey, stakeRewardIndexed);
    }

    function getDelegatorData(
        uint72 identityId,
        bytes32 delegatorKey
    ) external view returns (uint96, uint96, uint256, uint96, uint96) {
        StakingLib.DelegatorData memory delegator = delegators[identityId][delegatorKey];
        return (
            delegator.stakeBase,
            delegator.stakeRewardIndexed,
            delegator.lastRewardIndex,
            delegator.cumulativeEarnedRewards,
            delegator.cumulativePaidOutRewards
        );
    }

    function getDelegatorStakeInfo(
        uint72 identityId,
        bytes32 delegatorKey
    ) external view returns (uint96, uint96, uint256) {
        StakingLib.DelegatorData memory delegator = delegators[identityId][delegatorKey];
        return (delegator.stakeBase, delegator.stakeRewardIndexed, delegator.lastRewardIndex);
    }

    function getDelegatorRewardsInfo(uint72 identityId, bytes32 delegatorKey) external view returns (uint96, uint96) {
        StakingLib.DelegatorData memory delegator = delegators[identityId][delegatorKey];
        return (delegator.cumulativeEarnedRewards, delegator.cumulativePaidOutRewards);
    }

    function setDelegatorStakeBase(uint72 identityId, bytes32 delegatorKey, uint96 stakeBase) external onlyContracts {
        StakingLib.DelegatorData storage delegator = delegators[identityId][delegatorKey];

        bool wasActive = (delegator.stakeBase > 0 || delegator.stakeRewardIndexed > 0);

        delegator.stakeBase = stakeBase;

        bool isActive = (delegator.stakeBase > 0 || delegator.stakeRewardIndexed > 0);

        _updateDelegatorActivity(identityId, delegatorKey, wasActive, isActive);

        emit DelegatorBaseStakeUpdated(identityId, delegatorKey, stakeBase);
    }

    function increaseDelegatorStakeBase(
        uint72 identityId,
        bytes32 delegatorKey,
        uint96 addedStake
    ) external onlyContracts {
        StakingLib.DelegatorData storage delegator = delegators[identityId][delegatorKey];

        bool wasActive = (delegator.stakeBase > 0 || delegator.stakeRewardIndexed > 0);

        delegator.stakeBase += addedStake;

        bool isActive = (delegator.stakeBase > 0 || delegator.stakeRewardIndexed > 0);

        _updateDelegatorActivity(identityId, delegatorKey, wasActive, isActive);

        emit DelegatorBaseStakeUpdated(identityId, delegatorKey, delegator.stakeBase);
    }

    function decreaseDelegatorStakeBase(
        uint72 identityId,
        bytes32 delegatorKey,
        uint96 removedStake
    ) external onlyContracts {
        StakingLib.DelegatorData storage delegator = delegators[identityId][delegatorKey];

        bool wasActive = (delegator.stakeBase > 0 || delegator.stakeRewardIndexed > 0);

        delegator.stakeBase -= removedStake;

        bool isActive = (delegator.stakeBase > 0 || delegator.stakeRewardIndexed > 0);

        _updateDelegatorActivity(identityId, delegatorKey, wasActive, isActive);

        emit DelegatorBaseStakeUpdated(identityId, delegatorKey, delegator.stakeBase);
    }

    function getDelegatorStakeBase(uint72 identityId, bytes32 delegatorKey) external view returns (uint96) {
        return delegators[identityId][delegatorKey].stakeBase;
    }

    function setDelegatorStakeRewardIndexed(
        uint72 identityId,
        bytes32 delegatorKey,
        uint96 stakeRewardIndexed
    ) external onlyContracts {
        StakingLib.DelegatorData storage delegator = delegators[identityId][delegatorKey];

        bool wasActive = (delegator.stakeBase > 0 || delegator.stakeRewardIndexed > 0);

        delegator.stakeRewardIndexed = stakeRewardIndexed;

        bool isActive = (delegator.stakeBase > 0 || delegator.stakeRewardIndexed > 0);

        _updateDelegatorActivity(identityId, delegatorKey, wasActive, isActive);

        emit DelegatorIndexedStakeUpdated(identityId, delegatorKey, stakeRewardIndexed);
    }

    function increaseDelegatorStakeRewardIndexed(
        uint72 identityId,
        bytes32 delegatorKey,
        uint96 addedStakeReward
    ) external onlyContracts {
        StakingLib.DelegatorData storage delegator = delegators[identityId][delegatorKey];

        bool wasActive = (delegator.stakeBase > 0 || delegator.stakeRewardIndexed > 0);

        delegator.stakeRewardIndexed += addedStakeReward;

        bool isActive = (delegator.stakeBase > 0 || delegator.stakeRewardIndexed > 0);

        _updateDelegatorActivity(identityId, delegatorKey, wasActive, isActive);

        emit DelegatorIndexedStakeUpdated(identityId, delegatorKey, delegator.stakeRewardIndexed);
    }

    function decreaseDelegatorStakeRewardIndexed(
        uint72 identityId,
        bytes32 delegatorKey,
        uint96 removedStakeReward
    ) external onlyContracts {
        StakingLib.DelegatorData storage delegator = delegators[identityId][delegatorKey];

        bool wasActive = (delegator.stakeBase > 0 || delegator.stakeRewardIndexed > 0);

        delegator.stakeRewardIndexed -= removedStakeReward;

        bool isActive = (delegator.stakeBase > 0 || delegator.stakeRewardIndexed > 0);

        _updateDelegatorActivity(identityId, delegatorKey, wasActive, isActive);

        emit DelegatorIndexedStakeUpdated(identityId, delegatorKey, delegator.stakeRewardIndexed);
    }

    function getDelegatorStakeRewardIndexed(uint72 identityId, bytes32 delegatorKey) external view returns (uint96) {
        return delegators[identityId][delegatorKey].stakeRewardIndexed;
    }

    function getDelegatorTotalStake(uint72 identityId, bytes32 delegatorKey) external view returns (uint96) {
        StakingLib.DelegatorData memory delegator = delegators[identityId][delegatorKey];
        return delegator.stakeBase + delegator.stakeRewardIndexed;
    }

    function setDelegatorLastRewardIndex(
        uint72 identityId,
        bytes32 delegatorKey,
        uint256 lastRewardIndex
    ) external onlyContracts {
        delegators[identityId][delegatorKey].lastRewardIndex = lastRewardIndex;

        emit DelegatorLastRewardIndexUpdated(identityId, delegatorKey, lastRewardIndex);
    }

    function getDelegatorLastRewardIndex(uint72 identityId, bytes32 delegatorKey) external view returns (uint256) {
        return delegators[identityId][delegatorKey].lastRewardIndex;
    }

    function getDelegatorNodes(bytes32 delegatorKey) external view returns (uint72[] memory) {
        EnumerableSetLib.Uint256Set storage nodesSet = delegatorNodes[delegatorKey];

        uint256 length = nodesSet.length();
        uint72[] memory nodeList = new uint72[](length);
        for (uint256 i = 0; i < length; i++) {
            nodeList[i] = uint72(nodesSet.at(i));
        }
        return nodeList;
    }

    function getDelegatorNodesCount(bytes32 delegatorKey) external view returns (uint256) {
        return delegatorNodes[delegatorKey].length();
    }

    function getDelegatorNodesIn(
        bytes32 delegatorKey,
        uint256 start,
        uint256 end
    ) external view returns (uint72[] memory) {
        EnumerableSetLib.Uint256Set storage nodesSet = delegatorNodes[delegatorKey];

        uint72[] memory nodeList = new uint72[](end - start);
        for (uint256 i = start; i < end; i++) {
            nodeList[i - start] = uint72(nodesSet.at(i));
        }
        return nodeList;
    }

    function isDelegatingToNode(uint72 identityId, bytes32 delegatorKey) external view returns (bool) {
        return delegatorNodes[delegatorKey].contains(identityId);
    }

    function addDelegatorCumulativeEarnedRewards(
        uint72 identityId,
        bytes32 delegatorKey,
        uint96 amount
    ) external onlyContracts {
        delegators[identityId][delegatorKey].cumulativeEarnedRewards += amount;

        emit DelegatorCumulativeEarnedRewardsUpdated(
            identityId,
            delegatorKey,
            delegators[identityId][delegatorKey].cumulativeEarnedRewards
        );
    }

    function getDelegatorCumulativeEarnedRewards(
        uint72 identityId,
        bytes32 delegatorKey
    ) external view returns (uint96) {
        return delegators[identityId][delegatorKey].cumulativeEarnedRewards;
    }

    function addDelegatorCumulativePaidOutRewards(
        uint72 identityId,
        bytes32 delegatorKey,
        uint96 amount
    ) external onlyContracts {
        delegators[identityId][delegatorKey].cumulativePaidOutRewards += amount;

        emit DelegatorCumulativePaidOutRewardsUpdated(
            identityId,
            delegatorKey,
            delegators[identityId][delegatorKey].cumulativePaidOutRewards
        );
    }

    function getDelegatorCumulativePaidOutRewards(
        uint72 identityId,
        bytes32 delegatorKey
    ) external view returns (uint96) {
        return delegators[identityId][delegatorKey].cumulativePaidOutRewards;
    }

    // -----------------------------------------------------------------------------------------------------------------
    // Delegators Stake Withdrawals Operations
    // -----------------------------------------------------------------------------------------------------------------

    function createDelegatorWithdrawalRequest(
        uint72 identityId,
        bytes32 delegatorKey,
        uint96 amount,
        uint96 indexedOutAmount,
        uint256 timestamp
    ) external onlyContracts {
        withdrawals[identityId][delegatorKey] = StakingLib.StakeWithdrawalRequest(amount, indexedOutAmount, timestamp);

        emit DelegatorWithdrawalRequestCreated(identityId, delegatorKey, amount, indexedOutAmount, timestamp);
    }

    function getDelegatorWithdrawalRequest(
        uint72 identityId,
        bytes32 delegatorKey
    ) external view returns (uint96, uint96, uint256) {
        StakingLib.StakeWithdrawalRequest memory wr = withdrawals[identityId][delegatorKey];
        return (wr.amount, wr.indexedOutAmount, wr.timestamp);
    }

    function deleteDelegatorWithdrawalRequest(uint72 identityId, bytes32 delegatorKey) external onlyContracts {
        delete withdrawals[identityId][delegatorKey];

        emit DelegatorWithdrawalRequestDeleted(identityId, delegatorKey);
    }

    function getDelegatorWithdrawalRequestAmount(
        uint72 identityId,
        bytes32 delegatorKey
    ) external view returns (uint96) {
        return withdrawals[identityId][delegatorKey].amount;
    }

    function getDelegatorWithdrawalRequestIndexedOutAmount(
        uint72 identityId,
        bytes32 delegatorKey
    ) external view returns (uint96) {
        return withdrawals[identityId][delegatorKey].indexedOutAmount;
    }

    function getDelegatorWithdrawalRequestTimestamp(
        uint72 identityId,
        bytes32 delegatorKey
    ) external view returns (uint256) {
        return withdrawals[identityId][delegatorKey].timestamp;
    }

    function delegatorWithdrawalRequestExists(uint72 identityId, bytes32 delegatorKey) external view returns (bool) {
        return withdrawals[identityId][delegatorKey].amount != 0;
    }

    // -----------------------------------------------------------------------------------------------------------------
    // Node Operators Stake Withdrawals Operations
    // -----------------------------------------------------------------------------------------------------------------

    function createOperatorFeeWithdrawalRequest(
        uint72 identityId,
        uint96 amount,
        uint96 indexedOutAmount,
        uint256 timestamp
    ) external onlyContracts {
        operatorFeeWithdrawals[identityId] = StakingLib.StakeWithdrawalRequest(amount, indexedOutAmount, timestamp);

        emit OperatorFeeWithdrawalRequestCreated(identityId, amount, indexedOutAmount, timestamp);
    }

    function deleteOperatorFeeWithdrawalRequest(uint72 identityId) external onlyContracts {
        delete operatorFeeWithdrawals[identityId];

        emit OperatorFeeWithdrawalRequestDeleted(identityId);
    }

    function getOperatorFeeWithdrawalRequest(uint72 identityId) external view returns (uint96, uint96, uint256) {
        StakingLib.StakeWithdrawalRequest memory wr = operatorFeeWithdrawals[identityId];
        return (wr.amount, wr.indexedOutAmount, wr.timestamp);
    }

    function getOperatorFeeWithdrawalRequestAmount(uint72 identityId) external view returns (uint96) {
        return operatorFeeWithdrawals[identityId].amount;
    }

    function getOperatorFeeWithdrawalRequestIndexedOutAmount(uint72 identityId) external view returns (uint96) {
        return operatorFeeWithdrawals[identityId].indexedOutAmount;
    }

    function getOperatorFeeWithdrawalRequestTimestamp(uint72 identityId) external view returns (uint256) {
        return operatorFeeWithdrawals[identityId].timestamp;
    }

    function operatorFeeWithdrawalRequestExists(uint72 identityId) external view returns (bool) {
        return operatorFeeWithdrawals[identityId].amount != 0;
    }

    // -----------------------------------------------------------------------------------------------------------------
    // Token Related Operations
    // -----------------------------------------------------------------------------------------------------------------

    function transferStake(address receiver, uint96 stakeAmount) external onlyContracts {
        // Slither: bare `.transfer()` flagged as unchecked-transfer because
        // the standard ERC20 contract returns a `bool`. The TRAC token —
        // the only token plugged into this storage by Hub config — reverts
        // on failure rather than returning false, so the return-value
        // discard is safe in practice. This is the V8 legacy outflow path
        // (V10 traffic goes through ConvictionStakingStorage.transferStake
        // which uses SafeERC20). Kept directive'd rather than rewritten
        // because changing the V8 path risks invalidating already-deployed
        // V8→V10 migration scripts that snapshot storage layout.
        // slither-disable-next-line unchecked-transfer
        tokenContract.transfer(receiver, stakeAmount);

        emit StakedTokensTransferred(receiver, stakeAmount);
    }

    // -----------------------------------------------------------------------------------------------------------------
    // Internal Operations
    // -----------------------------------------------------------------------------------------------------------------

    function _updateDelegatorActivity(uint72 identityId, bytes32 delegatorKey, bool wasActive, bool isActive) internal {
        if (!wasActive && isActive) {
            delegatorNodes[delegatorKey].add(identityId);
            nodes[identityId].delegatorCount += 1;

            emit DelegatorCountUpdated(identityId, nodes[identityId].delegatorCount);
        } else if (wasActive && !isActive) {
            delegatorNodes[delegatorKey].remove(identityId);
            nodes[identityId].delegatorCount -= 1;

            emit DelegatorCountUpdated(identityId, nodes[identityId].delegatorCount);
        }
    }
}
