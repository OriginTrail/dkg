// SPDX-License-Identifier: Apache-2.0

pragma solidity ^0.8.20;

import {Chronos} from "./Chronos.sol";
import {HubDependent} from "../abstract/HubDependent.sol";
import {INamed} from "../interfaces/INamed.sol";
import {IVersioned} from "../interfaces/IVersioned.sol";

contract EpochStorage is INamed, IVersioned, HubDependent {
    string private constant _NAME = "EpochStorage";
    string private constant _VERSION = "1.0.0";

    event EpochProducedKnowledgeValueAdded(uint72 indexed identityId, uint256 indexed epoch, uint96 knowledgeValue);
    event TokensAddedToEpochRange(
        uint256 indexed shardId,
        uint256 startEpoch,
        uint256 endEpoch,
        uint96 tokenAmount,
        uint96 remainder
    );
    event EpochTokensPaidOut(uint256 indexed shardId, uint256 indexed epoch, uint72 indexed identityId, uint96 amount);
    event EpochsFinalized(uint256 indexed shardId, uint256 startEpoch, uint256 endEpoch);

    Chronos public chronos;

    mapping(uint256 => uint256) public lastFinalizedEpoch;
    mapping(uint256 => uint96) public accumulatedRemainder;

    mapping(uint256 => mapping(uint256 => int96)) public diff;
    mapping(uint256 => mapping(uint256 => uint96)) public cumulative;
    mapping(uint256 => mapping(uint256 => uint96)) public distributed;

    mapping(uint72 => mapping(uint256 => uint96)) public nodesEpochProducedKnowledgeValue;
    mapping(uint256 => uint96) public epochProducedKnowledgeValue;
    mapping(uint256 => uint96) public epochNodeMaxProducedKnowledgeValue;

    mapping(uint72 => mapping(uint256 => mapping(uint256 => uint96))) public nodesPaidOut;

    constructor(address hubAddress) HubDependent(hubAddress) {}

    function initialize() public onlyHub {
        chronos = Chronos(hub.getContractAddress("Chronos"));
    }

    function name() external pure virtual override returns (string memory) {
        return _NAME;
    }

    function version() external pure virtual override returns (string memory) {
        return _VERSION;
    }

    function addEpochProducedKnowledgeValue(
        uint72 identityId,
        uint256 epoch,
        uint96 knowledgeValue
    ) external onlyContracts {
        nodesEpochProducedKnowledgeValue[identityId][epoch] += knowledgeValue;
        epochProducedKnowledgeValue[epoch] += knowledgeValue;

        if (nodesEpochProducedKnowledgeValue[identityId][epoch] > epochNodeMaxProducedKnowledgeValue[epoch]) {
            epochNodeMaxProducedKnowledgeValue[epoch] = nodesEpochProducedKnowledgeValue[identityId][epoch];
        }

        emit EpochProducedKnowledgeValueAdded(identityId, epoch, knowledgeValue);
    }

    function getEpochProducedKnowledgeValue(uint256 epoch) external view returns (uint96) {
        return epochProducedKnowledgeValue[epoch];
    }

    function getCurrentEpochProducedKnowledgeValue() external view returns (uint96) {
        return epochProducedKnowledgeValue[chronos.getCurrentEpoch()];
    }

    function getPreviousEpochProducedKnowledgeValue() external view returns (uint96) {
        uint256 currentEpoch = chronos.getCurrentEpoch();
        if (currentEpoch <= 1) {
            return 0;
        }
        return epochProducedKnowledgeValue[currentEpoch - 1];
    }

    function getNodeEpochProducedKnowledgeValue(uint72 identityId, uint256 epoch) external view returns (uint96) {
        return nodesEpochProducedKnowledgeValue[identityId][epoch];
    }

    function getNodeCurrentEpochProducedKnowledgeValue(uint72 identityId) external view returns (uint96) {
        return nodesEpochProducedKnowledgeValue[identityId][chronos.getCurrentEpoch()];
    }

    function getNodePreviousEpochProducedKnowledgeValue(uint72 identityId) external view returns (uint96) {
        uint256 currentEpoch = chronos.getCurrentEpoch();
        if (currentEpoch <= 1) {
            return 0;
        }
        return nodesEpochProducedKnowledgeValue[identityId][currentEpoch - 1];
    }

    function getEpochNodeMaxProducedKnowledgeValue(uint256 epoch) external view returns (uint96) {
        return epochNodeMaxProducedKnowledgeValue[epoch];
    }

    function getCurrentEpochNodeMaxProducedKnowledgeValue() external view returns (uint96) {
        return epochNodeMaxProducedKnowledgeValue[chronos.getCurrentEpoch()];
    }

    function getPreviousEpochNodeMaxProducedKnowledgeValue() external view returns (uint96) {
        uint256 currentEpoch = chronos.getCurrentEpoch();
        if (currentEpoch <= 1) {
            return 0;
        }
        return epochNodeMaxProducedKnowledgeValue[currentEpoch - 1];
    }

    function getNodeEpochProducedKnowledgeValuePercentage(
        uint72 identityId,
        uint256 epoch
    ) external view returns (uint256) {
        if (epochProducedKnowledgeValue[epoch] == 0) {
            return 0;
        }

        return
            (uint256(nodesEpochProducedKnowledgeValue[identityId][epoch]) * 1e18) / epochProducedKnowledgeValue[epoch];
    }

    function getNodeCurrentEpochProducedKnowledgeValuePercentage(uint72 identityId) external view returns (uint256) {
        uint256 currentEpoch = chronos.getCurrentEpoch();

        if (epochProducedKnowledgeValue[currentEpoch] == 0) {
            return 0;
        }

        return ((uint256(nodesEpochProducedKnowledgeValue[identityId][currentEpoch]) * 1e18) /
            epochProducedKnowledgeValue[currentEpoch]);
    }

    function getNodePreviousEpochProducedKnowledgeValuePercentage(uint72 identityId) external view returns (uint256) {
        uint256 currentEpoch = chronos.getCurrentEpoch();
        if (currentEpoch <= 1 || epochProducedKnowledgeValue[currentEpoch - 1] == 0) {
            return 0;
        }
        return ((uint256(nodesEpochProducedKnowledgeValue[identityId][currentEpoch - 1]) * 1e18) /
            epochProducedKnowledgeValue[currentEpoch - 1]);
    }

    function addTokensToEpochRange(
        uint256 shardId,
        uint256 startEpoch,
        uint256 endEpoch,
        uint96 tokenAmount
    ) external onlyContracts {
        require(
            startEpoch > lastFinalizedEpoch[shardId],
            "EpochStorage: start epoch already finalized"
        );

        uint256 numEpochs = endEpoch - startEpoch + 1;

        uint96 totalTokens = tokenAmount + accumulatedRemainder[shardId];
        uint96 tokensPerEpochU = uint96(totalTokens / numEpochs);
        uint96 remainder = uint96(totalTokens % numEpochs);

        accumulatedRemainder[shardId] = remainder;

        int96 tokensPerEpoch = int96(tokensPerEpochU);

        diff[shardId][startEpoch] += tokensPerEpoch;
        diff[shardId][endEpoch + 1] -= tokensPerEpoch;

        uint256 currentEpoch = chronos.getCurrentEpoch();
        if (currentEpoch > 1) {
            _finalizeEpochsUpTo(shardId, currentEpoch - 1);
        }

        emit TokensAddedToEpochRange(shardId, startEpoch, endEpoch, tokenAmount, remainder);
    }

    function payOutEpochTokens(
        uint256 shardId,
        uint256 epoch,
        uint72 identityId,
        uint96 amount
    ) external onlyContracts {
        uint256 currentEpoch = chronos.getCurrentEpoch();
        if (currentEpoch > 1) {
            _finalizeEpochsUpTo(shardId, currentEpoch - 1);
        }

        require(
            amount <= getEpochRemainingPool(shardId, epoch),
            "EpochStorage: payout exceeds remaining pool"
        );

        distributed[shardId][epoch] += amount;
        nodesPaidOut[identityId][shardId][epoch] += amount;

        emit EpochTokensPaidOut(shardId, epoch, identityId, amount);
    }

    function getEpochPool(uint256 shardId, uint256 epoch) public view returns (uint96) {
        if (epoch <= lastFinalizedEpoch[shardId]) {
            return cumulative[shardId][epoch];
        } else {
            return _simulateEpochFinalization(shardId, epoch);
        }
    }

    function getEpochRemainingPool(uint256 shardId, uint256 epoch) public view returns (uint96) {
        if (epoch <= lastFinalizedEpoch[shardId]) {
            return cumulative[shardId][epoch] - distributed[shardId][epoch];
        } else {
            return _simulateEpochFinalization(shardId, epoch) - distributed[shardId][epoch];
        }
    }

    function getCurrentEpochPool(uint256 shardId) external view returns (uint96) {
        return getEpochPool(shardId, chronos.getCurrentEpoch());
    }

    function getCurrentEpochRemainingPool(uint256 shardId) external view returns (uint96) {
        return getEpochRemainingPool(shardId, chronos.getCurrentEpoch());
    }

    function getPreviousEpochPool(uint256 shardId) external view returns (uint96) {
        uint256 currentEpoch = chronos.getCurrentEpoch();
        if (currentEpoch <= 1) {
            return 0;
        }
        return getEpochPool(shardId, currentEpoch - 1);
    }

    function getPreviousEpochRemainingPool(uint256 shardId) external view returns (uint96) {
        uint256 currentEpoch = chronos.getCurrentEpoch();
        if (currentEpoch <= 1) {
            return 0;
        }
        return getEpochRemainingPool(shardId, currentEpoch - 1);
    }

    function getEpochRangePool(uint256 shardId, uint256 startEpoch, uint256 endEpoch) external view returns (uint96) {
        uint256 lastFinalized = lastFinalizedEpoch[shardId];
        uint96 totalPool = 0;

        if (startEpoch <= lastFinalized) {
            for (uint256 epoch = startEpoch; epoch <= lastFinalized && epoch <= endEpoch; epoch++) {
                totalPool += cumulative[shardId][epoch];
            }
        }

        uint96 simulatedCumulative = lastFinalized > 0 ? cumulative[shardId][lastFinalized] : cumulative[shardId][1];
        for (uint256 epoch = lastFinalized + 1; epoch <= endEpoch; epoch++) {
            int96 tmp = int96(simulatedCumulative) + diff[shardId][epoch];
            simulatedCumulative = uint96(tmp);
            if (epoch >= startEpoch) {
                totalPool += simulatedCumulative;
            }
        }

        return totalPool;
    }

    function getEpochDistributedPool(uint256 shardId, uint256 epoch) external view returns (uint96) {
        return distributed[shardId][epoch];
    }

    function getPreviousEpochDistributedPool(uint256 shardId) external view returns (uint96) {
        uint256 currentEpoch = chronos.getCurrentEpoch();
        if (currentEpoch <= 1) {
            return 0;
        }
        return distributed[shardId][currentEpoch - 1];
    }

    function getNodeEpochPaidOut(uint256 shardId, uint72 identityId, uint256 epoch) external view returns (uint96) {
        return nodesPaidOut[identityId][shardId][epoch];
    }

    function getNodePreviousEpochPaidOut(uint256 shardId, uint72 identityId) external view returns (uint96) {
        uint256 currentEpoch = chronos.getCurrentEpoch();
        if (currentEpoch <= 1) {
            return 0;
        }
        return nodesPaidOut[identityId][shardId][currentEpoch - 1];
    }

    function _finalizeEpochsUpTo(uint256 shardId, uint256 epoch) internal {
        uint256 startEpoch = lastFinalizedEpoch[shardId] + 1;
        for (uint256 e = startEpoch; e <= epoch; e++) {
            int96 prev = 0;
            if (e > 1) {
                prev = int96(cumulative[shardId][e - 1]);
            }
            cumulative[shardId][e] = uint96(prev + diff[shardId][e]);
        }
        lastFinalizedEpoch[shardId] = epoch;

        emit EpochsFinalized(shardId, startEpoch, epoch);
    }

    function _simulateEpochFinalization(uint256 shardId, uint256 epoch) internal view returns (uint96) {
        if (epoch <= lastFinalizedEpoch[shardId]) {
            return cumulative[shardId][epoch];
        }

        uint96 simulatedCumulative = 0;
        if (lastFinalizedEpoch[shardId] > 0) {
            simulatedCumulative = cumulative[shardId][lastFinalizedEpoch[shardId]];
        }

        for (uint256 e = lastFinalizedEpoch[shardId] + 1; e <= epoch; e++) {
            int96 prev = int96(simulatedCumulative);
            int96 result = prev + diff[shardId][e];
            simulatedCumulative = uint96(result);
        }

        return simulatedCumulative;
    }
}
