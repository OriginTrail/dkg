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
     * The participant-agent allow-list (address list) lives in its own
     * mapping inside ContextGraphStorage rather than as a struct field,
     * because Solidity's memory↔storage copy semantics make struct-level
     * dynamic arrays awkward to mutate.
     *
     * `publishAuthority` stores the curator address for EOA / Safe curator
     * types AND the account-owner address for PCA. The curator type is
     * disambiguated by the `_publishAuthorityAccountId` mapping — non-zero
     * means PCA.
     *
     * Per-CG hosting committees (`hostingNodes`) and per-CG quorum
     * (`requiredSignatures`) were removed in SPEC_CG_MEMORY_MODEL: every
     * CG is hosted by the sharding table at publish time, and the ACK
     * quorum is the system parameter `parametersStorage.minimumRequiredSignatures()`.
     *
     * Storage layout (tight-packed, 2 slots):
     *   slot 0: publishAuthority (20) | createdAt (5) | publishPolicy (1)
     *           | active (1) | accessPolicy (1) = 28 bytes
     *   slot 1: metadataBatchId (32) — full 256 bits for forward-compat
     *
     * `createdAt` is uint40 seconds-since-epoch: max value ~1.1e12 seconds ≈
     * year 36,835, plenty of headroom over any realistic contract lifetime.
     */
    struct ContextGraph {
        // Slot 0 (28 bytes of 32 used)
        address publishAuthority;  // Curator address (EOA, Safe multisig, or PCA owner)
        uint40 createdAt;          // Seconds since epoch; good until year ~36,835
        uint8 publishPolicy;       // 0 = curated (default), 1 = open
        bool active;
        uint8 accessPolicy;        // 0 = public/discoverable, 1 = private/curated
        // Slot 1
        uint256 metadataBatchId;
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
    error NotContextGraphOwnerOrAuthority(uint256 contextGraphId, address caller);
    error AgentParticipantAlreadyExists(uint256 contextGraphId, address agent);
    error AgentParticipantNotFound(uint256 contextGraphId, address agent);
    error KnowledgeAssetAlreadyRegisteredToContextGraph(uint256 kaId, uint256 existingContextGraphId);

    // ----- PCA coherence validation (facade-enforced on create/update paths) -----
    /// @dev Caller passed a non-zero PCA accountId but the DKGPublishingConvictionNFT
    ///      is not currently resolvable via Hub (not deployed, not registered, or
    ///      Hub returned address(0)). Fail-closed: a caller that wants PCA mode
    ///      must deploy the NFT first, or use EOA/Safe mode instead.
    error PCANotResolvable(uint256 accountId);

    /// @dev Caller passed a non-zero PCA accountId but the NFT has no token minted
    ///      for that accountId (ownerOf reverted). The account does not exist.
    error PCAAccountDoesNotExist(uint256 accountId);

    /// @dev Caller passed a PCA pair whose publishAuthority does NOT match the
    ///      actual owner of the NFT at accountId. Closes a silent-broadening
    ///      authorization vector: a mismatched pair would otherwise stack an
    ///      EOA direct-authority match AND a PCA-agent match on the same CG,
    ///      granting TWO distinct curators.
    error PCAAuthorityMismatch(
        uint256 accountId,
        address claimedAuthority,
        address actualOwner
    );
}
