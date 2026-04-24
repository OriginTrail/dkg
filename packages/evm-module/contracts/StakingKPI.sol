// SPDX-License-Identifier: Apache-2.0

pragma solidity ^0.8.20;

import {IdentityStorage} from "./storage/IdentityStorage.sol";
import {ProfileStorage} from "./storage/ProfileStorage.sol";
import {StakingStorage} from "./storage/StakingStorage.sol";
import {ConvictionStakingStorage} from "./storage/ConvictionStakingStorage.sol";
import {ContractStatus} from "./abstract/ContractStatus.sol";
import {IInitializable} from "./interfaces/IInitializable.sol";
import {INamed} from "./interfaces/INamed.sol";
import {IVersioned} from "./interfaces/IVersioned.sol";
import {ProfileLib} from "./libraries/ProfileLib.sol";
import {IdentityLib} from "./libraries/IdentityLib.sol";
import {EpochStorage} from "./storage/EpochStorage.sol";
import {RandomSamplingStorage} from "./storage/RandomSamplingStorage.sol";
import {ParametersStorage} from "./storage/ParametersStorage.sol";

contract StakingKPI is INamed, IVersioned, ContractStatus, IInitializable {
    string private constant _NAME = "StakingKPI";
    string private constant _VERSION = "1.0.0";
    uint256 public constant SCALE18 = 1e18;

    IdentityStorage public identityStorage;
    ProfileStorage public profileStorage;
    StakingStorage public stakingStorage;
    // D3+D13 — `DelegatorsInfo` unregistered in V10. The two per-epoch flags
    // KPI needs (`isOperatorFeeClaimedForEpoch`, `netNodeEpochRewards`) now
    // live on `ConvictionStakingStorage`.
    ConvictionStakingStorage public convictionStakingStorage;
    RandomSamplingStorage public randomSamplingStorage;
    EpochStorage public epochStorage;
    ParametersStorage public parametersStorage;

    /**
     * @dev Initializes the StakingKPI contract with the Hub address for access control
     * Only called once during deployment
     * @param hubAddress Address of the Hub contract for access control and contract dependencies
     */
    constructor(address hubAddress) ContractStatus(hubAddress) {}

    modifier profileExists(uint72 identityId) {
        _checkProfileExists(identityId);
        _;
    }

    /**
     * @dev Initializes the contract by connecting to all required Hub storage dependencies
     * Called once during deployment to set up contract references for staking calculations
     * Only the Hub can call this function
     */
    function initialize() external onlyHub {
        identityStorage = IdentityStorage(hub.getContractAddress("IdentityStorage"));
        profileStorage = ProfileStorage(hub.getContractAddress("ProfileStorage"));
        stakingStorage = StakingStorage(hub.getContractAddress("StakingStorage"));
        convictionStakingStorage = ConvictionStakingStorage(hub.getContractAddress("ConvictionStakingStorage"));
        randomSamplingStorage = RandomSamplingStorage(hub.getContractAddress("RandomSamplingStorage"));
        epochStorage = EpochStorage(hub.getContractAddress("EpochStorageV8"));
        parametersStorage = ParametersStorage(hub.getContractAddress("ParametersStorage"));
    }

    /**
     * @dev Returns the name of this contract for identification purposes
     * @return Contract name as a string
     */
    function name() external pure virtual override returns (string memory) {
        return _NAME;
    }

    /**
     * @dev Returns the version of this contract for compatibility tracking
     * @return Contract version as a string
     */
    function version() external pure virtual override returns (string memory) {
        return _VERSION;
    }

    /**
     * @dev Returns the total stake of all admin keys for a node
     * @param identityId Node's identity ID to get total stake for
     * @return Total stake of all admin keys for the node
     */
    function getOperatorStats(uint72 identityId) external view returns (uint96) {
        bytes32[] memory adminKeys = identityStorage.getKeysByPurpose(identityId, IdentityLib.ADMIN_KEY);

        uint96 totalStake;
        for (uint256 i; i < adminKeys.length; i++) {
            uint96 delegatorStakeBase = stakingStorage.getDelegatorStakeBase(identityId, adminKeys[i]);
            totalStake += delegatorStakeBase;
        }

        return totalStake;
    }

    /**
     * @dev Returns the total node stake
     * @param identityId Node's identity ID to get total stake for
     * @return Total stake of the node
     */
    function getNodeStats(uint72 identityId) external view returns (uint96) {
        return stakingStorage.getNodeStake(identityId);
    }

    /**
     * @dev Returns the total node operator fee balance
     * @param identityId Node's identity ID to get total operator fee balance for
     * @return Total node operator fee balance
     */
    function getOperatorFeeStats(uint72 identityId) external view returns (uint96) {
        return stakingStorage.getOperatorFeeBalance(identityId);
    }

    /**
     * @dev Returns the total stake of a node's delegator
     * @param identityId Node's identity ID to get total stake for
     * @param delegator Delegator's address to get stake for
     * @return Total stake of the node's delegator
     */
    function getDelegatorStats(uint72 identityId, address delegator) external view returns (uint96) {
        bytes32 delegatorKey = keccak256(abi.encodePacked(delegator));
        return stakingStorage.getDelegatorStakeBase(identityId, delegatorKey);
    }

    /**
     * @dev Calculate the reward for a delegator in an epoch (correct only for the finalized epochs)
     * Determines the delegator's share of the total node rewards for a specific epoch
     * Uses the delegator's score relative to the total node score to calculate proportional rewards
     * @param identityId Node's identity ID that the delegator is delegating to
     * @param epoch Epoch number to calculate rewards for (must be finalized)
     * @param delegator Delegator's address to calculate rewards for
     * @return Reward amount for the delegator in the specified epoch
     */
    function getDelegatorReward(
        uint72 identityId,
        uint256 epoch,
        address delegator
    ) external view profileExists(identityId) returns (uint256) {
        // D13 — `DelegatorsInfo.isNodeDelegator` is V8 address-keyed and
        // unregistered in V10. Dropped here: KPI still returns 0 for a
        // non-delegator through `_simulatePrepareForStakeChange` (stakeBase
        // == 0 → early return 0), so the guard is redundant under the
        // frozen-V8 archive model. V10 per-NFT KPI lives elsewhere.

        bytes32 delegatorKey = keccak256(abi.encodePacked(delegator));

        uint256 delegatorScore18 = _simulatePrepareForStakeChange(epoch, identityId, delegatorKey);
        if (delegatorScore18 == 0) return 0;

        uint256 nodeScore18 = randomSamplingStorage.getNodeEpochScore(epoch, identityId);
        if (nodeScore18 == 0) return 0;

        // Calculate the final delegators rewards pool
        uint256 netNodeRewards = getNetNodeRewards(identityId, epoch);

        if (netNodeRewards == 0) return 0;

        return (delegatorScore18 * netNodeRewards) / nodeScore18;
    }

    /**
     * @dev Fetch the net rewards for all node's delegators in an epoch (rewards of node's delegators - operator fee)
     * Calculates the total rewards available to node's delegators after operator fees are deducted
     * Handles both cases: when operator fee has been claimed and when it hasn't
     * @param identityId Node's identity ID to get net rewards for
     * @param epoch Epoch number to calculate net rewards for
     * @return Net rewards available for distribution to the node's delegators in the epoch
     */
    function getNetNodeRewards(
        uint72 identityId,
        uint256 epoch
    ) public view profileExists(identityId) returns (uint256) {
        // D3+D13 — post-V10 these flags live on ConvictionStakingStorage.
        if (convictionStakingStorage.isOperatorFeeClaimedForEpoch(identityId, epoch)) {
            return convictionStakingStorage.netNodeEpochRewards(identityId, epoch);
        }

        uint256 nodeScore18 = randomSamplingStorage.getNodeEpochScore(epoch, identityId);
        if (nodeScore18 == 0) return 0;

        uint256 allNodesScore18 = randomSamplingStorage.getAllNodesEpochScore(epoch);
        if (allNodesScore18 == 0) return 0;

        uint256 epocRewardsPool = epochStorage.getEpochPool(1, epoch);
        if (epocRewardsPool == 0) return 0;

        uint256 totalNodeRewards = (epocRewardsPool * nodeScore18) / allNodesScore18;

        uint256 feePercentageForEpoch = profileStorage.getLatestOperatorFeePercentage(identityId);
        uint96 operatorFeeAmount = uint96(
            (totalNodeRewards * feePercentageForEpoch) / parametersStorage.maxOperatorFee()
        );

        return totalNodeRewards - operatorFeeAmount;
    }

    /**
     * @dev Internal function to simulate preparing for stake change and calculate delegator score
     * Calculates what the delegator's score would be after settling all pending score changes
     * Used for reward calculations without actually updating storage state
     * @param epoch The epoch to simulate the stake change for
     * @param identityId The node identity ID the delegator is delegating to
     * @param delegatorKey The unique key identifying the delegator
     * @return delegatorScore18 The simulated delegator score after settling, scaled by 10^18
     */
    function _simulatePrepareForStakeChange(
        uint256 epoch,
        uint72 identityId,
        bytes32 delegatorKey
    ) internal view returns (uint256 delegatorScore18) {
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
            return currentDelegatorScore18;
        }
        // 4. Newly earned score for this delegator in the epoch
        uint256 diff36 = nodeScorePerStake36 - delegatorLastSettledNodeEpochScorePerStake36; // scaled 1e36
        uint256 scoreEarned18 = (uint256(stakeBase) * diff36) / SCALE18;

        return currentDelegatorScore18 + scoreEarned18;
    }

    /**
     * @dev Internal function to validate that a node profile exists
     * Used by modifiers and functions to ensure operations target valid nodes
     * Reverts with ProfileDoesntExist error if profile is not found
     * @param identityId Node identity ID to check existence for
     */
    function _checkProfileExists(uint72 identityId) internal view virtual {
        if (!profileStorage.profileExists(identityId)) {
            revert ProfileLib.ProfileDoesntExist(identityId);
        }
    }
}
