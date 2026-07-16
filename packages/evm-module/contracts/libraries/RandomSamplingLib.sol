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
        // OT-RFC-49 / WS-B Trap 1 (proof-race) — the (leafCount, root) pair PINNED
        // at issuance. `submitProof` verifies against THESE snapshotted values
        // instead of re-reading `getLatest*Root`/`get*Count` live, so a KA update
        // landing between `createChallenge` and `submitProof` can no longer rotate
        // the challenge surface out from under an honest prover (which would lose
        // stake). `challengeLeafCount` (uint32) packs into the `solved`/`isCurated`
        // slot's remaining 30 bytes; `challengeRoot` takes a fresh slot. Resolved
        // from the SAME curated/public branch the draw used:
        // curated → (getCatalogLeafCount, getCatalogRoot);
        // public  → (getMerkleLeafCount, getLatestMerkleRoot).
        uint32 challengeLeafCount;
        bytes32 challengeRoot;
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
