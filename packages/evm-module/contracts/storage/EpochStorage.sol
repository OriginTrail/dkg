// SPDX-License-Identifier: Apache-2.0

pragma solidity ^0.8.20;

import {Chronos} from "./Chronos.sol";
import {HubDependent} from "../abstract/HubDependent.sol";
import {INamed} from "../interfaces/INamed.sol";
import {IVersioned} from "../interfaces/IVersioned.sol";

contract EpochStorage is INamed, IVersioned, HubDependent {
    string private constant _NAME = "EpochStorage";
    // 10.0.4 — OT-RFC-51 "Publishing Allocation": the per-node
    //          produced-knowledge-value accounting is repurposed as
    //          committed PCA "publishing allocation". The mappings,
    //          mutator, event, and getters are renamed
    //          (`*ProducedKnowledgeValue*` -> `*PublishingAllocation*`)
    //          and a net-zero `moveEpochPublishingAllocation` mutator is
    //          added so a PCA can re-designate its primary node without
    //          changing the epoch total (K_total).
    string private constant _VERSION = "10.0.4";

    event EpochPublishingAllocationAdded(uint72 indexed identityId, uint256 indexed epoch, uint96 amount);
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

    mapping(uint72 => mapping(uint256 => uint96)) public nodesEpochPublishingAllocation;
    mapping(uint256 => uint96) public epochPublishingAllocation;
    mapping(uint256 => uint96) public epochNodeMaxPublishingAllocation;

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

    function addEpochPublishingAllocation(
        uint72 identityId,
        uint256 epoch,
        uint96 amount
    ) external onlyContracts {
        nodesEpochPublishingAllocation[identityId][epoch] += amount;
        epochPublishingAllocation[epoch] += amount;

        // Maintain the per-epoch node max so its (public) getters stay
        // consistent. The OT-RFC-51 scoring path does NOT read it
        // (RandomSampling reads only getNodeEpochPublishingAllocation /
        // getEpochPublishingAllocation), but the mapping cannot be removed —
        // it precedes `nodesPaidOut` in this persistent (non-fresh-state)
        // storage layout — and leaving it written-nowhere/read-in-getters
        // trips Slither's uninitialized-state finding. The compare/SSTORE is
        // negligible against the surrounding accounting.
        if (nodesEpochPublishingAllocation[identityId][epoch] > epochNodeMaxPublishingAllocation[epoch]) {
            epochNodeMaxPublishingAllocation[epoch] = nodesEpochPublishingAllocation[identityId][epoch];
        }

        emit EpochPublishingAllocationAdded(identityId, epoch, amount);
    }

    /// @notice OT-RFC-51: move `amount` of publishing allocation from one
    ///         node to another within a single `epoch`. Used when a PCA
    ///         re-designates its primary node — the epoch total
    ///         (`epochPublishingAllocation`, i.e. K_total) is intentionally
    ///         NOT touched, so the move is net-zero on the denominator of
    ///         every node's publishing factor.
    /// @dev    `epochNodeMaxPublishingAllocation` is a per-epoch HIGH-WATER
    ///         MARK, maintained identically on the add and move paths: it is
    ///         only ever RAISED (when the destination's new value exceeds it),
    ///         never lowered by the `fromId` decrement — computing the true
    ///         current max after a decrement would need an O(nodes) scan.
    ///         Nothing on-chain reads it (scoring reads only
    ///         get(Node)EpochPublishingAllocation); it exists for off-chain
    ///         observability, for which the high-water-mark semantic is correct.
    function moveEpochPublishingAllocation(
        uint72 fromId,
        uint72 toId,
        uint256 epoch,
        uint96 amount
    ) external onlyContracts {
        nodesEpochPublishingAllocation[fromId][epoch] -= amount;
        nodesEpochPublishingAllocation[toId][epoch] += amount; // epoch total unchanged -> K_total net-zero

        if (nodesEpochPublishingAllocation[toId][epoch] > epochNodeMaxPublishingAllocation[epoch]) {
            epochNodeMaxPublishingAllocation[epoch] = nodesEpochPublishingAllocation[toId][epoch];
        }
    }

    function getEpochPublishingAllocation(uint256 epoch) external view returns (uint96) {
        return epochPublishingAllocation[epoch];
    }

    function getCurrentEpochPublishingAllocation() external view returns (uint96) {
        return epochPublishingAllocation[chronos.getCurrentEpoch()];
    }

    function getPreviousEpochPublishingAllocation() external view returns (uint96) {
        uint256 currentEpoch = chronos.getCurrentEpoch();
        if (currentEpoch <= 1) {
            return 0;
        }
        return epochPublishingAllocation[currentEpoch - 1];
    }

    function getNodeEpochPublishingAllocation(uint72 identityId, uint256 epoch) external view returns (uint96) {
        return nodesEpochPublishingAllocation[identityId][epoch];
    }

    function getNodeCurrentEpochPublishingAllocation(uint72 identityId) external view returns (uint96) {
        return nodesEpochPublishingAllocation[identityId][chronos.getCurrentEpoch()];
    }

    function getNodePreviousEpochPublishingAllocation(uint72 identityId) external view returns (uint96) {
        uint256 currentEpoch = chronos.getCurrentEpoch();
        if (currentEpoch <= 1) {
            return 0;
        }
        return nodesEpochPublishingAllocation[identityId][currentEpoch - 1];
    }

    function getEpochNodeMaxPublishingAllocation(uint256 epoch) external view returns (uint96) {
        return epochNodeMaxPublishingAllocation[epoch];
    }

    function getCurrentEpochNodeMaxPublishingAllocation() external view returns (uint96) {
        return epochNodeMaxPublishingAllocation[chronos.getCurrentEpoch()];
    }

    function getPreviousEpochNodeMaxPublishingAllocation() external view returns (uint96) {
        uint256 currentEpoch = chronos.getCurrentEpoch();
        if (currentEpoch <= 1) {
            return 0;
        }
        return epochNodeMaxPublishingAllocation[currentEpoch - 1];
    }

    function getNodeEpochPublishingAllocationPercentage(
        uint72 identityId,
        uint256 epoch
    ) external view returns (uint256) {
        if (epochPublishingAllocation[epoch] == 0) {
            return 0;
        }

        return
            (uint256(nodesEpochPublishingAllocation[identityId][epoch]) * 1e18) / epochPublishingAllocation[epoch];
    }

    function getNodeCurrentEpochPublishingAllocationPercentage(uint72 identityId) external view returns (uint256) {
        uint256 currentEpoch = chronos.getCurrentEpoch();

        if (epochPublishingAllocation[currentEpoch] == 0) {
            return 0;
        }

        return ((uint256(nodesEpochPublishingAllocation[identityId][currentEpoch]) * 1e18) /
            epochPublishingAllocation[currentEpoch]);
    }

    function getNodePreviousEpochPublishingAllocationPercentage(uint72 identityId) external view returns (uint256) {
        uint256 currentEpoch = chronos.getCurrentEpoch();
        if (currentEpoch <= 1 || epochPublishingAllocation[currentEpoch - 1] == 0) {
            return 0;
        }
        return ((uint256(nodesEpochPublishingAllocation[identityId][currentEpoch - 1]) * 1e18) /
            epochPublishingAllocation[currentEpoch - 1]);
    }

    function addTokensToEpochRange(
        uint256 shardId,
        uint256 startEpoch,
        uint256 endEpoch,
        uint96 tokenAmount
    ) external onlyContracts {
        // SECURITY FIX: a credit whose startEpoch is already FINALIZED is
        // otherwise lost forever. `_finalizeEpochsUpTo` only folds `diff` for
        // `(lastFinalizedEpoch, currentEpoch-1]` and never revisits a finalized
        // epoch, so `diff[startEpoch] += p` at `startEpoch <= lastFinalizedEpoch`
        // is never folded into `cumulative` (the tokens vanish — stranded in the
        // contract with no payable pool entry) and the paired
        // `diff[endEpoch+1] -= p` later under-credits an unrelated future epoch.
        //
        // Clamp the range up to `lastFinalizedEpoch + 1` — the first epoch NOT
        // yet folded into `cumulative`, and therefore still payable (epochs above
        // `lastFinalizedEpoch` are read via on-the-fly simulation in
        // `getEpochPool`). This is the minimal correction: it rescues only the
        // credits that were genuinely lost (finalized epochs) and lands them in
        // the CLOSEST still-creditable epoch, preserving the caller's intended
        // attribution as much as possible — PublishingConviction deliberately
        // attributes a closed billing window to the chain epochs it overlapped,
        // so forcing `currentEpoch` here would misattribute/delay those rewards
        // on an idle shard. Any stricter "settle into the current epoch" policy
        // belongs at the specific caller, not in this shared primitive. Clamp,
        // don't revert: lazy past-window settlement is an intended pattern.
        uint256 firstOpenEpoch = lastFinalizedEpoch[shardId] + 1;
        if (startEpoch < firstOpenEpoch) {
            startEpoch = firstOpenEpoch;
            if (endEpoch < startEpoch) {
                endEpoch = startEpoch;
            }
        }

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
