// SPDX-License-Identifier: Apache-2.0

pragma solidity ^0.8.20;

import {AskStorage} from "./storage/AskStorage.sol";
import {ShardingTableStorage} from "./storage/ShardingTableStorage.sol";
import {ParametersStorage} from "./storage/ParametersStorage.sol";
import {ProfileStorage} from "./storage/ProfileStorage.sol";
import {ConvictionStakingStorage} from "./storage/ConvictionStakingStorage.sol";
import {INamed} from "./interfaces/INamed.sol";
import {IVersioned} from "./interfaces/IVersioned.sol";
import {IInitializable} from "./interfaces/IInitializable.sol";
import {ContractStatus} from "./abstract/ContractStatus.sol";

contract Ask is INamed, IVersioned, ContractStatus, IInitializable {
    string private constant _NAME = "Ask";
    // Version history:
    //   1.0.0 — initial active-set / weighted-ask reader (V8 stake source).
    //   2.0.0 — v4.0.0 storage consolidation: reads V10 canonical stake
    //           (`ConvictionStakingStorage.getNodeStakeV10`) so post-migration
    //           V10 nodes are not silently filtered out of the active set.
    string private constant _VERSION = "2.0.0";

    uint256 public constant ASK_SCALING_FACTOR = 1e18;

    AskStorage public askStorage;
    ShardingTableStorage public shardingTableStorage;
    ParametersStorage public parametersStorage;
    ProfileStorage public profileStorage;
    /// @notice v4.0.0 — V10 canonical node stake source. Replaces the prior
    ///         `stakingStorage` field; V8 `getNodeStake` is unmaintained for
    ///         post-migration nodes and would zero-skip every V10 node.
    ConvictionStakingStorage public convictionStakingStorage;

    // solhint-disable-next-line no-empty-blocks
    constructor(address hubAddress) ContractStatus(hubAddress) {}

    function initialize() public onlyHub {
        askStorage = AskStorage(hub.getContractAddress("AskStorage"));
        shardingTableStorage = ShardingTableStorage(hub.getContractAddress("ShardingTableStorage"));
        parametersStorage = ParametersStorage(hub.getContractAddress("ParametersStorage"));
        profileStorage = ProfileStorage(hub.getContractAddress("ProfileStorage"));
        convictionStakingStorage = ConvictionStakingStorage(hub.getContractAddress("ConvictionStakingStorage"));
    }

    function name() public pure virtual returns (string memory) {
        return _NAME;
    }

    function version() external pure virtual returns (string memory) {
        return _VERSION;
    }

    function recalculateActiveSet() external onlyContracts {
        AskStorage ass = askStorage;
        ShardingTableStorage sts = shardingTableStorage;
        ConvictionStakingStorage cs = convictionStakingStorage;
        ParametersStorage params = parametersStorage;
        ProfileStorage ps = profileStorage;

        ass.setPrevWeightedActiveAskSum(ass.weightedActiveAskSum());
        ass.setPrevTotalActiveStake(ass.totalActiveStake());

        uint96 minimumStake = params.minimumStake();
        uint96 maximumStake = params.maximumStake();

        uint256 askLowerBound;
        uint256 askUpperBound;

        if (ass.prevTotalActiveStake() > 0 && ass.prevWeightedActiveAskSum() > 0) {
            (askLowerBound, askUpperBound) = ass.getAskBounds();
        } else {
            (askLowerBound, askUpperBound) = (0, type(uint256).max);
        }

        uint256 newWeightedActiveAskSum;
        uint96 newTotalActiveStake;

        uint72 count = sts.nodesCount();
        for (uint72 i; i < count; i++) {
            uint72 nodeIdentityId = sts.indexToIdentityId(i);
            // v4.0.0 — V10 raw stake. Cast safe because the very next line
            // caps at `maximumStake` (uint96) before the uint96 multiplications
            // / accumulators below; CSS's `nodeStakeV10` is `uint256` only
            // because the migration sums could theoretically exceed uint96
            // when modelled mid-flight, but the cap eliminates any overflow
            // risk in this loop.
            uint256 stake256 = cs.getNodeStakeV10(nodeIdentityId);

            if (stake256 < minimumStake) {
                continue;
            }

            uint96 stake = stake256 > maximumStake ? maximumStake : uint96(stake256);
            uint256 nodeAskScaled = uint256(ps.getAsk(nodeIdentityId)) * ASK_SCALING_FACTOR;
            if (nodeAskScaled >= askLowerBound && nodeAskScaled <= askUpperBound) {
                newWeightedActiveAskSum += (nodeAskScaled / ASK_SCALING_FACTOR) * stake;
                newTotalActiveStake += stake;
            }
        }

        ass.setWeightedActiveAskSum(newWeightedActiveAskSum);
        ass.setTotalActiveStake(newTotalActiveStake);
    }
}
