// SPDX-License-Identifier: Apache-2.0

pragma solidity ^0.8.20;

import {INamed} from "./interfaces/INamed.sol";
import {IVersioned} from "./interfaces/IVersioned.sol";
import {ContractStatus} from "./abstract/ContractStatus.sol";
import {IInitializable} from "./interfaces/IInitializable.sol";
import {RandomSamplingLib} from "./libraries/RandomSamplingLib.sol";
import {ProfileLib} from "./libraries/ProfileLib.sol";
import {IdentityStorage} from "./storage/IdentityStorage.sol";
import {RandomSamplingStorage} from "./storage/RandomSamplingStorage.sol";
import {DKGKnowledgeAssets} from "./storage/DKGKnowledgeAssets.sol";
import {ProfileStorage} from "./storage/ProfileStorage.sol";
import {EpochStorage} from "./storage/EpochStorage.sol";
import {Chronos} from "./storage/Chronos.sol";
import {AskStorage} from "./storage/AskStorage.sol";
import {ParametersStorage} from "./storage/ParametersStorage.sol";
import {ShardingTableStorage} from "./storage/ShardingTableStorage.sol";
import {ContextGraphStorage} from "./storage/ContextGraphStorage.sol";
import {ContextGraphValueStorage} from "./storage/ContextGraphValueStorage.sol";
import {ConvictionStakingStorage} from "./storage/ConvictionStakingStorage.sol";
import {ICustodian} from "./interfaces/ICustodian.sol";
import {HubLib} from "./libraries/HubLib.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

contract RandomSampling is INamed, IVersioned, ContractStatus, IInitializable {
    string private constant _NAME = "RandomSampling";
    // OT-RFC-49 WS-B: bumped 10.0.4 -> 10.1.0 alongside the proof-race rewrite of
    // submitProof (reads the snapshotted challengeRoot/challengeLeafCount) and the
    // coupled RandomSamplingStorage 10.0.2 -> 10.1.0 / RandomSamplingLib.Challenge
    // struct growth. The on-chain version string must change when behavior does,
    // so a redeploy is not mistaken for a no-op (live base_sepolia is 10.0.4).
    // 10.1.1 — OT-RFC-51 "Publishing Allocation": the publishing factor P(t)
    //          is fed by committed PCA publishing allocation over a single
    //          current-epoch window (was a 4-epoch realized-publishing sum).
    //          Coefficients / S(t) / A(t) unchanged.
    string private constant _VERSION = "10.1.1";
    uint256 public constant SCALE18 = 1e18;

    /// @notice Maximum number of in-CG resamples when the picker hits an
    ///         expired KC during Phase 10 weighted challenge generation.
    ///         Exhausting this budget reverts with `NoEligibleKnowledgeAsset`
    ///         so the node skips the current proof period and retries on the
    ///         next one (see {_pickWeightedChallenge}).
    uint8 public constant MAX_KC_RETRIES = 10;

    /// @notice RFC-39 Phase A.5 — bounded retries at the CG selection layer
    ///         when the picked CG has no challengeable KC (all legacy /
    ///         uncommitted curated KCs, or every retry hit an expired KC).
    ///         Falls through to a fresh weighted draw with the picked CG
    ///         excluded, instead of reverting the whole sampling tick and
    ///         letting one high-value legacy curated CG DoS the network.
    uint8 public constant MAX_CG_RETRIES = 5;

    IdentityStorage public identityStorage;
    RandomSamplingStorage public randomSamplingStorage;
    DKGKnowledgeAssets public knowledgeAssetStorage;
    ProfileStorage public profileStorage;
    EpochStorage public epochStorage;
    Chronos public chronos;
    AskStorage public askStorage;
    ParametersStorage public parametersStorage;
    ShardingTableStorage public shardingTableStorage;
    ContextGraphStorage public contextGraphStorage;
    ContextGraphValueStorage public contextGraphValueStorage;
    ConvictionStakingStorage public convictionStakingStorage;

    error MerkleRootMismatchError(bytes32 computedMerkleRoot, bytes32 expectedMerkleRoot);
    /// @notice Thrown by `_generateChallenge` when no active CG (public or
    ///         curated) holds non-zero per-epoch value at the current epoch —
    ///         i.e. there is nothing eligible to challenge against. The caller's
    ///         transaction reverts and the node retries on the next proof period.
    error NoEligibleContextGraph();
    /// @notice Thrown by `_generateChallenge` when the chosen CG's KC list is
    ///         empty or all sampled KCs are expired after `MAX_KC_RETRIES`
    ///         attempts. Same retry-next-period semantics as above.
    error NoEligibleKnowledgeAsset();

    /// @notice Emitted when {createChallenge} produces a new challenge for a
    ///         node. Off-chain consumers (node UI, indexers) use the indexed
    ///         `cgId` to know which Context Graph the challenge targets — this
    ///         information is intentionally NOT stored on the Challenge struct
    ///         to keep its on-chain footprint unchanged.
    event ChallengeGenerated(
        uint72 indexed identityId,
        uint256 indexed contextGraphId,
        uint256 indexed knowledgeAssetId,
        uint256 chunkId,
        uint256 epoch,
        uint256 activeProofPeriodStartBlock
    );

    /**
     * @dev Constructor initializes the contract with essential parameters for random sampling
     * Only called once during deployment
     * @param hubAddress Address of the Hub contract for access control
     */
    constructor(address hubAddress) ContractStatus(hubAddress) {}

    modifier profileExists(uint72 identityId) {
        _checkProfileExists(identityId);
        _;
    }

    /**
     * @dev Modifier to check if a node exists in the sharding table
     * Used by functions to ensure operations target valid nodes
     * Reverts with NodeDoesntExist error if node is not found
     * @param identityId Node identity to check existence for
     */
    modifier nodeExistsInShardingTable(uint72 identityId) {
        _checkNodeExistsInShardingTable(identityId);
        _;
    }

    // @dev Only transactions by HubController owner or one of the owners of the MultiSig Wallet
    modifier onlyOwnerOrMultiSigOwner() {
        _checkOwnerOrMultiSigOwner();
        _;
    }

    /**
     * @dev Initializes the contract by connecting to all required Hub dependencies
     * Called once during deployment to set up contract references for storage and computation
     * Only the Hub can call this function
     */
    function initialize() public onlyHub {
        identityStorage = IdentityStorage(hub.getContractAddress("IdentityStorage"));
        randomSamplingStorage = RandomSamplingStorage(hub.getContractAddress("RandomSamplingStorage"));
        knowledgeAssetStorage = DKGKnowledgeAssets(
            hub.getAssetStorageAddress("DKGKnowledgeAssets")
        );
        profileStorage = ProfileStorage(hub.getContractAddress("ProfileStorage"));
        epochStorage = EpochStorage(hub.getContractAddress("EpochStorageV8"));
        chronos = Chronos(hub.getContractAddress("Chronos"));
        askStorage = AskStorage(hub.getContractAddress("AskStorage"));
        parametersStorage = ParametersStorage(hub.getContractAddress("ParametersStorage"));
        shardingTableStorage = ShardingTableStorage(hub.getContractAddress("ShardingTableStorage"));
        // Phase 10 — value-weighted challenge generation. ContextGraphStorage is
        // an asset storage (ERC-721 NFT registry), ContextGraphValueStorage is a
        // regular hub contract.
        contextGraphStorage = ContextGraphStorage(hub.getAssetStorageAddress("ContextGraphStorage"));
        contextGraphValueStorage = ContextGraphValueStorage(hub.getContractAddress("ContextGraphValueStorage"));
        convictionStakingStorage = ConvictionStakingStorage(hub.getContractAddress("ConvictionStakingStorage"));
    }

    /**
     * @dev Returns the name of this contract
     * Used for contract identification and versioning
     */
    function name() external pure virtual override returns (string memory) {
        return _NAME;
    }

    /**
     * @dev Returns the version of this contract
     * Used for contract identification and versioning
     */
    function version() external pure virtual override returns (string memory) {
        return _VERSION;
    }

    /**
     * @dev Checks if there is a pending proofing period duration that hasn't taken effect yet
     * @return True if there is a pending duration change, false otherwise
     */
    function isPendingProofingPeriodDuration() public view returns (bool) {
        return chronos.getCurrentEpoch() < randomSamplingStorage.getLatestProofingPeriodDurationEffectiveEpoch();
    }

    /**
     * @dev Sets the duration of proofing periods in blocks with a one-epoch delay
     * Only contracts registered in the Hub can call this function
     * If a pending change exists, replaces it; otherwise adds a new duration
     * Changes take effect in the next epoch to ensure smooth transitions
     * @param durationInBlocks New proofing period duration in blocks (must be > 0)
     */
    function setProofingPeriodDurationInBlocks(uint16 durationInBlocks) external onlyOwnerOrMultiSigOwner {
        require(durationInBlocks > 0, "Duration in blocks must be greater than 0");

        // Calculate the effective epoch (current epoch + delay)
        uint256 effectiveEpoch = chronos.getCurrentEpoch() + 1;

        // Check if there's a pending change
        if (isPendingProofingPeriodDuration()) {
            randomSamplingStorage.replacePendingProofingPeriodDuration(durationInBlocks, effectiveEpoch);
        } else {
            randomSamplingStorage.addProofingPeriodDuration(durationInBlocks, effectiveEpoch);
        }
    }

    /**
     * @dev Creates a new challenge for the calling node in the current proofing period
     * Caller must have a registered profile and cannot have an active unsolved challenge
     * Generates a random knowledge collection and chunk to be proven
     * Can only create one challenge per proofing period
     */
    // Slither: strict equality is the intended proof-period identity check;
    // updateAndGetActiveProofPeriodStartBlock writes only to protocol storage.
    // slither-disable-next-line incorrect-equality,reentrancy-events
    function createChallenge()
        external
        profileExists(identityStorage.getIdentityId(msg.sender))
        nodeExistsInShardingTable(identityStorage.getIdentityId(msg.sender))
    {
        uint72 identityId = identityStorage.getIdentityId(msg.sender);

        RandomSamplingLib.Challenge memory nodeChallenge = randomSamplingStorage.getNodeChallenge(identityId);

        if (nodeChallenge.activeProofPeriodStartBlock == updateAndGetActiveProofPeriodStartBlock()) {
            // Revert if node has already solved the challenge for this period
            if (nodeChallenge.solved) {
                revert("The challenge for this proof period has already been solved");
            }

            // Revert if a challenge for this node exists but has not been solved yet
            if (nodeChallenge.knowledgeAssetId != 0) {
                revert("An unsolved challenge already exists for this node in the current proof period");
            }
        }

        // Generate a new challenge
        RandomSamplingLib.Challenge memory challenge = _generateChallenge(msg.sender);

        // Store the new challenge in the storage contract
        randomSamplingStorage.setNodeChallenge(identityId, challenge);
    }

    /**
     * @dev Submits proof for an active challenge to earn score used for later reward calculation
     *
     * Public CG path — verifies a V10 flat-KC Merkle inclusion proof
     * (dkg-core `V10MerkleTree` / spec §9.0.2): `leaf` is a `hashTripleV10`
     * public leaf or a private sub-root leaf; `challenge.chunkId` stores
     * the challenged leaf index in the sorted+deduped bottom layer;
     * `merkleProof` is the sibling path produced by
     * `V10MerkleTree.proof(leafIndex)`.
     *
     * Curated CG path (OT-RFC-49) — same `_verifyV10MerkleProof` sibling-pair
     * composition over a different leaf/root pair: `leaf` is `hashTripleV10(s,p,o)`
     * of the challenged PUBLIC `_catalog` triple at index `challenge.chunkId`, and
     * the root is the per-KC catalog root (`getCatalogRoot`) snapshotted at
     * issuance. Cores hold zero private bytes post-strip, so they prove the public
     * catalog, never the ciphertext. `_verifyV10MerkleProof` is unchanged — only
     * the (root, leaf, count) triple differs between the two paths.
     *
     * Root/count source: the (root, leafCount) pair is PINNED on the challenge at
     * issuance (`_generateChallenge`). `submitProof` reads NO live getter, so a KA
     * update mid-period cannot rotate the challenge surface out from under an
     * honest prover (Trap 1), and the pinned root also captures the exact branch /
     * KA-store / generation the leaf was drawn against (subsumes the R3 seam).
     *
     * Sharding-table check: `nodeExistsInShardingTable` is universal
     * membership today. RFC-39 §5.2 calls for tightening to per-CG
     * `isHostForCG(identityId, cgId)` once `ShardingTableStorage` ships
     * that view (and once per-CG sub-sharding lands in the v2 of RFC-38).
     * Under universal-hosting (Phase A.5), the universal check is
     * functionally equivalent — every active core hosts every KC's
     * substrate.
     */
    function submitProof(bytes32 leaf, bytes32[] calldata merkleProof)
        external
        profileExists(identityStorage.getIdentityId(msg.sender))
        nodeExistsInShardingTable(identityStorage.getIdentityId(msg.sender))
    {
        // Get node identityId
        uint72 identityId = identityStorage.getIdentityId(msg.sender);

        // Get node challenge
        RandomSamplingLib.Challenge memory challenge = randomSamplingStorage.getNodeChallenge(identityId);

        if (challenge.solved) {
            revert("This challenge has already been solved");
        }

        uint256 activeProofPeriodStartBlock = updateAndGetActiveProofPeriodStartBlock();

        // verify that the challengeId matches the current challenge
        if (challenge.activeProofPeriodStartBlock != activeProofPeriodStartBlock) {
            revert("This challenge is no longer active");
        }

        // OT-RFC-49 / WS-B Trap 1 (proof-race): verify against the
        // (root, leafCount) pair PINNED on the challenge at issuance
        // (`_generateChallenge`), NOT a live re-read of `getCatalogRoot` /
        // `getLatestMerkleRoot`. A KA update landing between `createChallenge` and
        // `submitProof` rotates the live root + leaf count; reading them live here
        // would verify an honest prover's issuance-time proof against the NEW
        // surface and fail it — burning the stake of a node that did nothing
        // wrong. (The prior in-source comment claimed `submitProof` read nothing
        // live for branch/root selection — it was FALSE: the two ternaries below
        // read four live getters. This snapshot makes that claim true.)
        //
        // The pinned root SUBSUMES both prior pins: it already encodes the exact
        // curation branch (catalog vs merkle) AND the exact KA store / generation
        // the leaf was drawn against, so `submitProof` reads NO live singleton for
        // root/branch selection. `challenge.isCurated` /
        // `challenge.knowledgeAssetStorageContract` remain on the persisted
        // challenge for off-chain indexers and a future multi-generation verifier.
        bytes32 expectedMerkleRoot = challenge.challengeRoot;
        uint32 leafCount = challenge.challengeLeafCount;

        if (leafCount == 0 || challenge.chunkId >= uint256(leafCount)) {
            revert MerkleRootMismatchError(bytes32(0), expectedMerkleRoot);
        }

        if (!_verifyV10MerkleProof(expectedMerkleRoot, leaf, challenge.chunkId, merkleProof)) {
            revert MerkleRootMismatchError(bytes32(0), expectedMerkleRoot);
        }

        // Mark as correct submission and add points to the node.
        challenge.solved = true;
        randomSamplingStorage.setNodeChallenge(identityId, challenge);

        uint256 epoch = chronos.getCurrentEpoch();
        randomSamplingStorage.incrementEpochNodeValidProofsCount(epoch, identityId);

        // D4+D15+D26 — post-migration the only source of staked TRAC is
        // the V10 conviction layer. The node score and score-per-stake
        // denominator must use the same timestamp-accurate effective stake
        // snapshot: raw TRAC multiplied by active conviction boosts, with
        // expired boosts drained at this proof's block timestamp.
        uint40 tsNow = uint40(block.timestamp);
        convictionStakingStorage.settleNodeTo(identityId, tsNow);
        uint256 effectiveNodeStake = convictionStakingStorage.getNodeRunningEffectiveStake(identityId);
        uint256 score18 = _calculateNodeScore(identityId, effectiveNodeStake);
        randomSamplingStorage.addToNodeEpochProofPeriodScore(
            epoch,
            activeProofPeriodStartBlock,
            identityId,
            score18
        );
        randomSamplingStorage.addToNodeEpochScore(epoch, identityId, score18);
        randomSamplingStorage.addToAllNodesEpochScore(epoch, score18);

        if (effectiveNodeStake > 0) {
            uint256 deltaScorePerStake36 = (score18 * SCALE18) / effectiveNodeStake;
            uint256 newLast = randomSamplingStorage.getEpochLastScorePerStake(identityId, epoch) +
                deltaScorePerStake36;
            // `appendCheckpoint` records the timestamped post-proof value so
            // claim-time binary-search can split at a mid-epoch boost expiry.
            // Under D26 `scorePerStake36` is epoch-local (accumulates from 0),
            // no first-sentinel seeding needed (M6/M7).
            randomSamplingStorage.appendCheckpoint(identityId, epoch, tsNow, newLast);
        }
    }

    /**
     * @dev V10 Merkle verify — matches `V10MerkleTree.verify` in TypeScript (pair order
     *      by tree position: even index → `keccak256(abi.encodePacked(hash, sibling))`).
     */
    function _verifyV10MerkleProof(
        bytes32 root,
        bytes32 leaf,
        uint256 leafIndex,
        bytes32[] calldata proof
    ) internal pure returns (bool) {
        bytes32 h = leaf;
        uint256 idx = leafIndex;
        for (uint256 i = 0; i < proof.length; ) {
            bytes32 sib = proof[i];
            if (idx % 2 == 0) {
                h = keccak256(abi.encodePacked(h, sib));
            } else {
                h = keccak256(abi.encodePacked(sib, h));
            }
            unchecked {
                idx = idx / 2;
                ++i;
            }
        }
        return h == root;
    }

    /**
     * @dev Generates a new value-weighted challenge for a node.
     *
     * Phase 10 — value-weighted CG selection (replaces V8 uniform-random KC pick).
     * Uses blockchain properties (block hash, difficulty, timestamp, gas price)
     * for randomness, picks a Context Graph weighted by its per-epoch TRAC
     * value at the current epoch, and then picks a KC uniformly at random
     * within that CG.
     *
     * Read-time eligibility (NOT a write-time filter): deactivated CGs are
     * skipped during both the adjusted-total accumulation and the cumulative
     * walk (`_isCGEligible`). Curated ("private") CGs ARE eligible and ARE
     * drawn — post-RFC-49 their cores prove the PUBLIC `_catalog` (a per-KC
     * `catalogRoot`/`catalogLeafCount`), not the private payload, so they earn
     * the sampling reward like public CGs. A curated KC with no catalog
     * commitment (`catalogLeafCount == 0`) is skipped at the KC level in step 2.
     * (Historical note: an earlier RFC-39 revision DID exclude curated CGs here;
     * RFC-39 Phase B re-enabled them and RFC-49 moved the proof target to the
     * catalog — this docstring previously lagged that change.)
     *
     * ## Open Risks (documented for V11+ — out of scope for Phase 10)
     *
     * - Weighting decay (cumulative drift): `cgValueCumulative` is per-epoch
     *   (not lifetime-cumulative) via the diff/cumulative pattern in
     *   `ContextGraphValueStorage`, so expired KCs auto-decay after their
     *   active window. Correct by design — no Phase 10 action.
     * - KC-level gaming: within a CG, KC selection is uniform — not
     *   value-weighted. Skipping one high-value KC in a 100-KC CG costs only
     *   1% of challenges, not proportional to that KC's TRAC share. Accepted
     *   per `V10_CONTRACTS_REDESIGN_v2.md` §"Known limitation — KC-level
     *   gaming". CG-level weighting is the primary defense.
     * - Gas scaling: linear scan over all CGs is O(N) per challenge. Fine up
     *   to ~1K CGs (~2.1M gas). Fenwick tree (BIT) deferred to V10.x.
     * - Sync grace period / node publishing timing: out of scope.
     *
     * @param originalSender Original caller address used for randomness seed.
     * @return challenge The generated challenge struct (signature-compatible
     *         with V8 — `submitProof` does not need to know the cgId).
     */
    // Slither: event-after-storage-write is expected; the storage contract is
    // trusted protocol state, not an untrusted external callback surface.
    // slither-disable-next-line reentrancy-events
    function _generateChallenge(address originalSender) internal returns (RandomSamplingLib.Challenge memory) {
        bytes32 baseSeed = _deriveChallengeSeed(originalSender);
        uint256 currentEpoch = chronos.getCurrentEpoch();

        (uint256 cgId, uint256 kaId, uint256 chunkId) = _pickWeightedChallenge(baseSeed, currentEpoch);

        uint72 identityId = identityStorage.getIdentityId(originalSender);
        uint256 startBlock = updateAndGetActiveProofPeriodStartBlock();
        emit ChallengeGenerated(identityId, cgId, kaId, chunkId, currentEpoch, startBlock);

        // OT-RFC-43 / R3 — pin the curation classification at issuance. `cgId`
        // came from `_pickWeightedChallenge`, which only returns an eligible
        // (non-zero, active) CG, so this resolves the SAME curated/public branch
        // the leaf draw above used. Retained on the challenge for off-chain
        // indexers; `submitProof` no longer re-derives it (the pinned root below
        // already captures the branch).
        bool isCurated = contextGraphStorage.getIsCurated(cgId);

        // OT-RFC-49 / WS-B Trap 1 — SNAPSHOT the (leafCount, root) pair the proof
        // must verify against, resolved from the SAME curated/public branch the
        // leaf was drawn against. `submitProof` reads THESE pinned values, never a
        // live getter, so a KA update landing between issuance and proof submission
        // cannot rotate the challenge surface out from under an honest prover.
        // Read in the same `view` tx as the `chunkId = seed % leafCount` draw, so
        // the snapshotted count equals the count the draw used.
        //   curated → public `_catalog` commitment (cores prove the catalog);
        //   public  → the full flat-KC merkle root over all leaves.
        uint32 challengeLeafCount = isCurated
            ? knowledgeAssetStorage.getCatalogLeafCount(kaId)
            : knowledgeAssetStorage.getMerkleLeafCount(kaId);
        bytes32 challengeRoot = isCurated
            ? knowledgeAssetStorage.getCatalogRoot(kaId)
            : knowledgeAssetStorage.getLatestMerkleRoot(kaId);

        return
            RandomSamplingLib.Challenge(
                kaId,
                chunkId,
                address(knowledgeAssetStorage),
                currentEpoch,
                startBlock,
                getActiveProofingPeriodDurationInBlocks(),
                false,
                isCurated,
                challengeLeafCount,
                challengeRoot
            );
    }

    /**
     * @dev Builds the per-call randomness seed from block state + caller.
     *
     *      AUDIT INTERIM (v10.0.4): `tx.gasprice` and `block.timestamp` were
     *      removed from the mix. `tx.gasprice` is fully chosen by the caller
     *      at zero cost, and `previewChallengeForSeed` is public — together
     *      they let a node grind gas price off-chain in a SINGLE tx until the
     *      drawn challenge lands on a chunk it actually stores, defeating the
     *      proof-of-storage guarantee. `block.timestamp` adds proposer wiggle
     *      to the same search. Dropping both downgrades the attack from
     *      "free deterministic targeting in one tx" to "must be the block
     *      proposer and grind constrained block fields".
     *
     *      This is NOT a complete fix: the remaining `prevrandao` /
     *      `blockhash` inputs are still proposer-influenceable. The durable
     *      fix is commit–reveal (commit in period N, draw against period
     *      N+1's then-unknown block) or a VRF the node cannot grind — a
     *      coordinated node+contract release tracked separately.
     */
    function _deriveChallengeSeed(address originalSender) internal view returns (bytes32) {
        return
            keccak256(
                abi.encodePacked(
                    block.difficulty,
                    blockhash(block.number - ((block.difficulty % 256) + 1)),
                    originalSender,
                    uint8(1) // sector = 1 by default
                )
            );
    }

    /**
     * @dev Read-only public preview of {_pickWeightedChallenge}. Lets nodes
     *      and indexers simulate a draw for an arbitrary seed without writing
     *      to storage; tests use it to drive distribution regression with
     *      deterministic per-draw seeds and no block-mining.
     *
     *      Because this view shares the underlying picker with the production
     *      path, any change to the weighted-selection logic is reflected in
     *      both call sites — no test-only drift.
     *
     * @param seed       The 32-byte seed to draw against. Production callers
     *                   should pass a high-entropy hash; tests pass deterministic
     *                   per-iteration seeds for distribution analysis.
     * @param targetEpoch Epoch to read CG values at. Pass `chronos.getCurrentEpoch()`
     *                   for the live picker semantics.
     * @return cgId      Selected Context Graph id.
     * @return kaId      Selected Knowledge Collection id within that CG.
     * @return chunkId   Selected **V10 Merkle leaf index** within the KC (same field
     *                   name as V8 byte-chunk index for struct compatibility).
     */
    function previewChallengeForSeed(
        bytes32 seed,
        uint256 targetEpoch
    ) external view returns (uint256 cgId, uint256 kaId, uint256 chunkId) {
        return _pickWeightedChallenge(seed, targetEpoch);
    }

    /**
     * @dev Two-step weighted draw: pick a Context Graph weighted by per-epoch
     *      TRAC value, then pick a KC uniformly at random within that CG with
     *      bounded resampling on expired KCs.
     *
     *      Step 1 — Walk all CGs once to compute the adjusted total (sum of
     *      `getCGValueAtEpoch` over every ELIGIBLE CG, i.e. active — see
     *      `_isCGEligible`). Curated ("private") CGs ARE included post-RFC-49:
     *      their cores prove the public `_catalog`, so they earn the sampling
     *      reward like public CGs. The only read-time exclusions are deactivated
     *      CGs and, in a retry, the exhausted-CG list. Walk again with a running
     *      cumulative to pick the first eligible CG whose cumulative > r. Linear
     *      scan is gas-acceptable up to ~1K CGs per V10_CONTRACTS_REDESIGN_v2
     *      §"Gas scaling" — Fenwick tree is the V10.x upgrade path.
     *
     *      Step 2 — Pick a KC at a random index in `_contextGraphKCList[cgId]`
     *      (via `getContextGraphKCAt` so we copy a single element instead of
     *      the full list). Resample up to `MAX_KC_RETRIES` if the picked KC
     *      has expired (`endEpoch < currentEpoch`) or — for curated CGs — has no
     *      catalog commitment (`getCatalogLeafCount == 0`). Uses a fresh seed each
     *      attempt via `keccak256(seed, attempt)`.
     *
     *      Step 3 — Pick a V10 Merkle leaf index `uint256(kcSeed) % leafCount`,
     *      where `leafCount` is the curated KC's `getCatalogLeafCount` (catalog
     *      leaves) or the public KC's `getMerkleLeafCount` (all flat-KC leaves).
     *      Reverts `NoEligibleKnowledgeAsset` if the KC has zero leaves recorded.
     *
     *      Reverts:
     *      - {NoEligibleContextGraph}        adjustedTotal == 0 (no public,
     *                                        active CG holds value).
     *      - {NoEligibleKnowledgeAsset} CG has an empty KC list, or
     *                                        every retry hit an expired KC.
     */
    // Slither: protocol sampling intentionally derives bounded pseudo-random
    // indices from the period seed; the storage reads are bounded by
    // MAX_CG_RETRIES/MAX_KC_RETRIES and strict equality checks are guards.
    // slither-disable-start weak-prng,uninitialized-local,cyclomatic-complexity,incorrect-equality,calls-loop,timestamp
    function _pickWeightedChallenge(
        bytes32 seed,
        uint256 currentEpoch
    ) internal view returns (uint256 cgId, uint256 kaId, uint256 chunkId) {
        uint256 cgCount = contextGraphStorage.getLatestContextGraphId();

        // Codex PR #630 R1 #3 — outer retry: bounded fallback when the
        // picked CG has no challengeable KC (all curated KCs uncommitted,
        // or every inner retry hit an expired KC). Without this loop, one
        // high-value legacy curated CG could DoS the entire sampling tick
        // by being picked repeatedly under the weighted draw and reverting
        // on every attempt. We track `exhaustedCgs` and re-draw with the
        // failing CG excluded from the adjusted total until either a KC is
        // found or the retry budget runs out.
        uint256[] memory exhaustedCgs = new uint256[](MAX_CG_RETRIES);
        uint8 exhaustedCount = 0;
        bytes32 cgSeed = seed;

        for (uint8 cgAttempt = 0; cgAttempt < MAX_CG_RETRIES; cgAttempt++) {
            // ---- Step 1a: adjusted total over eligible + non-exhausted CGs. ----
            uint256 adjustedTotal;
            for (uint256 i = 1; i <= cgCount; i++) {
                if (!_isCGEligible(i)) continue;
                if (_isInExhaustedList(i, exhaustedCgs, exhaustedCount)) continue;
                adjustedTotal += contextGraphValueStorage.getCGValueAtEpoch(i, currentEpoch);
            }
            if (adjustedTotal == 0) {
                // First attempt with zero-total = genuinely no eligible CG.
                // Subsequent attempts with zero-total = all eligible CGs
                // exhausted; the next-period sampling tick will retry.
                if (cgAttempt == 0) revert NoEligibleContextGraph();
                revert NoEligibleKnowledgeAsset();
            }

            // ---- Step 1b: walk + pick the CG straddling r. ----
            uint256 r = uint256(cgSeed) % adjustedTotal;
            uint256 running;
            uint256 chosenCg;
            for (uint256 i = 1; i <= cgCount; i++) {
                if (!_isCGEligible(i)) continue;
                if (_isInExhaustedList(i, exhaustedCgs, exhaustedCount)) continue;
                running += contextGraphValueStorage.getCGValueAtEpoch(i, currentEpoch);
                if (running > r) { chosenCg = i; break; }
            }
            // Defensive: adjustedTotal > 0 guarantees at least one CG
            // contributed a positive weight, so the loop above must have
            // set chosenCg. Reaching this branch means the per-epoch read
            // drifted between the two passes (impossible from `view`).
            if (chosenCg == 0) revert NoEligibleContextGraph();

            // ---- Step 2: pick a KC inside `chosenCg` with bounded retries. ----
            //
            // OT-RFC-49: the per-KC eligibility test for curated CGs gates on the
            // PUBLIC `_catalog` commitment, not the (stripped) ciphertext one. A
            // curated KC with `catalogLeafCount == 0` has no catalog commitment
            // (legacy KC not re-published since RFC-49, or a malformed publish that
            // the KAV10 gate would have rejected) and is skipped here the same way
            // an expired KC is skipped — cores prove the catalog, so a KC with no
            // catalog tree is unchallengeable.
            //
            // Caching `cgIsCurated` once outside the loop keeps the per-
            // attempt cost at exactly 2 SLOADs on the curated path and 1
            // SLOAD on the public path (unchanged).
            uint256 kcCount = contextGraphStorage.getContextGraphKCCount(chosenCg);
            bool cgIsCurated = contextGraphStorage.getIsCurated(chosenCg);
            uint256 pickedKaId;
            bytes32 kcSeed = cgSeed;
            if (kcCount > 0) {
                for (uint8 attempt = 0; attempt < MAX_KC_RETRIES; attempt++) {
                    kcSeed = keccak256(abi.encodePacked(kcSeed, attempt));
                    uint256 idx = uint256(kcSeed) % kcCount;
                    uint256 candidate = contextGraphStorage.getContextGraphKCAt(chosenCg, idx);
                    if (knowledgeAssetStorage.getEndEpoch(candidate) < currentEpoch) continue;
                    if (cgIsCurated && knowledgeAssetStorage.getCatalogLeafCount(candidate) == 0) continue;
                    pickedKaId = candidate;
                    break;
                }
            }

            if (pickedKaId != 0) {
                // ---- Step 3: leaf index draw (curated vs public). ----
                // curated → draw over the public `_catalog` leaves;
                // public  → draw over the full flat-KC merkle leaves.
                uint32 leafCount = cgIsCurated
                    ? knowledgeAssetStorage.getCatalogLeafCount(pickedKaId)
                    : knowledgeAssetStorage.getMerkleLeafCount(pickedKaId);
                if (leafCount == 0) revert NoEligibleKnowledgeAsset();
                cgId = chosenCg;
                kaId = pickedKaId;
                chunkId = uint256(kcSeed) % uint256(leafCount);
                return (cgId, kaId, chunkId);
            }

            // No eligible KC in `chosenCg` — mark it exhausted and re-draw.
            exhaustedCgs[exhaustedCount] = chosenCg;
            exhaustedCount += 1;
            cgSeed = keccak256(abi.encodePacked(cgSeed, "cgRetry", cgAttempt));
        }

        // All CG-retries exhausted — every picked CG was empty / had only
        // legacy curated / expired KCs. Next sampling tick will retry with
        // fresh entropy.
        revert NoEligibleKnowledgeAsset();
    }
    // slither-disable-end weak-prng,uninitialized-local,cyclomatic-complexity,incorrect-equality,calls-loop,timestamp

    /// @dev O(n) membership check against the exhausted-CG list. `n` is bounded
    ///      by `MAX_CG_RETRIES` (≤ 5), so this is a fixed sub-linear cost per
    ///      eligibility test.
    function _isInExhaustedList(
        uint256 candidate,
        uint256[] memory exhausted,
        uint8 exhaustedCount
    ) internal pure returns (bool) {
        for (uint8 j = 0; j < exhaustedCount; j++) {
            if (exhausted[j] == candidate) return true;
        }
        return false;
    }

    /**
     * @dev True iff the CG is active.
     *
     *      Curated CGs are NOT filtered out here. Post-RFC-49 ("hosting follows
     *      access") cores hold zero private bytes; the random-sampling reward
     *      surface for a curated CG is its PUBLIC `_catalog` (the per-KC
     *      `catalogRoot`/`catalogLeafCount` commitment on `DKGKnowledgeAssets`),
     *      which cores DO host and serve. The economic-parity goal forbids any
     *      CG-wide curated exclusion; KC-level eligibility (a curated KC with no
     *      catalog commitment) is handled inside `_pickWeightedChallenge` step 2
     *      via the per-KC `getCatalogLeafCount == 0` check, not here.
     */
    // Slither: this storage read is intentionally used inside the bounded
    // sampling loop above.
    // slither-disable-next-line calls-loop
    function _isCGEligible(uint256 contextGraphId) internal view returns (bool) {
        // OT-RFC-49: curated CGs are drawn (the off-chain prover at
        // `packages/random-sampling/src/prover.ts` ships a catalog branch that
        // proves the public `_catalog` leaves). The KC-level catalog-commitment
        // check inside `_pickWeightedChallenge` step 2 is the authoritative gate
        // for curated KCs that have no catalog commitment yet (skipped via
        // `getCatalogLeafCount == 0`).
        return contextGraphStorage.isContextGraphActive(contextGraphId);
    }

    /**
     * @dev Calculates the node score based on stake, publishing activity, and ask alignment
     * Implements anti-sybil multiplicative score formula (RFC-26 update)
     *
     * Formula: nodeScore(t) = S(t) * (c + 0.86 * P(t) + 0.60 * A(t) * P(t))
     *
     * Where:
     * - S(t) = sqrt(nodeEffectiveStake / STAKE_CAP) - sublinear conviction stake scaling
     * - P(t) = K_n / K_total - publishing share over 4 epochs (t-3, t-2, t-1, t)
     * - A(t) = 1 - |nodeAsk - networkPrice| / networkPrice - ask alignment factor
     * - c = 0.002 (STAKE_BASELINE_COEFFICIENT) - small baseline for staked non-publishers
     *
     * The multiplicative structure ensures stake amplifies contribution rather than
     * providing an unconditional reward floor. The small c coefficient preserves a
     * minimal incentive for staking even without publishing, preventing a hard cliff
     * while making sybil extraction economically unattractive.
     *
     * All calculations use 18-decimal precision for accuracy
     * @param identityId The node identity to calculate score for
     * @return score18 The calculated node score scaled by 18-decimal for precision
     */
    function calculateNodeScore(uint72 identityId) public view returns (uint256) {
        return _calculateNodeScore(identityId, convictionStakingStorage.getNodeEffectiveStake(identityId));
    }

    // Slither: score math uses fixed-point integer ratios deliberately; epoch
    // storage reads are over a bounded four-epoch window.
    // slither-disable-start divide-before-multiply,calls-loop
    function _calculateNodeScore(uint72 identityId, uint256 nodeEffectiveStake) internal view returns (uint256) {
        uint256 currentEpoch = chronos.getCurrentEpoch();

        // 1. Stake factor S(t) = sqrt(nodeEffectiveStake / stakeCap)
        // Using sublinear scaling to reduce stake dominance (RFC-26 Section 4.1)
        //
        // D15/D26 — post-migration the node's scoring stake is V10 effective
        // stake: raw TRAC multiplied by active conviction multipliers and
        // timestamp-adjusted for expired boosts. Migration is mandatory (user
        // directive), so V8 `StakingStorage.nodes[id].stake` is legacy-only.
        uint256 stakeCap = uint256(parametersStorage.maximumStake());
        nodeEffectiveStake = nodeEffectiveStake > stakeCap ? stakeCap : nodeEffectiveStake;
        // S18 = sqrt((nodeEffectiveStake / stakeCap) * SCALE18) * sqrt(SCALE18)
        uint256 stakeRatio18 = (nodeEffectiveStake * SCALE18) / stakeCap;
        uint256 stakeFactor18 = Math.sqrt(stakeRatio18 * SCALE18);

        // 2. Publishing factor P(t) = K_n / K_total (RFC-26 Section 4.2,
        //    re-based by OT-RFC-51 "Publishing Allocation").
        //
        //    OT-RFC-51: the publishing factor is now fed by COMMITTED PCA
        //    "publishing allocation" rather than realized publishing, over a
        //    single (current-epoch) window instead of the prior 4-epoch sum.
        //    `K_n` = the current epoch's allocation seeded to this node by
        //    its designated PCAs; `K_total` = the network-wide current-epoch
        //    allocation. Coefficients / S(t) / A(t) below are unchanged.
        uint256 nodeKV = epochStorage.getNodeEpochPublishingAllocation(identityId, currentEpoch);
        uint256 totalKV = epochStorage.getEpochPublishingAllocation(currentEpoch);
        uint256 publishingFactor18 = totalKV > 0 ? (nodeKV * SCALE18) / totalKV : 0;

        // 3. Ask alignment factor A(t) = 1 - |nodeAsk - networkPrice| / networkPrice (RFC-26 Section 4.3)
        // Rewards nodes whose ask is close to the network reference price:
        // - Perfect alignment (deviation = 0): A(t) = 1.0 (maximum bonus)
        // - 50% deviation: A(t) = 0.5
        // - 100%+ deviation: A(t) = 0.0 (no bonus, capped to avoid negative values)
        uint256 nodeAsk = uint256(profileStorage.getAsk(identityId));
        uint256 networkPrice = askStorage.getPricePerKbEpoch();
        uint256 askAlignmentFactor18 = 0;
        if (networkPrice > 0) {
            uint256 deviation = nodeAsk > networkPrice ? nodeAsk - networkPrice : networkPrice - nodeAsk;
            uint256 deviationRatio18 = (deviation * SCALE18) / networkPrice;
            askAlignmentFactor18 = deviationRatio18 >= SCALE18 ? 0 : SCALE18 - deviationRatio18;
        }

        // nodeScore(t) = S(t) * (c + 0.86 * P(t) + 0.60 * A(t) * P(t))
        // c = 0.002 = 2/1000 (STAKE_BASELINE_COEFFICIENT)
        // Coefficients: 0.86 = 86/100, 0.60 = 60/100
        uint256 baselineComponent18 = (2 * SCALE18) / 1000;
        uint256 publishingComponent18 = (86 * publishingFactor18) / 100;
        uint256 askPublishingComponent18 = (60 * askAlignmentFactor18 * publishingFactor18) / (100 * SCALE18);

        uint256 innerScore18 = baselineComponent18 + publishingComponent18 + askPublishingComponent18;
        return (stakeFactor18 * innerScore18) / SCALE18;
    }
    // slither-disable-end divide-before-multiply,calls-loop

    /**
     * @dev Updates and returns the current active proof period start block
     * Automatically advances to the next period if the current one has ended
     * @return Current active proof period start block number
     */
    // Slither: divide-then-multiply intentionally floors to the latest complete
    // proof period boundary.
    // slither-disable-next-line divide-before-multiply
    function updateAndGetActiveProofPeriodStartBlock() public returns (uint256) {
        uint256 activeProofingPeriodDurationInBlocks = getActiveProofingPeriodDurationInBlocks();

        if (activeProofingPeriodDurationInBlocks == 0) {
            revert("Active proofing period duration in blocks should not be 0");
        }

        uint256 activeProofPeriodStartBlock = randomSamplingStorage.getActiveProofPeriodStartBlock();

        if (block.number > activeProofPeriodStartBlock + activeProofingPeriodDurationInBlocks - 1) {
            // Calculate how many complete periods have passed since the last active period started
            uint256 blocksSinceLastStart = block.number - activeProofPeriodStartBlock;
            uint256 completePeriodsPassed = blocksSinceLastStart / activeProofingPeriodDurationInBlocks;

            uint256 newActiveProofPeriodStartBlock = activeProofPeriodStartBlock +
                completePeriodsPassed *
                activeProofingPeriodDurationInBlocks;

            randomSamplingStorage.setActiveProofPeriodStartBlock(newActiveProofPeriodStartBlock);

            return newActiveProofPeriodStartBlock;
        }

        return activeProofPeriodStartBlock;
    }

    /**
     * @dev Returns the status of the current active proof period including start block and whether it's still active
     * @return ProofPeriodStatus struct containing start block and active status
     */
    function getActiveProofPeriodStatus() external view returns (RandomSamplingLib.ProofPeriodStatus memory) {
        uint256 activeProofPeriodStartBlock = randomSamplingStorage.getActiveProofPeriodStartBlock();
        return
            RandomSamplingLib.ProofPeriodStatus(
                activeProofPeriodStartBlock,
                block.number < activeProofPeriodStartBlock + getActiveProofingPeriodDurationInBlocks()
            );
    }

    /**
     * @dev Calculates the start block of a historical proof period based on current period and offset
     * Used to determine proof periods from the past for validation purposes
     * @param proofPeriodStartBlock Start block of a valid proof period (must be > 0 and aligned to period boundaries)
     * @param offset Number of periods to go back (must be > 0)
     * @return Start block of the historical proof period
     */
    function getHistoricalProofPeriodStartBlock(
        uint256 proofPeriodStartBlock,
        uint256 offset
    ) external view returns (uint256) {
        require(proofPeriodStartBlock > 0, "Proof period start block must be greater than 0");
        require(
            proofPeriodStartBlock % getActiveProofingPeriodDurationInBlocks() == 0,
            "Proof period start block is not valid"
        );
        require(offset > 0, "Offset must be greater than 0");
        return proofPeriodStartBlock - offset * getActiveProofingPeriodDurationInBlocks();
    }

    /**
     * @dev Returns the currently active proofing period duration in blocks
     * Automatically selects the appropriate duration based on current epoch
     * @return Duration in blocks of the currently active proofing period
     */
    function getActiveProofingPeriodDurationInBlocks() public view returns (uint16) {
        return randomSamplingStorage.getEpochProofingPeriodDurationInBlocks(chronos.getCurrentEpoch());
    }

    /**
     * @dev Internal function to validate that a node profile exists
     * Used by modifiers and functions to ensure operations target valid nodes
     * Reverts with ProfileDoesntExist error if profile is not found
     * @param identityId Node identity to check existence for
     */
    function _checkProfileExists(uint72 identityId) internal view virtual {
        if (!profileStorage.profileExists(identityId)) {
            revert ProfileLib.ProfileDoesntExist(identityId);
        }
    }

    /**
     * @dev Internal function to validate that a node exists in the sharding table
     * Used by modifiers and functions to ensure operations target valid nodes
     * Reverts with NodeDoesntExist error if node is not found
     * @param identityId Node identity to check existence for
     */
    function _checkNodeExistsInShardingTable(uint72 identityId) internal view virtual {
        if (!shardingTableStorage.nodeExists(identityId)) {
            revert("Node does not exist in sharding table");
        }
    }

    function _isMultiSigOwner(address multiSigAddress) internal view returns (bool) {
        try ICustodian(multiSigAddress).getOwners() returns (address[] memory multiSigOwners) {
            for (uint256 i = 0; i < multiSigOwners.length; i++) {
                if (msg.sender == multiSigOwners[i]) {
                    return true;
                }
            }
        } catch {
            // Not a multisig or call reverted; treat as not owner.
        }

        return false;
    }

    function _checkOwnerOrMultiSigOwner() internal view virtual {
        address hubOwner = hub.owner();
        if (msg.sender != hubOwner && !_isMultiSigOwner(hubOwner)) {
            revert HubLib.UnauthorizedAccess("Only Hub Owner or Multisig Owner");
        }
    }
}
