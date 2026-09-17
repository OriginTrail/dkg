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
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

/// @notice Owns node reward-cache reconciliation and per-position reward
///         receipts. A receipt stores the exact immutable score source and the
///         amount already paid, so a later PCA pool credit pays only
///         `current full entitlement - paid entitlement` regardless of claim
///         ordering, relock, transfer, or withdrawal.
contract StakingRewardSettlement is INamed, IVersioned, HubDependent, IInitializable {
    string private constant _NAME = "StakingRewardSettlement";
    string private constant _VERSION = "10.0.8";
    uint256 private constant EPOCH_POOL_INDEX = 1;

    struct RewardSource {
        uint72 identityId;
        uint32 epoch;
        bytes32 delegatorKey;
        uint256 delegatorScore18;
        uint256 paidReward;
    }

    ConvictionStakingStorage public convictionStorage;
    EpochStorage public epochStorage;
    Chronos public chronos;
    ParametersStorage public parametersStorage;
    ProfileStorage public profileStorage;
    RandomSamplingStorage public randomSamplingStorage;

    /// @dev A relock burn/mint keeps one reward account. Every historical
    ///      tokenId remains an alias because RSS score slots retain its key.
    mapping(uint256 => uint256) public rewardAccountOfToken;
    mapping(uint256 => uint256) public liveTokenOfRewardAccount;
    mapping(uint256 => address) public closedRewardRecipient;
    mapping(uint256 => RewardSource[]) private rewardSources;
    mapping(uint256 => mapping(bytes32 => uint256)) private rewardSourceIndexPlusOne;

    /// @dev Solvency ledgers. With valid RSS score conservation, source
    ///      payouts cannot exceed a node's net reward and node gross rewards
    ///      cannot exceed the epoch pool.
    mapping(uint72 => mapping(uint256 => uint256)) public operatorFeePaid;
    mapping(uint72 => mapping(uint256 => uint256)) public delegatorRewardsPaid;
    mapping(uint256 => uint256) public totalGrossRewardsObserved;

    event RewardSourceRecorded(
        uint256 indexed rewardAccountId,
        uint72 indexed identityId,
        uint32 indexed epoch,
        bytes32 delegatorKey,
        uint256 delegatorScore18
    );
    event RewardAccountRelocked(
        uint256 indexed rewardAccountId,
        uint256 indexed oldTokenId,
        uint256 indexed newTokenId
    );
    event RewardAccountClosed(uint256 indexed rewardAccountId, uint256 indexed tokenId, address recipient);
    event RewardDeltaPaid(uint256 indexed rewardAccountId, uint256 rewardDelta, bool paidToWallet);

    error OnlyStakingV10();
    error RewardAccountNotLive(uint256 tokenId);
    error RewardAccountNotClosed(uint256 rewardAccountId);
    error InvalidRewardRecipient();
    error RewardScoreChanged();
    error DelegatorRewardInvariant(uint72 identityId, uint256 epoch, uint256 paid, uint256 netReward);
    error EpochRewardInvariant(uint256 epoch, uint256 observedGross, uint256 epochPool);
    error RewardOverflow();

    modifier onlyStakingV10() {
        if (msg.sender != hub.getContractAddress("StakingV10")) revert OnlyStakingV10();
        _;
    }

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

    /// @notice Settle one immutable delegator-score source. The first call
    ///         pays its full current entitlement; later calls pay only a late
    ///         pool delta.
    function settlePositionEpochReward(
        uint256 tokenId,
        uint256 epoch,
        uint72 identityId,
        bytes32 delegatorKey,
        uint256 delegatorScore18
    ) external onlyStakingV10 returns (uint256 epochReward) {
        if (delegatorScore18 == 0) return 0;

        uint256 rewardAccountId = _liveRewardAccount(tokenId);
        bytes32 sourceKey = keccak256(abi.encode(epoch, identityId, delegatorKey));
        uint256 indexPlusOne = rewardSourceIndexPlusOne[rewardAccountId][sourceKey];
        uint256 sourceIndex;
        uint32 epoch32 = SafeCast.toUint32(epoch);

        if (indexPlusOne == 0) {
            sourceIndex = rewardSources[rewardAccountId].length;
            rewardSources[rewardAccountId].push(RewardSource({
                identityId: identityId,
                epoch: epoch32,
                delegatorKey: delegatorKey,
                delegatorScore18: delegatorScore18,
                paidReward: 0
            }));
            rewardSourceIndexPlusOne[rewardAccountId][sourceKey] = sourceIndex + 1;
            emit RewardSourceRecorded(
                rewardAccountId,
                identityId,
                epoch32,
                delegatorKey,
                delegatorScore18
            );
        } else {
            sourceIndex = indexPlusOne - 1;
            if (rewardSources[rewardAccountId][sourceIndex].delegatorScore18 != delegatorScore18) {
                revert RewardScoreChanged();
            }
        }

        epochReward = _reconcileSource(rewardAccountId, sourceIndex);
    }

    /// @notice Permissionlessly reconcile a bounded slice of an active
    ///         position's historical reward sources. The returned delta is
    ///         compounded by StakingV10 into the current live position.
    function reconcileRewardSources(
        uint256 tokenId,
        uint256 start,
        uint256 count
    ) external onlyStakingV10 returns (uint256 rewardDelta) {
        uint256 rewardAccountId = _liveRewardAccount(tokenId);
        rewardDelta = _reconcileRange(rewardAccountId, start, count);
        if (rewardDelta > 0) emit RewardDeltaPaid(rewardAccountId, rewardDelta, false);
    }

    /// @notice Keep the reward account and old RSS token-key aliases across a
    ///         relock burn/mint replacement.
    function migrateRewardAccount(uint256 oldTokenId, uint256 newTokenId) external onlyStakingV10 {
        uint256 rewardAccountId = _liveRewardAccount(oldTokenId);
        if (rewardAccountOfToken[newTokenId] != 0) revert RewardAccountNotLive(newTokenId);
        rewardAccountOfToken[newTokenId] = rewardAccountId;
        liveTokenOfRewardAccount[rewardAccountId] = newTokenId;
        emit RewardAccountRelocked(rewardAccountId, oldTokenId, newTokenId);
    }

    /// @notice Preserve a fixed beneficiary before the live position is
    ///         deleted, so a pool credit arriving after withdrawal remains
    ///         payable without resurrecting stake.
    function closeRewardAccount(uint256 tokenId, address recipient) external onlyStakingV10 {
        if (recipient == address(0)) revert InvalidRewardRecipient();
        uint256 rewardAccountId = _liveRewardAccount(tokenId);
        liveTokenOfRewardAccount[rewardAccountId] = 0;
        closedRewardRecipient[rewardAccountId] = recipient;
        emit RewardAccountClosed(rewardAccountId, tokenId, recipient);
    }

    /// @notice Anyone may settle a bounded historical slice for a withdrawn
    ///         position; payout always goes to the owner recorded at atomic
    ///         withdrawal, never to the caller.
    function claimClosedRewardDeltas(
        uint256 rewardAccountId,
        uint256 start,
        uint256 count
    ) external returns (uint96 rewardDelta) {
        address recipient = closedRewardRecipient[rewardAccountId];
        if (recipient == address(0) || liveTokenOfRewardAccount[rewardAccountId] != 0) {
            revert RewardAccountNotClosed(rewardAccountId);
        }
        uint256 delta = _reconcileRange(rewardAccountId, start, count);
        if (delta > type(uint96).max) revert RewardOverflow();
        rewardDelta = uint96(delta);
        if (rewardDelta > 0) {
            convictionStorage.transferStake(recipient, rewardDelta);
            emit RewardDeltaPaid(rewardAccountId, rewardDelta, true);
        }
    }

    function getRewardSources(uint256 rewardAccountId) external view returns (RewardSource[] memory) {
        return rewardSources[rewardAccountId];
    }

    /// @notice Return and persist the current net node reward for `epoch`.
    ///         Retained as an observable/test surface; position claims use the
    ///         receipt-aware entry point above.
    function settleNodeEpochReward(
        uint256 epoch,
        uint72 identityId,
        uint256 nodeScore18
    ) external onlyStakingV10 returns (uint256 netNodeRewards) {
        return _settleNodeEpochReward(epoch, identityId, nodeScore18);
    }

    function _liveRewardAccount(uint256 tokenId) internal returns (uint256 rewardAccountId) {
        rewardAccountId = rewardAccountOfToken[tokenId];
        if (rewardAccountId == 0) {
            rewardAccountId = tokenId;
            rewardAccountOfToken[tokenId] = rewardAccountId;
            liveTokenOfRewardAccount[rewardAccountId] = tokenId;
        }
        if (liveTokenOfRewardAccount[rewardAccountId] != tokenId) {
            revert RewardAccountNotLive(tokenId);
        }
    }

    function _reconcileRange(
        uint256 rewardAccountId,
        uint256 start,
        uint256 count
    ) internal returns (uint256 rewardDelta) {
        RewardSource[] storage sources = rewardSources[rewardAccountId];
        uint256 end = start + count;
        if (end > sources.length) end = sources.length;
        for (uint256 i = start; i < end; i++) {
            rewardDelta += _reconcileSource(rewardAccountId, i);
        }
    }

    function _reconcileSource(
        uint256 rewardAccountId,
        uint256 sourceIndex
    ) internal returns (uint256 rewardDelta) {
        RewardSource storage source = rewardSources[rewardAccountId][sourceIndex];
        uint256 nodeScore18 = randomSamplingStorage.getNodeEpochScore(
            uint256(source.epoch),
            source.identityId
        );
        if (nodeScore18 == 0) return 0;

        uint256 netNodeRewards = _settleNodeEpochReward(
            uint256(source.epoch),
            source.identityId,
            nodeScore18
        );
        uint256 currentReward = Math.mulDiv(source.delegatorScore18, netNodeRewards, nodeScore18);
        if (currentReward <= source.paidReward) return 0;

        rewardDelta = currentReward - source.paidReward;
        source.paidReward = currentReward;

        uint256 newPaid = delegatorRewardsPaid[source.identityId][uint256(source.epoch)] + rewardDelta;
        if (newPaid > netNodeRewards) {
            revert DelegatorRewardInvariant(source.identityId, uint256(source.epoch), newPaid, netNodeRewards);
        }
        delegatorRewardsPaid[source.identityId][uint256(source.epoch)] = newPaid;
    }

    function _settleNodeEpochReward(
        uint256 epoch,
        uint72 identityId,
        uint256 nodeScore18
    ) internal returns (uint256 netNodeRewards) {
        uint256 allNodesScore18 = randomSamplingStorage.getAllNodesEpochScore(epoch);
        if (allNodesScore18 == 0) return 0;

        uint256 epochPool = epochStorage.getEpochPool(EPOCH_POOL_INDEX, epoch);
        // Deliberate two-stage rounding: first allocate this node's integer
        // gross reward, then split that integer amount between operator and
        // delegators. Math.mulDiv retains this policy without overflow.
        uint256 grossNodeRewards = Math.mulDiv(epochPool, nodeScore18, allNodesScore18);
        uint16 feePercentage = profileStorage.getOperatorFeePercentageByTimestampReverse(
            identityId,
            chronos.timestampForEpoch(epoch + 1) - 1
        );
        uint96 operatorFeeAmount = uint96(
            Math.mulDiv(grossNodeRewards, feePercentage, parametersStorage.maxOperatorFee())
        );
        netNodeRewards = grossNodeRewards - operatorFeeAmount;

        if (!convictionStorage.isOperatorFeeClaimedForEpoch(identityId, epoch)) {
            _recordGrossIncrease(epoch, grossNodeRewards, epochPool);
            convictionStorage.setIsOperatorFeeClaimedForEpoch(identityId, epoch, true);
            convictionStorage.setGrossNodeEpochRewards(identityId, epoch, grossNodeRewards);
            convictionStorage.setNetNodeEpochRewards(identityId, epoch, netNodeRewards);
            operatorFeePaid[identityId][epoch] = operatorFeeAmount;
            convictionStorage.increaseOperatorFeeBalance(identityId, operatorFeeAmount);
            return netNodeRewards;
        }

        uint256 cachedGross = convictionStorage.getGrossNodeEpochRewards(identityId, epoch);
        if (cachedGross == 0) {
            uint256 cachedNet = convictionStorage.getNetNodeEpochRewards(identityId, epoch);
            if (cachedNet == 0 && grossNodeRewards > 0) {
                _recordGrossIncrease(epoch, grossNodeRewards, epochPool);
                operatorFeePaid[identityId][epoch] = operatorFeeAmount;
                convictionStorage.increaseOperatorFeeBalance(identityId, operatorFeeAmount);
                convictionStorage.setGrossNodeEpochRewards(identityId, epoch, grossNodeRewards);
                convictionStorage.setNetNodeEpochRewards(identityId, epoch, netNodeRewards);
                return netNodeRewards;
            }
            convictionStorage.setGrossNodeEpochRewards(identityId, epoch, grossNodeRewards);
            return cachedNet;
        }
        if (grossNodeRewards <= cachedGross) {
            return convictionStorage.getNetNodeEpochRewards(identityId, epoch);
        }

        _recordGrossIncrease(epoch, grossNodeRewards - cachedGross, epochPool);
        uint256 feeAlreadyPaid = operatorFeePaid[identityId][epoch];
        if (uint256(operatorFeeAmount) > feeAlreadyPaid) {
            uint96 feeDelta = uint96(uint256(operatorFeeAmount) - feeAlreadyPaid);
            operatorFeePaid[identityId][epoch] = operatorFeeAmount;
            convictionStorage.increaseOperatorFeeBalance(identityId, feeDelta);
        }
        convictionStorage.setGrossNodeEpochRewards(identityId, epoch, grossNodeRewards);
        convictionStorage.setNetNodeEpochRewards(identityId, epoch, netNodeRewards);
    }

    function _recordGrossIncrease(uint256 epoch, uint256 grossDelta, uint256 epochPool) internal {
        uint256 observedGross = totalGrossRewardsObserved[epoch] + grossDelta;
        if (observedGross > epochPool) revert EpochRewardInvariant(epoch, observedGross, epochPool);
        totalGrossRewardsObserved[epoch] = observedGross;
    }
}
