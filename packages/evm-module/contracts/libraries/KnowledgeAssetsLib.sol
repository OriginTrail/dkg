// SPDX-License-Identifier: Apache-2.0

pragma solidity ^0.8.20;

library KnowledgeAssetsLib {
    struct PublisherRange {
        uint64 startId;
        uint64 endId;
    }

    struct PublishParams {
        uint72 publisherNodeIdentityId;
        bytes32 merkleRoot;
        uint64 startKAId;
        uint64 endKAId;
        uint64 publicByteSize;
        uint40 epochs;
        uint96 tokenAmount;
        address paymaster;
        bytes32 publisherNodeR;
        bytes32 publisherNodeVS;
        uint72[] identityIds;
        bytes32[] r;
        bytes32[] vs;
    }

    struct KnowledgeBatch {
        address publisherAddress;
        bytes32 merkleRoot;
        uint64 publicByteSize;
        uint32 knowledgeAssetsCount;
        uint64 startKAId;
        uint64 endKAId;
        uint40 startEpoch;
        uint40 endEpoch;
        uint96 tokenAmount;
        bool isPermanent;
        uint256 createdAt;
    }

    struct ContextGraph {
        address manager;
        uint72[] participantIdentityIds;
        uint8 requiredSignatures;
        uint256 metadataBatchId;
        bool active;
        uint256 createdAt;
    }

    error PublisherRangeExhausted(address publisher, uint64 needed, uint64 available);
    error KAIdNotInPublisherRange(address publisher, uint64 kaId);
    error KAIdAlreadyUsed(address publisher, uint64 kaId);
    error BatchNotFound(uint256 batchId);
    error NotBatchPublisher(uint256 batchId, address caller);
    error BatchExpired(uint256 batchId, uint256 currentEpoch, uint40 endEpoch);
    error InvalidTokenAmount(uint96 expected, uint96 provided);
    error ZeroTokenAmount();
    error InvalidKARange(uint64 startKAId, uint64 endKAId);
    error InvalidSignature(uint72 identityId, bytes32 messageHash, bytes32 r, bytes32 vs);
    error SignerIsNotNodeOperator(uint72 identityId, address signer);
    error SignaturesSignersMismatch(uint256 rAmount, uint256 vsAmount, uint256 identityIdsAmount);
    error MinSignaturesRequirementNotMet(uint256 required, uint256 received);
    error NotNamespaceOwner(address namespace, address caller);
    error NamespaceAlreadyExists(address target);
    error InvalidContextGraphConfig(string reason);
    error ContextGraphNotActive(uint256 contextGraphId);
    error ContextGraphNotFound(uint256 contextGraphId);
}
