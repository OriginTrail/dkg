// SPDX-License-Identifier: Apache-2.0

pragma solidity ^0.8.20;

import {ContractStatus} from "./abstract/ContractStatus.sol";
import {IInitializable} from "./interfaces/IInitializable.sol";
import {INamed} from "./interfaces/INamed.sol";
import {IVersioned} from "./interfaces/IVersioned.sol";
import {ContextGraphStorage} from "./storage/ContextGraphStorage.sol";
import {KnowledgeAssetsLib} from "./libraries/KnowledgeAssetsLib.sol";

/**
 * @title ContextGraphs
 * @notice Stateless logic facade for Context Graph operations. All state lives in
 *         ContextGraphStorage (ERC-721 registry). This contract is replaceable via Hub.
 *
 * @dev V10 Phase 7 Task 1 (interim): the legacy `addBatchToContextGraph`
 *      attestation/inclusion-proof path has been REMOVED (closes audit H2),
 *      and the participant model is split into hosting nodes (uint72) and
 *      participant agents (address). This file is the *minimal* facade kept
 *      compiling under the new storage shape; Phase 7 Task 2 will rewrite the
 *      full curator-aware logic (3-curator-type publish gating, NFT-owner
 *      governance modifiers, etc.).
 */
contract ContextGraphs is INamed, IVersioned, ContractStatus, IInitializable {
    string private constant _NAME = "ContextGraphs";
    string private constant _VERSION = "1.0.0";

    ContextGraphStorage public contextGraphStorage;

    constructor(address hubAddress) ContractStatus(hubAddress) {}

    function initialize() public onlyHub {
        contextGraphStorage = ContextGraphStorage(
            hub.getAssetStorageAddress("ContextGraphStorage")
        );
    }

    function name() public pure virtual returns (string memory) {
        return _NAME;
    }

    function version() external pure virtual returns (string memory) {
        return _VERSION;
    }

    // --- Creation ---

    /**
     * @notice Create a new context graph. Mints an ERC-721 to msg.sender.
     * @param hostingNodes              Sorted ascending node identity IDs (storage attestation set)
     * @param participantAgents         EOA allow-list (no zeros, no dups)
     * @param requiredSignatures        M-of-N quorum (≤ hostingNodes.length)
     * @param metadataBatchId           Batch ID describing the CG metadata (0 if none)
     * @param publishPolicy             0 = curated, 1 = open
     * @param publishAuthority          Curator address (required when curated; ignored when open)
     * @param publishAuthorityAccountId Non-zero -> PCA curator type. Requires curated. Ignored when open.
     * @return contextGraphId           Newly assigned context graph ID (= ERC-721 token ID)
     */
    function createContextGraph(
        uint72[] calldata hostingNodes,
        address[] calldata participantAgents,
        uint8 requiredSignatures,
        uint256 metadataBatchId,
        uint8 publishPolicy,
        address publishAuthority,
        uint256 publishAuthorityAccountId
    ) external returns (uint256 contextGraphId) {
        // Storage validates sorting/dedup/zero-rejection, but a friendly
        // default for curated CGs: if caller passes zero authority and the
        // policy is curated, use msg.sender.
        address authority = publishAuthority;
        if (publishPolicy == 0 && authority == address(0)) {
            authority = msg.sender;
        }

        contextGraphId = contextGraphStorage.createContextGraph(
            msg.sender,
            hostingNodes,
            participantAgents,
            requiredSignatures,
            metadataBatchId,
            publishPolicy,
            authority,
            publishAuthorityAccountId
        );
    }

    // --- Governance (token-holder gated) ---

    modifier onlyContextGraphOwner(uint256 contextGraphId) {
        if (contextGraphStorage.getContextGraphOwner(contextGraphId) != msg.sender) {
            revert KnowledgeAssetsLib.NotContextGraphOwner(contextGraphId, msg.sender);
        }
        _;
    }

    function updatePublishPolicy(
        uint256 contextGraphId,
        uint8 publishPolicy,
        address publishAuthority,
        uint256 publishAuthorityAccountId
    ) external onlyContextGraphOwner(contextGraphId) {
        contextGraphStorage.updatePublishPolicy(
            contextGraphId,
            publishPolicy,
            publishAuthority,
            publishAuthorityAccountId
        );
    }

    function updatePublishAuthority(
        uint256 contextGraphId,
        address newAuthority,
        uint256 newAuthorityAccountId
    ) external onlyContextGraphOwner(contextGraphId) {
        contextGraphStorage.updatePublishAuthority(
            contextGraphId,
            newAuthority,
            newAuthorityAccountId
        );
    }

    function setHostingNodes(
        uint256 contextGraphId,
        uint72[] calldata nodes
    ) external onlyContextGraphOwner(contextGraphId) {
        contextGraphStorage.setHostingNodes(contextGraphId, nodes);
    }

    function addParticipantAgent(
        uint256 contextGraphId,
        address agent
    ) external onlyContextGraphOwner(contextGraphId) {
        contextGraphStorage.addParticipantAgent(contextGraphId, agent);
    }

    function removeParticipantAgent(
        uint256 contextGraphId,
        address agent
    ) external onlyContextGraphOwner(contextGraphId) {
        contextGraphStorage.removeParticipantAgent(contextGraphId, agent);
    }

    function updateQuorum(
        uint256 contextGraphId,
        uint8 requiredSignatures
    ) external onlyContextGraphOwner(contextGraphId) {
        contextGraphStorage.updateQuorum(contextGraphId, requiredSignatures);
    }

    // --- Publish authorization ---

    /**
     * @notice Check whether `publisher` is authorized to publish to a context graph.
     *
     * @dev Phase 7 Task 1 keeps this minimal: open policy is universal,
     *      curated policy gates on a direct address match against
     *      `publishAuthority`. The 3-curator-type logic (Safe ERC-1271 check
     *      + PCA agent resolution via DKGPublishingConvictionNFT) is added in
     *      Task 2 — KAV10 callsite (line 188) keeps the same external
     *      signature `(uint256, address)` so it continues to compile.
     */
    function isAuthorizedPublisher(
        uint256 contextGraphId,
        address publisher
    ) external view returns (bool authorized) {
        uint256 latestId = contextGraphStorage.getLatestContextGraphId();
        if (contextGraphId == 0 || contextGraphId > latestId) return false;
        if (!contextGraphStorage.isContextGraphActive(contextGraphId)) return false;
        (uint8 policy, address authority) = contextGraphStorage.getPublishPolicy(contextGraphId);
        if (policy == 1) return true; // open
        return publisher == authority;
    }
}
