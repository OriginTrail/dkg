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
import {StakingStorage} from "./storage/StakingStorage.sol";
import {ProfileStorage} from "./storage/ProfileStorage.sol";
import {EpochStorage} from "./storage/EpochStorage.sol";
import {Chronos} from "./storage/Chronos.sol";
import {AskStorage} from "./storage/AskStorage.sol";
import {DelegatorsInfo} from "./storage/DelegatorsInfo.sol";
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
    string private constant _VERSION = "1.0.0";
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
    StakingStorage public stakingStorage;
    ProfileStorage public profileStorage;
    EpochStorage public epochStorage;
    Chronos public chronos;
    AskStorage public askStorage;
    DelegatorsInfo public delegatorsInfo;
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
        stakingStorage = StakingStorage(hub.getContractAddress("StakingStorage"));
        profileStorage = ProfileStorage(hub.getContractAddress("ProfileStorage"));
        epochStorage = EpochStorage(hub.getContractAddress("EpochStorageV8"));
        chronos = Chronos(hub.getContractAddress("Chronos"));
        askStorage = AskStorage(hub.getContractAddress("AskStorage"));
        delegatorsInfo = DelegatorsInfo(hub.getContractAddress("DelegatorsInfo"));
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
     * Validates the submitted chunk and merkle proof against the expected Merkle root
     * On successful proof: marks challenge as solved, increments valid proofs count,
     * calculates and adds node score, and updates epoch scoring data
     * @param chunk The data chunk being proven (must match challenge requirements)
     * @param merkleProof Array of hashes for Merkle proof verification
     */
    function submitProof(
        string memory chunk,
        bytes32[] calldata merkleProof
    )
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

        // Construct the merkle root from chunk and merkleProof
        bytes32 computedMerkleRoot = _computeMerkleRootFromProof(chunk, challenge.chunkId, merkleProof);

        // Get the expected merkle root for this challenge
        bytes32 expectedMerkleRoot = knowledgeCollectionStorage.getLatestMerkleRoot(challenge.knowledgeCollectionId);

        // Verify the submitted root matches
        if (computedMerkleRoot == expectedMerkleRoot) {
            // Mark as correct submission and add points to the node
            challenge.solved = true;
            randomSamplingStorage.setNodeChallenge(identityId, challenge);

            uint256 epoch = chronos.getCurrentEpoch();
            randomSamplingStorage.incrementEpochNodeValidProofsCount(epoch, identityId);
            uint256 score18 = calculateNodeScore(identityId);
            randomSamplingStorage.addToNodeEpochProofPeriodScore(
                epoch,
                activeProofPeriodStartBlock,
                identityId,
                score18
            );
            randomSamplingStorage.addToNodeEpochScore(epoch, identityId, score18);
            randomSamplingStorage.addToAllNodesEpochScore(epoch, score18);

            // Calculate and add to nodeEpochScorePerStake
            // Phase 11: use effective node stake = V8_raw + V10_effective
            // = nodeStake + (nodeEffective_V10 - nodeV10BaseStake)
            uint256 rawNodeStake = uint256(stakingStorage.getNodeStake(identityId));
            uint256 nodeEffV10 = convictionStakingStorage.getNodeEffectiveStakeAtEpoch(
                identityId, epoch
            );
            uint256 nodeV10Base = convictionStakingStorage.getNodeV10BaseStake(identityId);
            uint256 effectiveNodeStake = rawNodeStake + nodeEffV10 - nodeV10Base;
            if (effectiveNodeStake > 0) {
                uint256 nodeScorePerStake36 = (score18 * SCALE18) / effectiveNodeStake;
                randomSamplingStorage.addToNodeEpochScorePerStake(epoch, identityId, nodeScorePerStake36);
            }
        } else {
            revert MerkleRootMismatchError(computedMerkleRoot, expectedMerkleRoot);
        }
    }

    /**
     * @dev Internal function to compute Merkle root from a chunk and its proof
     * Reconstructs the Merkle tree root by hashing the chunk with its ID and
     * traversing up the tree using the provided proof hashes
     * Uses standard Merkle tree construction where smaller hash goes left
     * @param chunk The data chunk to verify
     * @param chunkId Unique identifier for the chunk position
     * @param merkleProof Array of sibling hashes for tree traversal
     * @return computedRoot The computed Merkle root hash
     */
    function _computeMerkleRootFromProof(
        string memory chunk,
        uint256 chunkId,
        bytes32[] calldata merkleProof
    ) internal pure returns (bytes32) {
        bytes32 computedHash = keccak256(abi.encodePacked(chunk, chunkId));

        for (uint256 i = 0; i < merkleProof.length; ) {
            if (computedHash < merkleProof[i]) {
                computedHash = keccak256(abi.encodePacked(computedHash, merkleProof[i]));
            } else {
                computedHash = keccak256(abi.encodePacked(merkleProof[i], computedHash));
            }

            unchecked {
                i++;
            }
        }

        return computedHash;
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
     * @return chunkId   Selected chunk index within the KC.
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
     *      Step 3 — Compute the chunk index as in V8: `seed % (byteSize /
     *      chunkByteSize)`, or 0 if the KC is smaller than one chunk.
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
        uint256 kcCount = contextGraphStorage.getContextGraphKCCount(cgId);
        if (kcCount == 0) {
            // Eligible CG exists but holds no registered KCs; treat the same
            // as an all-expired CG (skip and retry next period).
            revert NoEligibleKnowledgeCollection();
        }
        uint256 pickedKcId;
        bytes32 kcSeed = seed;
        for (uint8 attempt = 0; attempt < MAX_KC_RETRIES; attempt++) {
            kcSeed = keccak256(abi.encodePacked(kcSeed, attempt));
            uint256 idx = uint256(kcSeed) % kcCount;
            uint256 candidate = contextGraphStorage.getContextGraphKCAt(cgId, idx);
            if (knowledgeCollectionStorage.getEndEpoch(candidate) >= currentEpoch) {
                pickedKcId = candidate;
                break;
            }
        }
        if (pickedKcId == 0) {
            revert NoEligibleKnowledgeCollection();
        }
        kcId = pickedKcId;

        // ---- Step 3: compute the chunk index identically to V8. ----
        uint88 kcByteSize = knowledgeCollectionStorage.getByteSize(kcId);
        if (kcByteSize == 0) {
            // V8 used a verbose string here; surfacing as a custom error
            // would change the ABI; keep the string for parity.
            revert("Knowledge collection byte size is 0");
        }
        uint256 chunkByteSize = randomSamplingStorage.CHUNK_BYTE_SIZE();
        if (kcByteSize > chunkByteSize) {
            // Use the rotated kcSeed so chunk picks within a CG don't degenerate
            // when many KCs share the same byte size.
            chunkId = uint256(kcSeed) % (uint256(kcByteSize) / chunkByteSize);
        }
    }

    /**
     * @dev True iff the CG is active AND non-curated. Curated CGs are
     *      treated as private for Phase 10 random sampling and excluded
     *      from the weighted draw at read time. See `_generateChallenge`
     *      NatSpec for the rationale (Phase 8 already ships unconditional
     *      writes to `ContextGraphValueStorage`).
     */
    function _isCGEligible(uint256 contextGraphId) internal view returns (bool) {
        if (!contextGraphStorage.isContextGraphActive(contextGraphId)) {
            return false;
        }
        if (contextGraphStorage.getIsCurated(contextGraphId)) {
            return false;
        }
        return true;
    }

    /**
     * @dev Calculates the node score based on stake, publishing activity, and ask alignment
     * Implements anti-sybil multiplicative score formula (RFC-26 update)
     *
     * Formula: nodeScore(t) = S(t) * (c + 0.86 * P(t) + 0.60 * A(t) * P(t))
     *
     * Where:
     * - S(t) = sqrt(nodeStake / STAKE_CAP) - sublinear stake scaling
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
        uint256 currentEpoch = chronos.getCurrentEpoch();

        // 1. Stake factor S(t) = sqrt(nodeStake / stakeCap)
        // Using sublinear scaling to reduce stake dominance (RFC-26 Section 4.1)
        uint256 stakeCap = uint256(parametersStorage.maximumStake());
        uint256 nodeStake = uint256(stakingStorage.getNodeStake(identityId));
        nodeStake = nodeStake > stakeCap ? stakeCap : nodeStake;
        // S18 = sqrt((nodeStake / stakeCap) * SCALE18) * sqrt(SCALE18)
        uint256 stakeRatio18 = (nodeStake * SCALE18) / stakeCap;
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
