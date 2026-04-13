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

    /**
     * @dev Core context graph metadata.
     *
     * The two participant lists (hosting nodes — uint72 identity IDs — and
     * participant agents — addresses) live in their own mappings inside
     * ContextGraphStorage rather than as struct fields, because Solidity's
     * memory↔storage copy semantics make struct-level dynamic arrays
     * awkward to mutate.
     *
     * `publishAuthority` stores the curator address for EOA / Safe curator
     * types AND the account-owner address for PCA. The curator type is
     * disambiguated by the `_publishAuthorityAccountId` mapping — non-zero
     * means PCA.
     */
    struct ContextGraph {
        uint8 requiredSignatures;
        uint256 metadataBatchId;
        bool active;
        uint256 createdAt;
        uint8 publishPolicy;      // 0 = curated (default), 1 = open
        address publishAuthority;  // Curator address (EOA, Safe multisig, or PCA owner)
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
    error UnauthorizedPublisher(uint256 contextGraphId, address publisher);
    error NotContextGraphOwner(uint256 contextGraphId, address caller);
    error AgentParticipantAlreadyExists(uint256 contextGraphId, address agent);
    error AgentParticipantNotFound(uint256 contextGraphId, address agent);
    error KCAlreadyRegisteredToContextGraph(uint256 kcId, uint256 existingContextGraphId);
}
