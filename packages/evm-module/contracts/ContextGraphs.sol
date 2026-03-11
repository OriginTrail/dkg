// SPDX-License-Identifier: Apache-2.0

pragma solidity ^0.8.20;

import {ContractStatus} from "./abstract/ContractStatus.sol";
import {IInitializable} from "./interfaces/IInitializable.sol";
import {INamed} from "./interfaces/INamed.sol";
import {IVersioned} from "./interfaces/IVersioned.sol";
import {ContextGraphStorage} from "./storage/ContextGraphStorage.sol";
import {IdentityStorage} from "./storage/IdentityStorage.sol";
import {KnowledgeAssetsStorageLike} from "./interfaces/KnowledgeAssetsStorageLike.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/**
 * @title ContextGraphs
 * @notice Facade for creating / expanding context graphs.
 *         Registered with Hub so it satisfies `onlyContracts` on ContextGraphStorage.
 */
contract ContextGraphs is INamed, IVersioned, ContractStatus, IInitializable {
    string private constant _NAME = "ContextGraphs";
    string private constant _VERSION = "1.0.0";

    ContextGraphStorage public contextGraphStorage;
    IdentityStorage public identityStorage;
    KnowledgeAssetsStorageLike public knowledgeAssetsStorage;

    constructor(address hubAddress) ContractStatus(hubAddress) {}

    function initialize() public onlyHub {
        contextGraphStorage = ContextGraphStorage(
            hub.getAssetStorageAddress("ContextGraphStorage")
        );
        identityStorage = IdentityStorage(
            hub.getContractAddress("IdentityStorage")
        );
        knowledgeAssetsStorage = KnowledgeAssetsStorageLike(
            hub.getAssetStorageAddress("KnowledgeAssetsStorage")
        );
    }

    function name() public pure virtual returns (string memory) {
        return _NAME;
    }

    function version() external pure virtual returns (string memory) {
        return _VERSION;
    }

    /**
     * @notice Create a new context graph.
     * @param participantIdentityIds Participant node identity IDs
     * @param requiredSignatures     M-of-N threshold
     * @param metadataBatchId        Batch ID holding the context graph metadata (0 if none)
     * @return contextGraphId        Newly assigned context graph ID
     */
    function createContextGraph(
        uint72[] calldata participantIdentityIds,
        uint8 requiredSignatures,
        uint256 metadataBatchId
    ) external returns (uint256 contextGraphId) {
        for (uint256 i; i < participantIdentityIds.length; i++) {
            require(participantIdentityIds[i] != 0, "Zero participant ID");
        }
        contextGraphId = contextGraphStorage.createContextGraph(
            msg.sender,
            participantIdentityIds,
            requiredSignatures,
            metadataBatchId
        );
    }

    /**
     * @notice Add a published batch to an existing context graph with M/N signature verification.
     * @dev    Each signer must be a registered participant. Signatures are over
     *         `keccak256(abi.encodePacked(contextGraphId, merkleRoot))`.
     * @param contextGraphId        Target context graph
     * @param batchId               Batch to register
     * @param merkleRoot            Merkle root of the batch (used in signature digest)
     * @param signerIdentityIds     Identity IDs of the signers (must be participants)
     * @param signatureRs           ECDSA signature R values
     * @param signatureVss          ECDSA compact signature (v << 255 | s) values
     */
    mapping(uint256 => mapping(uint256 => bool)) private _batchRegistered;

    function addBatchToContextGraph(
        uint256 contextGraphId,
        uint256 batchId,
        bytes32 merkleRoot,
        uint72[] calldata signerIdentityIds,
        bytes32[] calldata signatureRs,
        bytes32[] calldata signatureVss
    ) external {
        require(!_batchRegistered[contextGraphId][batchId], "Batch already registered");
        _verifyParticipantSignatures(contextGraphId, merkleRoot, signerIdentityIds, signatureRs, signatureVss);
        bytes32 onChainRoot = knowledgeAssetsStorage.getBatchMerkleRoot(batchId);
        require(onChainRoot != bytes32(0), "Batch does not exist");
        require(onChainRoot == merkleRoot, "MerkleRoot does not match batch");
        _batchRegistered[contextGraphId][batchId] = true;
        contextGraphStorage.addBatchToContextGraph(contextGraphId, batchId);
    }

    function _verifyParticipantSignatures(
        uint256 contextGraphId,
        bytes32 merkleRoot,
        uint72[] calldata signerIdentityIds,
        bytes32[] calldata signatureRs,
        bytes32[] calldata signatureVss
    ) internal view {
        uint8 required = contextGraphStorage.getContextGraphRequiredSignatures(contextGraphId);
        require(
            signerIdentityIds.length >= required,
            "Not enough signatures"
        );
        require(
            signerIdentityIds.length == signatureRs.length &&
            signerIdentityIds.length == signatureVss.length,
            "Array length mismatch"
        );

        bytes32 digest = keccak256(abi.encodePacked(contextGraphId, merkleRoot));

        uint72 prevId = 0;
        for (uint256 i; i < signerIdentityIds.length; i++) {
            require(signerIdentityIds[i] > prevId, "Duplicate or unsorted signer");
            prevId = signerIdentityIds[i];

            require(
                contextGraphStorage.isParticipant(contextGraphId, signerIdentityIds[i]),
                "Signer not a participant"
            );

            bytes32 ethHash = MessageHashUtils.toEthSignedMessageHash(digest);
            address recovered = ECDSA.recover(ethHash, signatureRs[i], signatureVss[i]);

            uint72 recoveredId = identityStorage.getIdentityId(recovered);
            require(recoveredId == signerIdentityIds[i], "Invalid signature");
        }
    }
}
