// SPDX-License-Identifier: Apache-2.0

pragma solidity ^0.8.20;

library KnowledgeAssetLib {
    /// @dev `publisher` is `msg.sender` of the publish/update tx (payment of
    ///      record). The verified author identity from the EIP-712
    ///      attestation lives on a parallel
    ///      `mapping(kaId => mapping(rootIndex => address))` on
    ///      `DKGKnowledgeAssets` (`merkleRootAuthors`). This keeps the
    ///      dynamic-array slot stride at 3 slots so already-minted KAs
    ///      decode their historical roots correctly. Readers should treat
    ///      the parallel map's `address(0)` as "this state change did not
    ///      carry an author attestation," never as a valid post-upgrade
    ///      identity claim.
    struct MerkleRoot {
        address publisher;
        bytes32 merkleRoot;
        uint256 timestamp;
    }

    struct KnowledgeAsset {
        MerkleRoot[] merkleRoots;
        uint256[] burned;
        uint256 minted;
        uint88 byteSize;
        uint40 startEpoch;
        uint40 endEpoch;
        uint96 tokenAmount;
        bool isImmutable;
        /// @notice Number of leaves in the V10 flat-KA Merkle tree (sorted +
        ///         deduped `hashTripleV10` public leaves plus private roots),
        ///         matching `V10MerkleTree` in `@origintrail-official/dkg-core`.
        ///         `RandomSampling` uses this for `leafIndex = seed % count`.
        uint32 merkleLeafCount;
    }

    error ExceededKnowledgeAssetBatchSize(uint256 id, uint256 minted, uint256 requested, uint256 maxSize);
    error InvalidTokenId(uint256 tokenId, uint256 startTokenId, uint256 endTokenId);
    error BurnFromZeroAddress();
    error BurnFromNonOwnerAddress();
    error InvalidTokenAmount(uint96 expectedTokenAMount, uint96 tokenAmount);
    error InvalidSignature(uint72 identityId, bytes32 messageHash, bytes32 r, bytes32 vs);
    error SignerIsNotNodeOperator(uint72 identityId, address signer);
    error KnowledgeAssetExpired(uint256 id, uint256 currentEpoch, uint256 endEpoch);
    error NotPartOfKnowledgeAsset(uint256 id, uint256 tokenId);
    error SignaturesSignersMismatch(uint256 rAmount, uint256 vsAmount, uint256 identityIdsAmount);
    error MinSignaturesRequirementNotMet(uint256 requiredSignatures, uint256 receivedSignatures);
    error CannotUpdateImmutableKnowledgeAsset(uint256 id);
}
