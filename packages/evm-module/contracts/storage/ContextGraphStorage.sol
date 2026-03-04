// SPDX-License-Identifier: Apache-2.0

pragma solidity ^0.8.20;

import {Guardian} from "../Guardian.sol";
import {KnowledgeAssetsLib} from "../libraries/KnowledgeAssetsLib.sol";
import {INamed} from "../interfaces/INamed.sol";
import {IVersioned} from "../interfaces/IVersioned.sol";

/**
 * @title ContextGraphStorage
 * @notice Registry for Context Graphs — bounded, M/N signature-gated subgraphs within paranets.
 *
 * A Context Graph defines a set of participant node identities and a signature threshold (M of N).
 * KAs published to a Context Graph require at least M valid signatures from the participant set.
 */
contract ContextGraphStorage is INamed, IVersioned, Guardian {
    string private constant _NAME = "ContextGraphStorage";
    string private constant _VERSION = "1.0.0";

    uint256 private _contextGraphCounter;
    mapping(uint256 => KnowledgeAssetsLib.ContextGraph) private _contextGraphs;

    /// @notice Tracks which batches belong to a context graph (contextGraphId => batchId[])
    mapping(uint256 => uint256[]) private _contextGraphBatches;

    event ContextGraphCreated(
        uint256 indexed contextGraphId,
        address indexed manager,
        uint72[] participantIdentityIds,
        uint8 requiredSignatures,
        uint256 metadataBatchId
    );

    event ContextGraphExpanded(
        uint256 indexed contextGraphId,
        uint256 indexed batchId
    );

    event ContextGraphDeactivated(
        uint256 indexed contextGraphId
    );

    constructor(address hubAddress) Guardian(hubAddress) {}

    function name() public pure virtual returns (string memory) {
        return _NAME;
    }

    function version() external pure virtual returns (string memory) {
        return _VERSION;
    }

    // --- Creation ---

    function createContextGraph(
        address manager,
        uint72[] calldata participantIdentityIds,
        uint8 requiredSignatures,
        uint256 metadataBatchId
    ) external onlyContracts returns (uint256 contextGraphId) {
        if (manager == address(0)) {
            revert KnowledgeAssetsLib.InvalidContextGraphConfig("zero address manager");
        }
        if (participantIdentityIds.length == 0) {
            revert KnowledgeAssetsLib.InvalidContextGraphConfig("empty participants");
        }
        if (requiredSignatures == 0 || requiredSignatures > participantIdentityIds.length) {
            revert KnowledgeAssetsLib.InvalidContextGraphConfig("invalid M/N threshold");
        }

        contextGraphId = ++_contextGraphCounter;

        KnowledgeAssetsLib.ContextGraph storage cg = _contextGraphs[contextGraphId];
        cg.manager = manager;
        cg.participantIdentityIds = participantIdentityIds;
        cg.requiredSignatures = requiredSignatures;
        cg.metadataBatchId = metadataBatchId;
        cg.active = true;
        cg.createdAt = block.timestamp;

        emit ContextGraphCreated(
            contextGraphId,
            manager,
            participantIdentityIds,
            requiredSignatures,
            metadataBatchId
        );
    }

    // --- Expansion tracking ---

    function addBatchToContextGraph(
        uint256 contextGraphId,
        uint256 batchId
    ) external onlyContracts {
        if (!_contextGraphs[contextGraphId].active) {
            revert KnowledgeAssetsLib.ContextGraphNotActive(contextGraphId);
        }
        _contextGraphBatches[contextGraphId].push(batchId);
        emit ContextGraphExpanded(contextGraphId, batchId);
    }

    // --- Deactivation ---

    function deactivateContextGraph(
        uint256 contextGraphId
    ) external onlyContracts {
        KnowledgeAssetsLib.ContextGraph storage cg = _contextGraphs[contextGraphId];
        if (cg.manager == address(0)) {
            revert KnowledgeAssetsLib.ContextGraphNotFound(contextGraphId);
        }
        cg.active = false;
        emit ContextGraphDeactivated(contextGraphId);
    }

    // --- Participant verification ---

    function isParticipant(
        uint256 contextGraphId,
        uint72 identityId
    ) external view returns (bool) {
        uint72[] storage participants = _contextGraphs[contextGraphId].participantIdentityIds;
        for (uint256 i; i < participants.length; i++) {
            if (participants[i] == identityId) return true;
        }
        return false;
    }

    // --- Getters ---

    function getContextGraph(
        uint256 contextGraphId
    ) external view returns (
        address manager,
        uint72[] memory participantIdentityIds,
        uint8 requiredSignatures,
        uint256 metadataBatchId,
        bool active,
        uint256 createdAt
    ) {
        KnowledgeAssetsLib.ContextGraph storage cg = _contextGraphs[contextGraphId];
        if (cg.manager == address(0)) {
            revert KnowledgeAssetsLib.ContextGraphNotFound(contextGraphId);
        }
        return (
            cg.manager,
            cg.participantIdentityIds,
            cg.requiredSignatures,
            cg.metadataBatchId,
            cg.active,
            cg.createdAt
        );
    }

    function getContextGraphRequiredSignatures(
        uint256 contextGraphId
    ) external view returns (uint8) {
        return _contextGraphs[contextGraphId].requiredSignatures;
    }

    function getContextGraphParticipants(
        uint256 contextGraphId
    ) external view returns (uint72[] memory) {
        return _contextGraphs[contextGraphId].participantIdentityIds;
    }

    function getContextGraphManager(
        uint256 contextGraphId
    ) external view returns (address) {
        return _contextGraphs[contextGraphId].manager;
    }

    function isContextGraphActive(
        uint256 contextGraphId
    ) external view returns (bool) {
        return _contextGraphs[contextGraphId].active;
    }

    function getContextGraphBatches(
        uint256 contextGraphId
    ) external view returns (uint256[] memory) {
        return _contextGraphBatches[contextGraphId];
    }

    function getContextGraphBatchCount(
        uint256 contextGraphId
    ) external view returns (uint256) {
        return _contextGraphBatches[contextGraphId].length;
    }

    function getLatestContextGraphId() external view returns (uint256) {
        return _contextGraphCounter;
    }

    /**
     * @notice Verify that a triple (identified by its hash) is included in a context graph batch
     *         by checking a Merkle inclusion proof against the batch's on-chain merkle root.
     * @param contextGraphId   The context graph the batch belongs to
     * @param batchId          The batch within this context graph
     * @param tripleHash       keccak256 hash of the triple (subject, predicate, object)
     * @param leafIndex        Position of the triple hash in the sorted leaf array
     * @param siblings         Merkle proof siblings from leaf to root
     * @param kaStorageAddress Address of KnowledgeAssetsStorage to read the batch merkle root
     * @return valid           True if the proof is correct and batchId belongs to contextGraphId
     */
    function verifyTripleInclusion(
        uint256 contextGraphId,
        uint256 batchId,
        bytes32 tripleHash,
        uint256 leafIndex,
        bytes32[] calldata siblings,
        address kaStorageAddress
    ) external view returns (bool valid) {
        require(_contextGraphs[contextGraphId].active, "ContextGraph not active");

        bool batchBelongs = false;
        uint256[] storage batches = _contextGraphBatches[contextGraphId];
        for (uint256 i = 0; i < batches.length; i++) {
            if (batches[i] == batchId) {
                batchBelongs = true;
                break;
            }
        }
        require(batchBelongs, "Batch not in context graph");

        bytes32 onChainRoot = KnowledgeAssetsStorageLike(kaStorageAddress)
            .getBatchMerkleRoot(batchId);

        bytes32 computed = tripleHash;
        uint256 idx = leafIndex;
        for (uint256 i = 0; i < siblings.length; i++) {
            if (idx % 2 == 0) {
                computed = keccak256(abi.encodePacked(computed, siblings[i]));
            } else {
                computed = keccak256(abi.encodePacked(siblings[i], computed));
            }
            idx /= 2;
        }

        return computed == onChainRoot;
    }
}

interface KnowledgeAssetsStorageLike {
    function getBatchMerkleRoot(uint256 batchId) external view returns (bytes32);
}
