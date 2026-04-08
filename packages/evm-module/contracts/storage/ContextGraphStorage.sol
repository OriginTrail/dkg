// SPDX-License-Identifier: Apache-2.0

pragma solidity ^0.8.20;

import {Guardian} from "../Guardian.sol";
import {KnowledgeAssetsLib} from "../libraries/KnowledgeAssetsLib.sol";
import {KnowledgeAssetsStorageLike} from "../interfaces/KnowledgeAssetsStorageLike.sol";
import {INamed} from "../interfaces/INamed.sol";
import {IVersioned} from "../interfaces/IVersioned.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC721Enumerable} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721Enumerable.sol";

/**
 * @title ContextGraphStorage
 * @notice ERC-721 registry for Context Graphs. Each CG is an NFT — the token holder
 *         has management authority (publish policy, participants, quorum).
 *
 * Inherits Guardian for Hub-based access control and ERC721Enumerable for
 * transferable governance tokens. The logic facade (ContextGraphs.sol) remains
 * stateless and replaceable; all state lives here.
 */
contract ContextGraphStorage is INamed, IVersioned, Guardian, ERC721Enumerable {
    string private constant _NAME = "ContextGraphStorage";
    string private constant _VERSION = "2.0.0";

    uint256 private _contextGraphCounter;
    mapping(uint256 => KnowledgeAssetsLib.ContextGraph) private _contextGraphs;

    mapping(uint256 => uint256[]) private _contextGraphBatches;

    mapping(uint256 => mapping(uint256 => bytes32)) private _attestedRoots;

    // --- Events ---

    event ContextGraphCreated(
        uint256 indexed contextGraphId,
        address indexed owner,
        uint72[] participantIdentityIds,
        uint8 requiredSignatures,
        uint256 metadataBatchId,
        uint8 publishPolicy,
        address publishAuthority
    );

    event ContextGraphExpanded(
        uint256 indexed contextGraphId,
        uint256 indexed batchId
    );

    event ContextGraphDeactivated(
        uint256 indexed contextGraphId
    );

    event PublishPolicyUpdated(
        uint256 indexed contextGraphId,
        uint8 publishPolicy,
        address publishAuthority
    );

    event ParticipantAdded(
        uint256 indexed contextGraphId,
        uint72 identityId
    );

    event ParticipantRemoved(
        uint256 indexed contextGraphId,
        uint72 identityId
    );

    event QuorumUpdated(
        uint256 indexed contextGraphId,
        uint8 requiredSignatures
    );

    constructor(
        address hubAddress
    ) Guardian(hubAddress) ERC721("DKG Context Graph", "DKGCG") {}

    function name() public pure virtual override(INamed, ERC721) returns (string memory) {
        return _NAME;
    }

    function version() external pure virtual returns (string memory) {
        return _VERSION;
    }

    // --- Creation ---

    function createContextGraph(
        address owner_,
        uint72[] calldata participantIdentityIds,
        uint8 requiredSignatures,
        uint256 metadataBatchId,
        uint8 publishPolicy,
        address publishAuthority
    ) external onlyContracts returns (uint256 contextGraphId) {
        if (owner_ == address(0)) {
            revert KnowledgeAssetsLib.InvalidContextGraphConfig("zero address owner");
        }
        if (participantIdentityIds.length == 0) {
            revert KnowledgeAssetsLib.InvalidContextGraphConfig("empty participants");
        }
        if (requiredSignatures == 0 || requiredSignatures > participantIdentityIds.length) {
            revert KnowledgeAssetsLib.InvalidContextGraphConfig("invalid M/N threshold");
        }
        if (publishPolicy > 1) {
            revert KnowledgeAssetsLib.InvalidContextGraphConfig("invalid publishPolicy");
        }
        if (publishPolicy == 0 && publishAuthority == address(0)) {
            revert KnowledgeAssetsLib.InvalidContextGraphConfig("curated requires publishAuthority");
        }

        contextGraphId = ++_contextGraphCounter;

        _mint(owner_, contextGraphId);

        KnowledgeAssetsLib.ContextGraph storage cg = _contextGraphs[contextGraphId];
        cg.participantIdentityIds = participantIdentityIds;
        cg.requiredSignatures = requiredSignatures;
        cg.metadataBatchId = metadataBatchId;
        cg.active = true;
        cg.createdAt = block.timestamp;
        cg.publishPolicy = publishPolicy;
        cg.publishAuthority = publishAuthority;

        emit ContextGraphCreated(
            contextGraphId,
            owner_,
            participantIdentityIds,
            requiredSignatures,
            metadataBatchId,
            publishPolicy,
            publishAuthority
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

    // --- Attested roots (moved from ContextGraphs for stateless facade) ---

    function setAttestedRoot(
        uint256 contextGraphId,
        uint256 batchId,
        bytes32 merkleRoot
    ) external onlyContracts {
        _attestedRoots[contextGraphId][batchId] = merkleRoot;
    }

    function getAttestedRoot(
        uint256 contextGraphId,
        uint256 batchId
    ) external view returns (bytes32) {
        return _attestedRoots[contextGraphId][batchId];
    }

    // --- Deactivation ---

    function deactivateContextGraph(
        uint256 contextGraphId
    ) external onlyContracts {
        _requireExists(contextGraphId);
        _contextGraphs[contextGraphId].active = false;
        emit ContextGraphDeactivated(contextGraphId);
    }

    // --- Publish policy ---

    function updatePublishPolicy(
        uint256 contextGraphId,
        uint8 publishPolicy,
        address publishAuthority
    ) external onlyContracts {
        _requireExists(contextGraphId);
        if (publishPolicy > 1) {
            revert KnowledgeAssetsLib.InvalidContextGraphConfig("invalid publishPolicy");
        }
        if (publishPolicy == 0 && publishAuthority == address(0)) {
            revert KnowledgeAssetsLib.InvalidContextGraphConfig("curated requires publishAuthority");
        }

        _contextGraphs[contextGraphId].publishPolicy = publishPolicy;
        _contextGraphs[contextGraphId].publishAuthority = publishAuthority;

        emit PublishPolicyUpdated(contextGraphId, publishPolicy, publishAuthority);
    }

    // --- Participant governance ---

    function addParticipant(
        uint256 contextGraphId,
        uint72 identityId
    ) external onlyContracts {
        _requireExists(contextGraphId);
        uint72[] storage participants = _contextGraphs[contextGraphId].participantIdentityIds;
        uint256 len = participants.length;

        // Find insertion point to maintain ascending sort order
        uint256 insertAt = len;
        for (uint256 i; i < len; i++) {
            if (participants[i] == identityId) {
                revert KnowledgeAssetsLib.ParticipantAlreadyExists(contextGraphId, identityId);
            }
            if (participants[i] > identityId && insertAt == len) {
                insertAt = i;
            }
        }

        participants.push(0); // extend array
        for (uint256 j = len; j > insertAt; j--) {
            participants[j] = participants[j - 1];
        }
        participants[insertAt] = identityId;

        emit ParticipantAdded(contextGraphId, identityId);
    }

    function removeParticipant(
        uint256 contextGraphId,
        uint72 identityId
    ) external onlyContracts {
        _requireExists(contextGraphId);
        uint72[] storage participants = _contextGraphs[contextGraphId].participantIdentityIds;
        uint256 len = participants.length;

        if (len <= _contextGraphs[contextGraphId].requiredSignatures) {
            revert KnowledgeAssetsLib.InvalidContextGraphConfig("removal would break quorum");
        }

        for (uint256 i; i < len; i++) {
            if (participants[i] == identityId) {
                // Shift left to preserve sorted order (no swap-pop)
                for (uint256 j = i; j < len - 1; j++) {
                    participants[j] = participants[j + 1];
                }
                participants.pop();
                emit ParticipantRemoved(contextGraphId, identityId);
                return;
            }
        }
        revert KnowledgeAssetsLib.ParticipantNotFound(contextGraphId, identityId);
    }

    function updateQuorum(
        uint256 contextGraphId,
        uint8 requiredSignatures
    ) external onlyContracts {
        _requireExists(contextGraphId);
        uint256 participantCount = _contextGraphs[contextGraphId].participantIdentityIds.length;
        if (requiredSignatures == 0 || requiredSignatures > participantCount) {
            revert KnowledgeAssetsLib.InvalidContextGraphConfig("invalid M/N threshold");
        }
        _contextGraphs[contextGraphId].requiredSignatures = requiredSignatures;
        emit QuorumUpdated(contextGraphId, requiredSignatures);
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
        address owner_,
        uint72[] memory participantIdentityIds,
        uint8 requiredSignatures,
        uint256 metadataBatchId,
        bool active,
        uint256 createdAt,
        uint8 publishPolicy,
        address publishAuthority
    ) {
        _requireExists(contextGraphId);
        KnowledgeAssetsLib.ContextGraph storage cg = _contextGraphs[contextGraphId];
        return (
            ownerOf(contextGraphId),
            cg.participantIdentityIds,
            cg.requiredSignatures,
            cg.metadataBatchId,
            cg.active,
            cg.createdAt,
            cg.publishPolicy,
            cg.publishAuthority
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

    function getContextGraphOwner(
        uint256 contextGraphId
    ) external view returns (address) {
        return ownerOf(contextGraphId);
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

    function getPublishPolicy(
        uint256 contextGraphId
    ) external view returns (uint8 publishPolicy, address publishAuthority) {
        KnowledgeAssetsLib.ContextGraph storage cg = _contextGraphs[contextGraphId];
        return (cg.publishPolicy, cg.publishAuthority);
    }

    function getLatestContextGraphId() external view returns (uint256) {
        return _contextGraphCounter;
    }

    // --- Merkle verification ---

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

    // --- Internal ---

    function _requireExists(uint256 contextGraphId) internal view {
        _requireOwned(contextGraphId);
    }

    /**
     * @dev Override required by Solidity for ERC721Enumerable.
     */
    function supportsInterface(
        bytes4 interfaceId
    ) public view virtual override(ERC721Enumerable) returns (bool) {
        return super.supportsInterface(interfaceId);
    }

    function _increaseBalance(
        address account,
        uint128 value
    ) internal virtual override(ERC721Enumerable) {
        super._increaseBalance(account, value);
    }

    function _update(
        address to,
        uint256 tokenId,
        address auth
    ) internal virtual override(ERC721Enumerable) returns (address) {
        return super._update(to, tokenId, auth);
    }
}

