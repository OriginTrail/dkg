// SPDX-License-Identifier: Apache-2.0

pragma solidity ^0.8.20;

import {Guardian} from "../Guardian.sol";
import {KnowledgeAssetsLib} from "../libraries/KnowledgeAssetsLib.sol";
import {INamed} from "../interfaces/INamed.sol";
import {IVersioned} from "../interfaces/IVersioned.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC721Enumerable} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721Enumerable.sol";

/**
 * @title ContextGraphStorage
 * @notice ERC-721 registry for Context Graphs. Each CG is an NFT — the token holder
 *         has management authority (publish policy, participants).
 *
 * Inherits Guardian for Hub-based access control and ERC721Enumerable for
 * transferable governance tokens. The logic facade (ContextGraphs.sol) remains
 * stateless and replaceable; all state lives here.
 *
 * Design notes:
 *   - Per-CG hosting committees and per-CG quorum were removed in
 *     SPEC_CG_MEMORY_MODEL. Every CG is hosted by the network's sharding
 *     table at publish time, and the ACK quorum is the system parameter
 *     `parametersStorage.minimumRequiredSignatures()`. The CG records only
 *     the participant-agent allow-list (addresses used for curated / PCA
 *     flows).
 *   - 3 curator types are supported via (publishAuthority, publishAuthorityAccountId):
 *       EOA      -> publishAuthority = wallet, accountId = 0
 *       Safe     -> publishAuthority = multisig contract, accountId = 0
 *       PCA      -> publishAuthority = account-owner address (read-only marker),
 *                   accountId = DKGPublishingConvictionNFT account ID
 *     The facade is responsible for resolving curator type at publish time.
 *   - `kaToContextGraph` reverse lookup and `_contextGraphKAList` forward list
 *     are written via `registerKnowledgeAssetToContextGraph` (called from the publish flow
 *     in Phase 8) and read by Phase 10 random sampling.
 *   - The legacy `addBatchToContextGraph` / `_contextGraphBatches` /
 *     `_attestedRoots` / `verifyTripleInclusion` surface is REMOVED. The
 *     deleted Merkle-inclusion path closes audit finding H2 (forged inclusion
 *     proofs via caller-supplied storage address).
 */
contract ContextGraphStorage is INamed, IVersioned, Guardian, ERC721Enumerable {
    string private constant _NAME = "ContextGraphStorage";
    // 10.0.3 — KC→KA terminology: public getters renamed getContextGraphKCCount/At/List →
    //          getContextGraphKaCount/At/List (ABI selector change; no behavior change).
    // 10.0.4 — OT-RFC-53: per-CG registration-escrow accounting (get/set/decrease/
    //          clear) consumed by the deposit pull + admin sweep. ABI surface addition.
    // 10.0.6 — Decoupled sampling list: a SECOND per-CG array (`_samplingKAList`)
    //          drives random sampling and is the one the keeper compacts, while
    //          `_contextGraphKAList` stays strictly append-only as the
    //          registration-ordinal source the off-chain chain-reconciler reads
    //          (`getContextGraphKaCount/At`). Pruning expired KAs from sampling no
    //          longer mutates that ordinal, so the reconciler's [watermark, head)
    //          cursor can never skip a later publish. Adds getSamplingKaCount/At;
    //          swapRemoveSamplingKnowledgeAssetAt now targets the sampling list.
    string private constant _VERSION = "10.0.6";

    // -----------------------------------------------------------------------
    // Bounds on participant list — anti-griefing cap.
    //
    // MAX_PARTICIPANT_AGENTS bounds both the O(n^2) creation-time dedup and
    // the O(n) shift-left in `removeParticipantAgent` to ~1.3M gas worst case.
    // -----------------------------------------------------------------------
    uint256 public constant MAX_PARTICIPANT_AGENTS = 256;

    // -----------------------------------------------------------------------
    // Storage layout — fresh design (no prior deployments to preserve).
    // -----------------------------------------------------------------------

    uint256 private _contextGraphCounter;

    // Core context graph metadata (no participant list; that lives in its
    // own mapping to avoid struct↔dynamic-array mutability constraints).
    mapping(uint256 contextGraphId => KnowledgeAssetsLib.ContextGraph) private _contextGraphs;

    // Participant agents: EOA addresses authorised to publish into a curated
    // CG (used as an allow-list for Safe / PCA-agent flows). Insertion order
    // preserved; duplicates rejected.
    // Slither: mappings are zero-initialized by the language (no slot is
    // written until first key insertion). The "uninitialized-state" rule
    // fires on declaration-without-initializer, but there is no
    // initializer syntax for mappings — Solidity rejects it. False
    // positive for every public/private mapping in the codebase.
    // slither-disable-next-line uninitialized-state
    mapping(uint256 contextGraphId => address[]) private _participantAgents;

    // Non-zero when curator type is PCA: the DKGPublishingConvictionNFT
    // account ID whose registered agents are authorised to publish.
    mapping(uint256 contextGraphId => uint256) private _publishAuthorityAccountId;

    // OT-RFC-38 / LU-6 Phase B — opt-in stable identifier the curator
    // commits to at create time. Set to `keccak256(bytes(cleartextId))`
    // by the agent layer so the wire form of SWM gossip (topic,
    // envelope `contextGraphId`, signing payload, host-mode store key)
    // is chain-derivable and privacy-preserving (cleartext never leaves
    // the local node). Hosting cores that hear `ContextGraphCreated`
    // read this and auto-subscribe to `dkg/context-graph/{nameHash}/
    // shared-memory` in host mode — no off-chain discovery channel
    // required for registered CGs. Zero indicates a CG that didn't
    // commit to a name hash (curator chose not to opt in, or it pre-
    // dates this surface); host-mode auto-subscribe is then governed
    // by the discovery beacon path instead.
    mapping(uint256 contextGraphId => bytes32) private _contextGraphNameHash;

    // KA -> CG reverse lookup (Phase 10 random sampling).
    // Public for convenience; zero means "not registered".
    mapping(uint256 kaId => uint256 contextGraphId) public kaToContextGraph;

    // CG -> [KA IDs] APPEND-ONLY registration list. This is the per-CG
    // registration-ordinal source the off-chain chain-reconciler walks as
    // `[watermark, head)` (head = getContextGraphKaCount) — so it MUST stay
    // append-only: never reorder, never shrink. Sampling pruning happens on
    // `_samplingKAList` below, never here.
    mapping(uint256 contextGraphId => uint256[]) private _contextGraphKAList;

    // CG -> [live KA IDs] COMPACTED list that drives within-CG random sampling.
    // Written alongside `_contextGraphKAList` on registration, but the keeper
    // (`RandomSampling.pruneExpiredKnowledgeAssets` → `swapRemoveSamplingKnowledgeAssetAt`)
    // swap-pops EXPIRED KAs out of THIS list only. Decoupling the sampling
    // enumeration from the append-only registration ordinal lets the draw shed
    // dead slots without corrupting the reconciler cursor. Read via
    // getSamplingKaCount/At; the two lists diverge over time by design.
    //
    // POPULATION INVARIANT: `registerKnowledgeAssetToContextGraph` is the SOLE
    // writer of both arrays and always appends to them together — there is no
    // setter or migration that writes `_contextGraphKAList` alone. So a CG can
    // never hold registrations in the append-only list without the matching
    // sampling entries (the "pre-existing KAs invisible to sampling" state is
    // unreachable). This is a fresh-design, non-proxy contract deployed empty for
    // V10 (both lists populate from genesis); should a future deployment ever
    // need to preserve CG state, the migration MUST seed both arrays together.
    mapping(uint256 contextGraphId => uint256[]) private _samplingKAList;

    // OT-RFC-53 — per-CG registration-deposit escrow (anti-spam). Accounting
    // only: the TRAC itself is custodied in the CSS vault (mirrors
    // PublishingConviction's committed-TRAC model). Set at on-chain CG
    // creation, decremented as the owner spends it on publishing into the CG,
    // cleared on an admin sweep to the staker reward pool.
    mapping(uint256 contextGraphId => uint96) private _cgRegistrationEscrow;

    // -----------------------------------------------------------------------
    // Events
    // -----------------------------------------------------------------------

    event ContextGraphCreated(
        uint256 indexed contextGraphId,
        address indexed owner,
        bytes32 indexed nameHash,
        address[] participantAgents,
        uint256 metadataBatchId,
        uint8 accessPolicy,
        uint8 publishPolicy,
        address publishAuthority,
        uint256 publishAuthorityAccountId
    );

    event ContextGraphDeactivated(
        uint256 indexed contextGraphId
    );

    event PublishPolicyUpdated(
        uint256 indexed contextGraphId,
        uint8 publishPolicy,
        address publishAuthority,
        uint256 publishAuthorityAccountId
    );

    event PublishAuthorityUpdated(
        uint256 indexed contextGraphId,
        address newAuthority,
        uint256 newAuthorityAccountId
    );

    event AgentParticipantAdded(
        uint256 indexed contextGraphId,
        address indexed agent
    );

    event AgentParticipantRemoved(
        uint256 indexed contextGraphId,
        address indexed agent
    );

    event KnowledgeAssetRegisteredToContextGraph(
        uint256 indexed contextGraphId,
        uint256 indexed kaId
    );

    constructor(
        address hubAddress
    ) Guardian(hubAddress) ERC721("DKG Context Graph", "DKGCG") {}

    function name() public pure virtual override(INamed, ERC721) returns (string memory) {
        return _NAME;
    }

    function version() external pure virtual returns (string memory) {
        return _VERSION;
    }

    // -----------------------------------------------------------------------
    // Creation
    // -----------------------------------------------------------------------

    /**
     * @notice Create a new context graph and mint its governance NFT.
     * @param owner_                       Recipient of the ERC-721 (token holder == manager).
     * @param participantAgents            EOA allow-list (no zeros, no duplicates).
     * @param metadataBatchId              Batch ID describing the CG metadata (0 if none).
     * @param accessPolicy                 0 = public/discoverable, 1 = private/curated.
     * @param publishPolicy                0 = curated, 1 = open.
     * @param publishAuthority             Curator address. Required when curated; ignored
     *                                     (and forced to address(0)) when open.
     * @param publishAuthorityAccountId    Non-zero for PCA curator type. Requires curated.
     *                                     Forced to 0 when open.
     * @param nameHash                     OT-RFC-38 / LU-6 Phase B — opt-in stable wire
     *                                     identifier the curator commits to (intended to
     *                                     be `keccak256(bytes(cleartextId))`, but the
     *                                     contract is agnostic to the derivation; ANY
     *                                     unique non-zero `bytes32` works). Hosting
     *                                     cores in the sharding table use this to
     *                                     auto-subscribe to the SWM gossip topic on
     *                                     receipt of the `ContextGraphCreated` event.
     *                                     Pass `bytes32(0)` to opt out — host-mode
     *                                     auto-discovery for the CG then relies on the
     *                                     gossip-beacon path (Option β).
     *
     * @dev Hosts and ACK quorum are network-level concerns: the sharding table
     *      supplies hosts at publish time and `parametersStorage.minimumRequiredSignatures()`
     *      sets the quorum. CGs do not declare a per-CG hosting committee.
     */
    function createContextGraph(
        address owner_,
        address[] calldata participantAgents,
        uint256 metadataBatchId,
        uint8 accessPolicy,
        uint8 publishPolicy,
        address publishAuthority,
        uint256 publishAuthorityAccountId,
        bytes32 nameHash
    ) external onlyContracts returns (uint256 contextGraphId) {
        if (owner_ == address(0)) {
            revert KnowledgeAssetsLib.InvalidContextGraphConfig("zero address owner");
        }
        if (participantAgents.length > MAX_PARTICIPANT_AGENTS) {
            revert KnowledgeAssetsLib.InvalidContextGraphConfig("agents cap");
        }
        if (accessPolicy > 1) {
            revert KnowledgeAssetsLib.InvalidContextGraphConfig("invalid accessPolicy");
        }
        if (publishPolicy > 1) {
            revert KnowledgeAssetsLib.InvalidContextGraphConfig("invalid publishPolicy");
        }

        // Curator config is policy-dependent.
        address normalizedAuthority;
        uint256 normalizedAccountId;
        if (publishPolicy == 0) {
            // Curated: authority required; accountId optional (non-zero -> PCA).
            if (publishAuthority == address(0)) {
                revert KnowledgeAssetsLib.InvalidContextGraphConfig("curated requires publishAuthority");
            }
            normalizedAuthority = publishAuthority;
            normalizedAccountId = publishAuthorityAccountId;
        } else {
            // Open: authority + accountId must be empty.
            if (publishAuthority != address(0)) {
                revert KnowledgeAssetsLib.InvalidContextGraphConfig("open policy: zero authority required");
            }
            if (publishAuthorityAccountId != 0) {
                revert KnowledgeAssetsLib.InvalidContextGraphConfig("open policy: zero accountId required");
            }
            normalizedAuthority = address(0);
            normalizedAccountId = 0;
        }

        contextGraphId = ++_contextGraphCounter;

        // CEI ordering: populate ALL CG state below first; `_mint` happens
        // last so the wrapper never observes a half-built (NFT-without-
        // metadata-or-participants) state. `_mint` (not `_safeMint`) is
        // intentional: `owner_` is forwarded from `ContextGraphs.create
        // ContextGraph` as the upstream `msg.sender`, and contract owners
        // without `IERC721Receiver` (DAO timelocks, custom multisigs,
        // factory wrappers) are part of the supported caller set.
        KnowledgeAssetsLib.ContextGraph storage cg = _contextGraphs[contextGraphId];
        cg.metadataBatchId = metadataBatchId;
        cg.active = true;
        cg.createdAt = uint40(block.timestamp);
        cg.accessPolicy = accessPolicy;
        cg.publishPolicy = publishPolicy;
        cg.publishAuthority = normalizedAuthority;

        address[] storage storedAgents = _participantAgents[contextGraphId];
        for (uint256 i; i < participantAgents.length; i++) {
            address agent = participantAgents[i];
            if (agent == address(0)) {
                revert KnowledgeAssetsLib.InvalidContextGraphConfig("zero participant agent");
            }
            // Linear dedup; small lists in practice.
            for (uint256 j; j < i; j++) {
                if (participantAgents[j] == agent) {
                    revert KnowledgeAssetsLib.AgentParticipantAlreadyExists(contextGraphId, agent);
                }
            }
            storedAgents.push(agent);
        }

        if (normalizedAccountId != 0) {
            _publishAuthorityAccountId[contextGraphId] = normalizedAccountId;
        }

        if (nameHash != bytes32(0)) {
            _contextGraphNameHash[contextGraphId] = nameHash;
        }

        _mint(owner_, contextGraphId);

        emit ContextGraphCreated(
            contextGraphId,
            owner_,
            nameHash,
            participantAgents,
            metadataBatchId,
            accessPolicy,
            publishPolicy,
            normalizedAuthority,
            normalizedAccountId
        );
    }

    // -----------------------------------------------------------------------
    // KA <-> CG registration (Phase 8 publish flow + Phase 10 sampling)
    // -----------------------------------------------------------------------

    /**
     * @notice Bind a Knowledge Asset to a Context Graph.
     * @dev Records the reverse lookup (`kaToContextGraph[kaId] = cgId`) and
     *      appends to BOTH per-CG lists: `_contextGraphKAList` (the append-only
     *      registration ordinal the reconciler reads) and `_samplingKAList` (the
     *      compactable sampling enumeration). They start identical; the keeper
     *      later prunes expired entries from the sampling list only.
     *      Reverts on double registration.
     */
    function registerKnowledgeAssetToContextGraph(
        uint256 contextGraphId,
        uint256 kaId
    ) external onlyContracts {
        if (kaId == 0) {
            revert KnowledgeAssetsLib.InvalidContextGraphConfig("zero kaId");
        }
        if (!_contextGraphs[contextGraphId].active) {
            revert KnowledgeAssetsLib.ContextGraphNotActive(contextGraphId);
        }
        uint256 existing = kaToContextGraph[kaId];
        if (existing != 0) {
            revert KnowledgeAssetsLib.KnowledgeAssetAlreadyRegisteredToContextGraph(kaId, existing);
        }
        kaToContextGraph[kaId] = contextGraphId;
        _contextGraphKAList[contextGraphId].push(kaId);
        _samplingKAList[contextGraphId].push(kaId);
        emit KnowledgeAssetRegisteredToContextGraph(contextGraphId, kaId);
    }

    event KnowledgeAssetPrunedFromSamplingList(uint256 indexed contextGraphId, uint256 indexed kaId);

    /// @dev The generic swap-pop below can desync the sampling list from
    ///      `kaToContextGraph`, so it is restricted to the RandomSampling
    ///      contract (the sole component that prunes the list, and only for
    ///      EXPIRED KAs — it checks `endEpoch` before calling). This is stricter
    ///      than `onlyContracts`: it stops a future/buggy Hub contract from
    ///      removing a LIVE KA from sampling while it still reports as registered.
    error OnlyRandomSampling(address caller);

    /**
     * @notice Remove a Knowledge Asset from a Context Graph's SAMPLING list by
     *         swap-and-pop.
     * @dev Called only by `RandomSampling.pruneExpiredKnowledgeAssets` (the
     *      permissionless keeper) to prune EXPIRED KAs, so the sampling
     *      enumeration cannot accumulate dead slots into a within-CG sampling DoS.
     *      Removes ONLY from `_samplingKAList` — the append-only
     *      `_contextGraphKAList` (the reconciler's registration ordinal) is NOT
     *      touched, so a later publish can never be skipped by the reconciler's
     *      cursor. The `kaToContextGraph[kaId]` reverse binding is also left
     *      intact: readers (`getKAContextGraphId`) must still resolve the KA, and
     *      an expired KA can never be re-registered (it cannot be re-published
     *      with the same id), so the double-registration guard stays correct.
     *      `expectedKaId` makes the call a no-op when the slot no longer holds it
     *      (a prior swap-pop moved a different KA into `index`) — robust to stale
     *      indices.
     */
    function swapRemoveSamplingKnowledgeAssetAt(
        uint256 contextGraphId,
        uint256 index,
        uint256 expectedKaId
    ) external {
        if (msg.sender != hub.getContractAddress("RandomSampling")) {
            revert OnlyRandomSampling(msg.sender);
        }
        uint256[] storage list = _samplingKAList[contextGraphId];
        uint256 len = list.length;
        if (index >= len || list[index] != expectedKaId) {
            return; // stale / already moved — skip; pruned on a later draw
        }
        uint256 last = len - 1;
        if (index != last) {
            list[index] = list[last];
        }
        list.pop();
        emit KnowledgeAssetPrunedFromSamplingList(contextGraphId, expectedKaId);
    }

    /**
     * @notice Return the entire KA list for a context graph as a memory array.
     * @dev WARNING — ON-CHAIN CALLERS MUST NOT USE THIS GETTER. Gas cost is
     *      O(n) in the list length and the ABI decode copies the full array
     *      into memory. Phase 10 random sampling and any other on-chain
     *      consumer MUST use `getContextGraphKaAt(cgId, index)` together
     *      with `getContextGraphKaCount(cgId)` to fetch a single element at
     *      a bounded cost. This full-array getter is retained for off-chain
     *      indexers (eth_call) where the gas cost is not charged.
     */
    function getContextGraphKaList(
        uint256 contextGraphId
    ) external view returns (uint256[] memory) {
        return _contextGraphKAList[contextGraphId];
    }

    function getContextGraphKaCount(
        uint256 contextGraphId
    ) external view returns (uint256) {
        return _contextGraphKAList[contextGraphId].length;
    }

    /**
     * @notice Return a single KA id at a given index within a CG's KA list.
     * @dev O(1) indexed accessor for on-chain consumers (Phase 10 random
     *      sampling). Reverts with `InvalidContextGraphConfig("kaIndex oob")`
     *      on out-of-bounds access — empty list rejects all indices.
     */
    function getContextGraphKaAt(
        uint256 contextGraphId,
        uint256 index
    ) external view returns (uint256 kaId) {
        uint256[] storage list = _contextGraphKAList[contextGraphId];
        if (index >= list.length) {
            revert KnowledgeAssetsLib.InvalidContextGraphConfig("kaIndex oob");
        }
        return list[index];
    }

    /**
     * @notice Length of the COMPACTED sampling list (live + not-yet-pruned KAs).
     * @dev This is the count the within-CG random-sampling draw bounds against
     *      (`RandomSampling._pickKa`) and the keeper scans. It shrinks as the
     *      keeper prunes expired KAs — unlike `getContextGraphKaCount`, which is
     *      the monotonic append-only registration count.
     */
    function getSamplingKaCount(
        uint256 contextGraphId
    ) external view returns (uint256) {
        return _samplingKAList[contextGraphId].length;
    }

    /**
     * @notice Single KA id at an index within a CG's compacted sampling list.
     * @dev O(1) accessor for the within-CG draw + the keeper. Reverts
     *      `InvalidContextGraphConfig("samplingIndex oob")` out of bounds.
     */
    function getSamplingKaAt(
        uint256 contextGraphId,
        uint256 index
    ) external view returns (uint256 kaId) {
        uint256[] storage list = _samplingKAList[contextGraphId];
        if (index >= list.length) {
            revert KnowledgeAssetsLib.InvalidContextGraphConfig("samplingIndex oob");
        }
        return list[index];
    }

    // -----------------------------------------------------------------------
    // Deactivation
    // -----------------------------------------------------------------------

    function deactivateContextGraph(
        uint256 contextGraphId
    ) external onlyContracts {
        _requireExists(contextGraphId);
        _contextGraphs[contextGraphId].active = false;
        emit ContextGraphDeactivated(contextGraphId);
    }

    // -----------------------------------------------------------------------
    // OT-RFC-53 — registration-deposit escrow accounting (onlyContracts).
    //
    // `ContextGraphs` writes the balance at on-chain creation and clears it on
    // an admin sweep; `KnowledgeAssetsLifecycle` decrements it as the CG owner
    // funds publishing from the escrow. The underlying TRAC lives in the CSS
    // vault throughout — these functions only move the per-CG accounting.
    // -----------------------------------------------------------------------

    function getRegistrationEscrow(uint256 contextGraphId) external view returns (uint96) {
        return _cgRegistrationEscrow[contextGraphId];
    }

    function setRegistrationEscrow(uint256 contextGraphId, uint96 amount) external onlyContracts {
        _requireExists(contextGraphId);
        _cgRegistrationEscrow[contextGraphId] = amount;
    }

    function decreaseRegistrationEscrow(uint256 contextGraphId, uint96 amount) external onlyContracts {
        _requireExists(contextGraphId);
        uint96 current = _cgRegistrationEscrow[contextGraphId];
        if (amount > current) {
            revert KnowledgeAssetsLib.InvalidContextGraphConfig("escrow underflow");
        }
        _cgRegistrationEscrow[contextGraphId] = current - amount;
    }

    function clearRegistrationEscrow(uint256 contextGraphId) external onlyContracts returns (uint96 cleared) {
        _requireExists(contextGraphId);
        cleared = _cgRegistrationEscrow[contextGraphId];
        if (cleared != 0) {
            _cgRegistrationEscrow[contextGraphId] = 0;
        }
    }

    // -----------------------------------------------------------------------
    // Publish policy & authority
    // -----------------------------------------------------------------------

    /**
     * @notice Replace the publish policy + curator config in a single call.
     * @dev When `publishPolicy == 1` (open), the new authority and accountId
     *      MUST both be zero — open CGs have no curator.
     */
    function updatePublishPolicy(
        uint256 contextGraphId,
        uint8 publishPolicy,
        address publishAuthority,
        uint256 publishAuthorityAccountId
    ) external onlyContracts {
        _requireExists(contextGraphId);
        if (publishPolicy > 1) {
            revert KnowledgeAssetsLib.InvalidContextGraphConfig("invalid publishPolicy");
        }
        if (publishPolicy == 0) {
            if (publishAuthority == address(0)) {
                revert KnowledgeAssetsLib.InvalidContextGraphConfig("curated requires publishAuthority");
            }
        } else {
            if (publishAuthority != address(0)) {
                revert KnowledgeAssetsLib.InvalidContextGraphConfig("open policy: zero authority required");
            }
            if (publishAuthorityAccountId != 0) {
                revert KnowledgeAssetsLib.InvalidContextGraphConfig("open policy: zero accountId required");
            }
        }

        KnowledgeAssetsLib.ContextGraph storage cg = _contextGraphs[contextGraphId];
        cg.publishPolicy = publishPolicy;
        cg.publishAuthority = publishAuthority;
        _publishAuthorityAccountId[contextGraphId] = publishAuthorityAccountId;

        emit PublishPolicyUpdated(
            contextGraphId,
            publishPolicy,
            publishAuthority,
            publishAuthorityAccountId
        );
    }

    /**
     * @notice Update only the curator (authority + accountId), keeping policy.
     * @dev Convenience for rotating an EOA / Safe / PCA without touching the
     *      open/curated bit. Caller is the facade — it is responsible for
     *      gating to the NFT owner.
     */
    function updatePublishAuthority(
        uint256 contextGraphId,
        address newAuthority,
        uint256 newAuthorityAccountId
    ) external onlyContracts {
        _requireExists(contextGraphId);
        KnowledgeAssetsLib.ContextGraph storage cg = _contextGraphs[contextGraphId];
        if (cg.publishPolicy == 0) {
            // Curated: authority required.
            if (newAuthority == address(0)) {
                revert KnowledgeAssetsLib.InvalidContextGraphConfig("curated requires publishAuthority");
            }
        } else {
            // Open: authority + accountId must remain empty.
            if (newAuthority != address(0) || newAuthorityAccountId != 0) {
                revert KnowledgeAssetsLib.InvalidContextGraphConfig("open policy: clear authority/accountId");
            }
        }
        cg.publishAuthority = newAuthority;
        _publishAuthorityAccountId[contextGraphId] = newAuthorityAccountId;

        emit PublishAuthorityUpdated(contextGraphId, newAuthority, newAuthorityAccountId);
    }

    // -----------------------------------------------------------------------
    // Participant agent governance
    // -----------------------------------------------------------------------

    function addParticipantAgent(
        uint256 contextGraphId,
        address agent
    ) external onlyContracts {
        _requireExists(contextGraphId);
        if (agent == address(0)) {
            revert KnowledgeAssetsLib.InvalidContextGraphConfig("zero participant agent");
        }
        address[] storage agents = _participantAgents[contextGraphId];
        uint256 len = agents.length;
        if (len >= MAX_PARTICIPANT_AGENTS) {
            revert KnowledgeAssetsLib.InvalidContextGraphConfig("agents cap");
        }
        for (uint256 i; i < len; i++) {
            if (agents[i] == agent) {
                revert KnowledgeAssetsLib.AgentParticipantAlreadyExists(contextGraphId, agent);
            }
        }
        agents.push(agent);
        emit AgentParticipantAdded(contextGraphId, agent);
    }

    /// @notice Remove an agent from the participant allow-list.
    /// @dev Shift-left preserves insertion order for deterministic off-chain
    ///      iteration. Gas cost is bounded by MAX_PARTICIPANT_AGENTS
    ///      (~1.3M gas worst case at the 256-entry cap).
    function removeParticipantAgent(
        uint256 contextGraphId,
        address agent
    ) external onlyContracts {
        _requireExists(contextGraphId);
        address[] storage agents = _participantAgents[contextGraphId];
        uint256 len = agents.length;

        for (uint256 i; i < len; i++) {
            if (agents[i] == agent) {
                // Shift left to preserve insertion order (no swap-pop).
                for (uint256 j = i; j < len - 1; j++) {
                    agents[j] = agents[j + 1];
                }
                agents.pop();
                emit AgentParticipantRemoved(contextGraphId, agent);
                return;
            }
        }
        revert KnowledgeAssetsLib.AgentParticipantNotFound(contextGraphId, agent);
    }

    // -----------------------------------------------------------------------
    // Read APIs
    // -----------------------------------------------------------------------

    function getContextGraph(
        uint256 contextGraphId
    ) external view returns (
        address owner_,
        address[] memory participantAgents,
        uint256 metadataBatchId,
        bool active,
        uint256 createdAt,
        uint8 accessPolicy,
        uint8 publishPolicy,
        address publishAuthority,
        uint256 publishAuthorityAccountId
    ) {
        _requireExists(contextGraphId);
        KnowledgeAssetsLib.ContextGraph storage cg = _contextGraphs[contextGraphId];
        return (
            ownerOf(contextGraphId),
            _participantAgents[contextGraphId],
            cg.metadataBatchId,
            cg.active,
            cg.createdAt,
            cg.accessPolicy,
            cg.publishPolicy,
            cg.publishAuthority,
            _publishAuthorityAccountId[contextGraphId]
        );
    }

    function getParticipantAgents(
        uint256 contextGraphId
    ) external view returns (address[] memory) {
        return _participantAgents[contextGraphId];
    }

    function isParticipantAgent(
        uint256 contextGraphId,
        address agent
    ) external view returns (bool) {
        address[] storage agents = _participantAgents[contextGraphId];
        for (uint256 i; i < agents.length; i++) {
            if (agents[i] == agent) return true;
        }
        return false;
    }

    function getContextGraphOwner(
        uint256 contextGraphId
    ) external view returns (address) {
        return ownerOf(contextGraphId);
    }

    function isContextGraphActive(
        uint256 contextGraphId
    ) external view returns (bool) {
        return _contextGraphs[contextGraphId].active;
    }

    function getPublishPolicy(
        uint256 contextGraphId
    ) external view returns (uint8 publishPolicy, address publishAuthority) {
        KnowledgeAssetsLib.ContextGraph storage cg = _contextGraphs[contextGraphId];
        return (cg.publishPolicy, cg.publishAuthority);
    }

    function getAccessPolicy(
        uint256 contextGraphId
    ) external view returns (uint8) {
        return _contextGraphs[contextGraphId].accessPolicy;
    }

    function getPublishAuthorityAccountId(
        uint256 contextGraphId
    ) external view returns (uint256) {
        return _publishAuthorityAccountId[contextGraphId];
    }

    /**
     * @notice OT-RFC-38 / LU-6 Phase B — committed name hash for the CG.
     *         Returns `bytes32(0)` when the curator opted out at create
     *         time (rare; expected only for CGs that pre-date the
     *         Phase B surface or want to rely on the discovery-beacon
     *         path exclusively).
     */
    function getNameHash(
        uint256 contextGraphId
    ) external view returns (bytes32) {
        return _contextGraphNameHash[contextGraphId];
    }

    /**
     * @notice True iff the CG carries curated (encrypted) payloads — i.e.,
     *         the ACCESS policy is curated, regardless of publish policy.
     *
     * Originally this checked `publishPolicy == 0`, but that conflated two
     * orthogonal axes: "who can read" (access) vs. "who can publish".
     * The ciphertext-commitment branch on the KAv10 publish path needs
     * to know whether the payload is ENCRYPTED, which is an access-policy
     * question. The "curated access + open publish" combo (anyone in the
     * allowlist may publish, but readers must still decrypt) is a valid
     * configuration and must accept ciphertext commitments.
     *
     * Used by `RandomSampling._pickWeightedChallenge` step 2 to decide
     * whether the per-KA ciphertext-commitment filter applies (RFC-39
     * Phase A.5). Both call sites converge on this access-policy check.
     */
    function getIsCurated(
        uint256 contextGraphId
    ) external view returns (bool) {
        return _contextGraphs[contextGraphId].accessPolicy != 0;
    }

    function getLatestContextGraphId() external view returns (uint256) {
        return _contextGraphCounter;
    }

    // -----------------------------------------------------------------------
    // Internal
    // -----------------------------------------------------------------------

    function _requireExists(uint256 contextGraphId) internal view {
        _requireOwned(contextGraphId);
    }

    /**
     * @dev Override required by Solidity for ERC721Enumerable.
     */
    function supportsInterface(
        bytes4 interfaceId
    ) public view virtual override(ERC721Enumerable) returns (bool) {
        return super.supportsInterface(interfaceId);
    }

    function _increaseBalance(
        address account,
        uint128 value
    ) internal virtual override(ERC721Enumerable) {
        super._increaseBalance(account, value);
    }

    function _update(
        address to,
        uint256 tokenId,
        address auth
    ) internal virtual override(ERC721Enumerable) returns (address) {
        address from = super._update(to, tokenId, auth);

        // On transfer (not mint/burn, not self-transfer): if the curated
        // publishAuthority was the previous owner, auto-rotate it to the new
        // owner so governance follows the NFT and the old owner can't keep
        // publishing. Always clear the PCA accountId — the new owner is
        // unlikely to be the same PCA, and they must explicitly opt back into
        // PCA mode if desired.
        //
        // Self-transfers (`from == to`) are no-ops for governance: without the
        // `from != to` guard the branch below would trivially evaluate true
        // (publishAuthority == from == to) and silently clear the accountId.
        if (from != address(0) && to != address(0) && from != to) {
            KnowledgeAssetsLib.ContextGraph storage cg = _contextGraphs[tokenId];
            if (cg.publishAuthority == from) {
                cg.publishAuthority = to;
                _publishAuthorityAccountId[tokenId] = 0;
                emit PublishAuthorityUpdated(tokenId, to, 0);
            }
        }

        return from;
    }
}
