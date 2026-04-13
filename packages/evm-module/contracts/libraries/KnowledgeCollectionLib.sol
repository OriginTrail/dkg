// SPDX-License-Identifier: Apache-2.0

pragma solidity ^0.8.20;

library KnowledgeCollectionLib {
    struct MerkleRoot {
        address publisher;
        bytes32 merkleRoot;
        uint256 timestamp;
    }

    struct KnowledgeCollection {
        MerkleRoot[] merkleRoots;
        uint256[] burned;
        uint256 minted;
        uint88 byteSize;
        uint40 startEpoch;
        uint40 endEpoch;
        uint96 tokenAmount;
        bool isImmutable;
    }

    error ExceededKnowledgeCollectionMaxSize(uint256 id, uint256 minted, uint256 requested, uint256 maxSize);
    error InvalidTokenId(uint256 tokenId, uint256 startTokenId, uint256 endTokenId);
    error BurnFromZeroAddress();
    error BurnFromNonOwnerAddress();
    error InvalidTokenAmount(uint96 expectedTokenAMount, uint96 tokenAmount);
    error InvalidSignature(uint72 identityId, bytes32 messageHash, bytes32 r, bytes32 vs);
    error SignerIsNotNodeOperator(uint72 identityId, address signer);
    error KnowledgeCollectionExpired(uint256 id, uint256 currentEpoch, uint256 endEpoch);
    error NotPartOfKnowledgeCollection(uint256 id, uint256 tokenId);
    error SignaturesSignersMismatch(uint256 rAmount, uint256 vsAmount, uint256 identityIdsAmount);
    error MinSignaturesRequirementNotMet(uint256 requiredSignatures, uint256 receivedSignatures);
    error CannotUpdateImmutableKnowledgeCollection(uint256 id);
}
