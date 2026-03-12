// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

interface KnowledgeAssetsStorageLike {
    function getBatchMerkleRoot(uint256 batchId) external view returns (bytes32);
}
