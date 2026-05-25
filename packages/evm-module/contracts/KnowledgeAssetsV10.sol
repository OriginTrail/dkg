// SPDX-License-Identifier: Apache-2.0

pragma solidity ^0.8.20;

import {AskStorage} from "./storage/AskStorage.sol";
import {EpochStorage} from "./storage/EpochStorage.sol";
import {Chronos} from "./storage/Chronos.sol";
import {KnowledgeCollectionStorage} from "./storage/KnowledgeCollectionStorage.sol";
import {IdentityStorage} from "./storage/IdentityStorage.sol";
import {ParametersStorage} from "./storage/ParametersStorage.sol";
import {ConvictionStakingStorage} from "./storage/ConvictionStakingStorage.sol";
import {ShardingTableStorage} from "./storage/ShardingTableStorage.sol";
import {ContextGraphs} from "./ContextGraphs.sol";
import {ContextGraphStorage} from "./storage/ContextGraphStorage.sol";
import {ContextGraphValueStorage} from "./storage/ContextGraphValueStorage.sol";
import {KnowledgeAssetsLib} from "./libraries/KnowledgeAssetsLib.sol";
import {KnowledgeCollectionLib} from "./libraries/KnowledgeCollectionLib.sol";
import {TokenLib} from "./libraries/TokenLib.sol";
import {IdentityLib} from "./libraries/IdentityLib.sol";
import {INamed} from "./interfaces/INamed.sol";
import {IVersioned} from "./interfaces/IVersioned.sol";
import {IInitializable} from "./interfaces/IInitializable.sol";
import {IDKGPublishingConvictionNFT} from "./interfaces/IDKGPublishingConvictionNFT.sol";
import {ContractStatus} from "./abstract/ContractStatus.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {ECDSA} from "solady/src/utils/ECDSA.sol";

/**
 * @title KnowledgeAssetsV10
 * @notice V10 publish + update contract — wires together:
 *   - ContextGraphs facade (3 curator types, atomic KC↔CG bind)
 *   - ContextGraphStorage (direct read for `kcToContextGraph` on update)
 *   - ContextGraphValueStorage (per-CG value ledger for value-weighted challenges)
 *   - DKGPublishingConvictionNFT (publisher discount NFT; auto-resolves agent→account)
 *   - KnowledgeCollectionStorage (V8-compatible data model)
 *
 * Two public entry points (RFC-001 unified design):
 *   - `publish` — single entrypoint with two-branch cost coverage.
 *                 Auto-detects PCA discount via
 *                 `DKGPublishingConvictionNFT.agentToAccountId(msg.sender)`:
 *                 non-zero ⇒ discount path (NFT covers cost; TRAC was
 *                 already distributed at `createAccount` time, so the
 *                 entrypoint MUST NOT call `_distributeTokens` here);
 *                 zero ⇒ direct-spend path (`transferFrom(msg.sender, CSS,
 *                 fullCost)` + epoch-range distribution).
 *   - `update`  — same two-branch shape applied to delta payments. The
 *                 prior `publishDirect` / `updateDirect` entrypoints are
 *                 removed (no aliases retained — RFC-001 §3.7).
 *
 * `_executePublishCore` runs: author attestation verification → ACK
 * signature verification → CG existence + auth → KCS create → atomic CG
 * value diff → per-node produced-value bookkeeping. No TRAC movement
 * happens in the core — the public entry branches on cost coverage.
 *
 * ACK digest prefix (H5 closure): `block.chainid || address(this)` pins a
 * signed ACK to this contract on this chain. Replay across chains / forks
 * / contract redeployments is rejected at signature verification.
 *
 * Author attestation (RFC-001 §3.1): every publish carries a verified author
 * identity. The attestation is an EIP-712 typed-data signature over
 * `(contextGraphId, merkleRoot, authorAddress, schemeVersion)` under the
 * V10.1 domain. Verification dispatches at runtime on
 * `authorAddress.code.length` — EOAs use `ECDSA.tryRecover + equality`,
 * smart-contract wallets use `IERC1271.isValidSignature`. The
 * publisher-node signature surface is removed; `publisherNodeIdentityId`
 * is now a self-claimed attribution field (RFC-001 §3.6).
 *
 * Authorization:
 *   - publish: N17 closure — `isAuthorizedPublisher(msg.sender)` via facade.
 *   - update:  policy-branch gate in `_executeUpdateCore`. Curated CGs
 *              (`publishPolicy == 0`) delegate to
 *              `isAuthorizedPublisher(cgId, msg.sender)` via the facade so
 *              EOA / Safe curators and PCA agents inherit update rights
 *              automatically. Open CGs (`publishPolicy == 1`) have no curator
 *              authority to delegate to, so update auth pins to the ORIGINAL
 *              publisher (`merkleRoots[0].publisher`) — the paying principal
 *              recorded at publish time. Replaces the initial V10 ERC-1155
 *              `balanceOf(msg.sender, kcRange) > 0` gate (which was hijackable
 *              via ERC-1155Delta token transfers) and the V9
 *              `latestPublisher == msg.sender` gate (which gated on
 *              node-operator key, not the paying principal).
 *
 * Byte-size ceiling (decision #4 closure): updates may GROW `newByteSize`
 * beyond the original value, as long as the new `tokenAmount` covers the new
 * size × remaining lifetime at the current stake-weighted ask. The
 * `originalByteSize` ceiling mapping is REMOVED; byte-size audit provenance
 * lives in the KCS `KnowledgeCollectionByteSizeUpdated` event history.
 */
contract KnowledgeAssetsV10 is INamed, IVersioned, ContractStatus, IInitializable {
    string private constant _NAME = "KnowledgeAssetsV10";
    string private constant _VERSION = "10.1.0";

    // --- V10 publish input (grouped to bypass the 16-arg stack limit) ---

    /**
     * @notice V10.1 publish params (RFC-001).
     *
     * **Strictly breaking** vs V10.0: the per-publish publisher signature
     * (`publisherNodeR`, `publisherNodeVS`) is removed; four required author
     * attestation fields (`authorAddress`, `authorR`, `authorVS`,
     * `authorSchemeVersion`) are added. `publisherNodeIdentityId` keeps the
     * same wire position but its semantics flip: it is now a self-claimed
     * attribution target — "the core that gets publishing-factor credit
     * for this publish" — with no per-publish signature gate.
     *
     * The author attestation is mandatory: every publish post-upgrade must
     * carry a verified author. `authorAddress == 0` reverts with
     * `"Author required"`. There is no zero-default opt-out.
     */
    struct PublishParams {
        string publishOperationId;
        uint256 contextGraphId;
        bytes32 merkleRoot;
        uint256 knowledgeAssetsAmount;
        uint88 byteSize;
        uint40 epochs;
        uint96 tokenAmount;
        bool isImmutable;
        /// @notice V10 flat-KC Merkle leaf count (sorted + deduped), must match
        ///         off-chain `V10MerkleTree` built from the same publish payload.
        uint32 merkleLeafCount;
        // ── RFC-39 Phase A.5: curated-CG ciphertext commitment (OPTIONAL) ──
        /// @notice RFC-39: Merkle root over `[keccak256(ct_i)]` in
        ///         `swmMessageIndex` order for this publish batch's ciphertext
        ///         chunks (one chunk per SWM message — LU-11 Option B).
        ///         MUST be `bytes32(0)` for public CGs (rejected with
        ///         `PublicCGCannotHaveCiphertextCommitment`). For curated CGs,
        ///         MAY be `bytes32(0)` (legacy/transitional path — picker
        ///         skips that KC in the curated draw) OR non-zero AND paired
        ///         with a non-zero `ciphertextChunkCount` (full commitment —
        ///         KC participates in the curated draw). Partial commitments
        ///         (one zero, one non-zero) revert with
        ///         `IncompleteCiphertextCommitment`.
        bytes32 ciphertextChunksRoot;
        /// @notice RFC-39: number of ciphertext chunks in this batch (==
        ///         curated leaf count for random sampling). Same zero-or-paired
        ///         constraints as `ciphertextChunksRoot`.
        uint32 ciphertextChunkCount;
        /// @notice Self-claimed attribution: the core that gets publishing-factor
        ///         credit. `0` means "no attribution claimed". No on-chain
        ///         consent gate — see RFC-001 §3.6.
        uint72 publisherNodeIdentityId;
        // ── RFC-001: author attestation (REQUIRED — every publish post-upgrade) ──
        /// @notice Author identity. EOA or smart-contract wallet (EIP-1271).
        ///         `0` reverts.
        address authorAddress;
        bytes32 authorR;
        bytes32 authorVS;
        uint8   authorSchemeVersion;
        // ── ACK quorum (unchanged) ──
        uint72[] identityIds;
        bytes32[] r;
        bytes32[] vs;
    }

    /**
     * @notice V10 update input (grouped to bypass the 16-arg stack limit).
     *
     * `newTokenAmount` is the NEW TOTAL `tokenAmount` for the KC (not a delta).
     * KAV10 computes `delta = newTokenAmount - currentTokenAmount` internally
     * and charges the caller only for the delta via the conviction or direct
     * path. Metadata-only updates (`delta == 0`) are free but still require
     * a fresh ACK quorum.
     *
     * RFC-001: per-update publisher signature (`publisherNodeR/VS`) is removed.
     * `publisherNodeIdentityId` is now a self-claimed attribution field — same
     * semantics as in `PublishParams`. RFC-001 v1.1 will add the author
     * attestation fields here too; for now the update path does not verify
     * authorship on chain.
     */
    struct UpdateParams {
        uint256 id;
        string updateOperationId;
        bytes32 newMerkleRoot;
        uint88 newByteSize;
        uint96 newTokenAmount;
        uint32 newMerkleLeafCount;
        uint256 mintKnowledgeAssetsAmount;
        uint256[] knowledgeAssetsToBurn;
        uint72 publisherNodeIdentityId;
        uint72[] identityIds;
        bytes32[] r;
        bytes32[] vs;
        // Codex PR #630 R1 #2 — RFC-39 Phase A.5 commitment refresh.
        // Update must rotate the ciphertext commitment in lockstep
        // with the new merkle root; without these fields curated KCs
        // left their commitment frozen to the initial publish and the
        // random-sampling challenge surface would point at stale
        // ciphertext after the first update. Same zero-or-paired
        // contract as `PublishParams` (zero on metadata-only or
        // public-CG updates; both non-zero on curated commitment
        // rotation). Appended at the END of the struct so the
        // positional ABI for pre-existing 12-field callers stays
        // intact — they encode the same prefix and ABI decoder
        // zero-fills the trailing pair (Codex PR #630 R1 #1 on
        // `PublishParams`, applied prospectively here).
        bytes32 newCiphertextChunksRoot;
        uint32 newCiphertextChunkCount;
    }

    // --- Hub-resolved dependencies ---

    AskStorage public askStorage;
    EpochStorage public epochStorage;
    KnowledgeCollectionStorage public knowledgeCollectionStorage;
    Chronos public chronos;
    IERC20 public tokenContract;
    ParametersStorage public parametersStorage;
    IdentityStorage public identityStorage;
    /// @notice v4.0.0 — TRAC vault + V10 stake reads. Replaces the prior
    ///         `stakingStorage` field; CSS is the V10 source of truth.
    ConvictionStakingStorage public convictionStakingStorage;
    /// @notice RFC-001: ACK signer eligibility now gates on sharding-table
    ///         membership rather than positive stake. Edge-owned CGs that
    ///         broadcast publishes to any active core need this — the prior
    ///         "must have V10 stake" check rejected freshly-promoted hosts
    ///         and locked edge fan-out behind the staking lifecycle.
    ShardingTableStorage public shardingTableStorage;
    ContextGraphs public contextGraphs;
    ContextGraphStorage public contextGraphStorage;
    ContextGraphValueStorage public contextGraphValueStorage;
    IDKGPublishingConvictionNFT public publishingConvictionNFT;

    // --- Errors ---

    error ZeroAddressDependency(string name);
    error ZeroContextGraphId();
    error ZeroEpochs();

    // --- RFC-39 ciphertext-commitment errors ---

    /// @dev RFC-39 Phase A.5: a public-CG publish carried a non-zero ciphertext
    ///      commitment field. Catches client bugs early (a curated-only field
    ///      leaking into a public publish would silently bloat storage and
    ///      mislead off-chain indexers about which KCs are sampleable).
    error PublicCGCannotHaveCiphertextCommitment(uint256 contextGraphId);

    /// @dev RFC-39 Phase A.5: a curated-CG publish carried a partial ciphertext
    ///      commitment (root without count, or vice versa). The two are
    ///      meaningful only as a pair — committing a root without a count
    ///      would zero-divide the picker; committing a count without a root
    ///      would verify the proof against the empty-tree zero. KCS would
    ///      reject the partial state anyway via its own `require`; KAV10's
    ///      explicit error gives the caller a more diagnostic revert.
    error IncompleteCiphertextCommitment();

    // --- RFC-001 author attestation errors ---

    /// @dev `authorAddress == 0`. Every post-upgrade publish must carry a
    ///      verified author. There is no zero-default opt-out (RFC-001 §3.1).
    error AuthorRequired();

    /// @dev `authorSchemeVersion != 1`. v1 is the only supported scheme;
    ///      future schemes (multi-sig, threshold, passkey-aggregated) bump
    ///      this and replace the `(authorR, authorVS)` pair with a `bytes`
    ///      signature field — see RFC-001 §9.6.
    error UnsupportedAuthorScheme(uint8 schemeVersion);

    /// @dev EOA branch: `ECDSA.tryRecover(digest, r, vs) != authorAddress`.
    error InvalidAuthorSignature();

    /// @dev EIP-1271 branch: smart-wallet's `isValidSignature` returned a
    ///      magic value other than `0x1626ba7e`.
    error InvalidAuthorSignature1271();

    /// @dev RFC-001 §3.2 — EIP-712 type hash for `AuthorAttestation`.
    /// `keccak256("AuthorAttestation(uint256 contextGraphId,bytes32 merkleRoot,address authorAddress,uint8 schemeVersion)")`.
    bytes32 private constant _AUTHOR_ATTESTATION_TYPEHASH =
        keccak256(
            "AuthorAttestation(uint256 contextGraphId,bytes32 merkleRoot,address authorAddress,uint8 schemeVersion)"
        );

    /// @dev EIP-712 domain typehash. `keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")`.
    bytes32 private constant _EIP712_DOMAIN_TYPEHASH =
        keccak256(
            "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
        );

    /// @dev `name` hash for the EIP-712 domain — must match the off-chain
    ///      attestation builder. Mirrors the contract `_NAME` literal; any
    ///      rename in a future upgrade is a deliberate breaking change to
    ///      the digest and must update both sites.
    bytes32 private constant _EIP712_NAME_HASH = keccak256(bytes("KnowledgeAssetsV10"));

    /// @dev `version` hash for the EIP-712 domain. Bound to the major.minor
    ///      portion of `_VERSION` ("10.1") so off-chain signers can pin the
    ///      attestation to the contract semantic version. Patch bumps do not
    ///      change this — only major.minor changes do.
    bytes32 private constant _EIP712_VERSION_HASH = keccak256(bytes("10.1"));

    /// @dev Magic value returned by EIP-1271-compliant smart wallets on a
    ///      successful signature check. `bytes4(keccak256("isValidSignature(bytes32,bytes)"))`.
    bytes4 private constant _ERC1271_MAGIC_VALUE = 0x1626ba7e;

    // --- Update-specific errors (V10 Phase 8 Task 2) ---

    /// @dev Update would reduce the KC's `tokenAmount` below its current
    ///      value. Rebates are not supported — a publisher that wants to
    ///      downsize must let the KC expire and republish. (decision #4)
    error CannotShrinkTokenAmount(uint96 currentTokenAmount, uint96 newTokenAmount);

    /// @dev Caller is attempting a paid update (`newTokenAmount >
    ///      currentTokenAmount`) but the KC has no full epoch of remaining
    ///      lifetime (`currentEpoch == endEpoch`). No distribution vehicle
    ///      exists for the extra tokens — the publisher must extend the
    ///      lifetime via `extendKnowledgeCollectionLifetime` before growing
    ///      byte size or tokenAmount in the final epoch.
    error NoRemainingLifetimeForDelta(uint256 kcId, uint40 currentEpoch, uint40 endEpoch);

    /// @dev KC has no CG binding recorded (`kcToContextGraph[kcId] == 0`).
    ///      This is a corrupt-state assertion: publish atomically binds
    ///      kcId → cgId, so a missing binding indicates a Phase 7 storage
    ///      invariant was violated. Update cannot proceed without knowing
    ///      the CG because the CG value ledger needs the target cgId.
    error MissingContextGraphBinding(uint256 kcId);

    constructor(address hubAddress) ContractStatus(hubAddress) {}

    function initialize() public onlyHub {
        askStorage = AskStorage(hub.getContractAddress("AskStorage"));
        epochStorage = EpochStorage(hub.getContractAddress("EpochStorageV8"));
        knowledgeCollectionStorage = KnowledgeCollectionStorage(
            hub.getAssetStorageAddress("KnowledgeCollectionStorage")
        );
        chronos = Chronos(hub.getContractAddress("Chronos"));
        tokenContract = IERC20(hub.getContractAddress("Token"));
        parametersStorage = ParametersStorage(hub.getContractAddress("ParametersStorage"));
        identityStorage = IdentityStorage(hub.getContractAddress("IdentityStorage"));
        convictionStakingStorage = ConvictionStakingStorage(hub.getContractAddress("ConvictionStakingStorage"));
        shardingTableStorage = ShardingTableStorage(hub.getContractAddress("ShardingTableStorage"));

        // V10 new dependencies — fail-fast. Each MUST be Hub-registered at
        // KAV10 initialize() time. The Phase 7 transitional try/catch tolerance
        // is removed: Phase 8 makes ContextGraphs + CG value + NFT mandatory.

        address cgAddr = hub.getContractAddress("ContextGraphs");
        if (cgAddr == address(0)) revert ZeroAddressDependency("ContextGraphs");
        contextGraphs = ContextGraphs(cgAddr);

        // ContextGraphStorage is resolved directly for read-only `kcToContextGraph`
        // lookups on the update path. The facade does not expose a KC→CG view
        // getter, and caching the storage here avoids a double-hop SLOAD via
        // `contextGraphs.contextGraphStorage()` on every update. Writes still
        // go through the facade (auth + atomic bind in `publish`).
        address cgsAddr = hub.getAssetStorageAddress("ContextGraphStorage");
        if (cgsAddr == address(0)) revert ZeroAddressDependency("ContextGraphStorage");
        contextGraphStorage = ContextGraphStorage(cgsAddr);

        address cgvAddr = hub.getContractAddress("ContextGraphValueStorage");
        if (cgvAddr == address(0)) revert ZeroAddressDependency("ContextGraphValueStorage");
        contextGraphValueStorage = ContextGraphValueStorage(cgvAddr);

        address nftAddr = hub.getContractAddress("DKGPublishingConvictionNFT");
        if (nftAddr == address(0)) revert ZeroAddressDependency("DKGPublishingConvictionNFT");
        publishingConvictionNFT = IDKGPublishingConvictionNFT(nftAddr);
    }

    function name() public pure virtual returns (string memory) {
        return _NAME;
    }

    function version() external pure virtual returns (string memory) {
        return _VERSION;
    }

    // ========================================================================
    // V10 Publish Entry (RFC-001: unified entrypoint)
    // ========================================================================

    /**
     * @notice Publish a knowledge collection.
     *
     * RFC-001 unifies the prior two-entrypoint design (`publish` for the
     * conviction-discounted path and `publishDirect` for full-price /
     * paymaster-sponsored) into a single `publish` with auto-detected cost
     * coverage:
     *
     * - **Discount branch** — taken when `msg.sender` is registered as an
     *   agent on a PCA whose escrow is still active AND whose
     *   `lockDurationEpochs` exactly matches `p.epochs`. The NFT contract
     *   is the funding agent on this branch: `coverPublishingCost`
     *   deducts the discounted cost from the account's current
     *   billing-window budget (or top-up buffer), distributes that cost
     *   across the published KC's epoch range via
     *   `EpochStorage.addTokensToEpochRange` (active sink), and lazily
     *   settles any elapsed billing windows by sweeping their unspent
     *   base remainder to the staker pool (passive sink). KAv10
     *   therefore MUST NOT call `_distributeTokens` here — the NFT has
     *   already accounted for staker rewards directly.
     *
     *   A stale agent registration (PCA expired) or a publish submitted
     *   with the wrong epoch count silently falls through to direct
     *   spend at full price — eligibility is a discount opt-in, never a
     *   hard gate that bricks the publisher.
     *
     * - **Direct-spend branch** — taken otherwise. Pulls TRAC from
     *   `msg.sender`'s wallet via `transferFrom` and distributes it across
     *   the epoch range via `_distributeTokens`. No paymaster sponsorship —
     *   `Paymaster.sol` is removed from the active path; sponsorship is now
     *   subsumed by the conviction-account-agent registration mechanism (a
     *   sponsoring core registers the user's wallet via `registerAgent` and
     *   the user's publishes flow through the discount branch).
     *
     * In both branches `publisherNodeIdentityId` is recorded as a self-claim
     * for publishing-factor attribution (RFC-001 §3.6); there is no
     * per-publish on-chain consent gate on the direct-spend branch.
     *
     * @param p All publish parameters (see `PublishParams` struct).
     * @return kcId Newly created knowledge collection id.
     */
    function publish(PublishParams calldata p) external returns (uint256 kcId) {
        uint40 currentEpoch;
        (currentEpoch, kcId) = _executePublishCore(p);

        // PCA branch eligibility:
        //   (1) `msg.sender` is registered as an agent on a PCA,
        //   (2) the PCA is NOT past its expiry timestamp,
        //   (3) `p.epochs == lockDurationEpochs` (the discount tier was
        //       paid up-front for a KC lifetime of exactly that many
        //       epochs; anything shorter would orphan post-KC windows
        //       against passive sweeps, anything longer would extend the
        //       active sink past the escrow runway).
        //
        // ALL three must hold to take the PCA path. If any fails, the
        // publisher falls through to direct spend at full price — a
        // stale agent registration on an expired PCA, or a publish
        // submitted with the wrong epoch count, MUST NOT brick the
        // publisher (Codex round-3 finding on PR #470). `update()`
        // has a parallel gate (with `<=` instead of `==` since update
        // legitimately passes the KC's remaining lifetime, a delta).
        uint256 convictionAccountId = publishingConvictionNFT.agentToAccountId(msg.sender);
        bool useConviction;
        if (convictionAccountId != 0) {
            (,,,, uint40 expiresAtTimestamp, uint16 lockDurationEpochs,,,) =
                publishingConvictionNFT.accounts(convictionAccountId);
            useConviction =
                block.timestamp < uint256(expiresAtTimestamp) &&
                p.epochs == uint256(lockDurationEpochs);
        }

        if (useConviction) {
            // Discount branch. The NFT auto-resolves the paying account
            // from `agentToAccountId[msg.sender]`, deducts the discounted
            // cost, distributes it across the KC's epoch range (active
            // sink), and lazily settles any elapsed billing windows
            // (passive sink). KAv10 MUST NOT call `_distributeTokens`
            // here — the NFT is the funding agent on this branch.
            publishingConvictionNFT.coverPublishingCost(
                msg.sender,
                p.tokenAmount,
                currentEpoch,
                uint40(p.epochs)
            );
        } else {
            // Direct-spend branch. `transferFrom(msg.sender, CSS, fullCost)`
            // + epoch-range distribution. The named core (if non-zero) still
            // earns publishing-factor credit through `_executePublishCore`'s
            // `addEpochProducedKnowledgeValue` write — attribution and TRAC
            // source are decoupled (RFC-001 §3.6).
            _addTokens(p.tokenAmount);
            _distributeTokens(p.tokenAmount, p.epochs, currentEpoch);
        }

        return kcId;
    }

    // ========================================================================
    // Internal: Shared publish core
    // ========================================================================

    /**
     * @notice Signature verification + auth + validation + KCS create +
     *         atomic CG bind + CG value write.
     *
     * Both `publish` and `publishDirect` run this before branching on
     * payment path. No TRAC movement happens here — the caller's path
     * handles that.
     */
    function _executePublishCore(
        PublishParams calldata p
    ) internal returns (uint40 currentEpoch, uint256 kcId) {
        // --- 1. Author attestation verification (RFC-001) ---
        //
        // Every post-upgrade publish must carry a verified author. The author
        // signature commits to (chainId, verifyingContract, contextGraphId,
        // merkleRoot, authorAddress, schemeVersion) via EIP-712, and is
        // verified either through `ECDSA.tryRecover + equality` (EOAs) or
        // through `IERC1271.isValidSignature` (smart-contract wallets,
        // including EIP-7702-delegated EOAs). Branch is selected at runtime
        // by `authorAddress.code.length`. Forged author claims revert here
        // before any state mutation.
        //
        // No `publisherNodeIdentityId` signature: the per-publish publisher
        // signature surface is gone (RFC-001 §3.6). Attribution is now a
        // self-claim; consent on the discount path is enforced by the
        // existing `DKGPublishingConvictionNFT.agentToAccountId` registration
        // (auto-detected in the `publish` entrypoint below).
        _verifyAuthorAttestation(p);

        // ACK digest. H5 chain/contract prefix mirrors the prior design.
        // Field set per PRD (V10 protocol core §9 "Publish Flow — Contract
        // Verification") and decision #25 Option B, extended with V10 flat-KC
        // Merkle metadata:
        //   (chainid, address(this), contextGraphId, merkleRoot,
        //    knowledgeAssetsAmount, byteSize, epochs, tokenAmount, merkleLeafCount)
        // The publisher node identity is NOT part of the ACK digest — it lives
        // only in the publisher digest above. ACK signers attest to the
        // publication's economic + content shape; the publishing node is a
        // separate authority verified separately. Mixing the two would break
        // off-chain spec-conformant signers.
        bytes32 ackDigest = keccak256(
            abi.encodePacked(
                block.chainid,
                address(this),
                p.contextGraphId,
                p.merkleRoot,
                p.knowledgeAssetsAmount,
                uint256(p.byteSize),
                uint256(p.epochs),
                uint256(p.tokenAmount),
                uint256(p.merkleLeafCount)
            )
        );
        _verifySignatures(p.identityIds, ECDSA.toEthSignedMessageHash(ackDigest), p.r, p.vs);

        // --- 2. CG existence + validation (revert before any state mutation) ---

        // Decision #3: contextGraphId == 0 is forbidden. No legacy path.
        if (p.contextGraphId == 0) revert ZeroContextGraphId();

        // Same-contract input validation — without this, epochs == 0 would
        // flow through `_validateTokenAmount` (which computes 0), through
        // KCS create, and only revert downstream in
        // `ContextGraphValueStorage.addCGValueForEpochRange` with
        // `ZeroLifetime`. That downstream error hides the real cause from
        // the caller. Fail fast here with a KAV10-local diagnostic.
        if (p.epochs == 0) revert ZeroEpochs();

        // RFC-39 Phase A.5: validate the curated ciphertext-commitment shape
        // BEFORE any state mutation, so a mistyped client can't half-write a
        // KC.
        //
        // Semantics:
        //   - Public CG  + any non-zero ciphertext field → revert
        //     (catches client bugs; curated-only payload leaking to public).
        //   - Curated CG + both fields zero                → no commitment
        //     persisted; picker treats the KC as "skip in curated draw"
        //     (legacy / pre-LU-11 publishes — forward-only adoption per
        //     RFC-39 §6.4, Q4).
        //   - Curated CG + both fields non-zero            → commitment
        //     persisted; KC participates in curated draw.
        //   - Curated CG + exactly one field zero          → revert
        //     (partial commitment would zero-divide the picker or verify
        //     against the empty-tree zero).
        //
        // The cached `_hasCiphertextCommitment` carries the populate decision
        // forward to the post-create persistence call below — avoids a
        // second `getIsCurated` read and the two zero-checks that already
        // gated this branch.
        bool _hasCiphertextCommitment =
            p.ciphertextChunksRoot != bytes32(0) || p.ciphertextChunkCount != 0;
        if (_hasCiphertextCommitment) {
            if (!contextGraphStorage.getIsCurated(p.contextGraphId)) {
                revert PublicCGCannotHaveCiphertextCommitment(p.contextGraphId);
            }
            if (p.ciphertextChunksRoot == bytes32(0) || p.ciphertextChunkCount == 0) {
                revert IncompleteCiphertextCommitment();
            }
        }

        // H7: SafeCast guards the uint96 cast in _validateTokenAmount.
        _validateTokenAmount(p.byteSize, p.epochs, p.tokenAmount, false);

        // N17: pass the PAYING PRINCIPAL (msg.sender of this tx — the
        // publishing agent) to `isAuthorizedPublisher`, NOT the recovered
        // node signer. The pre-rewrite implementation authorized against
        // the wrong principal — a paying agent could be rejected if their
        // node ran the signing, and a non-authorized agent could be
        // approved if a node it didn't control signed off.
        if (!contextGraphs.isAuthorizedPublisher(p.contextGraphId, msg.sender)) {
            revert KnowledgeAssetsLib.UnauthorizedPublisher(p.contextGraphId, msg.sender);
        }

        // --- 3. Create KC in storage ---

        KnowledgeCollectionStorage kcs = knowledgeCollectionStorage;
        currentEpoch = uint40(chronos.getCurrentEpoch());

        // Publisher of record + ERC-1155 KA token recipient = `msg.sender`
        // (the paying agent). This address is stored as
        // `merkleRoots[0].publisher` in KCS and serves as the update-auth
        // pin for open CGs (which have no curator authority to delegate
        // to). Passing the recovered node signer here would record the
        // node operator wallet as the original publisher and break
        // publish→update coherence for open-CG publishers.
        // `author` = `p.authorAddress`, the address verified by
        // `_verifyAuthorAttestation` above. The chain commits the recovered
        // identity into KCS's parallel `merkleRootAuthors[kcId][0]` map
        // so off-chain readers (`/api/get`, indexers) can return the
        // canonical author without re-deriving from the EIP-712
        // signature embedded in calldata.
        kcId = kcs.createKnowledgeCollection(
            msg.sender,
            p.authorAddress,
            p.publishOperationId,
            p.merkleRoot,
            p.knowledgeAssetsAmount,
            p.byteSize,
            currentEpoch,
            currentEpoch + p.epochs,
            p.tokenAmount,
            p.isImmutable,
            p.merkleLeafCount
        );

        // --- 3b. RFC-39 Phase A.5: persist the curated ciphertext commitment ---
        //
        // Only fires when the upfront validation above set
        // `_hasCiphertextCommitment = true` (curated CG, both fields non-zero).
        // Public CGs, legacy curated CGs publishing without LU-11 substrate,
        // and partial-commitment attempts have already returned or reverted
        // above — this branch is the "full commitment" path. KCS's
        // `setCiphertextChunksCommitment` re-asserts the non-zero invariants
        // as a defensive crosscheck against contract-pair drift.
        if (_hasCiphertextCommitment) {
            kcs.setCiphertextChunksCommitment(kcId, p.ciphertextChunksRoot, p.ciphertextChunkCount);
        }

        // --- 4. N20: atomic CG↔KC binding + CG value diff ---

        // Facade write: kcToContextGraph[kcId] = cgId AND contextGraphKCList[cgId].push(kcId).
        contextGraphs.registerKnowledgeCollection(p.contextGraphId, kcId);

        // Per-CG + global value ledger for value-weighted random challenges.
        // Uses BASE `tokenAmount` — value weighting tracks data value, not
        // publisher economics (discounted cost is irrelevant here).
        contextGraphValueStorage.addCGValueForEpochRange(
            p.contextGraphId,
            uint256(currentEpoch),
            uint256(p.epochs),
            uint256(p.tokenAmount)
        );

        // Per-node produced value for scoring. Shared by both public entry
        // points — uses BASE `tokenAmount`, NOT any discounted effective
        // spend, so a node's produced-value score reflects the data value
        // the publisher declared.
        //
        // Validation gate: `publisherNodeIdentityId` is a self-claim under
        // RFC-001 §3.6, but we MUST refuse to credit nonexistent nodes.
        // Without this check any publisher with a valid ACK quorum could
        // pump publishing-factor credit into arbitrary identity ids that
        // the sharding table never minted, distorting RandomSampling node
        // scores. `0` is the explicit "no attribution" sentinel and is
        // accepted (skips the EpochStorage write entirely).
        if (p.publisherNodeIdentityId != 0) {
            require(
                shardingTableStorage.nodeExists(p.publisherNodeIdentityId),
                "publisherNodeIdentityId not in sharding table"
            );
            epochStorage.addEpochProducedKnowledgeValue(p.publisherNodeIdentityId, currentEpoch, p.tokenAmount);
        }
    }

    // ========================================================================
    // Lifetime Extension (V8-compatible, no ACK change needed)
    // ========================================================================

    function extendKnowledgeCollectionLifetime(
        uint256 id,
        uint40 epochs,
        uint96 tokenAmount
    ) external {
        KnowledgeCollectionStorage kcs = knowledgeCollectionStorage;

        (, , , uint88 byteSize, , uint40 endEpoch, uint96 oldTokenAmount, ) = kcs.getKnowledgeCollectionMetadata(id);

        uint256 currentEpoch = chronos.getCurrentEpoch();
        if (currentEpoch > endEpoch) {
            revert KnowledgeCollectionLib.KnowledgeCollectionExpired(id, currentEpoch, endEpoch);
        }

        kcs.setEndEpoch(id, endEpoch + epochs);
        kcs.setTokenAmount(id, oldTokenAmount + tokenAmount);

        _validateTokenAmount(byteSize, epochs, tokenAmount, false);
        epochStorage.addTokensToEpochRange(1, endEpoch, endEpoch + epochs, tokenAmount);
        _addTokens(tokenAmount);

        // Phase 1+8 cross-phase fix: extending a KC's lifetime adds value to
        // the CG it belongs to, so the CG's value-weighted random-sampling
        // contribution must grow accordingly. Without this write the CG would
        // undercount extended KCs at challenge selection time.
        //
        // V10 KCs always have a CG binding (Phase 7 invariant). Legacy V8 KCs
        // — created before atomic CG bind landed — return cgId == 0; in that
        // case we skip the CG value write so the V8 lifetime-extension path
        // keeps working unchanged.
        if (epochs > 0 && tokenAmount > 0) {
            uint256 cgId = contextGraphStorage.kcToContextGraph(id);
            if (cgId != 0) {
                // Pin the diff over the EXTENSION window only, starting at
                // the (old) endEpoch — the original publish window already
                // wrote its own diff at publish time and that contribution
                // retracts at the original endEpoch as designed.
                contextGraphValueStorage.addCGValueForEpochRange(
                    cgId,
                    uint256(endEpoch),
                    uint256(epochs),
                    uint256(tokenAmount)
                );
            }
        }
    }

    // ========================================================================
    // Internal: Signature Verification
    // ========================================================================

    function _verifySignatures(
        uint72[] calldata identityIds,
        bytes32 messageHash,
        bytes32[] calldata r,
        bytes32[] calldata vs
    ) internal view {
        if (r.length != identityIds.length || r.length != vs.length) {
            revert KnowledgeCollectionLib.SignaturesSignersMismatch(r.length, vs.length, identityIds.length);
        }

        uint256 minSigs = parametersStorage.minimumRequiredSignatures();

        if (r.length < minSigs) {
            revert KnowledgeCollectionLib.MinSignaturesRequirementNotMet(minSigs, r.length);
        }

        uint256 uniqueCount;
        for (uint256 i; i < identityIds.length; i++) {
            bool isDuplicate = false;
            for (uint256 j; j < i; j++) {
                if (identityIds[i] == identityIds[j]) {
                    isDuplicate = true;
                    break;
                }
            }
            if (!isDuplicate) {
                uniqueCount++;
                if (uniqueCount >= minSigs) break;
            }
        }
        require(uniqueCount >= minSigs, "Insufficient unique receiver identities");

        for (uint256 i; i < identityIds.length; i++) {
            _verifySignature(identityIds[i], messageHash, r[i], vs[i]);
        }
    }

    function _verifySignature(
        uint72 identityId,
        bytes32 messageHash,
        bytes32 _r,
        bytes32 _vs
    ) internal view returns (address signer) {
        signer = ECDSA.tryRecover(messageHash, _r, _vs);

        if (signer == address(0)) {
            revert KnowledgeCollectionLib.InvalidSignature(identityId, messageHash, _r, _vs);
        }

        if (
            !identityStorage.keyHasPurpose(identityId, keccak256(abi.encodePacked(signer)), IdentityLib.OPERATIONAL_KEY)
        ) {
            revert KnowledgeCollectionLib.SignerIsNotNodeOperator(identityId, signer);
        }

        // RFC-001 edge-publish unblocker: ACK signers must be in the active
        // sharding table, not merely staked. Sharding-table membership is the
        // canonical "this is a host that can serve queries" signal. The prior
        // `getNodeStakeV10 > 0` gate locked publishing behind the staking
        // lifecycle and rejected freshly-promoted cores; sharding-table
        // membership is updated atomically when nodes are promoted/demoted.
        require(shardingTableStorage.nodeExists(identityId), "ACK signer not in sharding table");
    }

    // ========================================================================
    // Internal: Author Attestation (RFC-001)
    // ========================================================================

    /**
     * @notice EIP-712 typed-data digest for the V10 author attestation.
     *
     * Domain pins (chainId, verifyingContract) to defeat cross-chain and
     * cross-deployment replay. The struct hash binds the publication's
     * (contextGraphId, merkleRoot) to a specific (authorAddress,
     * schemeVersion) — leaked signatures cannot be redirected to a different
     * CG, a different content root, or a different author identity.
     *
     * One-shot consumption of `(contextGraphId, merkleRoot)` at the
     * `KnowledgeCollectionStorage` layer is the temporal replay defense; no
     * `signedAtBlock` window is included in the digest (see RFC-001 §3.2).
     */
    function _hashAuthorAttestation(
        uint256 _contextGraphId,
        bytes32 _merkleRoot,
        address _authorAddress,
        uint8 _schemeVersion
    ) internal view returns (bytes32) {
        bytes32 domainSeparator = keccak256(
            abi.encode(
                _EIP712_DOMAIN_TYPEHASH,
                _EIP712_NAME_HASH,
                _EIP712_VERSION_HASH,
                block.chainid,
                address(this)
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(
                _AUTHOR_ATTESTATION_TYPEHASH,
                _contextGraphId,
                _merkleRoot,
                _authorAddress,
                _schemeVersion
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
    }

    /**
     * @notice Verify the author attestation attached to a publish call.
     *
     * Branches on `authorAddress.code.length`:
     *
     * - **EOA** (`code.length == 0`): standard ECDSA recovery, equality with
     *   `authorAddress`. `tryRecover` returns `address(0)` on malformed
     *   signatures — the explicit `recovered != address(0)` check is
     *   defense-in-depth above the outer `authorAddress != 0` revert.
     *
     * - **Smart-contract wallet** (`code.length > 0`): delegates to the
     *   wallet's own `isValidSignature` — the wallet decides which
     *   underlying keys are currently authorized, enabling key rotation,
     *   social recovery, multi-sig, and passkey signers. The wallet must
     *   accept a 65-byte `(r, s, v)` signature; multi-sig aggregations that
     *   need a longer payload are deferred to `authorSchemeVersion >= 2`
     *   (see RFC-001 §9.6). The `(r, s, v)` triple is reconstructed from
     *   the compact `(authorR, authorVS)` pair.
     *
     * EIP-7702 delegation works through the EIP-1271 branch automatically:
     * a delegated EOA has `code.length > 0` (the `0xef0100 || delegate`
     * prefix), so `staticcall(isValidSignature)` lands on the delegate's
     * implementation.
     */
    function _verifyAuthorAttestation(PublishParams calldata p) internal view {
        if (p.authorAddress == address(0)) revert AuthorRequired();
        if (p.authorSchemeVersion != 1) revert UnsupportedAuthorScheme(p.authorSchemeVersion);

        bytes32 digest = _hashAuthorAttestation(
            p.contextGraphId,
            p.merkleRoot,
            p.authorAddress,
            p.authorSchemeVersion
        );

        if (p.authorAddress.code.length == 0) {
            // EOA branch.
            address recovered = ECDSA.tryRecover(digest, p.authorR, p.authorVS);
            if (recovered == address(0) || recovered != p.authorAddress) {
                revert InvalidAuthorSignature();
            }
        } else {
            // EIP-1271 branch. Reconstruct the standard (r, s, v) form from
            // the compact (r, vs). `vs` packs `s` in the low 255 bits and
            // `v - 27` in the top bit.
            bytes32 s = p.authorVS & bytes32((uint256(1) << 255) - 1);
            uint8 v = uint8((uint256(p.authorVS) >> 255) + 27);
            bytes memory sig = abi.encodePacked(p.authorR, s, v);
            if (
                IERC1271(p.authorAddress).isValidSignature(digest, sig) != _ERC1271_MAGIC_VALUE
            ) {
                revert InvalidAuthorSignature1271();
            }
        }
    }

    // ========================================================================
    // Internal: Payment
    // ========================================================================

    function _validateTokenAmount(
        uint256 byteSize,
        uint256 epochs,
        uint96 tokenAmount,
        bool includeCurrentEpoch
    ) internal view {
        Chronos chron = chronos;

        uint256 stakeWeightedAverageAsk = askStorage.getStakeWeightedAverageAsk();
        // H7: `SafeCast.toUint96` reverts on overflow instead of silently
        // truncating. A publisher sending `stakeWeightedAverageAsk * byteSize
        // * epochs / 1024` > uint96.max (~79 bn TRAC) MUST revert — silent
        // truncation would make a catastrophically underpaid publish look
        // correctly-paid because `tokenAmount` would match the wrapped cost.
        uint96 expectedTokenAmount;
        if (includeCurrentEpoch) {
            uint256 totalStorageTime = (epochs * 1e18) + (chron.timeUntilNextEpoch() * 1e18) / chron.epochLength();
            expectedTokenAmount = SafeCast.toUint96(
                (stakeWeightedAverageAsk * byteSize * totalStorageTime) / 1024 / 1e18
            );
        } else {
            expectedTokenAmount = SafeCast.toUint96((stakeWeightedAverageAsk * byteSize * epochs) / 1024);
        }

        if (tokenAmount < expectedTokenAmount) {
            revert KnowledgeCollectionLib.InvalidTokenAmount(expectedTokenAmount, tokenAmount);
        }
    }

    /**
     * @notice Pull TRAC from `msg.sender` directly into the CSS reward pool.
     *
     * RFC-001: the prior `address paymaster` parameter is gone. Sponsorship
     * is now expressed via publisher-conviction-account agent registration —
     * a sponsoring core calls `DKGPublishingConvictionNFT.registerAgent(its
     * accountId, sponsoredWallet)`, and that wallet's publishes flow through
     * the discount branch in `publish` automatically.
     */
    function _addTokens(uint96 tokenAmount) internal {
        IERC20 token = tokenContract;

        if (token.allowance(msg.sender, address(this)) < tokenAmount) {
            revert TokenLib.TooLowAllowance(
                address(token),
                token.allowance(msg.sender, address(this)),
                tokenAmount
            );
        }

        if (token.balanceOf(msg.sender) < tokenAmount) {
            revert TokenLib.TooLowBalance(address(token), token.balanceOf(msg.sender), tokenAmount);
        }

        if (!token.transferFrom(msg.sender, address(convictionStakingStorage), tokenAmount)) {
            revert TokenLib.TransferFailed();
        }
    }

    // ========================================================================
    // V10 Update Entries
    // ========================================================================

    /**
     * @notice Update an existing knowledge collection via publisher conviction
     *         account (discounted path). Closes N16, N19 (local ceiling removal),
     *         and decision #4.
     *
     * Authorization: policy-branch gate in `_executeUpdateCore`. Curated CGs
     * delegate to the facade (`isAuthorizedPublisher`), which handles
     * EOA/Safe direct-equality and PCA live-resolve + agent delegation so
     * the authorized principal set tracks CG NFT transfers and PCA agent
     * cycling without off-chain coordination. Open CGs pin auth to
     * `merkleRoots[0].publisher` (the original paying principal at publish
     * time), because open CGs have no curator to delegate to. Replaces the
     * initial ERC-1155 `balanceOf` gate, which was unsound under
     * ERC-1155Delta transferability: any downstream buyer of a single KA
     * token inherited full update authority.
     *
     * Delta-only payment semantics (decision #4 interpretation): the caller
     * passes `newTokenAmount` as the NEW TOTAL `tokenAmount` for the KC. KAV10
     * charges only `delta = newTokenAmount - currentTokenAmount` via
     * `coverPublishingCost`. Rebates are rejected (`CannotShrinkTokenAmount`).
     * Metadata-only updates (`delta == 0`) bypass `coverPublishingCost`
     * entirely — no conviction spend, no zero-value NFT hop.
     *
     * Double-count prevention (same reasoning as `publish`): on the
     * conviction branch the NFT's `coverPublishingCost` directly distributes
     * `deltaTokenAmount` across the KC's remaining epoch range (active
     * sink) and lazily sweeps elapsed window remainders (passive sink), so
     * this path MUST NOT call `_addTokens` / `_distributeTokens`.
     *
     * @param p Update parameters (see `UpdateParams` struct).
     */
    /**
     * @notice Update a knowledge collection (RFC-001: unified entrypoint).
     *
     * Mirrors the unified `publish`: takes the PCA discount branch when
     * `msg.sender` is a registered agent on an active PCA whose
     * `lockDurationEpochs >= remainingEpochs`; otherwise falls through to
     * direct spend. Metadata-only updates (`delta == 0`) skip cost
     * coverage entirely on either branch.
     */
    function update(UpdateParams calldata p) external {
        (uint96 deltaTokenAmount, uint40 remainingEpochs, uint40 currentEpoch) = _executeUpdateCore(p);

        if (deltaTokenAmount == 0) return;

        // PCA branch eligibility (mirrors `publish()`, with `<=` for the
        // epoch count since `update()` passes the KC's REMAINING lifetime,
        // a delta bounded above by `lockDurationEpochs`):
        //   (1) `msg.sender` is registered as an agent on a PCA,
        //   (2) the PCA is NOT past its expiry timestamp,
        //   (3) `remainingEpochs <= lockDurationEpochs`.
        // Otherwise fall through to direct spend so a stale agent
        // registration / expired PCA / over-large remaining lifetime
        // cannot brick `update()` (Codex round-3 finding on PR #470).
        uint256 convictionAccountId = publishingConvictionNFT.agentToAccountId(msg.sender);
        bool useConviction;
        if (convictionAccountId != 0) {
            (,,,, uint40 expiresAtTimestamp, uint16 lockDurationEpochs,,,) =
                publishingConvictionNFT.accounts(convictionAccountId);
            useConviction =
                block.timestamp < uint256(expiresAtTimestamp) &&
                remainingEpochs <= uint40(lockDurationEpochs);
        }

        if (useConviction) {
            // Discount branch — delta funds the KC's REMAINING epoch range
            // `[currentEpoch, currentEpoch + remainingEpochs - 1]` via the
            // active sink. The active sink may extend past the conviction
            // account's `expiresAtEpoch` (harmless — the staker pool just
            // gets funded normally for those epochs).
            publishingConvictionNFT.coverPublishingCost(
                msg.sender,
                deltaTokenAmount,
                currentEpoch,
                remainingEpochs
            );
        } else {
            _addTokens(deltaTokenAmount);
            _distributeTokens(deltaTokenAmount, uint256(remainingEpochs), currentEpoch);
        }
    }

    // ========================================================================
    // Internal: Shared update core
    // ========================================================================

    /**
     * @notice Signature verification + auth + validation + KCS mutation +
     *         atomic CG value delta write.
     *
     * Both `update` and `updateDirect` run this before branching on payment
     * path. No TRAC movement happens here — the caller's path handles that.
     *
     * @return deltaTokenAmount Delta between `newTokenAmount` and the KC's
     *         current on-chain tokenAmount. Zero on metadata-only updates.
     * @return remainingEpochs Number of "epoch units" from `currentEpoch` to
     *         `endEpoch`, exclusive on the tail partial. Matches `p.epochs`
     *         semantics from `_executePublishCore` so `_distributeTokens` can
     *         be reused verbatim in `updateDirect`.
     * @return currentEpoch The current epoch (cached for `_distributeTokens`).
     */
    function _executeUpdateCore(
        UpdateParams calldata p
    )
        internal
        returns (uint96 deltaTokenAmount, uint40 remainingEpochs, uint40 currentEpoch)
    {
        KnowledgeCollectionStorage kcs = knowledgeCollectionStorage;

        // --- 1. Read current KC metadata (needed for validation + auth) ---
        //
        // `getKnowledgeCollectionUpdateContext` is a scalar-only getter
        // added for the update path specifically. The legacy
        // `getKnowledgeCollectionMetadata` performs a full storage → memory
        // struct copy, which walks every entry of `merkleRoots[]` and
        // `burned[]`. Both grow monotonically on every update, so calling
        // the legacy getter from the update path made gas scale (super-)
        // linearly with history — a KC with enough updates would
        // eventually become un-updatable. Switching to this scalar getter
        // keeps the update cost constant. (Codex round 3 finding 1.)

        // `minted` is intentionally discarded: the old N16 `balanceOf` auth
        // gate needed the KC's minted count to compute the token range, but
        // the policy-branch auth gate below no longer touches token ranges.
        (
            uint256 preUpdateMerkleRootCount,
            ,
            uint88 currentByteSize,
            uint40 endEpoch,
            uint96 currentTokenAmount,
            bool isImmutable,
            uint32 ignoredPreUpdateMerkleLeafCount
        ) = kcs.getKnowledgeCollectionUpdateContext(p.id);
        ignoredPreUpdateMerkleLeafCount;

        if (isImmutable) {
            revert KnowledgeCollectionLib.CannotUpdateImmutableKnowledgeCollection(p.id);
        }

        currentEpoch = uint40(chronos.getCurrentEpoch());
        if (uint256(currentEpoch) > uint256(endEpoch)) {
            revert KnowledgeCollectionLib.KnowledgeCollectionExpired(
                p.id,
                uint256(currentEpoch),
                uint256(endEpoch)
            );
        }

        // Remaining lifetime in "publish epoch units" — matches `p.epochs`
        // semantics in `_executePublishCore`, where `endEpoch = startEpoch +
        // epochs`. `_distributeTokens` consumes this as the partial-current
        // + full-middle + partial-final split, and `addCGValueForEpochRange`
        // pins its diff over `[currentEpoch, currentEpoch + remainingEpochs)`,
        // retracting at `endEpoch`. Matches the publish-time retraction point.
        remainingEpochs = endEpoch - currentEpoch;

        // --- 2. CG binding lookup (required for value delta write) ---

        uint256 contextGraphId = contextGraphStorage.kcToContextGraph(p.id);
        if (contextGraphId == 0) {
            // Post-Phase-7 invariant: publish atomically binds kcId → cgId
            // via `contextGraphs.registerKnowledgeCollection`. Zero here
            // means corrupt state (KC created outside publish, or Phase 7
            // migration gap). Fail loudly — silently authorizing without a
            // CG would orphan the KC from value-weighted challenges.
            revert MissingContextGraphBinding(p.id);
        }

        // --- 3. ACK signature verification ---
        //
        // RFC-001: per-update publisher signature (`publisherNodeR/VS`) is
        // removed. `publisherNodeIdentityId` is now a self-claimed
        // attribution field with no per-update authentication. ACK quorum
        // continues to gate update validity.
        //
        // RFC-001 v1.1 will add an author-attestation step here too,
        // mirroring the publish path. For now the update path has no
        // on-chain author verification.
        //
        // ACK digest — covers EVERY mutable field the update can change so a
        // stale ACK can't be replayed with different byte size, different
        // token amount, different mint/burn counts, or a different kc id. The
        // burn id list is digested by its `keccak256` so an arbitrary-length
        // array folds into a fixed-size `bytes32` without blowing out the
        // packed digest. H5 prefix pins replay to (chain, contract).
        //
        // Replay protection: the digest binds the PRE-UPDATE merkle-root chain
        // length. KCS appends to `merkleRoots[]` on every successful update, so
        // every successful update increments this counter and invalidates any
        // ACK that was signed against an earlier value. Without this binding,
        // a captured update ACK could be replayed against a later state of the
        // same KC — for paid updates the attacker would burn their own TRAC,
        // but a `delta == 0` (metadata-only) ACK could be replayed for free to
        // roll the merkle root back. The pre-update length comes from the
        // scalar metadata getter above — signers read the same value off-chain,
        // so both sides agree on the exact version they're attesting.
        //
        // Same field-set rule as publish: NO `publisherNodeIdentityId` in the
        // ACK digest. The publishing node is verified separately above. The
        // publish ACK shape is defined by the PRD (see `_executePublishCore`
        // comment); the update ACK mirrors the same separation and adds the
        // update-specific fields (`id`, pre-update merkle-root count, mint
        // amount, burn list hash).
        bytes32 ackDigest = keccak256(
            abi.encodePacked(
                block.chainid,
                address(this),
                contextGraphId,
                p.id,
                preUpdateMerkleRootCount,
                p.newMerkleRoot,
                uint256(p.newByteSize),
                uint256(p.newTokenAmount),
                p.mintKnowledgeAssetsAmount,
                keccak256(abi.encodePacked(p.knowledgeAssetsToBurn)),
                uint256(p.newMerkleLeafCount)
            )
        );
        _verifySignatures(p.identityIds, ECDSA.toEthSignedMessageHash(ackDigest), p.r, p.vs);

        // --- 4. Validate the new total + compute delta ---

        // No rebates: new total must be >= current total. A publisher that
        // wants to "shrink" must let the KC expire and republish.
        if (p.newTokenAmount < currentTokenAmount) {
            revert CannotShrinkTokenAmount(currentTokenAmount, p.newTokenAmount);
        }
        deltaTokenAmount = p.newTokenAmount - currentTokenAmount;

        // Final-epoch economic guard: with zero remaining lifetime there is
        // nothing to amortize a new commitment over. Any new TRAC delta OR
        // any byte-size growth is rejected — both need a future window to
        // land in (`_distributeTokens` would divide by zero on delta > 0,
        // and the byte-size growth validation below would compute an
        // expected cost of ZERO at `remainingEpochs == 0`, silently letting
        // growth through for free).
        if (
            remainingEpochs == 0 &&
            (deltaTokenAmount > 0 || p.newByteSize > currentByteSize)
        ) {
            revert NoRemainingLifetimeForDelta(p.id, currentEpoch, endEpoch);
        }

        // Byte-size growth cost check. Charges `delta` against the MARGINAL
        // cost of the growth (`newByteSize - currentByteSize`) over the
        // REMAINING lifetime, not against the cumulative `newTokenAmount`.
        //
        // Why not validate cumulative `newTokenAmount` vs `remainingEpochs`:
        // `newTokenAmount` is the TOTAL historical commitment, most of
        // which has already been distributed into PAST epoch pools by the
        // time the update lands. Late in a KC's lifetime (say, epoch 9 of
        // 10), ~90% of the cumulative has already been paid out to past
        // stakers. Validating `newTokenAmount` against the remaining
        // window would credit that sunk commitment as future funding,
        // letting a publisher double the byteSize at epoch 9/10 with
        // ZERO new TRAC. The cumulative looks sufficient, but the actual
        // undistributed reward pool for the remaining window would be
        // fractions of the new footprint's cost. Charging only the
        // marginal cost of the GROWTH, payable by `delta` over the
        // REMAINING window, closes that hole.
        //
        // Pure metadata-only updates (`newByteSize <= currentByteSize`,
        // regardless of delta) skip this check entirely — they are
        // re-attestations of existing data (merkle-root rotation) or pure
        // over-funding TRAC top-ups, and the original publish-time
        // validation still governs the underlying economic surface. Gating
        // on `delta > 0` instead would block routine root rotations under
        // a rising stake-weighted ask.
        if (p.newByteSize > currentByteSize) {
            uint256 byteSizeGrowth = uint256(p.newByteSize) - uint256(currentByteSize);
            _validateTokenAmount(
                byteSizeGrowth,
                uint256(remainingEpochs),
                deltaTokenAmount,
                false
            );
        }

        // --- 5. Update authorization (policy-branch) ---

        // Open CGs (`publishPolicy == 1`) have no curator authority, so
        // `isAuthorizedPublisher` returns true for ANY non-zero caller
        // there — using it as the update gate would let random addresses
        // rotate merkle roots on other publishers' KCs. Pin open-CG update
        // auth to `merkleRoots[0].publisher` instead (the original paying
        // principal at publish time).
        //
        // Curated CGs delegate to `isAuthorizedPublisher` via the facade,
        // which handles EOA/Safe direct-equality and PCA live-resolve +
        // agent mapping. This means an EOA/Safe curator transfer (via the
        // CG NFT's storage-rotated `publishAuthority`) and PCA agent
        // cycling both automatically flow through to update rights, with
        // no stale-authority drift.
        //
        // Replaces the initial `balanceOf(msg.sender, kcRange) > 0` gate,
        // which was unsound because ERC-1155Delta KA tokens are
        // transferable via `safeTransferFrom`. Under the old gate, any
        // downstream recipient of a single KA token from a KC gained full
        // update authority — could rotate the merkle root, mint new KAs,
        // burn existing KAs — trivially hijacking KCs whose tokens had
        // moved to a secondary holder.
        (uint8 publishPolicy, ) = contextGraphStorage.getPublishPolicy(contextGraphId);
        if (publishPolicy == 1) {
            address originalPublisher = kcs.getMerkleRootPublisherByIndex(p.id, 0);
            if (msg.sender != originalPublisher) {
                revert KnowledgeAssetsLib.UnauthorizedPublisher(contextGraphId, msg.sender);
            }
        } else if (!contextGraphs.isAuthorizedPublisher(contextGraphId, msg.sender)) {
            revert KnowledgeAssetsLib.UnauthorizedPublisher(contextGraphId, msg.sender);
        }

        // --- 6. Apply KCS mutation (new merkle root, bytes, tokens, mint/burn) ---

        // `msg.sender` (the paying publisher) is recorded as the new merkle
        // root author AND is the recipient of any newly minted KA tokens.
        // `p.updateOperationId` is the off-chain correlation id emitted on
        // `KnowledgeCollectionUpdated`. KCS internally reconciles its
        // `_totalTokenAmount` counter from old → new.
        // V10.1 update path does not (yet) carry an EIP-712 author
        // attestation — the new merkle-root entry is annotated with
        // `author = address(0)` so readers can distinguish "this state
        // change predates author attestation" from a deliberate
        // self-anonymisation. vNext will sign the update against the same
        // EIP-712 envelope as publish and pass `p.authorAddress` here.
        kcs.updateKnowledgeCollection(
            msg.sender,
            address(0),
            p.id,
            p.updateOperationId,
            p.newMerkleRoot,
            p.mintKnowledgeAssetsAmount,
            p.knowledgeAssetsToBurn,
            p.newByteSize,
            p.newTokenAmount,
            p.newMerkleLeafCount
        );

        // --- 6b. RFC-39 Phase A.5: refresh the curated ciphertext commitment ---
        //
        // Codex PR #630 R1 #2 — without this, curated KCs kept the
        // publish-time commitment forever and `RandomSampling`'s
        // curated-proof check (which reads
        // `getLatestCiphertextChunksRoot/Count`) would verify against
        // stale ciphertext after the first update. Mirrors the same
        // validation contract as the publish branch:
        //   - Public CG + any non-zero ciphertext field → revert.
        //   - Curated CG + KC has a prior commitment + zero pair → revert
        //     (Codex PR #630 R2 #1307). Previously a zero-pair on an
        //     already-committed curated KC silently fell through as a
        //     "metadata-only" update and left the OLD ciphertext
        //     commitment in storage. With the plaintext merkle root +
        //     leaf count rotated to the new batch, `RandomSampling`'s
        //     curated-proof check would then verify against stale
        //     ciphertext that no longer corresponds to the published
        //     leaves — sampling proofs against the post-update KC are
        //     unprovable. Once a KC has been committed, every
        //     subsequent update MUST rotate the commitment in lockstep
        //     with the plaintext one.
        //   - Curated CG + KC has no prior commitment + zero pair → no-op
        //     (legacy / pre-LU-11 path; picker still skips this KC in
        //     the curated draw until the first commitment lands).
        //   - Curated CG + both fields non-zero → commitment rotated
        //     (or set for the first time).
        //   - Curated CG + exactly one field zero → revert
        //     IncompleteCiphertextCommitment (partial commitment would
        //     zero-divide the picker).
        //   - Public CG + any non-zero ciphertext field → revert
        //     PublicCGCannotHaveCiphertextCommitment.
        bool _isCurated = contextGraphStorage.getIsCurated(contextGraphId);
        bool _hasNewCiphertextCommitment =
            p.newCiphertextChunksRoot != bytes32(0) || p.newCiphertextChunkCount != 0;
        if (_isCurated) {
            if (_hasNewCiphertextCommitment) {
                if (p.newCiphertextChunksRoot == bytes32(0) || p.newCiphertextChunkCount == 0) {
                    revert IncompleteCiphertextCommitment();
                }
                kcs.setCiphertextChunksCommitment(p.id, p.newCiphertextChunksRoot, p.newCiphertextChunkCount);
            } else if (kcs.getLatestCiphertextChunksRoot(p.id) != bytes32(0)) {
                // KC was previously committed; a zero-pair update would
                // strand the stale commitment.
                revert IncompleteCiphertextCommitment();
            }
            // else: legacy / pre-LU-11 curated KC, no commitment yet —
            // zero-pair update is permitted (mirrors the publish
            // legacy-path behaviour).
        } else if (_hasNewCiphertextCommitment) {
            revert PublicCGCannotHaveCiphertextCommitment(contextGraphId);
        }

        // --- 7. CG value delta + per-node produced-value bookkeeping ---

        // Skip on metadata-only updates — the CG value storage reverts on
        // `value == 0` (and `remainingEpochs == 0` was already gated above
        // when delta > 0, so by here either delta > 0 AND remainingEpochs > 0,
        // or delta == 0 and we short-circuit).
        if (deltaTokenAmount > 0) {
            // Write the delta CG value over the REMAINING lifetime so the
            // per-epoch contribution crystallizes into the CG value cumulative
            // the same way a fresh publish does. Retraction diff lands at
            // `endEpoch`, matching publish's retraction point.
            contextGraphValueStorage.addCGValueForEpochRange(
                contextGraphId,
                uint256(currentEpoch),
                uint256(remainingEpochs),
                uint256(deltaTokenAmount)
            );

            // Track per-node produced value for the delta. Uses BASE delta
            // (not discounted effective spend) so the scoring reflects data
            // value added, not publisher economics — identical to publish.
            //
            // Same validation gate as `_executePublishCore`: refuse to
            // credit nonexistent identity ids, accept `0` as no-attribution.
            if (p.publisherNodeIdentityId != 0) {
                require(
                    shardingTableStorage.nodeExists(p.publisherNodeIdentityId),
                    "publisherNodeIdentityId not in sharding table"
                );
                epochStorage.addEpochProducedKnowledgeValue(
                    p.publisherNodeIdentityId,
                    currentEpoch,
                    deltaTokenAmount
                );
            }
        }
    }

    // ========================================================================
    // Internal: Token Distribution
    // ========================================================================

    function _distributeTokens(uint96 tokenAmount, uint256 epochs, uint40 currentEpoch) internal {
        // `epochs > 0` is guaranteed by every caller:
        //   - `publishDirect` → `_executePublishCore` rejects `p.epochs == 0`
        //     with `ZeroEpochs` before reaching this helper.
        //   - `updateDirect` → `_executeUpdateCore` rejects
        //     `deltaTokenAmount > 0 && remainingEpochs == 0` with
        //     `NoRemainingLifetimeForDelta`, and only calls `_distributeTokens`
        //     inside an `if (deltaTokenAmount > 0)` gate.
        // No defensive re-check needed. `extendKnowledgeCollectionLifetime`
        // does NOT call this helper (it hits `addTokensToEpochRange` directly).

        uint256 epochLengthInSeconds = chronos.epochLength();
        uint256 timeRemainingInCurrentEpoch = chronos.timeUntilNextEpoch();
        uint256 baseTokensPerFullEpoch = tokenAmount / epochs;
        uint256 currentEpochAllocation = (baseTokensPerFullEpoch * timeRemainingInCurrentEpoch) / epochLengthInSeconds;
        uint256 finalEpochAllocation = baseTokensPerFullEpoch - currentEpochAllocation;
        uint256 numberOfFullEpochs = epochs - 1;
        uint256 totalTokensForFullEpochs = baseTokensPerFullEpoch * numberOfFullEpochs;

        uint256 totalAllocated = currentEpochAllocation + totalTokensForFullEpochs + finalEpochAllocation;
        if (totalAllocated < tokenAmount) {
            finalEpochAllocation += tokenAmount - totalAllocated;
        }

        if (currentEpochAllocation > 0) {
            epochStorage.addTokensToEpochRange(1, currentEpoch, currentEpoch, uint96(currentEpochAllocation));
        }

        if (numberOfFullEpochs > 0 && totalTokensForFullEpochs > 0) {
            epochStorage.addTokensToEpochRange(
                1,
                currentEpoch + 1,
                currentEpoch + uint40(numberOfFullEpochs),
                uint96(totalTokensForFullEpochs)
            );
        }

        if (finalEpochAllocation > 0) {
            epochStorage.addTokensToEpochRange(
                1,
                currentEpoch + uint40(epochs),
                currentEpoch + uint40(epochs),
                uint96(finalEpochAllocation)
            );
        }
    }
}
