// SPDX-License-Identifier: Apache-2.0

pragma solidity ^0.8.20;

import {ShardingTable} from "./ShardingTable.sol";
import {Ask} from "./Ask.sol";
import {IdentityStorage} from "./storage/IdentityStorage.sol";
import {ParametersStorage} from "./storage/ParametersStorage.sol";
import {ProfileStorage} from "./storage/ProfileStorage.sol";
import {ShardingTableStorage} from "./storage/ShardingTableStorage.sol";
import {StakingStorage} from "./storage/StakingStorage.sol";
import {DelegatorsInfo} from "./storage/DelegatorsInfo.sol";
import {ContractStatus} from "./abstract/ContractStatus.sol";
import {IInitializable} from "./interfaces/IInitializable.sol";
import {INamed} from "./interfaces/INamed.sol";
import {IVersioned} from "./interfaces/IVersioned.sol";
import {ProfileLib} from "./libraries/ProfileLib.sol";
import {ShardingTableLib} from "./libraries/ShardingTableLib.sol";
import {StakingLib} from "./libraries/StakingLib.sol";
import {TokenLib} from "./libraries/TokenLib.sol";
import {IdentityLib} from "./libraries/IdentityLib.sol";
import {Permissions} from "./libraries/Permissions.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {RandomSamplingStorage} from "./storage/RandomSamplingStorage.sol";
import {Chronos} from "./storage/Chronos.sol";
import {EpochStorage} from "./storage/EpochStorage.sol";

contract Staking is INamed, IVersioned, ContractStatus, IInitializable {
    string private constant _NAME = "Staking";
    string private constant _VERSION = "1.0.1";
    uint256 public constant SCALE18 = 1e18;
    uint256 private constant EPOCH_POOL_INDEX = 1;

    Ask public askContract;
    ShardingTableStorage public shardingTableStorage;
    ShardingTable public shardingTableContract;
    IdentityStorage public identityStorage;
    ParametersStorage public parametersStorage;
    ProfileStorage public profileStorage;
    StakingStorage public stakingStorage;
    DelegatorsInfo public delegatorsInfo;
    IERC20 public tokenContract;
    RandomSamplingStorage public randomSamplingStorage;
    Chronos public chronos;
    EpochStorage public epochStorage;

    // solhint-disable-next-line no-empty-blocks
    constructor(address hubAddress) ContractStatus(hubAddress) {}

    modifier onlyAdmin(uint72 identityId) {
        _checkAdmin(identityId);
        _;
    }

    modifier profileExists(uint72 identityId) {
        _checkProfileExists(identityId);
        _;
    }

    /**
     * @dev Initializes the contract by connecting to all required Hub dependencies
     * Called once during deployment to set up contract references
     * Only the Hub can call this function
     */
    function initialize() external onlyHub {
        askContract = Ask(hub.getContractAddress("Ask"));
        shardingTableStorage = ShardingTableStorage(hub.getContractAddress("ShardingTableStorage"));
        shardingTableContract = ShardingTable(hub.getContractAddress("ShardingTable"));
        identityStorage = IdentityStorage(hub.getContractAddress("IdentityStorage"));
        parametersStorage = ParametersStorage(hub.getContractAddress("ParametersStorage"));
        profileStorage = ProfileStorage(hub.getContractAddress("ProfileStorage"));
        stakingStorage = StakingStorage(hub.getContractAddress("StakingStorage"));
        delegatorsInfo = DelegatorsInfo(hub.getContractAddress("DelegatorsInfo"));
        tokenContract = IERC20(hub.getContractAddress("Token"));
        randomSamplingStorage = RandomSamplingStorage(hub.getContractAddress("RandomSamplingStorage"));
        chronos = Chronos(hub.getContractAddress("Chronos"));
        epochStorage = EpochStorage(hub.getContractAddress("EpochStorageV8"));
    }

    /**
     * @dev Returns the name of this contract
     * Used for contract identification and versioning
     */
    function name() external pure virtual override returns (string memory) {
        return _NAME;
    }

    /**
     * @dev Returns the version of this contract
     * Used for contract identification and versioning
     */
    function version() external pure virtual override returns (string memory) {
        return _VERSION;
    }

    /**
     * @dev Stakes tokens to a specific node, increasing both delegator and node stake
     * Transfers tokens from caller to StakingStorage, updates sharding table and active set
     * Validates token allowance, balance, and maximum stake limits
     * Must settle any pending previous epoch rewards before changing stake
     * @param identityId The node to stake to (must exist)
     * @param addedStake Amount of tokens to stake (must be > 0)
     */
    function stake(uint72 identityId, uint96 addedStake) external profileExists(identityId) {
        _stake(identityId, addedStake);
    }

    function _stake(uint72 identityId, uint96 addedStake) internal {
        IERC20 token = tokenContract;
        StakingStorage ss = stakingStorage;

        if (addedStake == 0) {
            revert TokenLib.ZeroTokenAmount();
        }
        if (token.allowance(msg.sender, address(this)) < addedStake) {
            revert TokenLib.TooLowAllowance(address(token), token.allowance(msg.sender, address(this)), addedStake);
        }
        if (token.balanceOf(msg.sender) < addedStake) {
            revert TokenLib.TooLowBalance(address(token), token.balanceOf(msg.sender), addedStake);
        }

        // Validate that all claims have been settled for the node before changing stake
        _validateDelegatorEpochClaims(identityId, msg.sender);

        bytes32 delegatorKey = _getDelegatorKey(msg.sender);
        uint256 currentEpoch = chronos.getCurrentEpoch();
        // settle all pending score changes for the node's delegator
        _prepareForStakeChange(currentEpoch, identityId, delegatorKey);

        uint96 delegatorStakeBase = stakingStorage.getDelegatorStakeBase(identityId, delegatorKey);

        uint96 totalNodeStakeBefore = ss.getNodeStake(identityId);
        uint96 totalNodeStakeAfter = totalNodeStakeBefore + addedStake;
        if (totalNodeStakeAfter > parametersStorage.maximumStake()) {
            revert StakingLib.MaximumStakeExceeded(parametersStorage.maximumStake());
        }
        ss.setDelegatorStakeBase(identityId, delegatorKey, delegatorStakeBase + addedStake);
        ss.setNodeStake(identityId, totalNodeStakeAfter);
        ss.increaseTotalStake(addedStake);

        _addNodeToShardingTable(identityId, totalNodeStakeAfter);

        askContract.recalculateActiveSet();

        // Check if this is first time staking
        _manageDelegatorStatus(identityId, msg.sender);

        token.transferFrom(msg.sender, address(ss), addedStake);
    }

    /**
     * @dev Moves stake from one node to another without unstaking/restaking process
     * Validates both source and destination nodes exist and all claims are settled
     * Updates stake amounts, sharding table, and active set for both nodes
     * Handles delegator removal if all stake is moved from source node and no score was earned in the current epoch
     * Must settle any pending previous epoch rewards before redelegating
     * @param fromIdentityId Source node to move stake from
     * @param toIdentityId Destination node to move stake to (cannot be same as source)
     * @param stakeAmount Amount of stake to move (must be > 0 and <= delegator's stake)
     */
    function redelegate(
        uint72 fromIdentityId,
        uint72 toIdentityId,
        uint96 stakeAmount
    ) external profileExists(fromIdentityId) profileExists(toIdentityId) {
        StakingStorage ss = stakingStorage;
        Ask ask = askContract;

        if (fromIdentityId == toIdentityId) {
            revert("Cannot redelegate to the same node");
        }

        if (stakeAmount == 0) {
            revert TokenLib.ZeroTokenAmount();
        }

        bytes32 delegatorKey = _getDelegatorKey(msg.sender);
        uint256 currentEpoch = chronos.getCurrentEpoch();

        // Validate that all claims have been settled for the source and destination nodes before changing stake
        _validateDelegatorEpochClaims(fromIdentityId, msg.sender);
        _validateDelegatorEpochClaims(toIdentityId, msg.sender);

        // Prepare for stake change on the source and destination nodes
        uint256 fromDelegatorEpochScore18 = _prepareForStakeChange(currentEpoch, fromIdentityId, delegatorKey);
        // settle all pending score changes for the node's delegator
        _prepareForStakeChange(currentEpoch, toIdentityId, delegatorKey);

        uint96 fromDelegatorStakeBase = ss.getDelegatorStakeBase(fromIdentityId, delegatorKey);

        if (stakeAmount > fromDelegatorStakeBase) {
            revert StakingLib.WithdrawalExceedsStake(fromDelegatorStakeBase, stakeAmount);
        }

        uint96 maxStake = parametersStorage.maximumStake();
        if (ss.getNodeStake(toIdentityId) + stakeAmount > maxStake) {
            revert StakingLib.MaximumStakeExceeded(maxStake);
        }

        // calculate new delegator stake base on the source node
        uint96 newFromDelegatorStakeBase = fromDelegatorStakeBase - stakeAmount;

        // calculate new total node stake on the source node
        uint96 totalFromNodeStakeBefore = ss.getNodeStake(fromIdentityId);
        uint96 totalFromNodeStakeAfter = totalFromNodeStakeBefore - stakeAmount;

        // calculate new total node stake on the destination node
        uint96 totalToNodeStakeBefore = ss.getNodeStake(toIdentityId);
        uint96 totalToNodeStakeAfter = totalToNodeStakeBefore + stakeAmount;

        // update the delegator stake base and the total node stake on the source node
        ss.setDelegatorStakeBase(fromIdentityId, delegatorKey, newFromDelegatorStakeBase);
        ss.setNodeStake(fromIdentityId, totalFromNodeStakeAfter);

        _removeNodeFromShardingTable(fromIdentityId, totalFromNodeStakeAfter);

        // update the delegator stake base and the total node stake on the destination node
        ss.increaseDelegatorStakeBase(toIdentityId, delegatorKey, stakeAmount);
        ss.setNodeStake(toIdentityId, totalToNodeStakeAfter);

        _addNodeToShardingTable(toIdentityId, totalToNodeStakeAfter);

        ask.recalculateActiveSet();

        // Check if all stake is being removed from the source node
        if (newFromDelegatorStakeBase == 0) {
            _handleDelegatorRemovalOnZeroStake(fromIdentityId, msg.sender, fromDelegatorEpochScore18, currentEpoch);
        }

        _manageDelegatorStatus(toIdentityId, msg.sender);
    }

    /**
     * @dev Initiates withdrawal process for staked tokens with time delay
     * For nodes above maximum stake: tokens are transferred immediately
     * For other nodes: creates withdrawal request with delay period
     * Updates sharding table/active set
     * Removes delegator from node if all stake is withdrawn and no score was earned in the current epoch
     * Must settle any pending previous epoch rewards before withdrawing
     * @param identityId Node to withdraw stake from (must exist)
     * @param removedStake Amount to withdraw (must be > 0 and <= delegator's stake)
     */
    function requestWithdrawal(uint72 identityId, uint96 removedStake) external profileExists(identityId) {
        StakingStorage ss = stakingStorage;

        if (removedStake == 0) {
            revert TokenLib.ZeroTokenAmount();
        }

        // Validate that all claims have been settled for the node before changing stake
        _validateDelegatorEpochClaims(identityId, msg.sender);

        bytes32 delegatorKey = _getDelegatorKey(msg.sender);
        uint256 currentEpoch = chronos.getCurrentEpoch();

        // settle all pending score changes for the node's delegator
        uint256 delegatorEpochScore18 = _prepareForStakeChange(currentEpoch, identityId, delegatorKey);

        uint96 delegatorStakeBase = ss.getDelegatorStakeBase(identityId, delegatorKey);
        if (removedStake > delegatorStakeBase) {
            revert StakingLib.WithdrawalExceedsStake(delegatorStakeBase, removedStake);
        }

        uint96 newDelegatorStakeBase = delegatorStakeBase - removedStake;
        uint96 totalNodeStakeBefore = ss.getNodeStake(identityId);
        uint96 totalNodeStakeAfter = totalNodeStakeBefore - removedStake;

        ss.setDelegatorStakeBase(identityId, delegatorKey, newDelegatorStakeBase);
        ss.setNodeStake(identityId, totalNodeStakeAfter);
        ss.decreaseTotalStake(removedStake);

        _removeNodeFromShardingTable(identityId, totalNodeStakeAfter);
        askContract.recalculateActiveSet();

        if (newDelegatorStakeBase == 0) {
            _handleDelegatorRemovalOnZeroStake(identityId, msg.sender, delegatorEpochScore18, currentEpoch);
        }

        if (totalNodeStakeAfter >= parametersStorage.maximumStake()) {
            ss.transferStake(msg.sender, removedStake);
        } else {
            (uint96 prevDelegatorWithdrawalAmount, , ) = ss.getDelegatorWithdrawalRequest(identityId, delegatorKey);
            ss.createDelegatorWithdrawalRequest(
                identityId,
                delegatorKey,
                removedStake + prevDelegatorWithdrawalAmount,
                0, // no indexed rewards any more
                block.timestamp + parametersStorage.stakeWithdrawalDelay()
            );
        }
    }

    /**
     * @dev Completes withdrawal process after the delay period has passed
     * Transfers the withdrawn tokens from StakingStorage to the delegator
     * Validates that withdrawal was initiated and delay period is complete
     * Removes the withdrawal request after successful transfer
     * @param identityId Node that withdrawal was requested from (must exist)
     */
    function finalizeWithdrawal(uint72 identityId) external profileExists(identityId) {
        StakingStorage ss = stakingStorage;

        bytes32 delegatorKey = _getDelegatorKey(msg.sender);
        (uint96 withdrawalAmount, , uint256 withdrawalReleaseTimestamp) = ss.getDelegatorWithdrawalRequest(
            identityId,
            delegatorKey
        );

        if (withdrawalAmount == 0) {
            revert StakingLib.WithdrawalWasntInitiated();
        }
        if (block.timestamp < withdrawalReleaseTimestamp) {
            revert StakingLib.WithdrawalPeriodPending(block.timestamp, withdrawalReleaseTimestamp);
        }

        ss.deleteDelegatorWithdrawalRequest(identityId, delegatorKey);
        ss.transferStake(msg.sender, withdrawalAmount);
    }

    /**
     * @dev Cancels pending withdrawal and restakes the tokens back to the node
     * If restaking would exceed maximum stake, partial amount is restaked and rest remains pending
     * Settles rewards and updates sharding table/active set
     * Validates that withdrawal was initiated and no rewards are pending claim
     * Must settle any pending previous epoch rewards before cancelling withdrawal
     * @param identityId Node to cancel withdrawal from (must exist)
     */
    function cancelWithdrawal(uint72 identityId) external profileExists(identityId) {
        StakingStorage ss = stakingStorage;

        bytes32 delegatorKey = _getDelegatorKey(msg.sender);
        (uint96 prevDelegatorWithdrawalAmount /*unused*/, , uint256 withdrawalReleaseTimestamp) = ss
            .getDelegatorWithdrawalRequest(identityId, delegatorKey);
        if (prevDelegatorWithdrawalAmount == 0) revert StakingLib.WithdrawalWasntInitiated();

        // Validate that all claims have been settled for the node before changing stake
        _validateDelegatorEpochClaims(identityId, msg.sender);

        // settle all pending score changes for the node's delegator
        _prepareForStakeChange(chronos.getCurrentEpoch(), identityId, delegatorKey);

        uint96 nodeStakeBefore = ss.getNodeStake(identityId);
        uint96 maxStake = parametersStorage.maximumStake();
        uint96 restake;
        uint96 keepPending = 0;

        if (nodeStakeBefore + prevDelegatorWithdrawalAmount > maxStake) {
            restake = maxStake - nodeStakeBefore; // might be zero
            keepPending = prevDelegatorWithdrawalAmount - restake;
        } else {
            restake = prevDelegatorWithdrawalAmount;
        }

        if (restake > 0) {
            uint96 newBase = ss.getDelegatorStakeBase(identityId, delegatorKey) + restake;

            ss.setDelegatorStakeBase(identityId, delegatorKey, newBase);
            ss.setNodeStake(identityId, nodeStakeBefore + restake);
            ss.increaseTotalStake(restake);

            // the delegator might have had zero stake before the cancel
            // If delegator was inactive and is now restaking, reset their lastStakeHeldEpoch
            _manageDelegatorStatus(identityId, msg.sender);
        }

        if (keepPending == 0) {
            ss.deleteDelegatorWithdrawalRequest(identityId, delegatorKey); // request fully cancelled
        } else {
            ss.createDelegatorWithdrawalRequest(
                identityId,
                delegatorKey,
                keepPending,
                0, // indexed-out rewards no longer exist
                withdrawalReleaseTimestamp // keep the original release time
            );
        }

        _addNodeToShardingTable(identityId, ss.getNodeStake(identityId));
        askContract.recalculateActiveSet();
    }

    /**
     * @dev Converts accumulated operator fees back into stake for the node
     * Only the node admin can perform this operation
     * Settles rewards, validates fee balance, and updates stake amounts
     * Updates sharding table and active set after restaking
     * Must settle any pending previous epoch rewards before restaking
     * @param identityId Node to restake fees for (caller must be admin)
     * @param addedStake Amount of fees to convert to stake (must be > 0 and <= fee balance)
     */
    function restakeOperatorFee(uint72 identityId, uint96 addedStake) external onlyAdmin(identityId) {
        StakingStorage ss = stakingStorage;

        if (addedStake == 0) {
            revert TokenLib.ZeroTokenAmount();
        }

        uint96 oldOperatorFeeBalance = ss.getOperatorFeeBalance(identityId);
        if (addedStake > oldOperatorFeeBalance) {
            revert StakingLib.AmountExceedsOperatorFeeBalance(oldOperatorFeeBalance, addedStake);
        }

        // Validate that all claims have been settled for the node before changing stake
        _validateDelegatorEpochClaims(identityId, msg.sender);
        bytes32 delegatorKey = _getDelegatorKey(msg.sender);
        // settle all pending score changes for the node's delegator
        _prepareForStakeChange(chronos.getCurrentEpoch(), identityId, delegatorKey);

        ss.setOperatorFeeBalance(identityId, oldOperatorFeeBalance - addedStake);

        uint96 delegatorStakeBase = ss.getDelegatorStakeBase(identityId, delegatorKey);
        uint96 totalNodeStakeBefore = ss.getNodeStake(identityId);
        uint96 totalNodeStakeAfter = totalNodeStakeBefore + addedStake;

        if (totalNodeStakeAfter > parametersStorage.maximumStake()) {
            revert StakingLib.MaximumStakeExceeded(parametersStorage.maximumStake());
        }

        ss.setDelegatorStakeBase(identityId, delegatorKey, delegatorStakeBase + addedStake);
        ss.setNodeStake(identityId, totalNodeStakeAfter);
        ss.addOperatorFeeCumulativePaidOutRewards(identityId, addedStake); // bookkeeping
        ss.increaseTotalStake(addedStake);

        _manageDelegatorStatus(identityId, msg.sender);

        _addNodeToShardingTable(identityId, totalNodeStakeAfter);
        askContract.recalculateActiveSet();
    }

    /**
     * @dev Initiates withdrawal process for accumulated operator fees
     * Only the node admin can perform this operation
     * Creates withdrawal request with delay period before funds can be claimed
     * Validates that sufficient fees are available for withdrawal
     * @param identityId Node to withdraw fees from (caller must be admin)
     * @param withdrawalAmount Amount of fees to withdraw (must be > 0 and <= fee balance)
     */
    function requestOperatorFeeWithdrawal(uint72 identityId, uint96 withdrawalAmount) external onlyAdmin(identityId) {
        StakingStorage ss = stakingStorage;

        if (withdrawalAmount == 0) {
            revert TokenLib.ZeroTokenAmount();
        }

        // Check if there's an existing withdrawal request
        uint96 existingRequestAmount = ss.getOperatorFeeWithdrawalRequestAmount(identityId);
        uint96 currentOperatorFeeBalance = ss.getOperatorFeeBalance(identityId);

        // If there's an existing request, add it back to the balance first
        if (existingRequestAmount > 0) {
            currentOperatorFeeBalance += existingRequestAmount;
        }

        // Calculate total request amount (existing + new)
        uint96 totalRequestAmount = existingRequestAmount + withdrawalAmount;

        if (totalRequestAmount > currentOperatorFeeBalance) {
            revert StakingLib.AmountExceedsOperatorFeeBalance(currentOperatorFeeBalance, totalRequestAmount);
        }

        uint256 withdrawalReleaseTimestamp = block.timestamp + parametersStorage.stakeWithdrawalDelay();
        // Deduct total request amount from balance
        ss.setOperatorFeeBalance(identityId, currentOperatorFeeBalance - totalRequestAmount);
        // Create request with total amount (existing + new)
        ss.createOperatorFeeWithdrawalRequest(
            identityId,
            totalRequestAmount,
            /*indexed*/ 0,
            withdrawalReleaseTimestamp
        );
    }

    /**
     * @dev Completes operator fee withdrawal after delay period has passed
     * Only the node admin can perform this operation
     * Transfers the withdrawn fees to the admin and updates bookkeeping
     * Validates that withdrawal was initiated and delay period is complete
     * @param identityId Node to finalize fee withdrawal for (caller must be admin)
     */
    function finalizeOperatorFeeWithdrawal(uint72 identityId) external onlyAdmin(identityId) {
        StakingStorage ss = stakingStorage;

        (uint96 operatorFeeWithdrawalAmount, , uint256 withdrawalReleaseTimestamp) = ss.getOperatorFeeWithdrawalRequest(
            identityId
        );
        if (operatorFeeWithdrawalAmount == 0) revert StakingLib.WithdrawalWasntInitiated();
        if (block.timestamp < withdrawalReleaseTimestamp)
            revert StakingLib.WithdrawalPeriodPending(block.timestamp, withdrawalReleaseTimestamp);

        ss.deleteOperatorFeeWithdrawalRequest(identityId);
        ss.addOperatorFeeCumulativePaidOutRewards(identityId, operatorFeeWithdrawalAmount);
        ss.transferStake(msg.sender, operatorFeeWithdrawalAmount);
    }

    /**
     * @dev Cancels pending operator fee withdrawal and returns fees to balance
     * Only the node admin can perform this operation
     * Validates that withdrawal was initiated and restores the fee balance
     * No delay period restrictions apply for cancellation
     * @param identityId Node to cancel fee withdrawal for (caller must be admin)
     */
    function cancelOperatorFeeWithdrawal(uint72 identityId) external onlyAdmin(identityId) {
        StakingStorage ss = stakingStorage;

        uint96 operatorFeeWithdrawalAmount = ss.getOperatorFeeWithdrawalRequestAmount(identityId);
        if (operatorFeeWithdrawalAmount == 0) {
            revert StakingLib.WithdrawalWasntInitiated();
        }

        ss.deleteOperatorFeeWithdrawalRequest(identityId);
        ss.increaseOperatorFeeBalance(identityId, operatorFeeWithdrawalAmount);
    }

    /**
     * @dev Claims rewards for a delegator for a specific epoch. Claiming is not the same as withdrawing.
     * Claiming adds delegator's rewards to their stake. Withdrawing takes delegator's stake out of the system.
     * Handles operator fee distribution and delegator reward calculation
     * Must claim epochs in sequential order starting from last claimed + 1
     * If more than one epoch rewards are pending, the rewards are accumulated in rolling rewards
     * Automatically restakes rewards if no other epoch rewards are pending
     * Updates delegator status and handles removal when appropriate
     * @param identityId Node to which delegator has delegated (must exist)
     * @param epoch Epoch to claim rewards for (must be finalized and in sequence)
     * @param delegator Address of the delegator to claim for (must be a node delegator)
     */
    function claimDelegatorRewards(
        uint72 identityId,
        uint256 epoch,
        address delegator
    ) public profileExists(identityId) {
        uint256 currentEpoch = chronos.getCurrentEpoch();
        require(epoch < currentEpoch, "Epoch not finalised");

        // Cannot claim rewards for a delegator that is not a node delegator
        require(delegatorsInfo.isNodeDelegator(identityId, delegator), "Delegator not found");

        uint256 lastClaimed = delegatorsInfo.getLastClaimedEpoch(identityId, delegator);
        if (lastClaimed == 0) {
            uint256 v81ReleaseEpoch = parametersStorage.v81ReleaseEpoch();
            delegatorsInfo.setLastClaimedEpoch(identityId, delegator, v81ReleaseEpoch - 1);
            lastClaimed = v81ReleaseEpoch - 1;
        }

        if (lastClaimed == currentEpoch - 1) {
            revert("Already claimed all finalised epochs");
        }

        if (epoch <= lastClaimed) {
            revert("Epoch already claimed");
        }

        if (epoch > lastClaimed + 1) {
            revert("Must claim older epochs first");
        }

        bytes32 delegatorKey = _getDelegatorKey(delegator);
        require(
            !delegatorsInfo.hasDelegatorClaimedEpochRewards(epoch, identityId, delegatorKey),
            "Already claimed rewards for this epoch"
        );

        // settle all pending score changes for the node's delegator
        uint256 delegatorScore18 = _prepareForStakeChange(epoch, identityId, delegatorKey);
        uint256 nodeScore18 = randomSamplingStorage.getNodeEpochScore(epoch, identityId);
        uint256 reward;

        // If nodeScore18 = 0, rewards are 0 too
        if (nodeScore18 > 0) {
            // netNodeRewards (rewards for node's delegators) = grossNodeRewards - operator fee
            uint256 netNodeRewards;
            if (!delegatorsInfo.isOperatorFeeClaimedForEpoch(identityId, epoch)) {
                // Operator fee has not been claimed for this epoch, calculate it
                uint256 allNodesScore18 = randomSamplingStorage.getAllNodesEpochScore(epoch);
                if (allNodesScore18 > 0) {
                    uint256 grossNodeRewards = (epochStorage.getEpochPool(EPOCH_POOL_INDEX, epoch) * nodeScore18) /
                        allNodesScore18;
                    uint96 operatorFeeAmount = uint96(
                        (grossNodeRewards * profileStorage.getLatestOperatorFeePercentage(identityId)) /
                            parametersStorage.maxOperatorFee()
                    );
                    netNodeRewards = grossNodeRewards - operatorFeeAmount;
                    // Mark the operator fee as claimed for this epoch
                    delegatorsInfo.setIsOperatorFeeClaimedForEpoch(identityId, epoch, true);
                    // Set node's delegators net rewards for this epoch so we don't have to calculate it again
                    delegatorsInfo.setNetNodeEpochRewards(identityId, epoch, netNodeRewards);
                    stakingStorage.increaseOperatorFeeBalance(identityId, operatorFeeAmount);
                }
            } else {
                // Operator fee has been claimed for this epoch already, use the previously calculated node's delegators net rewards for this epoch
                netNodeRewards = delegatorsInfo.getNetNodeEpochRewards(identityId, epoch);
            }

            reward = (delegatorScore18 * netNodeRewards) / nodeScore18;
        }

        // If the operator fee flag has not been set for the epoch (because it had no score), set it now.
        // This ensures that Profile.updateOperatorFee is not blocked by rewardless epochs.
        if (!delegatorsInfo.isOperatorFeeClaimedForEpoch(identityId, epoch)) {
            delegatorsInfo.setIsOperatorFeeClaimedForEpoch(identityId, epoch, true);
        }

        // update state even when reward is zero
        // Mark the delegator's rewards as claimed for this epoch
        delegatorsInfo.setHasDelegatorClaimedEpochRewards(epoch, identityId, delegatorKey, true);
        uint256 lastClaimedEpoch = delegatorsInfo.getLastClaimedEpoch(identityId, delegator);
        delegatorsInfo.setLastClaimedEpoch(identityId, delegator, epoch);

        // Check if this completes all required claims and reset lastStakeHeldEpoch
        uint256 lastStakeHeldEpoch = delegatorsInfo.getLastStakeHeldEpoch(identityId, delegator);
        if (lastStakeHeldEpoch > 0 && epoch >= lastStakeHeldEpoch) {
            // They've now claimed all rewards they're entitled to, reset the tracker
            delegatorsInfo.setLastStakeHeldEpoch(identityId, delegator, 0);

            // Check if they should be removed from delegators list
            if (reward == 0 && stakingStorage.getDelegatorStakeBase(identityId, delegatorKey) == 0) {
                delegatorsInfo.removeDelegator(identityId, delegator);
            }
        }

        uint256 rolling = delegatorsInfo.getDelegatorRollingRewards(identityId, delegator);

        if (reward == 0 && rolling == 0) return;

        // if there are still older epochs pending, accumulate; otherwise restake immediately
        if ((currentEpoch - 1) - lastClaimedEpoch > 1) {
            delegatorsInfo.setDelegatorRollingRewards(identityId, delegator, rolling + reward);
        } else {
            uint96 total = uint96(reward + rolling);
            delegatorsInfo.setDelegatorRollingRewards(identityId, delegator, 0);
            stakingStorage.increaseDelegatorStakeBase(identityId, delegatorKey, total);
            stakingStorage.increaseNodeStake(identityId, total);
            stakingStorage.increaseTotalStake(total);
        }
        //Should it increase on roling rewards or on stakeBaseIncrease only?
        stakingStorage.addDelegatorCumulativeEarnedRewards(identityId, delegatorKey, uint96(reward));
    }

    /**
     * @dev Claims rewards for multiple delegators across multiple epochs in batch
     * Calls claimDelegatorRewards internally for each epoch-delegator combination
     * Provides gas-efficient way to process multiple reward claims
     * All standard reward claiming rules and validations apply
     * @param identityId Node to claim rewards from (must exist)
     * @param epochs Array of epochs to claim for (each must be valid for claiming)
     * @param delegators Array of delegator addresses (each must be a node delegator)
     */
    function batchClaimDelegatorRewards(
        uint72 identityId,
        uint256[] memory epochs,
        address[] memory delegators
    ) external profileExists(identityId) {
        for (uint256 i = 0; i < epochs.length; i++) {
            for (uint256 j = 0; j < delegators.length; j++) {
                claimDelegatorRewards(identityId, epochs[i], delegators[j]);
            }
        }
    }

    /**
     * @dev Internal function to validate that delegator has claimed all required epoch rewards
     * Ensures delegators claim rewards before changing stake to prevent reward loss
     * Handles special cases for new delegators and those with zero stake
     * Auto-advances claim state when no rewards exist for previous epoch
     * @param identityId Node to validate claims for
     * @param delegator Address of delegator to validate
     */
    function _validateDelegatorEpochClaims(uint72 identityId, address delegator) internal {
        bytes32 delegatorKey = _getDelegatorKey(delegator);
        uint256 currentEpoch = chronos.getCurrentEpoch();
        uint256 previousEpoch = currentEpoch - 1;

        if (delegatorsInfo.hasEverDelegatedToNode(identityId, delegator)) {
            // If delegator has delegated to the node before, and has removed all their stake from the node at some point
            if (stakingStorage.getDelegatorStakeBase(identityId, delegatorKey) == 0) {
                uint256 lastStakeHeldEpoch = delegatorsInfo.getLastStakeHeldEpoch(identityId, delegator);
                // If lastStakeHeldEpoch > 0 and < currentEpoch, delegator has unclaimed rewards for a past epoch
                if (lastStakeHeldEpoch > 0 && lastStakeHeldEpoch < currentEpoch) {
                    revert("Must claim rewards up to the lastStakeHeldEpoch before changing stake");
                }
                // If lastStakeHeldEpoch == currentEpoch, rewards aren't claimable yet - allow operation
                // If lastStakeHeldEpoch == 0, delegator claimed all rewards they are entitled to
                delegatorsInfo.setLastClaimedEpoch(identityId, delegator, previousEpoch);
            }
        } else {
            // delegator is delegating to a node for the first time ever, set the last claimed epoch to the previous epoch
            delegatorsInfo.setHasEverDelegatedToNode(identityId, delegator, true);
            delegatorsInfo.setLastClaimedEpoch(identityId, delegator, previousEpoch);
        }

        uint256 lastClaimedEpoch = delegatorsInfo.getLastClaimedEpoch(identityId, delegator);

        // If delegator is up to date with claims, no validation needed
        if (lastClaimedEpoch == previousEpoch) {
            return;
        }

        // Check if delegator has multiple unclaimed epochs
        if (lastClaimedEpoch < previousEpoch - 1) {
            revert("Must claim all previous epoch rewards before changing stake");
        }

        // Delegator has exactly one unclaimed epoch (previousEpoch)
        // Check if there are actually rewards to claim for that epoch
        uint256 delegatorScore18 = randomSamplingStorage.getEpochNodeDelegatorScore(
            previousEpoch,
            identityId,
            delegatorKey
        );

        uint256 nodeScorePerStake36 = randomSamplingStorage.getNodeEpochScorePerStake(previousEpoch, identityId);

        uint256 delegatorLastSettledScorePerStake36 = randomSamplingStorage
            .getDelegatorLastSettledNodeEpochScorePerStake(previousEpoch, identityId, delegatorKey);

        // If no rewards exist for this delegator in the previous epoch, auto-advance their claim state
        if (delegatorScore18 == 0 && nodeScorePerStake36 == delegatorLastSettledScorePerStake36) {
            delegatorsInfo.setLastClaimedEpoch(identityId, delegator, previousEpoch);
            return;
        }

        // Delegator has unclaimed rewards that must be claimed first
        revert("Must claim the previous epoch rewards before changing stake");
    }

    function validateDelegatorEpochClaims(uint72 identityId, address delegator) external onlyContracts {
        _validateDelegatorEpochClaims(identityId, delegator);
    }

    /**
     * @dev Internal function to settle delegator rewards before stake changes
     * Calculates and applies newly earned score for the delegator in the epoch
     * Updates delegator's last settled score-per-stake index to current value
     * Handles edge cases for delegators with zero stake
     * @param epoch Epoch to settle score for
     * @param identityId Node to settle score for
     * @param delegatorKey Keccak256 hash of delegator address
     * @return delegatorEpochScore Total score for the delegator in the epoch after settlement
     */
    function _prepareForStakeChange(
        uint256 epoch,
        uint72 identityId,
        bytes32 delegatorKey
    ) internal returns (uint256 delegatorEpochScore) {
        // 1. Current "score-per-stake"
        uint256 nodeScorePerStake36 = randomSamplingStorage.getNodeEpochScorePerStake(epoch, identityId);

        uint256 currentDelegatorScore18 = randomSamplingStorage.getEpochNodeDelegatorScore(
            epoch,
            identityId,
            delegatorKey
        );

        // 2. Last index at which this delegator was settled
        uint256 delegatorLastSettledNodeEpochScorePerStake36 = randomSamplingStorage
            .getDelegatorLastSettledNodeEpochScorePerStake(epoch, identityId, delegatorKey);

        // Nothing new to settle
        if (nodeScorePerStake36 == delegatorLastSettledNodeEpochScorePerStake36) {
            return currentDelegatorScore18;
        }

        uint96 stakeBase = stakingStorage.getDelegatorStakeBase(identityId, delegatorKey);

        // If the delegator has no stake, just bump the index and exit
        if (stakeBase == 0) {
            randomSamplingStorage.setDelegatorLastSettledNodeEpochScorePerStake(
                epoch,
                identityId,
                delegatorKey,
                nodeScorePerStake36
            );
            return currentDelegatorScore18;
        }
        // 4. Newly earned score for this delegator in the epoch
        uint256 scorePerStakeDiff36 = nodeScorePerStake36 - delegatorLastSettledNodeEpochScorePerStake36;
        uint256 scoreEarned18 = (uint256(stakeBase) * scorePerStakeDiff36) / SCALE18;

        // 5. Persist results
        if (scoreEarned18 > 0) {
            randomSamplingStorage.addToEpochNodeDelegatorScore(epoch, identityId, delegatorKey, scoreEarned18);
        }

        randomSamplingStorage.setDelegatorLastSettledNodeEpochScorePerStake(
            epoch,
            identityId,
            delegatorKey,
            nodeScorePerStake36
        );

        return currentDelegatorScore18 + scoreEarned18;
    }

    function prepareForStakeChange(
        uint256 epoch,
        uint72 identityId,
        bytes32 delegatorKey
    ) external onlyContracts returns (uint256 delegatorEpochScore) {
        return _prepareForStakeChange(epoch, identityId, delegatorKey);
    }

    /**
     * @dev Internal function to manage delegator registration and status tracking
     * Adds delegator to node's delegator list if not already registered
     * Marks delegator as having ever delegated to the node (for claim validation)
     * Resets lastStakeHeldEpoch when delegator becomes active again
     * @param identityId Node to manage delegator status for
     * @param delegator Address of the delegator
     */
    function _manageDelegatorStatus(uint72 identityId, address delegator) internal {
        if (!delegatorsInfo.isNodeDelegator(identityId, delegator)) {
            delegatorsInfo.addDelegator(identityId, delegator);
        }
        // If operator was inactive and is now restaking fees, reset their lastStakeHeldEpoch
        uint256 lastStakeHeldEpoch = delegatorsInfo.getLastStakeHeldEpoch(identityId, delegator);
        if (lastStakeHeldEpoch > 0) {
            delegatorsInfo.setLastStakeHeldEpoch(identityId, delegator, 0);
        }
    }

    /**
     * @dev Internal function to add node to sharding table when stake requirements are met
     * Only adds node if it doesn't exist and has minimum required stake
     * Validates that sharding table isn't full before adding
     * @param identityId Node to potentially add to sharding table
     * @param newStake Current stake amount for the node
     */
    function _addNodeToShardingTable(uint72 identityId, uint96 newStake) internal {
        ShardingTableStorage sts = shardingTableStorage;
        ParametersStorage params = parametersStorage;

        if (!sts.nodeExists(identityId) && newStake >= params.minimumStake()) {
            if (sts.nodesCount() >= params.shardingTableSizeLimit()) {
                revert ShardingTableLib.ShardingTableIsFull();
            }
            shardingTableContract.insertNode(identityId);
        }
    }

    /**
     * @dev Internal function to remove node from sharding table when stake falls below minimum
     * Only removes node if it exists and stake is below minimum threshold
     * @param identityId Node to potentially remove from sharding table
     * @param newStake Current stake amount for the node
     */
    function _removeNodeFromShardingTable(uint72 identityId, uint96 newStake) internal {
        if (shardingTableStorage.nodeExists(identityId) && newStake < parametersStorage.minimumStake()) {
            shardingTableContract.removeNode(identityId);
        }
    }

    /**
     * @dev Internal function to validate that caller is an admin of the specified node
     * Checks if caller's address has admin key purpose for the identity
     * Used by functions that require node admin permissions
     * @param identityId Node identity to check admin rights for
     */
    function _checkAdmin(uint72 identityId) internal view virtual {
        if (!identityStorage.keyHasPurpose(identityId, _getDelegatorKey(msg.sender), IdentityLib.ADMIN_KEY)) {
            revert Permissions.OnlyProfileAdminFunction(msg.sender);
        }
    }

    /**
     * @dev Internal function to validate that a node profile exists
     * Used by modifiers and functions to ensure operations target valid nodes
     * @param identityId Node identity to check existence for
     */
    function _checkProfileExists(uint72 identityId) internal view virtual {
        if (!profileStorage.profileExists(identityId)) {
            revert ProfileLib.ProfileDoesntExist(identityId);
        }
    }

    /**
     * @dev Internal function to handle delegator cleanup when stake reaches zero
     * If delegator earned score in current epoch: keeps them for future reward claims
     * If no score earned: removes delegator from node immediately
     * Prevents loss of rewards while optimizing storage usage
     * @param identityId Node to handle delegator removal for
     * @param delegator Address of delegator with zero stake
     * @param delegatorEpochScore18 Score earned by delegator in current epoch
     * @param currentEpoch Current epoch number
     */
    function _handleDelegatorRemovalOnZeroStake(
        uint72 identityId,
        address delegator,
        uint256 delegatorEpochScore18,
        uint256 currentEpoch
    ) internal {
        // Don't remove delegator immediately - they might still be eligible for rewards in current epoch
        if (delegatorEpochScore18 > 0) {
            // Delegator earned score in current epoch (can claim), keep them for future reward claims
            delegatorsInfo.setLastStakeHeldEpoch(identityId, delegator, currentEpoch);
        } else {
            // No score earned in current epoch, safe to remove immediately
            delegatorsInfo.removeDelegator(identityId, delegator);
        }
    }

    /**
     * @dev Helper function to get delegator key from address
     * @param delegator Address to convert to key
     * @return bytes32 hash of the delegator address
     */
    function _getDelegatorKey(address delegator) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(delegator));
    }

    // ========================================================================
    // V10 Conviction Multiplier — Discrete Tiers
    // ========================================================================

    /**
     * @notice Compute the conviction multiplier for a delegator's lock duration.
     * Discrete tiers (lockEpochs → multiplier):
     *   0 = invalid (returns 0), 1 = 1.0x, ≥2 = 1.5x, ≥3 = 2.0x,
     *   ≥6 = 3.5x, ≥12 = 6.0x.
     * Values between tiers snap DOWN to the nearest tier.
     * @param lockEpochs Lock duration in epochs (1 epoch ≈ 30 days)
     * @return multiplier18 Multiplier scaled by 1e18 (e.g. 6e18 = 6x)
     */
    function convictionMultiplier(uint40 lockEpochs) public pure returns (uint256 multiplier18) {
        if (lockEpochs == 0) return 0;
        if (lockEpochs >= 12) return 6 * SCALE18;
        if (lockEpochs >= 6) return 35 * SCALE18 / 10; // 3.5x
        if (lockEpochs >= 3) return 2 * SCALE18;
        if (lockEpochs >= 2) return 15 * SCALE18 / 10; // 1.5x
        return SCALE18; // lockEpochs == 1 → 1.0x base
    }

    /**
     * @notice Get the conviction multiplier for a specific delegator on a node.
     * @dev Returns SCALE18 (1x) for all delegators. No per-delegator lock state
     *      is currently tracked in `Staking`; callers requiring multiplier data
     *      should read from the appropriate staking-position contract instead.
     * @return multiplier18 SCALE18 (1x).
     */
    function getDelegatorConvictionMultiplier(
        uint72 /* identityId */,
        address /* delegator */
    ) external pure returns (uint256 multiplier18) {
        return SCALE18;
    }

    // ========================================================================
    // V10 Two-Layer Staking Wire — NFT-backed stake recording
    // ========================================================================

    /**
     * @notice Emitted when an NFT-backed stake is recorded via the two-layer
     *         wire. `tokenId` doubles as the StakingStorage delegator key
     *         (`bytes32(tokenId)`), disjoint from the V8 legacy
     *         `keccak256(delegator)` key space.
     */
    event StakeRecorded(
        uint256 indexed tokenId,
        uint72 indexed identityId,
        uint96 amount,
        uint40 lockEpochs,
        address indexed caller
    );

    /**
     * @notice V10 permissioned entry for recording NFT-backed stake into
     *         `StakingStorage`. Callable ONLY by the Hub-registered
     *         `DKGStakingConvictionNFT` contract.
     *
     * @dev Source: V10 implementation plan Phase 4 ("two-layer staking
     *      wire") — see `.ai/v10-implementation-plan.md` §"Phase 4 —
     *      `Staking._recordStake` permissioned internal entry".
     *
     *      Delegator key scheme: `bytes32(tokenId)`, disjoint from the V8
     *      legacy `keccak256(abi.encodePacked(delegator))` key space. This is
     *      what allows multiple NFT positions for the same (delegator, node)
     *      pair to be settled independently.
     *
     *      Trust model (grill-me-decisions.md — "Staker Conviction Flow"):
     *      this function is pure on-chain accounting and performs NO token
     *      transfer. The resolved flow is:
     *         user -approve-> DKGStakingConvictionNFT
     *         user -> NFT.createConviction(...)
     *         NFT  -transferFrom(user, stakingStorage, amount)-> StakingStorage
     *         NFT  -> Staking._recordStake(...)  // this function
     *      TRAC flows user → StakingStorage in ONE hop and never sits in the
     *      NFT contract (grill-me: "TRAC should go to StakingStorage at
     *      creation time, not sit in NFT contract" / "Stakers always get
     *      their TRAC because it's already in StakingStorage from day
     *      one"). This entry therefore trusts the caller to have already
     *      moved TRAC before invoking it; the trust boundary is enforced
     *      by the double gate (`onlyContracts` + explicit
     *      `DKGStakingConvictionNFT` identity check) and by the fact that
     *      the only permitted caller is a Hub-registered, audited contract.
     *      Any future caller added to the Hub under that name inherits the
     *      same obligation: move the TRAC first, then call.
     *
     *      Gate: `onlyContracts` ensures the caller is a Hub-registered
     *      contract; the explicit `msg.sender` check pins the caller to the
     *      DKGStakingConvictionNFT contract specifically, so no other
     *      Hub-registered contract can spoof NFT-backed stake. The
     *      `profileExists` modifier mirrors the V8 `stake()` guard and
     *      prevents phantom nodes — without it `_addNodeToShardingTable`
     *      would happily insert a ghost node at `sha256("")` for any
     *      unregistered `identityId`.
     *
     *      The leading underscore in the function name reflects its semantic
     *      role as the internal entry of the two-layer wire, even though the
     *      visibility is `external` so `DKGStakingConvictionNFT` can call it
     *      cross-contract.
     *
     * @param tokenId     NFT position id — also the delegator key (bytes32(tokenId))
     * @param identityId  Target node (must be an existing profile)
     * @param amount      Stake amount in TRAC (>0)
     * @param lockEpochs  Conviction lock duration (recorded in the event only;
     *                    authoritative lock data lives in `ConvictionStakingStorage`)
     */
    function _recordStake(
        uint256 tokenId,
        uint72 identityId,
        uint96 amount,
        uint40 lockEpochs
    ) external onlyContracts profileExists(identityId) {
        if (msg.sender != hub.getContractAddress("DKGStakingConvictionNFT")) {
            revert StakingLib.OnlyConvictionNFT();
        }
        if (amount == 0) {
            revert TokenLib.ZeroTokenAmount();
        }

        StakingStorage ss = stakingStorage;
        bytes32 delegatorKey = bytes32(tokenId);

        // Freshness invariant: reject replays of the same tokenId on ANY
        // node. V10 treats each NFT as a create-once, one-position entity
        // (Phase 0d removed the legacy `increaseStake` top-up path as a
        // gaming vector — every additional stake must be a new NFT with
        // its own conviction commitment, and an NFT is bound to exactly
        // one node for its lifetime). Without a global guard, a buggy or
        // malicious caller could:
        //   - replay on the SAME node → `+= amount` writes would
        //     double-count `nodeStake`/`totalStake` while
        //     `setDelegatorStakeBase` overwrote the delegator base back
        //     to the latest amount, corrupting accounting by the
        //     inflated delta; or
        //   - replay on a DIFFERENT node → the per-(node, key) bucket
        //     would be fresh, so a per-node guard would miss it, and
        //     the same tokenId would end up staked on two nodes at once
        //     — semantic violation, double-pays rewards.
        // StakingStorage already maintains `delegatorNodes[bytes32(key)]`
        // via `_updateDelegatorActivity` on every `setDelegatorStakeBase`
        // write, so `getDelegatorNodesCount(delegatorKey)` is the
        // authoritative global-scope check: non-zero iff this tokenId is
        // currently registered on ANY node. Zero gas overhead vs. the
        // per-node read it replaces.
        if (ss.getDelegatorNodesCount(delegatorKey) != 0) {
            revert StakingLib.TokenIdAlreadyRecorded(tokenId, identityId);
        }

        uint96 maxStake = parametersStorage.maximumStake();
        uint96 totalNodeStakeAfter = ss.getNodeStake(identityId) + amount;
        if (totalNodeStakeAfter > maxStake) {
            revert StakingLib.MaximumStakeExceeded(maxStake);
        }

        // Baseline the fresh delegator key (bytes32(tokenId)) at the node's
        // current score-per-stake index for the current epoch. Without
        // this, a later reward claim on this NFT would start from the
        // zero-initialised `delegatorLastSettledNodeEpochScorePerStake`
        // and collect score the node earned *before* this NFT ever
        // existed. `_prepareForStakeChange` takes the `stakeBase == 0`
        // fast-path for fresh keys: it bumps
        // `delegatorLastSettledNodeEpochScorePerStake` to the current
        // node index and returns without mutating any score totals —
        // matching exactly what V8 `stake()` already does for first-time
        // address-keyed delegators.
        _prepareForStakeChange(chronos.getCurrentEpoch(), identityId, delegatorKey);

        ss.setDelegatorStakeBase(identityId, delegatorKey, amount);
        ss.setNodeStake(identityId, totalNodeStakeAfter);
        ss.increaseTotalStake(amount);

        _addNodeToShardingTable(identityId, totalNodeStakeAfter);
        askContract.recalculateActiveSet();

        emit StakeRecorded(tokenId, identityId, amount, lockEpochs, msg.sender);
    }
}
