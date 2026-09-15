// SPDX-License-Identifier: Apache-2.0

pragma solidity ^0.8.20;

import {ConvictionStakingStorage} from "./storage/ConvictionStakingStorage.sol";
import {EpochStorage} from "./storage/EpochStorage.sol";
import {Chronos} from "./storage/Chronos.sol";
import {ParametersStorage} from "./storage/ParametersStorage.sol";
import {ProfileStorage} from "./storage/ProfileStorage.sol";
import {RandomSamplingStorage} from "./storage/RandomSamplingStorage.sol";
import {HubDependent} from "./abstract/HubDependent.sol";
import {IInitializable} from "./interfaces/IInitializable.sol";
import {INamed} from "./interfaces/INamed.sol";
import {IVersioned} from "./interfaces/IVersioned.sol";

/// @notice Owns the cross-contract node reward-cache reconciliation path.
///         Keeping this policy outside StakingV10 leaves the staking facade
///         deployable while allowing late epoch-pool credits (such as lazy PCA
///         settlement) to update delegator and operator rewards exactly once.
contract StakingRewardSettlement is INamed, IVersioned, HubDependent, IInitializable {
    string private constant _NAME = "StakingRewardSettlement";
    string private constant _VERSION = "10.0.7";
    uint256 private constant EPOCH_POOL_INDEX = 1;

    ConvictionStakingStorage public convictionStorage;
    EpochStorage public epochStorage;
    Chronos public chronos;
    ParametersStorage public parametersStorage;
    ProfileStorage public profileStorage;
    RandomSamplingStorage public randomSamplingStorage;

    constructor(address hubAddress) HubDependent(hubAddress) {}

    function initialize() external onlyHub {
        convictionStorage = ConvictionStakingStorage(hub.getContractAddress("ConvictionStakingStorage"));
        epochStorage = EpochStorage(hub.getContractAddress("EpochStorageV8"));
        chronos = Chronos(hub.getContractAddress("Chronos"));
        parametersStorage = ParametersStorage(hub.getContractAddress("ParametersStorage"));
        profileStorage = ProfileStorage(hub.getContractAddress("ProfileStorage"));
        randomSamplingStorage = RandomSamplingStorage(hub.getContractAddress("RandomSamplingStorage"));
    }

    function name() external pure override returns (string memory) {
        return _NAME;
    }

    function version() external pure override returns (string memory) {
        return _VERSION;
    }

    /// @notice Return and persist the current net node reward for `epoch`.
    ///         A later pool increase updates the gross baseline and credits
    ///         only the incremental operator fee.
    function settleNodeEpochReward(
        uint256 epoch,
        uint72 identityId,
        uint256 nodeScore18
    ) external onlyContracts returns (uint256 netNodeRewards) {
        uint256 allNodesScore18 = randomSamplingStorage.getAllNodesEpochScore(epoch);
        if (allNodesScore18 == 0) return 0;

        uint256 grossNodeRewards =
            (epochStorage.getEpochPool(EPOCH_POOL_INDEX, epoch) * nodeScore18) / allNodesScore18;
        uint16 feePercentage = profileStorage.getOperatorFeePercentageByTimestampReverse(
            identityId,
            chronos.timestampForEpoch(epoch + 1) - 1
        );
        uint96 operatorFeeAmount = uint96(
            (grossNodeRewards * feePercentage) / parametersStorage.maxOperatorFee()
        );
        netNodeRewards = grossNodeRewards - operatorFeeAmount;

        if (!convictionStorage.isOperatorFeeClaimedForEpoch(identityId, epoch)) {
            convictionStorage.setIsOperatorFeeClaimedForEpoch(identityId, epoch, true);
            convictionStorage.setGrossNodeEpochRewards(identityId, epoch, grossNodeRewards);
            convictionStorage.setNetNodeEpochRewards(identityId, epoch, netNodeRewards);
            convictionStorage.increaseOperatorFeeBalance(identityId, operatorFeeAmount);
            return netNodeRewards;
        }

        uint256 cachedGross = convictionStorage.getGrossNodeEpochRewards(identityId, epoch);
        if (cachedGross == 0) {
            uint256 cachedNet = convictionStorage.getNetNodeEpochRewards(identityId, epoch);
            if (cachedNet == 0 && grossNodeRewards > 0) {
                // A zero-pool first touch was already marked claimed by the
                // pre-baseline path. Treat a later pool credit as the first
                // real reward and accrue its operator fee in full.
                convictionStorage.increaseOperatorFeeBalance(identityId, operatorFeeAmount);
                convictionStorage.setGrossNodeEpochRewards(identityId, epoch, grossNodeRewards);
                convictionStorage.setNetNodeEpochRewards(identityId, epoch, netNodeRewards);
                return netNodeRewards;
            }
            // Bootstrap epochs cached before the gross baseline was added.
            convictionStorage.setGrossNodeEpochRewards(identityId, epoch, grossNodeRewards);
            return cachedNet;
        }
        if (grossNodeRewards <= cachedGross) {
            return convictionStorage.getNetNodeEpochRewards(identityId, epoch);
        }

        uint96 cachedFee = uint96((cachedGross * feePercentage) / parametersStorage.maxOperatorFee());
        if (operatorFeeAmount > cachedFee) {
            convictionStorage.increaseOperatorFeeBalance(identityId, operatorFeeAmount - cachedFee);
        }
        convictionStorage.setGrossNodeEpochRewards(identityId, epoch, grossNodeRewards);
        convictionStorage.setNetNodeEpochRewards(identityId, epoch, netNodeRewards);
    }
}
