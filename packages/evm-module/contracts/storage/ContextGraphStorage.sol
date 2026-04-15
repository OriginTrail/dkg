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
 *         has management authority (publish policy, participants, quorum).
 *
 * Inherits Guardian for Hub-based access control and ERC721Enumerable for
 * transferable governance tokens. The logic facade (ContextGraphs.sol) remains
 * stateless and replaceable; all state lives here.
 *
 * V10 Phase 7 redesign:
 *   - Hosting nodes (uint72 identityIds) and participant agents (addresses)
 *     are tracked as two SEPARATE lists. Decision #21 — nodes and agents are
 *     different principals; the old conflated `participantIdentityIds` field
 *     is gone.
 *   - Quorum (`requiredSignatures`) is bound to hosting nodes only — ACK
 *     signatures attest storage and come from hosting nodes.
 *   - 3 curator types are supported via (publishAuthority, publishAuthorityAccountId):
 *       EOA      -> publishAuthority = wallet, accountId = 0
 *       Safe     -> publishAuthority = multisig contract, accountId = 0
 *       PCA      -> publishAuthority = account-owner address (read-only marker),
 *                   accountId = DKGPublishingConvictionNFT account ID
 *     The facade is responsible for resolving curator type at publish time.
 *   - `kcToContextGraph` reverse lookup and `_contextGraphKCList` forward list
 *     are written via `registerKCToContextGraph` (called from the publish flow
 *     in Phase 8) and read by Phase 10 random sampling.
 *   - The legacy `addBatchToContextGraph` / `_contextGraphBatches` /
 *     `_attestedRoots` / `verifyTripleInclusion` surface is REMOVED. The
 *     deleted Merkle-inclusion path closes audit finding H2 (forged inclusion
 *     proofs via caller-supplied storage address).
 */
contract ContextGraphStorage is INamed, IVersioned, Guardian, ERC721Enumerable {
    string private constant _NAME = "ContextGraphStorage";
    string private constant _VERSION = "1.0.0";

    // -----------------------------------------------------------------------
    // Bounds on participant lists — anti-griefing caps.
    //
    // MAX_HOSTING_NODES bounds the O(n^2) creation-time sorted-dedup walk
    // (`_validateHostingNodes`) to ~4k storage-reads worst case.
    //
    // MAX_PARTICIPANT_AGENTS bounds both the O(n^2) creation-time dedup and
    // the O(n) shift-left in `removeParticipantAgent` to ~1.3M gas worst case.
    // -----------------------------------------------------------------------
    uint256 public constant MAX_HOSTING_NODES = 64;
    uint256 public constant MAX_PARTICIPANT_AGENTS = 256;

    // -----------------------------------------------------------------------
    // Storage layout — fresh design (no prior deployments to preserve).
    // -----------------------------------------------------------------------

    uint256 private _contextGraphCounter;

    // Core context graph metadata (no participant lists; those live in their
    // own mappings to avoid struct↔dynamic-array mutability constraints).
    mapping(uint256 contextGraphId => KnowledgeAssetsLib.ContextGraph) private _contextGraphs;

    // Hosting nodes: identity IDs of nodes that store this CG's data.
    // Sorted ascending, no zeros, no duplicates.
    mapping(uint256 contextGraphId => uint72[]) private _hostingNodes;

    // Participant agents: EOA addresses authorised to publish into a curated
    // CG (used as an allow-list for Safe / PCA-agent flows). Insertion order
    // preserved; duplicates rejected.
    mapping(uint256 contextGraphId => address[]) private _participantAgents;

    // Non-zero when curator type is PCA: the DKGPublishingConvictionNFT
    // account ID whose registered agents are authorised to publish.
    mapping(uint256 contextGraphId => uint256) private _publishAuthorityAccountId;

    // KC -> CG reverse lookup (Phase 10 random sampling).
    // Public for convenience; zero means "not registered".
    mapping(uint256 kcId => uint256 contextGraphId) public kcToContextGraph;

    // CG -> [KC IDs] forward list for uniform random KC selection within a CG.
    mapping(uint256 contextGraphId => uint256[]) private _contextGraphKCList;

    // -----------------------------------------------------------------------
    // Events
    // -----------------------------------------------------------------------

    event ContextGraphCreated(
        uint256 indexed contextGraphId,
        address indexed owner,
        uint72[] hostingNodes,
        address[] participantAgents,
        uint8 requiredSignatures,
        uint256 metadataBatchId,
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

    event HostingNodesSet(
        uint256 indexed contextGraphId,
        uint72[] nodes
    );

    event AgentParticipantAdded(
        uint256 indexed contextGraphId,
        address indexed agent
    );

    event AgentParticipantRemoved(
        uint256 indexed contextGraphId,
        address indexed agent
    );

    event QuorumUpdated(
        uint256 indexed contextGraphId,
        uint8 requiredSignatures
    );

    event KCRegisteredToContextGraph(
        uint256 indexed contextGraphId,
        uint256 indexed kcId
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
     * @param hostingNodes                 Sorted ascending, no zeros, no duplicates.
     * @param participantAgents            EOA allow-list (no zeros, no duplicates).
     * @param requiredSignatures           ACK quorum, must be in (0, hostingNodes.length].
     * @param metadataBatchId              Batch ID describing the CG metadata (0 if none).
     * @param publishPolicy                0 = curated, 1 = open.
     * @param publishAuthority             Curator address. Required when curated; ignored
     *                                     (and forced to address(0)) when open.
     * @param publishAuthorityAccountId    Non-zero for PCA curator type. Requires curated.
     *                                     Forced to 0 when open.
     */
    function createContextGraph(
        address owner_,
        uint72[] calldata hostingNodes,
        address[] calldata participantAgents,
        uint8 requiredSignatures,
        uint256 metadataBatchId,
        uint8 publishPolicy,
        address publishAuthority,
        uint256 publishAuthorityAccountId
    ) external onlyContracts returns (uint256 contextGraphId) {
        if (owner_ == address(0)) {
            revert KnowledgeAssetsLib.InvalidContextGraphConfig("zero address owner");
        }
        if (hostingNodes.length == 0) {
            revert KnowledgeAssetsLib.InvalidContextGraphConfig("empty hosting nodes");
        }
        if (hostingNodes.length > MAX_HOSTING_NODES) {
            revert KnowledgeAssetsLib.InvalidContextGraphConfig("hosting nodes cap");
        }
        if (participantAgents.length > MAX_PARTICIPANT_AGENTS) {
            revert KnowledgeAssetsLib.InvalidContextGraphConfig("agents cap");
        }
        if (requiredSignatures == 0 || requiredSignatures > hostingNodes.length) {
            revert KnowledgeAssetsLib.InvalidContextGraphConfig("invalid M/N threshold");
        }
        if (publishPolicy > 1) {
            revert KnowledgeAssetsLib.InvalidContextGraphConfig("invalid publishPolicy");
        }
        _validateHostingNodes(hostingNodes);

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

        _mint(owner_, contextGraphId);

        KnowledgeAssetsLib.ContextGraph storage cg = _contextGraphs[contextGraphId];
        cg.requiredSignatures = requiredSignatures;
        cg.metadataBatchId = metadataBatchId;
        cg.active = true;
        cg.createdAt = uint40(block.timestamp);
        cg.publishPolicy = publishPolicy;
        cg.publishAuthority = normalizedAuthority;

        // Copy split lists into their own mappings.
        uint72[] storage storedNodes = _hostingNodes[contextGraphId];
        for (uint256 i; i < hostingNodes.length; i++) {
            storedNodes.push(hostingNodes[i]);
        }

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

        emit ContextGraphCreated(
            contextGraphId,
            owner_,
            hostingNodes,
            participantAgents,
            requiredSignatures,
            metadataBatchId,
            publishPolicy,
            normalizedAuthority,
            normalizedAccountId
        );
    }

    function _validateHostingNodes(uint72[] calldata hostingNodes) internal pure {
        uint72 prev = 0;
        for (uint256 i; i < hostingNodes.length; i++) {
            uint72 current = hostingNodes[i];
            if (current == 0) {
                revert KnowledgeAssetsLib.InvalidContextGraphConfig("zero hosting node id");
            }
            if (current <= prev) {
                revert KnowledgeAssetsLib.InvalidContextGraphConfig("hosting nodes unsorted or duplicate");
            }
            prev = current;
        }
    }

    // -----------------------------------------------------------------------
    // KC <-> CG registration (Phase 8 publish flow + Phase 10 sampling)
    // -----------------------------------------------------------------------

    /**
     * @notice Bind a Knowledge Collection to a Context Graph.
     * @dev Records both the reverse lookup (`kcToContextGraph[kcId] = cgId`)
     *      and the forward list (`_contextGraphKCList[cgId].push(kcId)`).
     *      Reverts on double registration.
     */
    function registerKCToContextGraph(
        uint256 contextGraphId,
        uint256 kcId
    ) external onlyContracts {
        if (kcId == 0) {
            revert KnowledgeAssetsLib.InvalidContextGraphConfig("zero kcId");
        }
        if (!_contextGraphs[contextGraphId].active) {
            revert KnowledgeAssetsLib.ContextGraphNotActive(contextGraphId);
        }
        uint256 existing = kcToContextGraph[kcId];
        if (existing != 0) {
            revert KnowledgeAssetsLib.KCAlreadyRegisteredToContextGraph(kcId, existing);
        }
        kcToContextGraph[kcId] = contextGraphId;
        _contextGraphKCList[contextGraphId].push(kcId);
        emit KCRegisteredToContextGraph(contextGraphId, kcId);
    }

    /**
     * @notice Return the entire KC list for a context graph as a memory array.
     * @dev WARNING — ON-CHAIN CALLERS MUST NOT USE THIS GETTER. Gas cost is
     *      O(n) in the list length and the ABI decode copies the full array
     *      into memory. Phase 10 random sampling and any other on-chain
     *      consumer MUST use `getContextGraphKCAt(cgId, index)` together
     *      with `getContextGraphKCCount(cgId)` to fetch a single element at
     *      a bounded cost. This full-array getter is retained for off-chain
     *      indexers (eth_call) where the gas cost is not charged.
     */
    function getContextGraphKCList(
        uint256 contextGraphId
    ) external view returns (uint256[] memory) {
        return _contextGraphKCList[contextGraphId];
    }

    function getContextGraphKCCount(
        uint256 contextGraphId
    ) external view returns (uint256) {
        return _contextGraphKCList[contextGraphId].length;
    }

    /**
     * @notice Return a single KC id at a given index within a CG's KC list.
     * @dev O(1) indexed accessor for on-chain consumers (Phase 10 random
     *      sampling). Reverts with `InvalidContextGraphConfig("kcIndex oob")`
     *      on out-of-bounds access — empty list rejects all indices.
     */
    function getContextGraphKCAt(
        uint256 contextGraphId,
        uint256 index
    ) external view returns (uint256 kcId) {
        uint256[] storage list = _contextGraphKCList[contextGraphId];
        if (index >= list.length) {
            revert KnowledgeAssetsLib.InvalidContextGraphConfig("kcIndex oob");
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
    // Hosting node governance — full-replace
    // -----------------------------------------------------------------------

    /**
     * @notice Replace the hosting node list entirely. New list is validated
     *         (sorted, no zeros, no duplicates) and the existing quorum must
     *         still fit in the new size.
     */
    function setHostingNodes(
        uint256 contextGraphId,
        uint72[] calldata nodes
    ) external onlyContracts {
        _requireExists(contextGraphId);
        if (nodes.length == 0) {
            revert KnowledgeAssetsLib.InvalidContextGraphConfig("empty hosting nodes");
        }
        if (nodes.length > MAX_HOSTING_NODES) {
            revert KnowledgeAssetsLib.InvalidContextGraphConfig("hosting nodes cap");
        }
        if (_contextGraphs[contextGraphId].requiredSignatures > nodes.length) {
            revert KnowledgeAssetsLib.InvalidContextGraphConfig("setHostingNodes would break quorum");
        }
        _validateHostingNodes(nodes);

        // Full replace.
        delete _hostingNodes[contextGraphId];
        uint72[] storage stored = _hostingNodes[contextGraphId];
        for (uint256 i; i < nodes.length; i++) {
            stored.push(nodes[i]);
        }

        emit HostingNodesSet(contextGraphId, nodes);
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
    // Quorum
    // -----------------------------------------------------------------------

    function updateQuorum(
        uint256 contextGraphId,
        uint8 requiredSignatures
    ) external onlyContracts {
        _requireExists(contextGraphId);
        uint256 hostCount = _hostingNodes[contextGraphId].length;
        if (requiredSignatures == 0 || requiredSignatures > hostCount) {
            revert KnowledgeAssetsLib.InvalidContextGraphConfig("invalid M/N threshold");
        }
        _contextGraphs[contextGraphId].requiredSignatures = requiredSignatures;
        emit QuorumUpdated(contextGraphId, requiredSignatures);
    }

    // -----------------------------------------------------------------------
    // Read APIs
    // -----------------------------------------------------------------------

    function getContextGraph(
        uint256 contextGraphId
    ) external view returns (
        address owner_,
        uint72[] memory hostingNodes,
        address[] memory participantAgents,
        uint8 requiredSignatures,
        uint256 metadataBatchId,
        bool active,
        uint256 createdAt,
        uint8 publishPolicy,
        address publishAuthority,
        uint256 publishAuthorityAccountId
    ) {
        _requireExists(contextGraphId);
        KnowledgeAssetsLib.ContextGraph storage cg = _contextGraphs[contextGraphId];
        return (
            ownerOf(contextGraphId),
            _hostingNodes[contextGraphId],
            _participantAgents[contextGraphId],
            cg.requiredSignatures,
            cg.metadataBatchId,
            cg.active,
            cg.createdAt,
            cg.publishPolicy,
            cg.publishAuthority,
            _publishAuthorityAccountId[contextGraphId]
        );
    }

    function getContextGraphRequiredSignatures(
        uint256 contextGraphId
    ) external view returns (uint8) {
        return _contextGraphs[contextGraphId].requiredSignatures;
    }

    function getHostingNodes(
        uint256 contextGraphId
    ) external view returns (uint72[] memory) {
        return _hostingNodes[contextGraphId];
    }

    function getParticipantAgents(
        uint256 contextGraphId
    ) external view returns (address[] memory) {
        return _participantAgents[contextGraphId];
    }

    function isHostingNode(
        uint256 contextGraphId,
        uint72 identityId
    ) external view returns (bool) {
        uint72[] storage nodes = _hostingNodes[contextGraphId];
        for (uint256 i; i < nodes.length; i++) {
            if (nodes[i] == identityId) return true;
        }
        return false;
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

    function getPublishAuthorityAccountId(
        uint256 contextGraphId
    ) external view returns (uint256) {
        return _publishAuthorityAccountId[contextGraphId];
    }

    /**
     * @notice Convenience helper: true iff the CG is curated (publishPolicy == 0).
     */
    function getIsCurated(
        uint256 contextGraphId
    ) external view returns (bool) {
        return _contextGraphs[contextGraphId].publishPolicy == 0;
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
