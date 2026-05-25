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
import {KnowledgeCollectionStorage} from "./storage/KnowledgeCollectionStorage.sol";
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
    string private constant _VERSION = "1.1.0";
    uint256 public constant SCALE18 = 1e18;

    /// @notice Maximum number of in-CG resamples when the picker hits an
    ///         expired KC during Phase 10 weighted challenge generation.
    ///         Exhausting this budget reverts with `NoEligibleKnowledgeCollection`
    ///         so the node skips the current proof period and retries on the
    ///         next one (see {_pickWeightedChallenge}).
    uint8 public constant MAX_KC_RETRIES = 10;

    IdentityStorage public identityStorage;
    RandomSamplingStorage public randomSamplingStorage;
    KnowledgeCollectionStorage public knowledgeCollectionStorage;
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
    /// @notice Thrown by `_generateChallenge` when no public, active CG holds
    ///         non-zero per-epoch value at the current epoch — i.e. there is
    ///         nothing eligible to challenge against. The caller's transaction
    ///         reverts and the node retries on the next proof period.
    error NoEligibleContextGraph();
    /// @notice Thrown by `_generateChallenge` when the chosen CG's KC list is
    ///         empty or all sampled KCs are expired after `MAX_KC_RETRIES`
    ///         attempts. Same retry-next-period semantics as above.
    error NoEligibleKnowledgeCollection();

    /// @notice Emitted when {createChallenge} produces a new challenge for a
    ///         node. Off-chain consumers (node UI, indexers) use the indexed
    ///         `cgId` to know which Context Graph the challenge targets — this
    ///         information is intentionally NOT stored on the Challenge struct
    ///         to keep its on-chain footprint unchanged.
    event ChallengeGenerated(
        uint72 indexed identityId,
        uint256 indexed contextGraphId,
        uint256 indexed knowledgeCollectionId,
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
        knowledgeCollectionStorage = KnowledgeCollectionStorage(
            hub.getAssetStorageAddress("KnowledgeCollectionStorage")
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
            if (nodeChallenge.knowledgeCollectionId != 0) {
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
     * Curated CG path (RFC-39 Phase A.5) — same `_verifyV10MerkleProof`
     * sibling-pair composition over a different leaf/root pair: `leaf` is
     * `keccak256(ct_i)` (hash of the LU-11 ciphertext chunk at index
     * `challenge.chunkId`), and the root is the per-KC
     * `getLatestCiphertextChunksRoot` set at publish time. `_verifyV10MerkleProof`
     * is unchanged — only the (root, leaf, count) triple changes between
     * the two paths.
     *
     * Branch selection: lookup the owning CG via
     * `ContextGraphStorage.kcToContextGraph(kcId)` (existing Phase 7
     * atomic-bind invariant) and read `getIsCurated`. Same single SLOAD
     * each, no struct change.
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

        // RFC-39 Phase A.5: resolve curation status to pick the right
        // (root, count) pair. `kcToContextGraph` is the Phase 7 atomic-bind
        // invariant — non-zero for every V10 publish — so the lookup never
        // returns zero on a freshly-created KC. A zero result indicates
        // pre-Phase-7 legacy state and is treated as "public unsampleable"
        // (defensive — should not occur in practice).
        uint256 cgId = contextGraphStorage.kcToContextGraph(challenge.knowledgeCollectionId);
        bool isCurated = cgId != 0 && contextGraphStorage.getIsCurated(cgId);

        // Get the expected merkle root + leaf count for this challenge.
        bytes32 expectedMerkleRoot = isCurated
            ? knowledgeCollectionStorage.getLatestCiphertextChunksRoot(challenge.knowledgeCollectionId)
            : knowledgeCollectionStorage.getLatestMerkleRoot(challenge.knowledgeCollectionId);

        uint32 leafCount = isCurated
            ? knowledgeCollectionStorage.getCiphertextChunkCount(challenge.knowledgeCollectionId)
            : knowledgeCollectionStorage.getMerkleLeafCount(challenge.knowledgeCollectionId);

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
     * Read-time exclusion (NOT a write-time filter): curated ("private") CGs
     * and deactivated CGs are skipped during both the adjusted-total
     * accumulation and the cumulative walk. Phase 8 writes to
     * `ContextGraphValueStorage` unconditionally because it ships earlier;
     * filtering at read time keeps Phase 10 isolated and reversible without
     * touching the publish path.
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
    function _generateChallenge(address originalSender) internal returns (RandomSamplingLib.Challenge memory) {
        bytes32 baseSeed = _deriveChallengeSeed(originalSender);
        uint256 currentEpoch = chronos.getCurrentEpoch();

        (uint256 cgId, uint256 kcId, uint256 chunkId) = _pickWeightedChallenge(baseSeed, currentEpoch);

        uint72 identityId = identityStorage.getIdentityId(originalSender);
        uint256 startBlock = updateAndGetActiveProofPeriodStartBlock();
        emit ChallengeGenerated(identityId, cgId, kcId, chunkId, currentEpoch, startBlock);

        return
            RandomSamplingLib.Challenge(
                kcId,
                chunkId,
                address(knowledgeCollectionStorage),
                currentEpoch,
                startBlock,
                getActiveProofingPeriodDurationInBlocks(),
                false
            );
    }

    /**
     * @dev Builds the per-call randomness seed from block state + caller. Same
     *      entropy mix as the V8 implementation — kept identical to preserve
     *      seed quality across the Phase 10 upgrade.
     */
    function _deriveChallengeSeed(address originalSender) internal view returns (bytes32) {
        return
            keccak256(
                abi.encodePacked(
                    block.difficulty,
                    blockhash(block.number - ((block.difficulty % 256) + 1)),
                    originalSender,
                    block.timestamp,
                    tx.gasprice,
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
     * @return kcId      Selected Knowledge Collection id within that CG.
     * @return chunkId   Selected **V10 Merkle leaf index** within the KC (same field
     *                   name as V8 byte-chunk index for struct compatibility).
     */
    function previewChallengeForSeed(
        bytes32 seed,
        uint256 targetEpoch
    ) external view returns (uint256 cgId, uint256 kcId, uint256 chunkId) {
        return _pickWeightedChallenge(seed, targetEpoch);
    }

    /**
     * @dev Two-step weighted draw: pick a Context Graph weighted by per-epoch
     *      TRAC value, then pick a KC uniformly at random within that CG with
     *      bounded resampling on expired KCs.
     *
     *      Step 1 — Walk all CGs once to compute the adjusted total (sum of
     *      `getCGValueAtEpoch` over CGs that are both active and non-curated).
     *      `ContextGraphValueStorage.getTotalValueAtEpoch` would be cheaper
     *      but it includes private CGs unconditionally; the adjusted total
     *      MUST exclude them at read time. Walk again with a running cumulative
     *      to pick the first eligible CG whose cumulative > r. Linear scan is
     *      gas-acceptable up to ~1K CGs per V10_CONTRACTS_REDESIGN_v2 §"Gas
     *      scaling" — Fenwick tree is the V10.x upgrade path.
     *
     *      Step 2 — Pick a KC at a random index in `_contextGraphKCList[cgId]`
     *      (via `getContextGraphKCAt` so we copy a single element instead of
     *      the full list). Resample up to `MAX_KC_RETRIES` if the picked KC
     *      has expired (`endEpoch < currentEpoch`). Uses a fresh seed each
     *      attempt via `keccak256(seed, attempt)`.
     *
     *      Step 3 — Pick a V10 Merkle leaf index: `uint256(kcSeed) % merkleLeafCount`
     *      (see `KnowledgeCollectionStorage.getMerkleLeafCount`). Reverts
     *      `NoEligibleKnowledgeCollection` if the KC has zero leaves recorded.
     *
     *      Reverts:
     *      - {NoEligibleContextGraph}        adjustedTotal == 0 (no public,
     *                                        active CG holds value).
     *      - {NoEligibleKnowledgeCollection} CG has an empty KC list, or
     *                                        every retry hit an expired KC.
     */
    function _pickWeightedChallenge(
        bytes32 seed,
        uint256 currentEpoch
    ) internal view returns (uint256 cgId, uint256 kcId, uint256 chunkId) {
        // ---- Step 1a: compute adjusted total over eligible CGs only. ----
        uint256 cgCount = contextGraphStorage.getLatestContextGraphId();
        uint256 adjustedTotal;
        for (uint256 i = 1; i <= cgCount; i++) {
            if (!_isCGEligible(i)) {
                continue;
            }
            adjustedTotal += contextGraphValueStorage.getCGValueAtEpoch(i, currentEpoch);
        }
        if (adjustedTotal == 0) {
            revert NoEligibleContextGraph();
        }

        // ---- Step 1b: walk eligible CGs and pick the one straddling r. ----
        uint256 r = uint256(seed) % adjustedTotal;
        uint256 running;
        for (uint256 i = 1; i <= cgCount; i++) {
            if (!_isCGEligible(i)) {
                continue;
            }
            running += contextGraphValueStorage.getCGValueAtEpoch(i, currentEpoch);
            if (running > r) {
                cgId = i;
                break;
            }
        }
        // Defensive: adjustedTotal > 0 guarantees at least one eligible CG
        // contributed a positive weight, so the loop above must have set cgId.
        // Reaching this branch means the per-epoch read drifted between
        // the two passes (impossible from a `view` call — eligibility and
        // values are deterministic for a fixed `currentEpoch`).
        if (cgId == 0) {
            revert NoEligibleContextGraph();
        }

        // ---- Step 2: pick a KC inside the chosen CG with bounded retries. ----
        //
        // RFC-39 Phase A.5: the per-KC eligibility test is extended for
        // curated CGs — a curated KC without a `(ciphertextChunksRoot,
        // ciphertextChunkCount)` commitment is "legacy / pre-LU-11
        // transitional" and skipped here the same way an expired KC is
        // skipped. Forward-only adoption per RFC-39 §6.4 (Q4) — no
        // migration path; legacy curated KCs simply don't participate in
        // the curated sampling lottery.
        //
        // Caching `cgIsCurated` once outside the loop keeps the per-attempt
        // cost at exactly 2 SLOADs (endEpoch + ciphertextChunkCount) on the
        // curated path and 1 SLOAD on the public path (unchanged).
        //
        // Note on value-weighting drift: a curated CG's
        // `ContextGraphValueStorage` weight still includes legacy KCs that
        // can't be sampled, so during the transitional window such CGs are
        // over-weighted relative to their effective sampleable surface. This
        // is acceptable for v1 — the gap closes as legacy KCs expire and
        // new publishes adopt the chunked path automatically. Closing the
        // drift earlier would require a Phase 8 cross-cut to retroactively
        // re-weight legacy-CG values, which is explicitly out of scope.
        uint256 kcCount = contextGraphStorage.getContextGraphKCCount(cgId);
        if (kcCount == 0) {
            // Eligible CG exists but holds no registered KCs; treat the same
            // as an all-expired CG (skip and retry next period).
            revert NoEligibleKnowledgeCollection();
        }
        bool cgIsCurated = contextGraphStorage.getIsCurated(cgId);
        uint256 pickedKcId;
        bytes32 kcSeed = seed;
        for (uint8 attempt = 0; attempt < MAX_KC_RETRIES; attempt++) {
            kcSeed = keccak256(abi.encodePacked(kcSeed, attempt));
            uint256 idx = uint256(kcSeed) % kcCount;
            uint256 candidate = contextGraphStorage.getContextGraphKCAt(cgId, idx);
            if (knowledgeCollectionStorage.getEndEpoch(candidate) < currentEpoch) {
                continue;
            }
            if (cgIsCurated && knowledgeCollectionStorage.getCiphertextChunkCount(candidate) == 0) {
                continue;
            }
            pickedKcId = candidate;
            break;
        }
        if (pickedKcId == 0) {
            revert NoEligibleKnowledgeCollection();
        }
        kcId = pickedKcId;

        // ---- Step 3: leaf index draw (curated vs public). ----
        //
        // RFC-39 Phase A.5: curated CGs draw against the LU-11
        // `ciphertextChunkCount` (number of SWM-message ciphertext chunks)
        // so the chunkId addresses a chunk the hosting cores actually
        // persist. Public CGs unchanged — V10 flat-KC plaintext leaf count.
        // `Challenge.chunkId`'s semantic is overloaded: same field, two
        // leaf spaces (mirror of `submitProof`'s root/count branching).
        uint32 leafCount = cgIsCurated
            ? knowledgeCollectionStorage.getCiphertextChunkCount(kcId)
            : knowledgeCollectionStorage.getMerkleLeafCount(kcId);
        if (leafCount == 0) {
            revert NoEligibleKnowledgeCollection();
        }
        chunkId = uint256(kcSeed) % uint256(leafCount);
    }

    /**
     * @dev True iff the CG is active.
     *
     *      RFC-39 Phase A.5 change: curated CGs are NO LONGER filtered out
     *      here. Under RFC-38 decoupled hosting, cores host curated CG
     *      ciphertext exactly as they host public CG plaintext, and RFC-39
     *      extends the random-sampling reward surface to that ciphertext via
     *      the per-KC `(ciphertextChunksRoot, ciphertextChunkCount)`
     *      commitment on `KnowledgeCollectionStorage`. The economic-parity
     *      goal forbids any CG-wide curated exclusion; KC-level eligibility
     *      (legacy/transitional curated KCs without a commitment) is handled
     *      inside `_pickWeightedChallenge` step 2 via the per-KC commitment
     *      check, not here.
     */
    function _isCGEligible(uint256 contextGraphId) internal view returns (bool) {
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

        // 2. Publishing factor P(t) = K_n / K_total over 4 epochs (RFC-26 Section 4.2)
        // Sum knowledge value over epochs (t-3, t-2, t-1, t)
        uint256 nodeKnowledgeValue = 0;
        uint256 totalKnowledgeValue = 0;
        uint256 startEpoch = currentEpoch >= 3 ? currentEpoch - 3 : 0;
        for (uint256 e = startEpoch; e <= currentEpoch; e++) {
            nodeKnowledgeValue += uint256(epochStorage.getNodeEpochProducedKnowledgeValue(identityId, e));
            totalKnowledgeValue += uint256(epochStorage.getEpochProducedKnowledgeValue(e));
        }
        uint256 publishingFactor18 = totalKnowledgeValue > 0 ? (nodeKnowledgeValue * SCALE18) / totalKnowledgeValue : 0;

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

    /**
     * @dev Updates and returns the current active proof period start block
     * Automatically advances to the next period if the current one has ended
     * @return Current active proof period start block number
     */
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
