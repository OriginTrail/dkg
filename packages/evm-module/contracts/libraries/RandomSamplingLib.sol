// SPDX-License-Identifier: Apache-2.0

pragma solidity ^0.8.20;

library RandomSamplingLib {
    struct Challenge {
        uint256 knowledgeAssetId;
        uint256 chunkId; // TODO:Smaller data structure
        address knowledgeAssetStorageContract;
        uint256 epoch;
        uint256 activeProofPeriodStartBlock;
        uint256 proofingPeriodDurationInBlocks;
        bool solved;
        // OT-RFC-43 / R3 — curation classification PINNED at issuance. Recorded
        // here (alongside `knowledgeAssetStorageContract`) so `submitProof`
        // verifies against the SAME (root, count) branch the challenge was drawn
        // against, instead of re-deriving it from the live `ContextGraphStorage`
        // singleton — which a generation cutover could re-point, misclassifying
        // an older curated challenge as public. Packs into the `solved` slot.
        bool isCurated;
    }

    struct ProofPeriodStatus {
        uint256 activeProofPeriodStartBlock;
        bool isValid;
    }

    struct ProofingPeriodDuration {
        uint16 durationInBlocks;
        uint256 effectiveEpoch;
    }
}
