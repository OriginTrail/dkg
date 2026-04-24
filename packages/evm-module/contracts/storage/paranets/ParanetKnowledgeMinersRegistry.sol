// SPDX-License-Identifier: Apache-2.0

pragma solidity ^0.8.20;

import {ParanetsRegistry} from "./ParanetsRegistry.sol";
import {HubDependent} from "../../abstract/HubDependent.sol";
import {INamed} from "../../interfaces/INamed.sol";
import {IVersioned} from "../../interfaces/IVersioned.sol";
import {ParanetLib} from "../../libraries/ParanetLib.sol";

contract ParanetKnowledgeMinersRegistry is INamed, IVersioned, HubDependent {
    string private constant _NAME = "ParanetKnowledgeMinersRegistry";
    string private constant _VERSION = "1.0.0";

    ParanetsRegistry public paranetsRegistry;

    // Address => Knowledge Miner Profile
    mapping(address => ParanetLib.KnowledgeMiner) internal knowledgeMiners;

    // solhint-disable-next-line no-empty-blocks
    constructor(address hubAddress) HubDependent(hubAddress) {}

    modifier onlyContractsOrIncentivesPool(bytes32 paranetId) {
        _checkSender(paranetId);
        _;
    }

    function initialize() public onlyHub {
        paranetsRegistry = ParanetsRegistry(hub.getContractAddress("ParanetsRegistry"));
    }

    function name() external pure virtual override returns (string memory) {
        return _NAME;
    }

    function version() external pure virtual override returns (string memory) {
        return _VERSION;
    }

    function registerKnowledgeMiner(address miner) external onlyContracts {
        ParanetLib.KnowledgeMiner storage knowledgeMiner = knowledgeMiners[miner];

        knowledgeMiner.addr = miner;
    }

    function deleteKnowledgeMiner(address miner) external onlyContracts {
        delete knowledgeMiners[miner];
    }

    function knowledgeMinerExists(address miner) external view returns (bool) {
        return knowledgeMiners[miner].addr == miner;
    }

    function getKnowledgeMinerMetadata(address addr) external view returns (ParanetLib.KnowledgeMinerMetadata memory) {
        return
            ParanetLib.KnowledgeMinerMetadata({
                addr: addr,
                totalTracSpent: knowledgeMiners[addr].totalTracSpent,
                totalSubmittedKnowledgeCollectionsCount: knowledgeMiners[addr].totalSubmittedKnowledgeCollectionsCount
            });
    }

    function getTotalTracSpent(address miner) external view returns (uint96) {
        return knowledgeMiners[miner].totalTracSpent;
    }

    function setTotalTracSpent(address miner, uint96 totalTracSpent) external onlyContracts {
        knowledgeMiners[miner].totalTracSpent = totalTracSpent;
    }

    function addTotalTracSpent(address miner, uint96 addedTracSpent) external onlyContracts {
        knowledgeMiners[miner].totalTracSpent += addedTracSpent;
    }

    function subTotalTracSpent(address miner, uint96 subtractedTracSpent) external onlyContracts {
        knowledgeMiners[miner].totalTracSpent -= subtractedTracSpent;
    }

    function getTotalSubmittedKnowledgeCollectionsCount(address miner) external view returns (uint256) {
        return knowledgeMiners[miner].totalSubmittedKnowledgeCollectionsCount;
    }

    function setTotalSubmittedKnowledgeCollectionsCount(
        address miner,
        uint256 totalSubmittedKnowledgeCollectionsCount
    ) external onlyContracts {
        knowledgeMiners[miner].totalSubmittedKnowledgeCollectionsCount = totalSubmittedKnowledgeCollectionsCount;
    }

    function incrementTotalSubmittedKnowledgeCollectionsCount(address miner) external onlyContracts {
        unchecked {
            knowledgeMiners[miner].totalSubmittedKnowledgeCollectionsCount++;
        }
    }

    function decrementTotalSubmittedKnowledgeCollectionsCount(address miner) external onlyContracts {
        unchecked {
            knowledgeMiners[miner].totalSubmittedKnowledgeCollectionsCount--;
        }
    }

    function addSubmittedKnowledgeCollection(
        address miner,
        bytes32 paranetId,
        bytes32 knowledgeCollectionId
    ) external onlyContracts {
        knowledgeMiners[miner].submittedKnowledgeCollectionsIndexes[paranetId][knowledgeCollectionId] = knowledgeMiners[
            miner
        ].submittedKnowledgeCollections[paranetId].length;
        knowledgeMiners[miner].submittedKnowledgeCollections[paranetId].push(knowledgeCollectionId);
    }

    function removeSubmittedKnowledgeCollection(
        address miner,
        bytes32 paranetId,
        bytes32 knowledgeCollectionId
    ) external onlyContracts {
        // 1. Move the last element to the slot of the element to remove
        knowledgeMiners[miner].submittedKnowledgeCollections[paranetId][
            knowledgeMiners[miner].submittedKnowledgeCollectionsIndexes[paranetId][knowledgeCollectionId]
        ] = knowledgeMiners[miner].submittedKnowledgeCollections[paranetId][
            knowledgeMiners[miner].submittedKnowledgeCollections[paranetId].length - 1
        ];

        // 2. Update the index of the moved element
        knowledgeMiners[miner].submittedKnowledgeCollectionsIndexes[paranetId][
            knowledgeMiners[miner].submittedKnowledgeCollections[paranetId][
                knowledgeMiners[miner].submittedKnowledgeCollections[paranetId].length - 1
            ]
        ] = knowledgeMiners[miner].submittedKnowledgeCollectionsIndexes[paranetId][knowledgeCollectionId];

        // 3. Remove the last element from the array
        knowledgeMiners[miner].submittedKnowledgeCollections[paranetId].pop();

        // 4. Delete the index of the removed element
        delete knowledgeMiners[miner].submittedKnowledgeCollectionsIndexes[paranetId][knowledgeCollectionId];
    }

    function getSubmittedKnowledgeCollections(
        address miner,
        bytes32 paranetId
    ) external view returns (bytes32[] memory) {
        return knowledgeMiners[miner].submittedKnowledgeCollections[paranetId];
    }

    function getSubmittedKnowledgeCollections(
        address miner,
        bytes32 paranetId,
        uint256 start,
        uint256 end
    ) external view returns (bytes32[] memory) {
        require(start <= end, "Start should be <= End");
        require(
            end <= knowledgeMiners[miner].submittedKnowledgeCollections[paranetId].length,
            "End should be <= length of Array"
        );

        bytes32[] memory slice = new bytes32[](end - start);
        for (uint256 i; i < slice.length; ) {
            slice[i] = knowledgeMiners[miner].submittedKnowledgeCollections[paranetId][i];

            unchecked {
                i++;
            }
        }

        return slice;
    }

    // This should be called on update from KC
    function addUpdatingKnowledgeCollectionState(
        address miner,
        bytes32 paranetId,
        address knowledgeCollectionStorageContract,
        uint256 knowledgeCollectionId,
        bytes32 merkleRoot,
        uint96 updateTokenAmount
    ) external onlyContracts {
        knowledgeMiners[miner].updatingKnowledgeCollectionsStateIndexes[paranetId][
            keccak256(abi.encodePacked(knowledgeCollectionStorageContract, knowledgeCollectionId, merkleRoot))
        ] = knowledgeMiners[miner].updatingKnowledgeCollectionsStates[paranetId].length;

        knowledgeMiners[miner].updatingKnowledgeCollectionsStates[paranetId].push(
            ParanetLib.UpdatingKnowledgeCollectionState({
                knowledgeCollectionStorageContract: knowledgeCollectionStorageContract,
                knowledgeCollectionId: knowledgeCollectionId,
                merkleRoot: merkleRoot,
                updateTokenAmount: updateTokenAmount
            })
        );
    }

    // If we do this on update
    // function removeUpdatingKnowledgeCollectionState(
    //     address miner,
    //     bytes32 paranetId,
    //     bytes32 knowledgeCollectionStateId
    // ) external onlyContracts {
    //     // 1. Move the last element to the slot of the element to remove
    //     knowledgeMiners[miner].updatingKnowledgeCollectionsStates[paranetId][
    //         knowledgeMiners[miner].updatingKnowledgeCollectionsStates[paranetId][knowledgeCollectionStateId]
    //     ] = knowledgeMiners[miner].updatingKnowledgeCollectionsStates[paranetId][
    //         knowledgeMiners[miner].updatingKnowledgeCollectionsStates[paranetId].length - 1
    //     ];

    //     // 2. Update the index of the moved element
    //     knowledgeMiners[miner].updatingKnowledgeCollectionsStateIndexes[paranetId][
    //         keccak256(
    //             abi.encodePacked(
    //                 knowledgeMiners[miner]
    //                 .updatingKnowledgeCollectionStates[paranetId][
    //                     knowledgeMiners[miner].updatingKnowledgeCollectionStates[paranetId].length - 1
    //                 ].knowledgeCollectionStorageContract,
    //                 knowledgeMiners[miner]
    //                 .updatingKnowledgeCollectionStates[paranetId][
    //                     knowledgeMiners[miner].updatingKnowledgeCollectionStates[paranetId].length - 1
    //                 ].tokenId,
    //                 knowledgeMiners[miner]
    //                 .updatingKnowledgeCollectionStates[paranetId][
    //                     knowledgeMiners[miner].updatingKnowledgeCollectionStates[paranetId].length - 1
    //                 ].merkleRoot
    //             )
    //         )
    //     ] = knowledgeMiners[miner].updatingKnowledgeCollectionStateIndexes[paranetId][knowledgeCollectionStateId];

    //     // 3. Remove the last element from the array
    //     knowledgeMiners[miner].updatingKnowledgeCollectionStates[paranetId].pop();

    //     // 4. Delete the index of the removed element
    //     delete knowledgeMiners[miner].updatingKnowledgeCollectionStateIndexes[paranetId][knowledgeCollectionStateId];
    // }

    function getUpdatingKnowledgeCollectionStates(
        address miner,
        bytes32 paranetId
    ) external view returns (ParanetLib.UpdatingKnowledgeCollectionState[] memory) {
        return knowledgeMiners[miner].updatingKnowledgeCollectionsStates[paranetId];
    }

    function getUpdatingKnowledgeCollectionStates(
        address miner,
        bytes32 paranetId,
        uint256 start,
        uint256 end
    ) external view returns (ParanetLib.UpdatingKnowledgeCollectionState[] memory) {
        require(start <= end, "Start should be <= End");
        require(
            end <= knowledgeMiners[miner].updatingKnowledgeCollectionsStates[paranetId].length,
            "End should be <= length of Array"
        );

        ParanetLib.UpdatingKnowledgeCollectionState[] memory slice = new ParanetLib.UpdatingKnowledgeCollectionState[](
            end - start
        );
        for (uint256 i; i < slice.length; ) {
            slice[i] = knowledgeMiners[miner].updatingKnowledgeCollectionsStates[paranetId][i];

            unchecked {
                i++;
            }
        }

        return slice;
    }

    function setUpdatingKnowledgeCollectionUpdateTokenAmount(
        address miner,
        bytes32 paranetId,
        bytes32 knowledgeCollectionStateId,
        uint96 updateTokenAmount
    ) external onlyContracts {
        knowledgeMiners[miner]
        .updatingKnowledgeCollectionsStates[paranetId][
            knowledgeMiners[miner].updatingKnowledgeCollectionsStateIndexes[paranetId][knowledgeCollectionStateId]
        ].updateTokenAmount = updateTokenAmount;
    }

    function addUpdatingKnowledgeCollectionUpdateTokenAmount(
        address miner,
        bytes32 paranetId,
        bytes32 knowledgeCollectionStateId,
        uint96 addedUpdateTokenAmount
    ) external onlyContracts {
        knowledgeMiners[miner]
        .updatingKnowledgeCollectionsStates[paranetId][
            knowledgeMiners[miner].updatingKnowledgeCollectionsStateIndexes[paranetId][knowledgeCollectionStateId]
        ].updateTokenAmount += addedUpdateTokenAmount;
    }

    function subUpdatingKnowledgeCollectionUpdateTokenAmount(
        address miner,
        bytes32 paranetId,
        bytes32 knowledgeCollectionStateId,
        uint96 subtractedUpdateTokenAmount
    ) external onlyContracts {
        knowledgeMiners[miner]
        .updatingKnowledgeCollectionsStates[paranetId][
            knowledgeMiners[miner].updatingKnowledgeCollectionsStateIndexes[paranetId][knowledgeCollectionStateId]
        ].updateTokenAmount -= subtractedUpdateTokenAmount;
    }

    function getCumulativeTracSpent(address miner, bytes32 paranetId) external view returns (uint96) {
        return knowledgeMiners[miner].cumulativeTracSpent[paranetId];
    }

    function setCumulativeTracSpent(
        address miner,
        bytes32 paranetId,
        uint96 cumulativeTracSpent
    ) external onlyContracts {
        knowledgeMiners[miner].cumulativeTracSpent[paranetId] = cumulativeTracSpent;
    }

    function addCumulativeTracSpent(address miner, bytes32 paranetId, uint96 addedTracSpent) external onlyContracts {
        knowledgeMiners[miner].cumulativeTracSpent[paranetId] += addedTracSpent;
    }

    function subCumulativeTracSpent(
        address miner,
        bytes32 paranetId,
        uint96 subtractedTracSpent
    ) external onlyContracts {
        knowledgeMiners[miner].cumulativeTracSpent[paranetId] -= subtractedTracSpent;
    }

    function getUnrewardedTracSpent(address miner, bytes32 paranetId) external view returns (uint96) {
        return knowledgeMiners[miner].unrewardedTracSpent[paranetId];
    }

    function setUnrewardedTracSpent(
        address miner,
        bytes32 paranetId,
        uint96 unrewardedTracSpent
    ) external onlyContractsOrIncentivesPool(paranetId) {
        knowledgeMiners[miner].unrewardedTracSpent[paranetId] = unrewardedTracSpent;
    }

    function addUnrewardedTracSpent(
        address miner,
        bytes32 paranetId,
        uint96 addedUnrewardedTracSpent
    ) external onlyContractsOrIncentivesPool(paranetId) {
        knowledgeMiners[miner].unrewardedTracSpent[paranetId] += addedUnrewardedTracSpent;
    }

    function subUnrewardedTracSpent(
        address miner,
        bytes32 paranetId,
        uint96 subtractedUnrewardedTracSpent
    ) external onlyContractsOrIncentivesPool(paranetId) {
        knowledgeMiners[miner].unrewardedTracSpent[paranetId] -= subtractedUnrewardedTracSpent;
    }

    function getcumulativeAwardedToken(address miner, bytes32 paranetId) external view returns (uint256) {
        return knowledgeMiners[miner].cumulativeAwardedToken[paranetId];
    }

    function setcumulativeAwardedToken(
        address miner,
        bytes32 paranetId,
        uint256 cumulativeAwardedToken
    ) external onlyContractsOrIncentivesPool(paranetId) {
        knowledgeMiners[miner].cumulativeAwardedToken[paranetId] = cumulativeAwardedToken;
    }

    function addcumulativeAwardedToken(
        address miner,
        bytes32 paranetId,
        uint256 addedcumulativeAwardedToken
    ) external onlyContractsOrIncentivesPool(paranetId) {
        knowledgeMiners[miner].cumulativeAwardedToken[paranetId] += addedcumulativeAwardedToken;
    }

    function subcumulativeAwardedToken(
        address miner,
        bytes32 paranetId,
        uint256 subtractedcumulativeAwardedToken
    ) external onlyContractsOrIncentivesPool(paranetId) {
        knowledgeMiners[miner].cumulativeAwardedToken[paranetId] -= subtractedcumulativeAwardedToken;
    }

    // V10 note: the V9 `IParanetIncentivesPool` escape hatch was removed with
    // the ParanetIncentivesPool* contracts. This modifier now behaves like a
    // plain `onlyContracts` — the on-chain incentives-pool list on
    // `ParanetsRegistry` is frozen at whatever state the V8→V10 migration
    // left it in and cannot grow.
    function _checkSender(bytes32 paranetId) internal view virtual {
        paranetId; // silence unused-parameter warning; preserved in modifier ABI
        require(hub.isContract(msg.sender), "Hub contracts only");
    }
}
