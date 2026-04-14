// SPDX-License-Identifier: Apache-2.0

pragma solidity ^0.8.20;

import {ContractStatus} from "./abstract/ContractStatus.sol";
import {IDKGPublishingConvictionNFT} from "./interfaces/IDKGPublishingConvictionNFT.sol";
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
 * @dev V10 Phase 7 Task 2: the legacy `addBatchToContextGraph` attestation /
 *      inclusion-proof path is REMOVED (closes audit H2). Participants are
 *      split into hosting nodes (uint72 identity IDs — quorum attesters) and
 *      participant agents (EOA allow-list used for curated / PCA flows).
 *
 *      Publish authorization supports the three curator types encoded in
 *      ContextGraphStorage (see decision #22):
 *
 *        1. EOA    — publishAuthority = wallet, accountId = 0
 *                    Read path: direct address match against stored authority.
 *        2. Safe   — publishAuthority = multisig contract, accountId = 0
 *                    (Safe executes txs as msg.sender, so address equality
 *                    works transparently; ERC-1271 is not required here)
 *        3. PCA    — accountId = DKGPublishingConvictionNFT account id;
 *                    `publishAuthority` is a CREATE-TIME SNAPSHOT only.
 *                    Read path LIVE-RESOLVES `ownerOf(accountId)` and
 *                    accepts that owner or any registered agent of the
 *                    same account. The stored snapshot is IGNORED at read
 *                    time because it goes stale the moment the PCA NFT
 *                    transfers. Governance mutators (participant-agent
 *                    allow-list) similarly live-resolve via
 *                    `_isOwnerOrAuthority`, and agents are NOT granted
 *                    governance rights — only the NFT holder is.
 *                    (Closes Codex HIGH: PCA auth drift on NFT transfer.)
 *
 *      The NFT reference is resolved from the Hub on every authorization
 *      check so that a Phase 6 deployment made *after* the Phase 7 facade
 *      starts working without a facade redeployment.
 *
 *      N17 note: KAV10's current callsite still passes the recovered node
 *      signer wallet into `isAuthorizedPublisher`. That's a Phase 8 fix at
 *      the caller — this facade is responsible for the logic being correct
 *      when a correct principal is supplied.
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

        // Coherence gate: when a PCA accountId is supplied, the claimed
        // authority MUST equal the current owner of the NFT at that accountId.
        // See _validatePCACoherence for rationale (closes "silent broadening"
        // authorization vector where a mismatched pair stacks EOA + PCA
        // curators on the same CG).
        _validatePCACoherence(authority, publishAuthorityAccountId);

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

    /**
     * @notice Allow the CG NFT holder OR the configured curator (EOA/Safe
     *         direct address, or the LIVE PCA NFT owner) to mutate the
     *         participant-agent allow-list.
     *
     * @dev For open-policy CGs `publishAuthority` is `address(0)` and the
     *      stored accountId is 0, so only the owner branch can ever pass —
     *      the authority comparison is dead code in that case. This matches
     *      the design: open CGs don't have curators, and agent allow-lists
     *      only matter for curated flows.
     *
     *      In PCA curator mode (`publishAuthorityAccountId != 0`), the stored
     *      `publishAuthority` is a write-time snapshot that goes STALE when
     *      the PCA NFT transfers. We therefore live-resolve the current PCA
     *      NFT owner via `IDKGPublishingConvictionNFT.ownerOf(accountId)`
     *      instead of trusting the stored snapshot. This closes the Codex
     *      HIGH "PCA auth drift on NFT transfer" finding, where the old PCA
     *      owner would otherwise retain governance rights on the CG after
     *      transferring the PCA.
     *
     *      PCA REGISTERED AGENTS are NOT granted governance rights through
     *      this modifier — agents can publish on behalf of the PCA owner
     *      (see `isAuthorizedPublisher`), but only the PCA NFT holder
     *      themselves can mutate the CG's participant-agent allow-list.
     *      Governance lives with the account, not with its operational
     *      wallets.
     */
    modifier onlyContextGraphOwnerOrAuthority(uint256 contextGraphId) {
        if (!_isOwnerOrAuthority(contextGraphId, msg.sender)) {
            revert KnowledgeAssetsLib.NotContextGraphOwnerOrAuthority(contextGraphId, msg.sender);
        }
        _;
    }

    /**
     * @dev Single source of truth for owner-or-authority governance checks.
     *      Extracted from the modifier so the same branching logic can be
     *      reused by future governance mutators without duplicating the
     *      PCA live-resolve dance.
     *
     *      Returns true when any of the following is true:
     *        1. `caller` is the current CG NFT token holder.
     *        2. Curator mode is EOA/Safe (accountId == 0) AND `caller` is the
     *           stored static authority.
     *        3. Curator mode is PCA (accountId != 0) AND `caller` is the
     *           LIVE current owner of the PCA NFT at `accountId`. The stored
     *           `publishAuthority` is ignored in PCA mode — it's a
     *           create-time snapshot that goes stale on PCA transfer.
     *
     *      Fail-closed behavior: if the DKGPublishingConvictionNFT contract
     *      is not resolvable from the Hub, or `ownerOf(accountId)` reverts
     *      (account burned or never minted), governance defaults to the CG
     *      owner branch only.
     */
    function _isOwnerOrAuthority(
        uint256 contextGraphId,
        address caller
    ) internal view returns (bool) {
        if (contextGraphStorage.getContextGraphOwner(contextGraphId) == caller) {
            return true;
        }

        uint256 accountId = contextGraphStorage.getPublishAuthorityAccountId(contextGraphId);

        if (accountId == 0) {
            // EOA / Safe curator: static stored authority is authoritative.
            (, address authority) = contextGraphStorage.getPublishPolicy(contextGraphId);
            return caller == authority;
        }

        // PCA curator: live-resolve current NFT owner. Stored authority is
        // ignored — it's a stale-on-transfer snapshot. Agents are NOT
        // granted governance rights; only the NFT holder is.
        address nftAddr;
        try hub.getContractAddress("DKGPublishingConvictionNFT") returns (address addr) {
            nftAddr = addr;
        } catch {
            return false;
        }
        if (nftAddr == address(0)) return false;

        try IDKGPublishingConvictionNFT(nftAddr).ownerOf(accountId) returns (address currentOwner) {
            return caller == currentOwner;
        } catch {
            return false;
        }
    }

    function updatePublishPolicy(
        uint256 contextGraphId,
        uint8 publishPolicy,
        address publishAuthority,
        uint256 publishAuthorityAccountId
    ) external onlyContextGraphOwner(contextGraphId) {
        // Coherence gate (see _validatePCACoherence): if the new config
        // switches to PCA mode, the authority must own the target NFT.
        _validatePCACoherence(publishAuthority, publishAuthorityAccountId);

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
        // Coherence gate (see _validatePCACoherence): if the rotated
        // authority carries a non-zero accountId, the new authority must
        // own the target NFT.
        _validatePCACoherence(newAuthority, newAuthorityAccountId);

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
    ) external onlyContextGraphOwnerOrAuthority(contextGraphId) {
        contextGraphStorage.addParticipantAgent(contextGraphId, agent);
    }

    function removeParticipantAgent(
        uint256 contextGraphId,
        address agent
    ) external onlyContextGraphOwnerOrAuthority(contextGraphId) {
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
     * @dev Implements the 3-curator-type model per decision #22:
     *
     *      - Open CGs (publishPolicy == 1) allow any non-zero principal.
     *      - Curated + EOA curator (accountId == 0): direct address equality
     *        against the STORED `publishAuthority`. The storage layer auto-
     *        rotates this field when the CG NFT transfers, so it is always
     *        live for EOA/Safe mode.
     *      - Curated + Safe multisig (accountId == 0): same direct address
     *        equality. A Gnosis Safe IS `msg.sender` when it executes a
     *        transaction, so any call made on behalf of the Safe arrives
     *        here with `publisher == safeAddress`. No ERC-1271 signature
     *        check is required at this layer.
     *      - Curated + PCA (accountId != 0): the stored `publishAuthority`
     *        is a CREATE-TIME SNAPSHOT that goes STALE the moment the PCA
     *        NFT transfers. The stored snapshot is therefore IGNORED for
     *        authorization. Instead we LIVE-RESOLVE the current PCA NFT
     *        owner via `IDKGPublishingConvictionNFT.ownerOf(accountId)` and
     *        accept either (a) that live owner directly or (b) a registered
     *        agent whose `agentToAccountId(publisher) == accountId`. Both
     *        mappings on the NFT contract are cleared by the transfer hook,
     *        so stale agent entries automatically stop authorizing.
     *
     *      Branch order is IMPORTANT. Because the EOA/Safe branch matches on
     *      the stored authority snapshot, it MUST NOT run in PCA mode — an
     *      unconditional direct-equality check before the accountId branch
     *      would silently authorize a stale ex-owner. (Closes Codex HIGH
     *      "PCA auth drift on NFT transfer": Alice creates a CG in PCA mode,
     *      transfers the NFT to Bob, and the stored authority still reads
     *      Alice. The pre-fix code returned true for Alice; the fix ignores
     *      the snapshot in PCA mode and live-resolves ownerOf(accountId)
     *      which now returns Bob.)
     *
     *      The DKGPublishingConvictionNFT reference is resolved on every call
     *      via a `try/catch` on `hub.getContractAddress("DKGPublishingConvictionNFT")`.
     *      Hub's `getContractAddress` reverts with `ContractDoesNotExist` when
     *      the contract is not registered (see UnorderedNamedContractDynamicSet.get),
     *      so the catch branch handles gracefully-degraded environments where
     *      Phase 6 has not been deployed yet. Using a fresh lookup each call
     *      (rather than caching on `initialize()`) lets the PCA branch start
     *      working without a facade redeployment once Phase 6 lands. Any
     *      resolution failure in PCA mode yields `false` (fail-closed read
     *      path — unlike the write path, which reverts).
     *
     *      View-only — no state mutations.
     *
     *      N17 note: the external signature intentionally matches the V9
     *      callsite at KAV10.sol:188 (`(uint256, address)`). The bug that
     *      KAV10 passes `publisherWallet` (the recovered node signer)
     *      instead of the paying principal is a Phase 8 caller-side fix.
     */
    function isAuthorizedPublisher(
        uint256 contextGraphId,
        address publisher
    ) external view returns (bool) {
        // 0. Bounds + liveness.
        uint256 latestId = contextGraphStorage.getLatestContextGraphId();
        if (contextGraphId == 0 || contextGraphId > latestId) return false;
        if (!contextGraphStorage.isContextGraphActive(contextGraphId)) return false;

        // 1. Open CGs authorize any non-zero principal.
        (uint8 policy, address storedAuthority) = contextGraphStorage.getPublishPolicy(contextGraphId);
        if (policy == 1) {
            return publisher != address(0);
        }

        // 2. Curated: never authorize the zero address.
        if (publisher == address(0)) return false;

        // 3. Determine curator type from accountId FIRST — we must not run
        //    the direct-equality branch in PCA mode because the stored
        //    authority is a stale-on-transfer snapshot in that case.
        uint256 authorityAccountId = contextGraphStorage.getPublishAuthorityAccountId(contextGraphId);

        if (authorityAccountId == 0) {
            // 3a. EOA / Safe curator: direct address match against the
            //     stored authority. Storage auto-rotates this field on CG
            //     NFT transfer, so it is always live for this mode.
            return publisher == storedAuthority;
        }

        // 3b. PCA curator: IGNORE the stored authority snapshot entirely.
        //     Live-resolve the NFT's current owner and accept it or any
        //     registered agent of the same account. A missing / burned NFT
        //     yields `false` (fail-closed read path).
        address nftAddr;
        try hub.getContractAddress("DKGPublishingConvictionNFT") returns (address addr) {
            nftAddr = addr;
        } catch {
            return false;
        }
        if (nftAddr == address(0)) return false;

        // Live owner match — supersedes the stale stored authority.
        try IDKGPublishingConvictionNFT(nftAddr).ownerOf(authorityAccountId) returns (address currentOwner) {
            if (publisher == currentOwner) return true;
        } catch {
            // Account burned or never existed — refuse gracefully.
            return false;
        }

        // Registered agent of the authorized account. `agentToAccountId`
        // is cleared by the NFT's `_update` transfer hook, so stale agent
        // entries automatically stop authorizing post-transfer.
        uint256 publisherAccountId = IDKGPublishingConvictionNFT(nftAddr).agentToAccountId(publisher);
        return publisherAccountId != 0 && publisherAccountId == authorityAccountId;
    }

    // --- KC registration (Phase 8 publish flow entry point) ---

    /**
     * @notice Bind a Knowledge Collection to a Context Graph via the facade.
     * @dev Thin wrapper over `ContextGraphStorage.registerKCToContextGraph`.
     *      Exists so Phase 8's `KnowledgeAssetsV10.publish` / `publishDirect`
     *      can call the facade (stable interface) instead of reaching into
     *      storage directly. `onlyContracts`-gated at the facade layer so the
     *      entry point has one canonical caller — the KA contract — and no
     *      direct EOA call path.
     */
    function registerKnowledgeCollection(
        uint256 contextGraphId,
        uint256 kcId
    ) external onlyContracts {
        contextGraphStorage.registerKCToContextGraph(contextGraphId, kcId);
    }

    // --- Internal: PCA coherence validation ---

    /**
     * @notice WRITE-TIME sanity check that a claimed (authority, accountId)
     *         pair is initially coherent for a PCA-mode CG.
     *
     * @dev IMPORTANT: this is a CREATE-TIME SANITY GATE, NOT a drift-
     *      prevention guarantee. The stored `publishAuthority` is a
     *      snapshot that this check validates ONCE at write time so the
     *      initial config is internally consistent — "you claimed authority
     *      X owns account Y; we verified X == ownerOf(Y) right now."
     *
     *      Drift AFTER write (e.g. Alice creates a CG in PCA mode, then
     *      transfers the PCA NFT to Bob) is handled by LIVE RESOLVE at
     *      read time in `isAuthorizedPublisher` and `_isOwnerOrAuthority`,
     *      which IGNORE the stored snapshot in PCA mode and dereference
     *      `ownerOf(accountId)` on every call. The stored snapshot is
     *      retained only as a write-time audit trail and is NOT used for
     *      authorization. (Codex HIGH: PCA auth drift on NFT transfer.)
     *
     *      Historical rationale (still valid): the pre-live-resolve design
     *      ORed an EOA/Safe direct-authority branch with a PCA-agent
     *      branch, so a mismatched pair — e.g. `publishAuthority = Alice`,
     *      `accountId = 42` where account 42 is owned by Bob — would have
     *      silently granted TWO curators to the same CG: Alice via the EOA
     *      branch, Bob's agents via the PCA branch. The live-resolve fix
     *      collapses the EOA branch out of PCA mode entirely, but the
     *      write-time coherence check is still valuable because it catches
     *      misconfigurations where the caller passes an authority that
     *      does not match the NFT they claim. Without it, Alice could
     *      create a CG with `(authority = Alice, accountId = Bob's)` and
     *      the initial authorization surface would silently be "whoever
     *      owns Bob's NFT now" rather than the more obvious "Alice". A
     *      clear write-time revert keeps storage honest.
     *
     *      Fail-closed write-path behavior (stricter than read-path):
     *        - If the NFT contract is not resolvable via Hub (not registered,
     *          zero address, or Hub reverts), revert with `PCANotResolvable`.
     *          Unlike `isAuthorizedPublisher`, which gracefully degrades on a
     *          missing NFT, a write path that fails to resolve the NFT must
     *          revert — otherwise it lets a PCA config land without validation.
     *          Callers who want a non-PCA CG must pass accountId == 0 and use
     *          EOA/Safe mode instead.
     *        - If `ownerOf(accountId)` reverts (OZ's ERC721NonexistentToken),
     *          revert with `PCAAccountDoesNotExist`.
     *        - If the ownership check succeeds but the owner doesn't match the
     *          claimed authority, revert with `PCAAuthorityMismatch`.
     *
     *      `accountId == 0` (non-PCA / EOA / Safe / open) skips the check
     *      entirely — EOA/Safe modes use the stored authority verbatim at
     *      read time and there is no PCA lookup to reconcile.
     *
     *      `authority == address(0)` also skips: it represents either the
     *      open-policy state (where non-zero accountId is structurally
     *      rejected by storage with a clear "open policy" message — we
     *      don't want to shadow that with a PCA-specific error) or a
     *      malformed curated state that storage's own zero-authority
     *      guard will reject downstream. Either way, deferring to storage
     *      gives the caller the clearer diagnostic.
     */
    function _validatePCACoherence(
        address authority,
        uint256 accountId
    ) internal view {
        if (accountId == 0 || authority == address(0)) return;

        // Fresh Hub lookup each call (same pattern as isAuthorizedPublisher).
        // Write paths fail closed: if we can't resolve the NFT, we refuse to
        // store an un-validatable PCA config.
        address nftAddr;
        try hub.getContractAddress("DKGPublishingConvictionNFT") returns (address addr) {
            nftAddr = addr;
        } catch {
            revert KnowledgeAssetsLib.PCANotResolvable(accountId);
        }
        if (nftAddr == address(0)) {
            revert KnowledgeAssetsLib.PCANotResolvable(accountId);
        }

        // ownerOf reverts for never-minted tokens (OZ ERC721NonexistentToken).
        // Wrap in try/catch so we can distinguish "no such account" from
        // a live ownership mismatch.
        address actualOwner;
        try IDKGPublishingConvictionNFT(nftAddr).ownerOf(accountId) returns (address owner_) {
            actualOwner = owner_;
        } catch {
            revert KnowledgeAssetsLib.PCAAccountDoesNotExist(accountId);
        }

        if (actualOwner != authority) {
            revert KnowledgeAssetsLib.PCAAuthorityMismatch(accountId, authority, actualOwner);
        }
    }
}
