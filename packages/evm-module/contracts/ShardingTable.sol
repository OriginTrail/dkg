// SPDX-License-Identifier: Apache-2.0

pragma solidity ^0.8.20;

import {ProfileStorage} from "./storage/ProfileStorage.sol";
import {ShardingTableStorage} from "./storage/ShardingTableStorage.sol";
import {ConvictionStakingStorage} from "./storage/ConvictionStakingStorage.sol";
import {ContractStatus} from "./abstract/ContractStatus.sol";
import {IInitializable} from "./interfaces/IInitializable.sol";
import {INamed} from "./interfaces/INamed.sol";
import {IVersioned} from "./interfaces/IVersioned.sol";
import {ShardingTableLib} from "./libraries/ShardingTableLib.sol";

contract ShardingTable is INamed, IVersioned, ContractStatus, IInitializable {
    string private constant _NAME = "ShardingTable";
    string private constant _VERSION = "1.0.0";

    ProfileStorage public profileStorage;
    ShardingTableStorage public shardingTableStorage;
    /// @notice v4.0.0 — V10 canonical node stake source. Replaces the prior
    ///         `stakingStorage` reference; the V8 archive is unmaintained
    ///         post-migration so its `getNodeStake` is not a faithful read.
    ConvictionStakingStorage public convictionStakingStorage;

    uint256 public migrationPeriodEnd;

    // solhint-disable-next-line no-empty-blocks
    constructor(address hubAddress, uint256 migrationPeriodEnd_) ContractStatus(hubAddress) {
        migrationPeriodEnd = migrationPeriodEnd_;
    }

    function initialize() public onlyHub {
        profileStorage = ProfileStorage(hub.getContractAddress("ProfileStorage"));
        shardingTableStorage = ShardingTableStorage(hub.getContractAddress("ShardingTableStorage"));
        convictionStakingStorage = ConvictionStakingStorage(hub.getContractAddress("ConvictionStakingStorage"));
    }

    function name() external pure virtual override returns (string memory) {
        return _NAME;
    }

    function version() external pure virtual override returns (string memory) {
        return _VERSION;
    }

    function getShardingTable(
        uint72 startingIdentityId,
        uint72 nodesNumber
    ) external view returns (ShardingTableLib.NodeInfo[] memory) {
        return _getShardingTable(startingIdentityId, nodesNumber);
    }

    function getShardingTable() external view returns (ShardingTableLib.NodeInfo[] memory) {
        ShardingTableStorage sts = shardingTableStorage;
        return _getShardingTable(sts.indexToIdentityId(0), sts.nodesCount());
    }

    function insertNode(uint72 identityId) external onlyContracts {
        uint256 newNodeHashRingPosition = uint256(sha256(profileStorage.getNodeId(identityId)));

        _insertNode(_binarySearchForIndex(newNodeHashRingPosition), identityId, newNodeHashRingPosition);
    }

    function insertNode(uint72 index, uint72 identityId) external onlyContracts {
        _insertNode(index, identityId, uint256(sha256(profileStorage.getNodeId(identityId))));
    }

    function removeNode(uint72 identityId) external onlyContracts {
        ShardingTableStorage sts = shardingTableStorage;

        ShardingTableLib.Node memory nodeToRemove = sts.getNode(identityId);

        // Decrement indexes of all nodes after removed one + add pointers to identityId for changed indexes
        uint72 index = nodeToRemove.index;
        uint72 nextIdentityId = sts.indexToIdentityId(nodeToRemove.index + 1);
        while (nextIdentityId != ShardingTableLib.NULL) {
            sts.decrementNodeIndex(nextIdentityId);
            sts.setIdentityId(index, nextIdentityId);

            unchecked {
                index += 1;
            }

            nextIdentityId = sts.indexToIdentityId(index + 1);
        }

        // Delete node object + set last index pointer to be ShardingTableLib.NULL + decrement total nodes count
        sts.deleteNodeObject(identityId);
        sts.setIdentityId(index, ShardingTableLib.NULL);
        sts.decrementNodesCount();
    }

    function _binarySearchForIndex(uint256 hashRingPosition) internal virtual returns (uint72) {
        ShardingTableStorage sts = shardingTableStorage;

        uint72 nodesCount = sts.nodesCount();

        if (nodesCount == 0) {
            return 0;
        }

        uint72 left;
        uint72 mid;
        uint72 right = nodesCount - 1;

        while (left <= right) {
            mid = (left + right) / 2;
            uint256 currentHashRingPosition = sts.getHashRingPositionByIndex(mid);

            if (hashRingPosition > currentHashRingPosition) {
                // Node is in the right half of the range, move left pointers
                left = mid + 1;
            } else if (hashRingPosition < currentHashRingPosition) {
                if (mid == 0) {
                    // The new element should be inserted at index 0
                    return 0;
                }
                // Node is in the left half of the range, move right pointers
                right = mid - 1;
            } else {
                // Exact match found
                return mid;
            }
        }

        return left;
    }

    function _insertNode(uint72 index, uint72 identityId, uint256 newNodeHashRingPosition) internal virtual {
        ShardingTableStorage sts = shardingTableStorage;
        ProfileStorage ps = profileStorage;

        if (sts.nodeExists(identityId)) {
            revert ShardingTableLib.NodeAlreadyInTheShardingTable(identityId);
        }

        if (index != 0) {
            uint256 prevNodeHashRingPosition = sts.getHashRingPositionByIndex(index - 1);

            // Check that the new Node is indeed on the right from the prevNode
            // Also allows new Head insertion as prevNode.hashRingPosition will be 0 in such case
            if (newNodeHashRingPosition < prevNodeHashRingPosition) {
                revert ShardingTableLib.InvalidIndexWithRespectToPreviousNode(
                    identityId,
                    newNodeHashRingPosition,
                    prevNodeHashRingPosition
                );
            }
        }

        ShardingTableLib.Node memory nextNode = sts.getNodeByIndex(index);

        // Check that the new Node is indeed on the left from the nextNode
        // Check is skipped when inserting new Tail
        if (nextNode.identityId != ShardingTableLib.NULL && newNodeHashRingPosition > nextNode.hashRingPosition) {
            revert ShardingTableLib.InvalidIndexWithRespectToNextNode(
                identityId,
                newNodeHashRingPosition,
                nextNode.hashRingPosition
            );
        }
        // Create node object + set index pointer to new identityId + increment total nodes count
        sts.createNodeObject(newNodeHashRingPosition, ps.getNodeId(identityId), identityId, index);
        sts.setIdentityId(index, identityId);
        sts.incrementNodesCount();

        // Increment indexes of all nodes after inserted one + add pointers to identityId for changed indexes
        uint72 currentIdentityId;
        uint72 nextIdentityId = nextNode.identityId;
        while (nextIdentityId != ShardingTableLib.NULL) {
            unchecked {
                index += 1;
            }

            currentIdentityId = nextIdentityId;
            nextIdentityId = sts.indexToIdentityId(index);

            sts.incrementNodeIndex(currentIdentityId);
            sts.setIdentityId(index, currentIdentityId);
        }
    }

    function _getShardingTable(
        uint72 startingIdentityId,
        uint72 nodesNumber
    ) internal view virtual returns (ShardingTableLib.NodeInfo[] memory) {
        ShardingTableLib.NodeInfo[] memory nodesPage;
        ShardingTableStorage sts = shardingTableStorage;

        if ((sts.nodesCount() == 0) || (nodesNumber == 0)) {
            return nodesPage;
        }
        ShardingTableLib.Node memory startingNode = sts.getNode(startingIdentityId);

        if (startingIdentityId == ShardingTableLib.NULL || startingNode.identityId == ShardingTableLib.NULL) {
            revert ShardingTableLib.InvalidStartingIdentityId(startingIdentityId);
        }

        nodesPage = new ShardingTableLib.NodeInfo[](nodesNumber);

        ProfileStorage ps = profileStorage;
        ConvictionStakingStorage cs = convictionStakingStorage;

        uint72 nextIdentityId = startingIdentityId;
        uint72 index;
        while ((index < nodesNumber) && (nextIdentityId != ShardingTableLib.NULL)) {
            // v4.0.0 — V10 canonical node stake. Down-cast to uint96 is safe
            // under protocol invariants: `StakingV10.stake` enforces
            // `nodeStakeV10 <= parametersStorage.maximumStake()` (uint96), and
            // the V10 raw stake field cannot exceed the cap.
            uint256 stake256 = cs.getNodeStakeV10(nextIdentityId);
            uint96 stakeView = stake256 > type(uint96).max ? type(uint96).max : uint96(stake256);
            nodesPage[index] = ShardingTableLib.NodeInfo({
                nodeId: ps.getNodeId(nextIdentityId),
                identityId: nextIdentityId,
                ask: ps.getAsk(nextIdentityId),
                stake: stakeView
            });

            unchecked {
                index += 1;
            }
            nextIdentityId = sts.indexToIdentityId(index + startingNode.index);
        }

        return nodesPage;
    }
}
