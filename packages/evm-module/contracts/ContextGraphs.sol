// SPDX-License-Identifier: Apache-2.0

pragma solidity ^0.8.20;

import {ContractStatus} from "./abstract/ContractStatus.sol";
import {IInitializable} from "./interfaces/IInitializable.sol";
import {INamed} from "./interfaces/INamed.sol";
import {IVersioned} from "./interfaces/IVersioned.sol";
import {ContextGraphStorage} from "./storage/ContextGraphStorage.sol";
import {IdentityStorage} from "./storage/IdentityStorage.sol";
import {KnowledgeAssetsLib} from "./libraries/KnowledgeAssetsLib.sol";
import {KnowledgeAssetsStorageLike} from "./interfaces/KnowledgeAssetsStorageLike.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/**
 * @title ContextGraphs
 * @notice Stateless logic facade for Context Graph operations. All state lives in
 *         ContextGraphStorage (ERC-721 registry). This contract is replaceable via Hub.
 */
contract ContextGraphs is INamed, IVersioned, ContractStatus, IInitializable {
    string private constant _NAME = "ContextGraphs";
    string private constant _VERSION = "2.0.0";

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

    // --- Creation ---

    /**
     * @notice Create a new context graph. Mints an ERC-721 to msg.sender.
     * @param participantIdentityIds Participant node identity IDs (sorted ascending)
     * @param requiredSignatures     M-of-N threshold
     * @param metadataBatchId        Batch ID holding the context graph metadata (0 if none)
     * @param publishPolicy          0 = curated (only publishAuthority can publish), 1 = open
     * @param publishAuthority       Curator address; defaults to msg.sender when zero and open
     * @return contextGraphId        Newly assigned context graph ID (= ERC-721 token ID)
     */
    function createContextGraph(
        uint72[] calldata participantIdentityIds,
        uint8 requiredSignatures,
        uint256 metadataBatchId,
        uint8 publishPolicy,
        address publishAuthority
    ) external returns (uint256 contextGraphId) {
        uint72 prevPid;
        for (uint256 i; i < participantIdentityIds.length; i++) {
            require(participantIdentityIds[i] != 0, "Zero participant ID");
            require(participantIdentityIds[i] > prevPid, "Duplicate or unsorted participant");
            prevPid = participantIdentityIds[i];
        }
        address authority = publishAuthority == address(0) ? msg.sender : publishAuthority;
        contextGraphId = contextGraphStorage.createContextGraph(
            msg.sender,
            participantIdentityIds,
            requiredSignatures,
            metadataBatchId,
            publishPolicy,
            authority
        );
    }

    // --- Governance (token-holder gated) ---

    modifier onlyContextGraphOwner(uint256 contextGraphId) {
        if (contextGraphStorage.getContextGraphOwner(contextGraphId) != msg.sender) {
            revert KnowledgeAssetsLib.NotContextGraphOwner(contextGraphId, msg.sender);
        }
        _;
    }

    function updatePublishPolicy(
        uint256 contextGraphId,
        uint8 publishPolicy,
        address publishAuthority
    ) external onlyContextGraphOwner(contextGraphId) {
        contextGraphStorage.updatePublishPolicy(contextGraphId, publishPolicy, publishAuthority);
    }

    function addParticipant(
        uint256 contextGraphId,
        uint72 identityId
    ) external onlyContextGraphOwner(contextGraphId) {
        contextGraphStorage.addParticipant(contextGraphId, identityId);
    }

    function removeParticipant(
        uint256 contextGraphId,
        uint72 identityId
    ) external onlyContextGraphOwner(contextGraphId) {
        contextGraphStorage.removeParticipant(contextGraphId, identityId);
    }

    function updateQuorum(
        uint256 contextGraphId,
        uint8 requiredSignatures
    ) external onlyContextGraphOwner(contextGraphId) {
        contextGraphStorage.updateQuorum(contextGraphId, requiredSignatures);
    }

    // --- Publish authorization ---

    /**
     * @notice Check whether `publisher` is authorized to publish to a context graph.
     * @return authorized True if the publisher passes the publish policy gate.
     */
    function isAuthorizedPublisher(
        uint256 contextGraphId,
        address publisher
    ) external view returns (bool authorized) {
        uint256 latestId = contextGraphStorage.getLatestContextGraphId();
        if (contextGraphId > latestId) return true; // CG doesn't exist — no policy to enforce
        if (!contextGraphStorage.isContextGraphActive(contextGraphId)) return false;
        (uint8 policy, address authority) = contextGraphStorage.getPublishPolicy(contextGraphId);
        if (policy == 1) return true; // open
        return publisher == authority;
    }

    // --- Batch attestation ---

    function addBatchToContextGraph(
        uint256 contextGraphId,
        uint256 batchId,
        bytes32 merkleRoot,
        uint72[] calldata signerIdentityIds,
        bytes32[] calldata signatureRs,
        bytes32[] calldata signatureVss
    ) external {
        require(contextGraphStorage.getAttestedRoot(contextGraphId, batchId) == bytes32(0), "Batch already registered");
        _verifyParticipantSignatures(contextGraphId, merkleRoot, signerIdentityIds, signatureRs, signatureVss);
        bytes32 onChainRoot = knowledgeAssetsStorage.getBatchMerkleRoot(batchId);
        require(onChainRoot != bytes32(0), "Batch does not exist");
        require(onChainRoot == merkleRoot, "MerkleRoot does not match batch");
        contextGraphStorage.setAttestedRoot(contextGraphId, batchId, merkleRoot);
        contextGraphStorage.addBatchToContextGraph(contextGraphId, batchId);
    }

    function getAttestedMerkleRoot(
        uint256 contextGraphId,
        uint256 batchId
    ) external view returns (bytes32) {
        return contextGraphStorage.getAttestedRoot(contextGraphId, batchId);
    }

    // --- Internal ---

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
