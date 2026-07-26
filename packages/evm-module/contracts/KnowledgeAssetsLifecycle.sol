// SPDX-License-Identifier: Apache-2.0

pragma solidity ^0.8.20;

import {AskStorage} from "./storage/AskStorage.sol";
import {EpochStorage} from "./storage/EpochStorage.sol";
import {Chronos} from "./storage/Chronos.sol";
import {DKGKnowledgeAssets} from "./storage/DKGKnowledgeAssets.sol";
import {IdentityStorage} from "./storage/IdentityStorage.sol";
import {ParametersStorage} from "./storage/ParametersStorage.sol";
import {ConvictionStakingStorage} from "./storage/ConvictionStakingStorage.sol";
import {ShardingTableStorage} from "./storage/ShardingTableStorage.sol";
import {ContextGraphs} from "./ContextGraphs.sol";
import {ContextGraphStorage} from "./storage/ContextGraphStorage.sol";
import {ContextGraphValueStorage} from "./storage/ContextGraphValueStorage.sol";
import {CGWeightTreeStorage} from "./storage/CGWeightTreeStorage.sol";
import {KnowledgeAssetsLib} from "./libraries/KnowledgeAssetsLib.sol";
import {KnowledgeAssetLib} from "./libraries/KnowledgeAssetLib.sol";
import {TokenLib} from "./libraries/TokenLib.sol";
import {IdentityLib} from "./libraries/IdentityLib.sol";
import {INamed} from "./interfaces/INamed.sol";
import {IVersioned} from "./interfaces/IVersioned.sol";
import {IInitializable} from "./interfaces/IInitializable.sol";
import {IDKGPublishingConvictionNFT} from "./interfaces/IDKGPublishingConvictionNFT.sol";
import {IPublishingConvictionErrors} from "./interfaces/IPublishingConvictionErrors.sol";
import {ContractStatus} from "./abstract/ContractStatus.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ECDSA} from "solady/src/utils/ECDSA.sol";

/**
 * @title KnowledgeAssetsLifecycle
 * @notice V10 publish + update contract — wires together:
 *   - ContextGraphs facade (3 curator types, atomic KA↔CG bind)
 *   - ContextGraphStorage (direct read for `kaToContextGraph` on update)
 *   - ContextGraphValueStorage (per-CG value ledger for value-weighted challenges)
 *   - DKGPublishingConvictionNFT (publisher discount NFT; auto-resolves agent→account)
 *   - DKGKnowledgeAssets (ERC-721, tokenId == kaId)
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
 * signature verification → CG existence + auth → KAS create → atomic CG
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
 *   - publish: satisfied by EITHER principal the publish carries —
 *              `isAuthorizedPublisher(msg.sender)` (the paying principal, N17
 *              closure) OR `isAuthorizedPublisher(p.authorAddress)` (the
 *              EIP-712-attested author, proven by `_verifyAuthorAttestation`
 *              before the gate). #1689: a curated-CG curator can delegate
 *              payment to a distinct funded wallet without sharing their key.
 *              Authorization only — payer-of-record, the CG registration
 *              escrow, the PCA discount and every TRAC transfer stay keyed to
 *              `msg.sender`.
 *   - update:  enforced in `_executeUpdateCore` as owner-only — the
 *              EIP-712-attested author MUST equal `ownerOf(kaId)`, independent
 *              of CG publish policy. There is no curator/PCA delegation on the
 *              update path (delegation applies to publish only). To change who
 *              may update a KA, transfer the NFT (an owner may be an EOA, a
 *              Safe via EIP-1271 for N-of-M, or an EIP-7702-delegated EOA).
 *              This supersedes the initial V10 ERC-1155
 *              `balanceOf(msg.sender, kaRange) > 0` gate (which was hijackable
 *              via ERC-1155Delta token transfers) and the V9
 *              `latestPublisher == msg.sender` gate (which gated on
 *              node-operator key). See OT-RFC-45 (owner-only update authority).
 *
 *              Key loss is a single point of failure: owner-only gives no
 *              protocol-level recovery, so for any canonical / long-lived KA,
 *              mint to a Safe (or recovery-enabled EIP-1271 account) from the
 *              first publish — transferring the NFT cannot recover an
 *              already-lost key (OT-RFC-45 §5.1).
 *
 * Byte-size ceiling (decision #4 closure): updates may GROW `newByteSize`
 * beyond the original value, as long as the new `tokenAmount` covers the new
 * size × remaining lifetime at the current stake-weighted ask. The
 * `originalByteSize` ceiling mapping is REMOVED; byte-size audit provenance
 * lives in the KAS `KnowledgeAssetByteSizeUpdated` event history.
 */
contract KnowledgeAssetsLifecycle is INamed, IVersioned, ContractStatus, IInitializable, ReentrancyGuard {
    string private constant _NAME = "KnowledgeAssetsLifecycle";
    // 10.1.0 → 10.1.1: ReentrancyGuard perimeter on publish / update /
    // extendKnowledgeAssetLifetime; strict-positive tokenAmount floor
    // in `_validateTokenAmount`. ReentrancyGuard contributes one uint256
    // storage slot at the end of the inheritance chain; KAV10 owns its
    // slots below the inherited chain and V10 deploys are redeploy +
    // reinit, so no storage-layout migration is required.
    // 10.0.3 → 10.0.4: curated publishes and paid legacy curated updates
    // must carry a ciphertext commitment before entering value-weighted
    // random-sampling state.
    // 10.0.5 → 10.1.0: OT-RFC-49 "hosting follows access" — the curated
    // random-sampling commitment is the PUBLIC `_catalog` root, not the
    // private ciphertext root (cores hold zero private bytes). PublishParams /
    // UpdateParams ciphertext fields become `catalogRoot`/`catalogLeafCount`
    // (same byte widths); the three commitment errors are renamed; the publish
    // and update ACK preimages prepend `ACK_DIGEST_VERSION` (Trap 3 — raw
    // abi.encodePacked, NOT the EIP-712 domain). Minor bump: new sampling
    // semantics, but no inherited-slot growth in this contract.
    // 10.0.4 → 10.0.5: audit fix — the conviction (PCA discount) branch in
    // `publish`/`update` now FALLS THROUGH to direct spend instead of
    // reverting when `coverPublishingCost` fails for a payment reason
    // (`InsufficientAllowance` / `AccountExpired`). Agent registration is
    // permissionless and requires no consent (RFC-001 §3.6), so a hard
    // revert on the conviction branch let anyone register a victim against
    // a deliberately-underfunded account and brick that victim's paid
    // publishes/updates indefinitely. This extends the existing
    // "stale registration MUST NOT brick the publisher" intent (already
    // applied to the expired / epoch-mismatch gate) to the
    // underfunded-active case.
    // 2.0.0 → 2.0.1 (PATCH): protocol treasury fee skimmed inside
    // `_addTokens` (publisher pays the same gross amount; the fee is taken
    // out of the staker-bound net). Patch-level on purpose.
    // #1116: the EIP-712 author-attestation domain version
    // (`_EIP712_VERSION_HASH`) is bumped "2.0.0" → "3.0.0" — a DELIBERATE
    // breaking change for the context-graph-independent author attestation
    // (the `contextGraphId` struct field was removed). Pre-cutover
    // attestations no longer verify (acceptable pre-mainnet, no backcompat).
    // 10.1.0 — OT-RFC-49 catalog model + ACK domain separation (see
    //          `ACK_DIGEST_VERSION` below).
    // 10.1.1 — OT-RFC-51 "Publishing Allocation": realized publishing no
    //          longer credits per-node publishing allocation (K_n). The two
    //          guarded `addEpochProducedKnowledgeValue` writes (publish core
    //          + increase/extend delta) are removed; the publishing factor is
    //          now fed exclusively by committed PCA allocation. The
    //          `publisherNodeIdentityId` struct field is retained as a
    //          self-claimed attribution (no longer scoring).
    // 10.1.2 — Phase 10.x settle-on-spend: after each addCGValueForEpochRange
    //          (publish / extend / update) the CG's BIT weight leaf is settled via
    //          CGWeightTreeStorage so the value-weighted challenge draw sees fresh
    //          weights. No ACK / attestation change — PATCH bump keeps the EIP-712
    //          domain (major.minor "10.1") stable.
    // 10.1.3 — OT-RFC-53: CG registration-deposit consume wired into
    //          publish / update / extend (escrow-funded portion drawn from the CSS
    //          vault; wallet/PCA covers the remainder). PATCH bump — no ACK /
    //          EIP-712 domain change.
    // 10.1.4 — OT-RFC-53: the escrow-funded portion now pays the protocol treasury
    //          fee at consume, at parity with the wallet path's `_addTokens` — net
    //          distributed to stakers, fee routed out of the CSS vault to the
    //          treasury via `_chargeEscrowTreasuryFee`. Supersedes 10.1.3's
    //          gross-for-gross distribution. PATCH bump — no ACK / EIP-712 change.
    // 10.1.5 — Audit G-7: the CG value-write paths (extendKnowledgeAssetLifetime
    //          and the _executeUpdateCore delta) revert with
    //          CannotWriteValueToInactiveContextGraph on a deactivated CG, so a
    //          swept CG can no longer be re-stranded with sampling weight. PATCH
    //          bump — no ACK / EIP-712 change.
    // 10.1.6 — extendKnowledgeAssetLifetime reward epoch-range correction: the
    //          extension now funds [endEpoch + 1, endEpoch + epochs] (exactly
    //          `epochs` buckets) instead of [endEpoch, endEpoch + epochs], which
    //          double-funded endEpoch (already funded by publish through endEpoch)
    //          and paid one epoch past the purchased lifetime. Also rejects
    //          epochs == 0 (ZeroEpochs) before mutating/paying. PATCH bump — no
    //          ACK / EIP-712 change.
    // 10.1.7 — #1689: the publish authorization gate in `_executePublishCore`
    //          accepts EITHER the paying principal (`msg.sender`) OR the
    //          EIP-712-attested author (`p.authorAddress`), instead of the payer
    //          alone. Pure widening — the accepted set is a strict superset, so
    //          an OLD client against this contract is unaffected. Payer-of-
    //          record, the OT-RFC-53 escrow, the PCA discount and all TRAC
    //          transfers remain keyed to `msg.sender`. PATCH bump — no ABI, ACK
    //          or EIP-712 change. Clients gate their matching client-side
    //          relaxation on `version() >= 10.1.7`, so this exact string is a
    //          capability signal and must not be reused for anything else.
    string private constant _VERSION = "10.1.7";

    /// @notice OT-RFC-49 / WS-B Trap 3: domain-separation version prepended to the
    ///         RAW publish/update ACK preimage (`abi.encodePacked`, later wrapped by
    ///         `toEthSignedMessageHash` — this is NOT the EIP-712 author-attestation
    ///         domain, which keys on `_EIP712_VERSION_HASH`). Bumping this makes an
    ///         ACK signed under one field-set unusable against another, closing the
    ///         cross-attest replay window across the ciphertext→catalog cutover.
    ///         Off-chain ACK signers (`packages/core/src/crypto/ack.ts`) MUST prepend
    ///         the SAME value as the first 32-byte member or every publish/update
    ///         ACK fails `SignerIsNotNodeOperator`.
    uint256 public constant ACK_DIGEST_VERSION = 1;

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
        /// @notice V10 flat-KA Merkle leaf count (sorted + deduped), must match
        ///         off-chain `V10MerkleTree` built from the same publish payload.
        uint32 merkleLeafCount;
        // ── OT-RFC-49 / WS-B: curated-CG PUBLIC `_catalog` commitment ──
        /// @notice OT-RFC-49: Merkle root over the public `_catalog` leaves of this
        ///         publish (a dedicated `V10MerkleTree` over the catalog quads only —
        ///         `computeCatalogRoot`). This replaces the stripped ciphertext
        ///         commitment: cores hold zero private bytes and prove the public
        ///         catalog instead. MUST be `bytes32(0)` for public CGs (rejected
        ///         with `PublicCGCannotHaveCatalogCommitment` — a public CG already
        ///         commits its full set in `merkleRoot`). For curated CGs, MUST be
        ///         non-zero AND paired with a non-zero `catalogLeafCount`; otherwise
        ///         the publish reverts with `CuratedCGRequiresCatalogCommitment`.
        ///         Partial commitments (one zero, one non-zero) revert with
        ///         `IncompleteCatalogCommitment`.
        bytes32 catalogRoot;
        /// @notice OT-RFC-49: post sort+dedupe leaf count of the catalog tree
        ///         (== off-chain `V10MerkleTree.leafCount`, the curated random-
        ///         sampling draw modulus). Same zero-or-paired constraints as
        ///         `catalogRoot`.
        uint32 catalogLeafCount;
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
        // ── OT-RFC-43 Option 1 (variant 1a): caller-supplied deterministic id ──
        /// @notice The packed KA id this publish claims:
        ///         kaId = (uint160(authorAddress) << 96) | uint96(number),
        ///         pre-allocated off-chain (the reserved UAL). KAS enforces
        ///         `(reservedKaId >> 96) == authorAddress` at mint, so a wallet
        ///         can only mint within its own namespace. REQUIRED — there is
        ///         no auto-mint fallback under 1a; a value outside the author's
        ///         namespace reverts `KaIdNamespaceMismatch`. Deliberately NOT
        ///         added to the ACK digest: the namespace is enforced on-chain
        ///         and choosing a different number within one's own namespace is
        ///         harmless (OT-RFC-43; see PR description / R5 decision).
        uint256 reservedKaId;
        // ── ACK quorum (unchanged) ──
        uint72[] identityIds;
        bytes32[] r;
        bytes32[] vs;
    }

    /**
     * @notice V10 update input (grouped to bypass the 16-arg stack limit).
     *
     * `newTokenAmount` is the NEW TOTAL `tokenAmount` for the KA (not a delta).
     * KAV10 computes `delta = newTokenAmount - currentTokenAmount` internally
     * and charges the caller only for the delta via the conviction or direct
     * path. Metadata-only updates (`delta == 0`) are free but still require
     * a fresh ACK quorum.
     *
     * RFC-001: per-update publisher signature (`publisherNodeR/VS`) is removed.
     * `publisherNodeIdentityId` is now a self-claimed attribution field — same
     * semantics as in `PublishParams`. The author attestation fields below
     * (`authorAddress` / `authorR` / `authorVS` / `authorSchemeVersion`) are
     * verified on chain by `_verifyUpdateAuthorAttestation`, and the update is
     * gated owner-only (`ownerOf(kaId) == authorAddress`) — OT-RFC-45.
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
        // OT-RFC-49 / WS-B — catalog-commitment refresh. An update must rotate the
        // PUBLIC `_catalog` commitment in lockstep with the new merkle root; without
        // these fields a curated KA would leave its commitment frozen to the initial
        // publish and the random-sampling challenge surface would point at a stale
        // catalog after the first update. Same zero-or-paired contract as
        // `PublishParams`: zero for public-CG updates; both non-zero for curated
        // commitment rotation. Same byte widths as the prior ciphertext pair so the
        // positional calldata shape is unchanged.
        bytes32 newCatalogRoot;
        uint32 newCatalogLeafCount;
        // Greenfield: KA owner attestation (binds kaId + new merkle root).
        address authorAddress;
        bytes32 authorR;
        bytes32 authorVS;
        uint8 authorSchemeVersion;
    }

    // --- Hub-resolved dependencies ---

    AskStorage public askStorage;
    EpochStorage public epochStorage;
    DKGKnowledgeAssets public knowledgeAssetsStorage;
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
    /// @notice Phase 10.x BIT weight index — settled on every CG value spend so the
    ///         value-weighted challenge draw sees fresh weights (settle-on-spend).
    CGWeightTreeStorage public cgWeightTreeStorage;
    IDKGPublishingConvictionNFT public publishingConvictionNFT;

    // --- Errors ---

    error ZeroAddressDependency(string name);
    error ZeroContextGraphId();
    error ZeroEpochs();

    // --- OT-RFC-49 catalog-commitment errors ---

    /// @dev OT-RFC-49: a public-CG publish carried a non-zero catalog commitment
    ///      field. Public CGs already commit their full set in `merkleRoot`, so a
    ///      separate catalog commitment is meaningless — catches client bugs early
    ///      (a curated-only field leaking into a public publish would mislead
    ///      off-chain indexers about which KAs are sampleable).
    error PublicCGCannotHaveCatalogCommitment(uint256 contextGraphId);

    /// @dev A public-CG publish/update supplied `merkleLeafCount == 0`. Public KAs
    ///      are challenged against their `merkleLeafCount` by RandomSampling; zero
    ///      leaves make the KA permanently unchallengeable. Reject it at the source
    ///      so a griefer cannot pack a CG with live zero-leaf KAs that burn the
    ///      bounded `MAX_KA_RETRIES` sampling budget and skew/strand the whole CG.
    ///      (RandomSampling still SKIPS any such legacy KA defensively.) Curated KAs
    ///      are unaffected — they commit a separate `catalogLeafCount`.
    error PublicKARequiresMerkleLeafCount(uint256 contextGraphId);

    /// @dev A curated-CG publish or paid update attempted to introduce sampling
    ///      value without a full PUBLIC `_catalog` commitment. Post-RFC-49 cores
    ///      prove the catalog, not the ciphertext, so a curated KA without a catalog
    ///      commitment is unchallengeable by design — KAV10 must not let it enter
    ///      the value-weighted challenge surface.
    error CuratedCGRequiresCatalogCommitment(uint256 contextGraphId);

    /// @dev OT-RFC-49: a curated-CG publish carried a partial catalog commitment
    ///      (root without count, or vice versa). The two are meaningful only as a
    ///      pair — committing a root without a count would zero-divide the picker;
    ///      committing a count without a root would verify the proof against the
    ///      empty-tree zero. KAS would reject the partial state anyway via its own
    ///      `require`; KAV10's explicit error gives the caller a more diagnostic
    ///      revert.
    error IncompleteCatalogCommitment();

    // --- RFC-001 author attestation errors ---

    /// @dev `authorAddress == 0`. Every post-upgrade publish must carry a
    ///      verified author. There is no zero-default opt-out (RFC-001 §3.1).
    error AuthorRequired();
    error InvalidKnowledgeAssetsAmount(uint256 amount);
    error NotKnowledgeAssetOwner(uint256 kaId, address owner, address caller);

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
    /// `keccak256("AuthorAttestation(bytes32 merkleRoot,address authorAddress,uint8 schemeVersion,uint256 reservedKaId)")`.
    /// @dev #1116: the seal is now CONTEXT-GRAPH-INDEPENDENT — `contextGraphId`
    ///      was removed from the author attestation so an assertion can be
    ///      finalized (sealed) BEFORE its CG is registered on-chain. The CG is
    ///      still bound to the publication via `PublishParams.contextGraphId`
    ///      (mint target / `isAuthorizedPublisher` / KA→CG registration) and the
    ///      separate ACK digest — just not by the author signature. The domain
    ///      version (`_EIP712_VERSION_HASH`) is bumped to 3.0.0 for the cutover.
    /// @dev OT-RFC-43 Option-1 (variant 1a): `reservedKaId` is bound into the
    ///      author attestation so the author signs the *slot* (the packed
    ///      `(author << 96) | number`) as well as the content. Without it a
    ///      delegated publisher/relay could mint the author's content at a
    ///      different number inside the author's own namespace — the on-chain
    ///      guard only enforces `(reservedKaId >> 96) == author` (the
    ///      namespace), not the number. Mirrors `UpdateAuthorAttestation`,
    ///      which already binds `kaId`.
    bytes32 private constant _AUTHOR_ATTESTATION_TYPEHASH =
        keccak256(
            "AuthorAttestation(bytes32 merkleRoot,address authorAddress,uint8 schemeVersion,uint256 reservedKaId)"
        );

    bytes32 private constant _UPDATE_AUTHOR_ATTESTATION_TYPEHASH =
        keccak256(
            "UpdateAuthorAttestation(uint256 kaId,bytes32 newMerkleRoot,address authorAddress,uint8 schemeVersion)"
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
    bytes32 private constant _EIP712_NAME_HASH = keccak256(bytes("KnowledgeAssetsLifecycle"));

    /// @dev `version` hash for the EIP-712 domain — must match the off-chain
    ///      attestation builder (`AUTHOR_ATTESTATION_DOMAIN_VERSION`). #1116:
    ///      bumped 2.0.0 → 3.0.0 for the CONTEXT-GRAPH-INDEPENDENT author
    ///      attestation cutover (the `contextGraphId` struct field was removed),
    ///      which deliberately invalidates any pre-cutover attestation. Patch
    ///      bumps do not change this — only a deliberate breaking change does.
    bytes32 private constant _EIP712_VERSION_HASH = keccak256(bytes("3.0.0"));

    /// @dev Magic value returned by EIP-1271-compliant smart wallets on a
    ///      successful signature check. `bytes4(keccak256("isValidSignature(bytes32,bytes)"))`.
    bytes4 private constant _ERC1271_MAGIC_VALUE = 0x1626ba7e;

    // --- Update-specific errors (V10 Phase 8 Task 2) ---

    /// @dev Update would reduce the KA's `tokenAmount` below its current
    ///      value. Rebates are not supported — a publisher that wants to
    ///      downsize must let the KA expire and republish. (decision #4)
    error CannotShrinkTokenAmount(uint96 currentTokenAmount, uint96 newTokenAmount);

    /// @dev Caller is attempting a paid update (`newTokenAmount >
    ///      currentTokenAmount`) but the KA has no full epoch of remaining
    ///      lifetime (`currentEpoch == endEpoch`). No distribution vehicle
    ///      exists for the extra tokens — the publisher must extend the
    ///      lifetime via `extendKnowledgeAssetLifetime` before growing
    ///      byte size or tokenAmount in the final epoch.
    error NoRemainingLifetimeForDelta(uint256 kaId, uint40 currentEpoch, uint40 endEpoch);

    /// @dev KA has no CG binding recorded (`kaToContextGraph[kaId] == 0`).
    ///      This is a corrupt-state assertion: publish atomically binds
    ///      kaId → cgId, so a missing binding indicates a Phase 7 storage
    ///      invariant was violated. Update cannot proceed without knowing
    ///      the CG because the CG value ledger needs the target cgId.
    error MissingContextGraphBinding(uint256 kaId);

    /// @dev G-7: a CG value-write (extend / update delta) targeted a context graph
    ///      that has been deactivated (e.g. swept via `sweepContextGraphEscrow`).
    ///      Writing value to it would re-strand sampling weight onto an inactive CG
    ///      — which `RandomSampling._pickWeightedChallengeFull` treats as a draw
    ///      miss that burns a retry — and would brick the admin re-sweep. A retired
    ///      CG must stay retired.
    error CannotWriteValueToInactiveContextGraph(uint256 contextGraphId);

    /// @notice OT-RFC-53: CG registration escrow spent to fund publishing.
    event RegistrationEscrowConsumed(uint256 indexed contextGraphId, uint96 amount);

    constructor(address hubAddress) ContractStatus(hubAddress) {}

    function initialize() public onlyHub {
        askStorage = AskStorage(hub.getContractAddress("AskStorage"));
        epochStorage = EpochStorage(hub.getContractAddress("EpochStorageV8"));
        knowledgeAssetsStorage = DKGKnowledgeAssets(
            hub.getAssetStorageAddress("DKGKnowledgeAssets")
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

        // ContextGraphStorage is resolved directly for read-only `kaToContextGraph`
        // lookups on the update path. The facade does not expose a KA→CG view
        // getter, and caching the storage here avoids a double-hop SLOAD via
        // `contextGraphs.contextGraphStorage()` on every update. Writes still
        // go through the facade (auth + atomic bind in `publish`).
        address cgsAddr = hub.getAssetStorageAddress("ContextGraphStorage");
        if (cgsAddr == address(0)) revert ZeroAddressDependency("ContextGraphStorage");
        contextGraphStorage = ContextGraphStorage(cgsAddr);

        address cgvAddr = hub.getContractAddress("ContextGraphValueStorage");
        if (cgvAddr == address(0)) revert ZeroAddressDependency("ContextGraphValueStorage");
        contextGraphValueStorage = ContextGraphValueStorage(cgvAddr);

        address cgwtAddr = hub.getContractAddress("CGWeightTreeStorage");
        if (cgwtAddr == address(0)) revert ZeroAddressDependency("CGWeightTreeStorage");
        cgWeightTreeStorage = CGWeightTreeStorage(cgwtAddr);

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
     * @notice Publish a knowledge asset.
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
     *   across the published KA's epoch range via
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
     * @return kaId Newly created knowledge asset id.
     */
    // Defense-in-depth perimeter on the three KAV10 entrypoints
    // (`publish`, `update`, `extendKnowledgeAssetLifetime`). KAS
    // mint dispatches an ERC-1155 receiver acceptance callback to the
    // publisher; `nonReentrant` keeps that callback from re-entering
    // these entrypoints. No behaviour change for valid callers.
    function publish(PublishParams calldata p) external nonReentrant returns (uint256 kaId) {
        uint40 currentEpoch;
        (currentEpoch, kaId) = _executePublishCore(p);

        // OT-RFC-53: spend the CG owner's prepaid registration escrow first
        // (no-op for third-party publishers into an open CG, or when the CG has no
        // escrow). The net (after the treasury fee) is distributed here over the
        // publish window; the wallet covers the remainder below.
        (uint96 netEscrow, uint96 walletCost) = _consumeEscrowNet(p.contextGraphId, p.tokenAmount);
        if (netEscrow > 0) {
            _distributeTokens(netEscrow, p.epochs, currentEpoch);
        }
        if (walletCost == 0) {
            return kaId;
        }

        // PCA branch eligibility:
        //   (1) `msg.sender` is registered as an agent on a PCA,
        //   (2) the PCA is NOT past its expiry timestamp,
        //   (3) `p.epochs == lockDurationEpochs` (the discount tier was
        //       paid up-front for a KA lifetime of exactly that many
        //       epochs; anything shorter would orphan post-KA windows
        //       against passive sweeps, anything longer would extend the
        //       active sink past the escrow runway).
        //
        // ALL three must hold to take the PCA path. If any fails, the
        // publisher falls through to direct spend at full price — a
        // stale agent registration on an expired PCA, or a publish
        // submitted with the wrong epoch count, MUST NOT brick the
        // publisher (Codex round-3 finding on PR #470). `update()`
        // has a parallel gate (with `<=` instead of `==` since update
        // legitimately passes the KA's remaining lifetime, a delta).
        uint256 convictionAccountId = publishingConvictionNFT.agentToAccountId(msg.sender);
        bool useConviction;
        if (convictionAccountId != 0) {
            (,,,, uint40 expiresAtTimestamp, uint16 lockDurationEpochs,,,,,) =
                publishingConvictionNFT.accounts(convictionAccountId);
            useConviction =
                block.timestamp < uint256(expiresAtTimestamp) &&
                p.epochs == uint256(lockDurationEpochs);
        }

        // Discount branch when eligible; otherwise (or on a PCA-side payment
        // failure) direct spend. The conviction attempt MUST NOT brick the
        // publisher — agent registration is permissionless and consent-free,
        // so an underfunded account a third party registered us against falls
        // through here instead of reverting. See {_coverViaConvictionOrFallThrough}.
        if (useConviction) {
            useConviction = _coverViaConvictionOrFallThrough(
                walletCost,
                currentEpoch,
                uint40(p.epochs)
            );
        }

        if (!useConviction) {
            // Direct-spend branch. `transferFrom(msg.sender, CSS, fullCost)`
            // + epoch-range distribution.
            //
            // OT-RFC-51 "Publishing Allocation": realized publishing no
            // longer feeds the RandomSampling publishing factor. The
            // publishing factor is now driven exclusively by COMMITTED PCA
            // publishing allocation (seeded in `PublishingConviction`), so
            // this branch no longer credits `addEpochPublishingAllocation`.
            // `publisherNodeIdentityId` is still recorded on the publish
            // struct as a self-claimed attribution field, but it is no
            // longer crediting any node's K_n.
            uint96 netTokenAmount = _addTokens(walletCost);
            _distributeTokens(netTokenAmount, p.epochs, currentEpoch);
        }

        return kaId;
    }

    /**
     * @dev Attempt to fund a publish/update via the caller's conviction
     *      account (PCA discount branch). Returns `true` if the cost was
     *      covered via conviction, `false` if the caller should fall through
     *      to direct spend.
     *
     *      Audit fix: agent registration is permissionless and requires no
     *      consent from the agent (RFC-001 §3.6). A hard revert here let an
     *      attacker register a victim against a deliberately-underfunded
     *      account and brick that victim's paid publishes/updates. We
     *      therefore swallow ONLY the PCA-side "cannot pay" errors
     *      (`InsufficientAllowance`, `AccountExpired`) and fall through to
     *      direct spend — mirroring the gate's existing
     *      "stale registration MUST NOT brick the publisher" intent. Any
     *      other revert is a genuine fault and is re-thrown unchanged so we
     *      never mask real bugs or silently downgrade on unexpected state.
     *
     *      `coverPublishingCost` is an external call to the NFT contract, so
     *      a revert rolls back all of its state writes atomically — the
     *      fall-through starts from clean state with no partial PCA effects.
     */
    function _coverViaConvictionOrFallThrough(
        uint96 baseCost,
        uint40 kaStartEpoch,
        uint40 kaEpochs
    ) internal returns (bool covered) {
        try publishingConvictionNFT.coverPublishingCost(msg.sender, baseCost, kaStartEpoch, kaEpochs) returns (
            uint96
        ) {
            return true;
        } catch (bytes memory reason) {
            bytes4 selector;
            if (reason.length >= 4) {
                // solhint-disable-next-line no-inline-assembly
                assembly {
                    selector := mload(add(reason, 0x20))
                }
            }
            // Selectors come from {IPublishingConvictionErrors} — the SAME
            // declarations `PublishingConviction` reverts with — so the
            // compiler keeps the catch side and the revert side in lock-step;
            // a signature change there breaks this file too.
            if (
                selector == IPublishingConvictionErrors.InsufficientAllowance.selector ||
                selector == IPublishingConvictionErrors.AccountExpired.selector
            ) {
                // Expected "cannot pay via conviction" — fall through.
                return false;
            }
            // Unexpected fault — bubble up verbatim.
            // solhint-disable-next-line no-inline-assembly
            assembly {
                revert(add(reason, 0x20), mload(reason))
            }
        }
    }

    // ========================================================================
    // Internal: Shared publish core
    // ========================================================================

    /**
     * @notice Signature verification + auth + validation + KAS create +
     *         atomic CG bind + CG value write.
     *
     * Both `publish` and `publishDirect` run this before branching on
     * payment path. No TRAC movement happens here — the caller's path
     * handles that.
     */
    function _executePublishCore(
        PublishParams calldata p
    ) internal returns (uint40 currentEpoch, uint256 kaId) {
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

        if (p.knowledgeAssetsAmount != 1) {
            revert InvalidKnowledgeAssetsAmount(p.knowledgeAssetsAmount);
        }

        // ACK digest. H5 chain/contract prefix mirrors the prior design.
        // Field set per PRD (V10 protocol core §9 "Publish Flow — Contract
        // Verification") and decision #25 Option B, extended with V10 flat-KA
        // Merkle metadata:
        //   (ACK_DIGEST_VERSION, chainid, address(this), contextGraphId, merkleRoot,
        //    knowledgeAssetsAmount, byteSize, epochs, tokenAmount, merkleLeafCount,
        //    catalogRoot, catalogLeafCount, isImmutable)
        //
        // OT-RFC-49 / WS-B Trap 3 (ACK cross-attest): `ACK_DIGEST_VERSION` is
        // prepended as the FIRST packed member of the RAW `abi.encodePacked`
        // preimage (this is what `toEthSignedMessageHash` then wraps — it is NOT
        // EIP-712, so the `_EIP712_VERSION_HASH` domain bump does NOT cover this
        // surface). Domain-separating the preimage by version makes an ACK signed
        // for the OLD ciphertext field-set unusable against the NEW catalog
        // field-set (and vice versa), closing the cross-attest replay window across
        // the strip cutover. `catalogRoot`/`catalogLeafCount` replace the stripped
        // `ciphertextChunksRoot`/`ciphertextChunkCount` at positions 10/11.
        //
        // The publisher node identity is NOT part of the ACK digest — it lives
        // only in the publisher digest above. ACK signers attest to the
        // publication's economic + content shape; the publishing node is a
        // separate authority verified separately. Mixing the two would break
        // off-chain spec-conformant signers.
        bytes32 ackDigest = keccak256(
            abi.encodePacked(
                ACK_DIGEST_VERSION,
                block.chainid,
                address(this),
                p.contextGraphId,
                p.merkleRoot,
                p.knowledgeAssetsAmount,
                uint256(p.byteSize),
                uint256(p.epochs),
                uint256(p.tokenAmount),
                uint256(p.merkleLeafCount),
                p.catalogRoot,
                uint256(p.catalogLeafCount),
                p.isImmutable ? uint256(1) : uint256(0)
            )
        );
        _verifySignatures(p.identityIds, ECDSA.toEthSignedMessageHash(ackDigest), p.r, p.vs);

        // --- 2. CG existence + validation (revert before any state mutation) ---

        // Decision #3: contextGraphId == 0 is forbidden. No legacy path.
        if (p.contextGraphId == 0) revert ZeroContextGraphId();

        // Same-contract input validation — without this, epochs == 0 would
        // flow through `_validateTokenAmount` (which computes 0), through
        // KAS create, and only revert downstream in
        // `ContextGraphValueStorage.addCGValueForEpochRange` with
        // `ZeroLifetime`. That downstream error hides the real cause from
        // the caller. Fail fast here with a KAV10-local diagnostic.
        if (p.epochs == 0) revert ZeroEpochs();

        // OT-RFC-49 / WS-B: validate the curated PUBLIC `_catalog` commitment shape
        // BEFORE any state mutation, so a mistyped client can't half-write a KA.
        //
        // Semantics:
        //   - Public CG + any non-zero catalog field → revert
        //     (catches client bugs; curated-only payload leaking to public — a
        //     public CG already commits its full set in `merkleRoot`).
        //   - Curated CG + both fields non-zero → commitment
        //     persisted; KA participates in curated draw against its catalog.
        //   - Curated CG + both fields zero → revert
        //     (a curated KA with no catalog commitment is unprovable post-strip and
        //     must not enter value-weighted sampling state).
        //   - Curated CG + exactly one field zero → revert
        //     (partial commitment would zero-divide the picker or verify
        //     against the empty-tree zero).
        //
        // The cached `_hasCatalogCommitment` carries the populate decision
        // forward to the post-create persistence call below — avoids a
        // second pair of zero-checks that already gated this branch.
        bool _isCurated = contextGraphStorage.getIsCurated(p.contextGraphId);
        bool _hasCatalogCommitment =
            p.catalogRoot != bytes32(0) || p.catalogLeafCount != 0;
        if (_isCurated) {
            if (!_hasCatalogCommitment) {
                revert CuratedCGRequiresCatalogCommitment(p.contextGraphId);
            }
            if (p.catalogRoot == bytes32(0) || p.catalogLeafCount == 0) {
                revert IncompleteCatalogCommitment();
            }
        } else {
            if (_hasCatalogCommitment) {
                revert PublicCGCannotHaveCatalogCommitment(p.contextGraphId);
            }
            // F08 (audit follow-up): a public KA is sampled against its
            // `merkleLeafCount`; zero makes it unchallengeable. Reject at publish so
            // no new live zero-leaf KA can grief a CG's challenge draw.
            if (p.merkleLeafCount == 0) {
                revert PublicKARequiresMerkleLeafCount(p.contextGraphId);
            }
        }

        // H7: SafeCast guards the uint96 cast in _validateTokenAmount.
        _validateTokenAmount(p.byteSize, p.epochs, p.tokenAmount, false);

        // #1689: publish authorization is satisfied by EITHER of the two
        // principals this publish carries — it is NOT a single-principal gate.
        //
        //   1. `msg.sender` — the PAYING principal. Checked FIRST because it is
        //      the common, already-working case, so the second `eth_call` into
        //      the facade is only made when the payer alone does not suffice.
        //   2. `p.authorAddress` — the EIP-712-ATTESTED AUTHOR. It is proven
        //      immediately above by `_verifyAuthorAttestation` (non-zero via
        //      `AuthorRequired`, then ECDSA-recovered for EOAs or ERC-1271-
        //      validated for contract wallets). A forged author claim has
        //      already reverted, so the author is exactly as trustworthy an
        //      authorization principal here as `msg.sender` is.
        //
        // Why: `isAuthorizedPublisher` requires exact equality with the single
        // stored authority for a curated CG in EOA/Safe mode. A curator whose
        // agent identity is wallet `A` could therefore only publish from `A`
        // itself — any distinct funded operational / async-publisher wallet `P`
        // was rejected, so delegating payment meant sharing the curator key.
        //
        // This SUPERSEDES, and deliberately does NOT revert, the N17 closure.
        // N17 addressed a DIFFERENT axis — recovered node signer vs paying
        // principal — and its conclusion is retained verbatim below: we pass the
        // paying principal, never the node signer, because authorizing the node
        // signer both rejected a paying agent whose node happened to run the
        // signing and approved a non-authorized agent that a node it did not
        // control had signed off. #1689 only ADDS a second accepted principal on
        // top of that. It is a pure widening: every publish that authorized
        // before still authorizes, so the shipped #1778 flow (author is a CG
        // member, the authorized curator pays) is untouched.
        //
        // Scope is AUTHORIZATION ONLY. Everything economic and every attribution
        // stays keyed to `msg.sender` and is intentionally unchanged here:
        // publisher-of-record (`createKnowledgeAsset(msg.sender, ...)` below),
        // the OT-RFC-53 CG registration escrow (`_useCgEscrow`), the PCA
        // discount lookup (`agentToAccountId(msg.sender)` in `publish`), and
        // every TRAC transfer. Re-keying any of those to the author would let a
        // holder of an author attestation spend the AUTHOR's escrow or discount,
        // turning an attacker-funded action into a victim-funded one.
        //
        // The revert argument stays `msg.sender` — the ABI is unchanged. The
        // richer two-principal diagnosis is produced client-side, where
        // operators actually read it.
        if (
            !contextGraphs.isAuthorizedPublisher(p.contextGraphId, msg.sender) &&
            !contextGraphs.isAuthorizedPublisher(p.contextGraphId, p.authorAddress)
        ) {
            revert KnowledgeAssetsLib.UnauthorizedPublisher(p.contextGraphId, msg.sender);
        }

        // --- 3. Create KA in storage ---

        DKGKnowledgeAssets kas = knowledgeAssetsStorage;
        currentEpoch = uint40(chronos.getCurrentEpoch());

        // Publisher of record + gas/TRAC payer = `msg.sender` (the paying
        // agent). This address is stored as `merkleRoots[0].publisher` in KAS
        // as the publisher-of-record. It is NOT the KA owner (the NFT is
        // `_safeMint`'d to `author` = `p.authorAddress`) and update authority
        // is NOT pinned to it — updates are owner-only (`ownerOf(kaId)` ==
        // attested author, OT-RFC-45). Passing the recovered node signer here
        // would record the node operator wallet as the original publisher and
        // break payer attribution.
        // `author` = `p.authorAddress`, the address verified by
        // `_verifyAuthorAttestation` above. The chain commits the recovered
        // identity into KAS's parallel `merkleRootAuthors[kaId][0]` map
        // so off-chain readers (`/api/get`, indexers) can return the
        // canonical author without re-deriving from the EIP-712
        // signature embedded in calldata.
        kaId = kas.createKnowledgeAsset(
            msg.sender,
            p.authorAddress,
            p.reservedKaId,
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

        // --- 3b. OT-RFC-49 / WS-B: persist the curated PUBLIC `_catalog` commitment ---
        //
        // Only fires when the upfront validation above set
        // `_hasCatalogCommitment = true` (curated CG, both fields non-zero).
        // Public CGs and partial-commitment attempts have already returned or
        // reverted above — this branch is the "full commitment" path. KAS's
        // `setCatalogCommitment` re-asserts the non-zero invariants as a defensive
        // crosscheck against contract-pair drift.
        if (_hasCatalogCommitment) {
            kas.setCatalogCommitment(kaId, p.catalogRoot, p.catalogLeafCount);
        }

        // --- 4. N20: atomic CG↔KA binding + CG value diff ---

        // Facade write: kaToContextGraph[kaId] = cgId AND contextGraphKaList[cgId].push(kaId).
        contextGraphs.registerKnowledgeAsset(p.contextGraphId, kaId);

        // Per-CG + global value ledger for value-weighted random challenges.
        // Uses BASE `tokenAmount` — value weighting tracks data value, not
        // publisher economics (discounted cost is irrelevant here).
        contextGraphValueStorage.addCGValueForEpochRange(
            p.contextGraphId,
            uint256(currentEpoch),
            uint256(p.epochs),
            uint256(p.tokenAmount)
        );
        // settle-on-spend: reconcile the BIT weight leaf to the new ledger truth.
        cgWeightTreeStorage.settle(p.contextGraphId);

        // OT-RFC-51 "Publishing Allocation": realized publishing no longer
        // credits per-node publishing allocation (K_n). The RandomSampling
        // publishing factor is now fed exclusively by COMMITTED PCA
        // allocation, seeded/moved in `PublishingConviction`. The former
        // `addEpochProducedKnowledgeValue(publisherNodeIdentityId, ...)`
        // write has been removed here. `publisherNodeIdentityId` remains a
        // self-claimed attribution field on the publish struct but no longer
        // drives scoring, so there is no longer a `nodeExists` gate to apply.
    }

    // ========================================================================
    // Lifetime Extension (V8-compatible, no ACK change needed)
    // ========================================================================

    function extendKnowledgeAssetLifetime(
        uint256 id,
        uint40 epochs,
        uint96 tokenAmount
    ) external nonReentrant {
        DKGKnowledgeAssets kas = knowledgeAssetsStorage;

        (, , , uint88 byteSize, , uint40 endEpoch, uint96 oldTokenAmount, ) = kas.getKnowledgeAssetMetadata(id);

        uint256 currentEpoch = chronos.getCurrentEpoch();
        if (currentEpoch > endEpoch) {
            revert KnowledgeAssetLib.KnowledgeAssetExpired(id, currentEpoch, endEpoch);
        }

        // Reject a zero-epoch extension BEFORE any metadata mutation or payment:
        // it is semantically a no-op, and the reward range below
        // ([endEpoch + 1, endEpoch + epochs]) would otherwise invert to
        // [endEpoch + 1, endEpoch] and underflow inside EpochStorage (an internal
        // arithmetic panic instead of a stable API error). Matches publish's
        // ZeroEpochs guard.
        if (epochs == 0) {
            revert ZeroEpochs();
        }

        kas.setEndEpoch(id, endEpoch + epochs);
        kas.setTokenAmount(id, oldTokenAmount + tokenAmount);

        _validateTokenAmount(byteSize, epochs, tokenAmount, false);

        // V10 KCs always have a CG binding (Phase 7 invariant); legacy V8 KCs
        // return cgId == 0 and skip both the escrow draw and the CG-value write.
        uint256 cgId = contextGraphStorage.kaToContextGraph(id);

        // OT-RFC-53: spend the CG owner's prepaid registration escrow first. The net
        // (after the treasury fee) is distributed over the extension window; the
        // wallet covers the remainder. The CG-value write below stays on the GROSS
        // `tokenAmount` regardless of payment source, so random-sampling weight
        // tracks the publisher's full committed value.
        //
        // Reward epoch-range: the ORIGINAL publish funds the staker pool THROUGH
        // `endEpoch` inclusive — `_distributeTokens` lands its final allocation on
        // `currentEpoch + epochs == endEpoch`. The extension must therefore begin
        // at `endEpoch + 1` and span exactly `epochs` buckets
        // `[endEpoch + 1, endEpoch + epochs]` (`addTokensToEpochRange` is
        // inclusive). Starting at `endEpoch` (the prior behaviour) double-funded
        // that epoch and paid one epoch past the purchased lifetime. NOTE: the
        // CG-value write below legitimately starts at `endEpoch` — on that side the
        // publish contribution retracts AT `endEpoch`, so the two seams differ by
        // one by construction; each abuts its own publish window with no overlap.
        (uint96 netEscrow, uint96 walletCost) = _consumeEscrowNet(cgId, tokenAmount);
        if (netEscrow > 0) {
            epochStorage.addTokensToEpochRange(1, endEpoch + 1, endEpoch + epochs, netEscrow);
        }
        if (walletCost > 0) {
            // Pull gross from the publisher, distribute net into the pool.
            uint96 netTokenAmount = _addTokens(walletCost);
            epochStorage.addTokensToEpochRange(1, endEpoch + 1, endEpoch + epochs, netTokenAmount);
        }

        // Phase 1+8 cross-phase fix: extending a KC's lifetime grows the CG's
        // value-weighted random-sampling contribution. Pin the diff over the
        // EXTENSION window only, starting at the (old) endEpoch — the original
        // publish window already wrote its diff that retracts at the original
        // endEpoch as designed.
        if (epochs > 0 && tokenAmount > 0 && cgId != 0) {
            // G-7: never re-strand sampling weight onto a deactivated CG.
            if (!contextGraphStorage.isContextGraphActive(cgId)) {
                revert CannotWriteValueToInactiveContextGraph(cgId);
            }
            contextGraphValueStorage.addCGValueForEpochRange(
                cgId,
                uint256(endEpoch),
                uint256(epochs),
                uint256(tokenAmount)
            );
            // settle-on-spend (merged from main): reconcile the BIT weight leaf
            // to the new ledger truth after the extension value write.
            cgWeightTreeStorage.settle(cgId);
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
            revert KnowledgeAssetLib.SignaturesSignersMismatch(r.length, vs.length, identityIds.length);
        }

        uint256 minSigs = parametersStorage.minimumRequiredSignatures();

        if (r.length < minSigs) {
            revert KnowledgeAssetLib.MinSignaturesRequirementNotMet(minSigs, r.length);
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
            revert KnowledgeAssetLib.InvalidSignature(identityId, messageHash, _r, _vs);
        }

        if (
            !identityStorage.keyHasPurpose(identityId, keccak256(abi.encodePacked(signer)), IdentityLib.OPERATIONAL_KEY)
        ) {
            revert KnowledgeAssetLib.SignerIsNotNodeOperator(identityId, signer);
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
     * `merkleRoot` to a specific (authorAddress, schemeVersion, reservedKaId)
     * — leaked signatures cannot be redirected to a different content root, a
     * different author identity, or a different KA id/slot.
     *
     * The seal is intentionally context-graph-independent (#1116): an
     * assertion can be sealed before its CG is registered on-chain. CG
     * binding happens at publish via `PublishParams.contextGraphId` plus the
     * separate ACK digest, not by this author signature.
     *
     * Replay defense is the one-shot consumption of the author-namespaced
     * `reservedKaId` (the packed `(uint160(author) << 96) | uint96(number)`
     * slot) at the `DKGKnowledgeAssets` layer; no `signedAtBlock` window is
     * included in the digest (see RFC-001 §3.2).
     */
    function _hashAuthorAttestation(
        bytes32 _merkleRoot,
        address _authorAddress,
        uint8 _schemeVersion,
        uint256 _reservedKaId
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
                _merkleRoot,
                _authorAddress,
                _schemeVersion,
                _reservedKaId
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
    function _hashUpdateAuthorAttestation(
        uint256 kaId,
        bytes32 newMerkleRoot,
        address authorAddress,
        uint8 schemeVersion
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
                _UPDATE_AUTHOR_ATTESTATION_TYPEHASH,
                kaId,
                newMerkleRoot,
                authorAddress,
                schemeVersion
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
    }

    function _verifyUpdateAuthorAttestation(UpdateParams calldata p) internal view {
        if (p.authorAddress == address(0)) revert AuthorRequired();
        if (p.authorSchemeVersion != 1) revert UnsupportedAuthorScheme(p.authorSchemeVersion);

        bytes32 digest = _hashUpdateAuthorAttestation(
            p.id,
            p.newMerkleRoot,
            p.authorAddress,
            p.authorSchemeVersion
        );

        if (p.authorAddress.code.length == 0) {
            address recovered = ECDSA.tryRecover(digest, p.authorR, p.authorVS);
            if (recovered == address(0) || recovered != p.authorAddress) {
                revert InvalidAuthorSignature();
            }
        } else {
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

    function _verifyAuthorAttestation(PublishParams calldata p) internal view {
        if (p.authorAddress == address(0)) revert AuthorRequired();
        if (p.authorSchemeVersion != 1) revert UnsupportedAuthorScheme(p.authorSchemeVersion);

        bytes32 digest = _hashAuthorAttestation(
            p.merkleRoot,
            p.authorAddress,
            p.authorSchemeVersion,
            p.reservedKaId
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

        // Strict-positive `tokenAmount` floor. The expected-cost formula
        // `(ask * byteSize * window) / 1024` flows through integer
        // truncation; for `(ask * byteSize * window) < 1024` the
        // expected cost collapses to 0 and the under-payment branch
        // below becomes unreachable on `tokenAmount == 0`. The explicit
        // floor ensures publish / lifetime-extension always charge a
        // non-zero economic cost regardless of input rounding. The
        // update path is unaffected (pure metadata updates skip this
        // validator entirely — gated on `newByteSize > currentByteSize`).
        if (tokenAmount == 0) {
            revert KnowledgeAssetLib.InvalidTokenAmount(1, 0);
        }

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
            revert KnowledgeAssetLib.InvalidTokenAmount(expectedTokenAmount, tokenAmount);
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
    /// @dev Protocol treasury fee (in TRAC) skimmed from `amount`. Returns
    ///      `(0, address(0))` while no treasury is wired or the fee is 0, so
    ///      callers can branch on `treasury != address(0)`.
    /// @param amount Gross staker-bound TRAC the fee is computed against.
    /// @return fee Treasury cut in TRAC (0 when no treasury or 0 bps).
    /// @return treasury Configured `protocolTreasury` (address(0) when unset).
    function _treasuryFee(uint96 amount) internal view returns (uint96 fee, address treasury) {
        treasury = parametersStorage.protocolTreasury();
        if (treasury == address(0)) {
            return (0, address(0));
        }
        uint16 bps = parametersStorage.protocolTreasuryFee();
        if (bps == 0) {
            return (0, treasury);
        }
        // bps is capped at MAX_PROTOCOL_TREASURY_FEE (1_000 = 10%), so
        // `fee <= amount / 10` and `net = amount - fee` never underflows.
        fee = uint96((uint256(amount) * uint256(bps)) / 10_000);
    }

    /// @dev Pulls `tokenAmount` (gross) from the publisher, routing the
    ///      protocol treasury fee to `protocolTreasury` and the remainder
    ///      (net) into the conviction-staking vault. Returns the net amount so
    ///      callers distribute only what actually reached the staker pool.
    function _addTokens(uint96 tokenAmount) internal returns (uint96 net) {
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

        (uint96 fee, address treasury) = _treasuryFee(tokenAmount);
        net = tokenAmount - fee;

        if (!token.transferFrom(msg.sender, address(convictionStakingStorage), net)) {
            revert TokenLib.TransferFailed();
        }
        // Defence-in-depth: only move the fee when a real recipient is wired.
        // `_treasuryFee` already returns fee == 0 when `protocolTreasury` is
        // the zero address, so this is belt-and-braces — it keeps the
        // "never transfer to address(0)" invariant local to this function
        // and survives any future change to the fee helper. Note: if this
        // branch is ever skipped while `fee > 0`, the uncollected `fee`
        // simply stays with the publisher (never minted, never burned).
        if (fee > 0 && treasury != address(0)) {
            if (!token.transferFrom(msg.sender, treasury, fee)) {
                revert TokenLib.TransferFailed();
            }
        }
    }

    /// @dev OT-RFC-53: applies the protocol treasury fee to an escrow-funded spend.
    ///      The registration deposit is escrowed GROSS in the CSS vault, so when
    ///      escrow funds a publish/update/extend the treasury fee owed on the
    ///      consumed portion is routed out of the vault to the treasury here —
    ///      mirroring `_addTokens` for the wallet path, so escrow-funded publishing
    ///      is NOT a treasury-fee loophole. Returns the net (escrow − fee) for the
    ///      caller to distribute to the staker pool. No-op (returns `fromEscrow`)
    ///      while the treasury is unset or the fee is 0 (`_treasuryFee` returns 0).
    function _chargeEscrowTreasuryFee(uint96 fromEscrow) internal returns (uint96 net) {
        (uint96 fee, address treasury) = _treasuryFee(fromEscrow);
        net = fromEscrow - fee;
        if (fee > 0 && treasury != address(0)) {
            convictionStakingStorage.transferRegistrationDepositFee(treasury, fee);
        }
    }

    /// @dev OT-RFC-53: consume the CG owner's prepaid escrow for `amount` and charge
    ///      the treasury fee on the consumed portion — the SHARED escrow accounting
    ///      for publish / extend / update (kept in one place so fee/escrow changes
    ///      stay in sync). Returns the NET escrow (after fee) for the caller to
    ///      distribute over its own window, plus the wallet remainder still owed.
    ///      No-op (0 net, full `walletRemainder`) when the CG has no escrow or the
    ///      caller isn't the owner (`_useCgEscrow` returns 0).
    function _consumeEscrowNet(uint256 contextGraphId, uint96 amount)
        internal
        returns (uint96 netEscrow, uint96 walletRemainder)
    {
        uint96 fromEscrow = _useCgEscrow(contextGraphId, amount);
        netEscrow = fromEscrow > 0 ? _chargeEscrowTreasuryFee(fromEscrow) : 0;
        walletRemainder = amount - fromEscrow;
    }

    // ========================================================================
    // V10 Update Entries
    // ========================================================================

    /**
     * @notice Update an existing knowledge asset via publisher conviction
     *         account (discounted path). Closes N16, N19 (local ceiling removal),
     *         and decision #4.
     *
     * Authorization: owner-only, enforced in `_executeUpdateCore` — the
     * EIP-712-attested author MUST equal `ownerOf(kaId)`, independent of CG
     * publish policy. There is no curator/PCA delegation on the update path
     * (delegation applies to publish only); to change who may update, transfer
     * the NFT. This supersedes the initial ERC-1155 `balanceOf` gate, which
     * was unsound under ERC-1155Delta transferability: any downstream buyer of
     * a single KA token inherited full update authority. See OT-RFC-45.
     *
     * Delta-only payment semantics (decision #4 interpretation): the caller
     * passes `newTokenAmount` as the NEW TOTAL `tokenAmount` for the KA. KAV10
     * charges only `delta = newTokenAmount - currentTokenAmount` via
     * `coverPublishingCost`. Rebates are rejected (`CannotShrinkTokenAmount`).
     * Metadata-only updates (`delta == 0`) bypass `coverPublishingCost`
     * entirely — no conviction spend, no zero-value NFT hop.
     *
     * Double-count prevention (same reasoning as `publish`): on the
     * conviction branch the NFT's `coverPublishingCost` directly distributes
     * `deltaTokenAmount` across the KA's remaining epoch range (active
     * sink) and lazily sweeps elapsed window remainders (passive sink), so
     * this path MUST NOT call `_addTokens` / `_distributeTokens`.
     *
     * @param p Update parameters (see `UpdateParams` struct).
     */
    /**
     * @notice Update a knowledge asset (RFC-001: unified entrypoint).
     *
     * Mirrors the unified `publish`: takes the PCA discount branch when
     * `msg.sender` is a registered agent on an active PCA whose
     * `lockDurationEpochs >= remainingEpochs`; otherwise falls through to
     * direct spend. Metadata-only updates (`delta == 0`) skip cost
     * coverage entirely on either branch.
     */
    function update(UpdateParams calldata p) external nonReentrant {
        (uint96 deltaTokenAmount, uint40 remainingEpochs, uint40 currentEpoch) = _executeUpdateCore(p);

        if (deltaTokenAmount == 0) return;

        // OT-RFC-53: spend the CG owner's prepaid registration escrow first. The net
        // (after the treasury fee) is distributed over the remaining epochs; the
        // wallet covers the remainder below.
        (uint96 netEscrow, uint96 walletDelta) = _consumeEscrowNet(
            contextGraphStorage.kaToContextGraph(p.id),
            deltaTokenAmount
        );
        if (netEscrow > 0) {
            _distributeTokens(netEscrow, uint256(remainingEpochs), currentEpoch);
        }
        if (walletDelta == 0) return;

        // PCA branch eligibility (mirrors `publish()`, with `<=` for the
        // epoch count since `update()` passes the KA's REMAINING lifetime,
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
            (,,,, uint40 expiresAtTimestamp, uint16 lockDurationEpochs,,,,,) =
                publishingConvictionNFT.accounts(convictionAccountId);
            useConviction =
                block.timestamp < uint256(expiresAtTimestamp) &&
                remainingEpochs <= uint40(lockDurationEpochs);
        }

        // Discount branch when eligible; otherwise (or on a PCA-side payment
        // failure) direct spend. As in `publish`, the conviction attempt MUST
        // NOT brick the updater — a consent-free agent registration on an
        // underfunded account falls through here rather than reverting.
        if (useConviction) {
            useConviction = _coverViaConvictionOrFallThrough(
                walletDelta,
                currentEpoch,
                remainingEpochs
            );
        }

        if (!useConviction) {
            uint96 netDeltaTokenAmount = _addTokens(walletDelta);
            _distributeTokens(netDeltaTokenAmount, uint256(remainingEpochs), currentEpoch);
        }
    }

    // ========================================================================
    // Internal: Shared update core
    // ========================================================================

    /**
     * @notice Signature verification + auth + validation + KAS mutation +
     *         atomic CG value delta write.
     *
     * Both `update` and `updateDirect` run this before branching on payment
     * path. No TRAC movement happens here — the caller's path handles that.
     *
     * @return deltaTokenAmount Delta between `newTokenAmount` and the KA's
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
        DKGKnowledgeAssets kas = knowledgeAssetsStorage;

        // --- 1. Read current KA metadata (needed for validation + auth) ---
        //
        // `getKnowledgeAssetUpdateContext` is a scalar-only getter
        // added for the update path specifically. The legacy
        // `getKnowledgeAssetMetadata` performs a full storage → memory
        // struct copy, which walks every entry of `merkleRoots[]` and
        // `burned[]`. Both grow monotonically on every update, so calling
        // the legacy getter from the update path made gas scale (super-)
        // linearly with history — a KA with enough updates would
        // eventually become un-updatable. Switching to this scalar getter
        // keeps the update cost constant. (Codex round 3 finding 1.)

        // `minted` is intentionally discarded: the old N16 `balanceOf` auth
        // gate needed the KA's minted count to compute the token range, but
        // the owner-only auth gate below (`ownerOf(kaId)` == attested author,
        // OT-RFC-45) does not touch token ranges.
        (
            uint256 preUpdateMerkleRootCount,
            ,
            uint88 currentByteSize,
            uint40 endEpoch,
            uint96 currentTokenAmount,
            bool isImmutable,
            uint32 ignoredPreUpdateMerkleLeafCount
        ) = kas.getKnowledgeAssetUpdateContext(p.id);
        ignoredPreUpdateMerkleLeafCount;

        if (isImmutable) {
            revert KnowledgeAssetLib.CannotUpdateImmutableKnowledgeAsset(p.id);
        }

        currentEpoch = uint40(chronos.getCurrentEpoch());
        if (uint256(currentEpoch) > uint256(endEpoch)) {
            revert KnowledgeAssetLib.KnowledgeAssetExpired(
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

        uint256 contextGraphId = contextGraphStorage.kaToContextGraph(p.id);
        if (contextGraphId == 0) {
            // Post-Phase-7 invariant: publish atomically binds kaId → cgId
            // via `contextGraphs.registerKnowledgeAsset`. Zero here
            // means corrupt state (KA created outside publish, or Phase 7
            // migration gap). Fail loudly — silently authorizing without a
            // CG would orphan the KA from value-weighted challenges.
            revert MissingContextGraphBinding(p.id);
        }

        // --- 3. ACK signature verification ---
        //
        // RFC-001: per-update publisher signature (`publisherNodeR/VS`) is
        // removed. `publisherNodeIdentityId` is now a self-claimed
        // attribution field with no per-update authentication. ACK quorum
        // continues to gate update validity.
        //
        // The update path verifies an EIP-712 author attestation below
        // (`_verifyUpdateAuthorAttestation`) and enforces owner-only: the
        // attested author MUST equal `ownerOf(kaId)` (OT-RFC-45). There is no
        // curator/PCA delegation on the update path.
        //
        // ACK digest — covers EVERY mutable field the update can change so a
        // stale ACK can't be replayed with different byte size, different
        // token amount, different mint/burn counts, or a different ka id. The
        // burn id list is digested by its `keccak256` so an arbitrary-length
        // array folds into a fixed-size `bytes32` without blowing out the
        // packed digest. H5 prefix pins replay to (chain, contract).
        //
        // Replay protection: the digest binds the PRE-UPDATE merkle-root chain
        // length. KAS appends to `merkleRoots[]` on every successful update, so
        // every successful update increments this counter and invalidates any
        // ACK that was signed against an earlier value. Without this binding,
        // a captured update ACK could be replayed against a later state of the
        // same KA — for paid updates the attacker would burn their own TRAC,
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
        // OT-RFC-49 / WS-B Trap 3: same `ACK_DIGEST_VERSION` prefix + catalog
        // members as the publish ACK preimage (see `_executePublishCore`).
        bytes32 ackDigest = keccak256(
            abi.encodePacked(
                ACK_DIGEST_VERSION,
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
                uint256(p.newMerkleLeafCount),
                p.newCatalogRoot,
                uint256(p.newCatalogLeafCount)
            )
        );
        _verifySignatures(p.identityIds, ECDSA.toEthSignedMessageHash(ackDigest), p.r, p.vs);

        _verifyUpdateAuthorAttestation(p);

        address kaOwner = kas.ownerOf(p.id);
        if (kaOwner != p.authorAddress) {
            revert NotKnowledgeAssetOwner(p.id, kaOwner, p.authorAddress);
        }

        // --- 4. Validate the new total + compute delta ---

        // No rebates: new total must be >= current total. A publisher that
        // wants to "shrink" must let the KA expire and republish.
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
        // time the update lands. Late in a KA's lifetime (say, epoch 9 of
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

        // --- 5. Update authorization ---
        //
        // Publisher (`msg.sender`) pays TRAC; KA owner (`ownerOf(kaId)`) must
        // match `authorAddress` attestation above. Curated default: owner-only
        // updates after publish (no curator/publisher override).

        // --- 6. Apply storage mutation (new merkle root, bytes, tokens) ---

        kas.updateKnowledgeAsset(
            msg.sender,
            p.authorAddress,
            p.id,
            p.updateOperationId,
            p.newMerkleRoot,
            p.mintKnowledgeAssetsAmount,
            p.knowledgeAssetsToBurn,
            p.newByteSize,
            p.newTokenAmount,
            p.newMerkleLeafCount
        );

        // --- 6b. OT-RFC-49 / WS-B: refresh the curated PUBLIC `_catalog` commitment ---
        //
        // Without this, a curated KA would keep its publish-time catalog
        // commitment forever and `RandomSampling`'s curated-proof check (which now
        // reads the PINNED `challengeRoot`/`challengeLeafCount` snapshotted from
        // `getCatalogRoot/Count`) would verify against a stale catalog after the
        // first update. Same validation contract as the publish branch:
        //   - Public CG + any non-zero catalog field → revert.
        //   - Curated CG + KA has a prior commitment + zero pair → revert. A
        //     zero-pair on an already-committed curated KA would strand the OLD
        //     catalog commitment while the merkle root + leaf count rotate to the
        //     new batch, so a future challenge would target a catalog the published
        //     set no longer matches. Once committed, every update MUST rotate the
        //     catalog commitment in lockstep with the plaintext one.
        //   - Curated CG + KA has no prior commitment + zero pair + delta 0
        //     → no-op (unreachable for KAs published post-RFC-49 — those always
        //     carry a catalog commitment from publish; kept for legacy KAs that
        //     have not yet re-published).
        //   - Curated CG + KA has no prior commitment + zero pair + delta > 0
        //     → revert. Value growth would otherwise add weight for a KA that
        //     cannot satisfy a catalog proof when sampled.
        //   - Curated CG + both fields non-zero → commitment rotated (or set).
        //   - Curated CG + exactly one field zero → revert
        //     IncompleteCatalogCommitment (partial commitment would zero-divide
        //     the picker).
        //   - Public CG + any non-zero catalog field → revert
        //     PublicCGCannotHaveCatalogCommitment.
        bool _isCurated = contextGraphStorage.getIsCurated(contextGraphId);
        bool _hasNewCatalogCommitment =
            p.newCatalogRoot != bytes32(0) || p.newCatalogLeafCount != 0;
        if (_isCurated) {
            if (_hasNewCatalogCommitment) {
                if (p.newCatalogRoot == bytes32(0) || p.newCatalogLeafCount == 0) {
                    revert IncompleteCatalogCommitment();
                }
                kas.setCatalogCommitment(p.id, p.newCatalogRoot, p.newCatalogLeafCount);
            } else if (kas.getCatalogRoot(p.id) != bytes32(0)) {
                // KA was previously committed; a zero-pair update would
                // strand the stale commitment.
                revert IncompleteCatalogCommitment();
            } else if (deltaTokenAmount > 0) {
                revert CuratedCGRequiresCatalogCommitment(contextGraphId);
            }
            // else: legacy curated KA not yet re-published, no commitment yet —
            // zero-pair metadata-only update is permitted.
        } else {
            if (_hasNewCatalogCommitment) {
                revert PublicCGCannotHaveCatalogCommitment(contextGraphId);
            }
            // F08 (audit follow-up): a content update must keep a public KA
            // challengeable — a zero `newMerkleLeafCount` would strand it from the
            // sampling draw. (Pure top-ups/extends use extendKnowledgeAssetLifetime,
            // not this content-update path, so they are unaffected.)
            if (p.newMerkleLeafCount == 0) {
                revert PublicKARequiresMerkleLeafCount(contextGraphId);
            }
        }

        // --- 7. CG value delta + per-node produced-value bookkeeping ---

        // Skip on metadata-only updates — the CG value storage reverts on
        // `value == 0` (and `remainingEpochs == 0` was already gated above
        // when delta > 0, so by here either delta > 0 AND remainingEpochs > 0,
        // or delta == 0 and we short-circuit).
        if (deltaTokenAmount > 0) {
            // G-7: never re-strand sampling weight onto a deactivated CG.
            if (!contextGraphStorage.isContextGraphActive(contextGraphId)) {
                revert CannotWriteValueToInactiveContextGraph(contextGraphId);
            }
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
            // settle-on-spend: reconcile the BIT weight leaf to the new ledger truth.
            cgWeightTreeStorage.settle(contextGraphId);

            // OT-RFC-51 "Publishing Allocation": realized publishing (here,
            // the increase/extend delta) no longer credits per-node
            // publishing allocation (K_n). The former
            // `addEpochProducedKnowledgeValue(publisherNodeIdentityId, ...)`
            // delta write has been removed — scoring is now driven solely by
            // committed PCA allocation seeded/moved in `PublishingConviction`.
        }
    }

    // ========================================================================
    // Internal: Token Distribution
    // ========================================================================

    /// @dev OT-RFC-53: draw down the CG owner's prepaid registration escrow to
    ///      cover up to `cost`. Returns the escrow-funded `used` amount (already
    ///      decremented; the underlying TRAC sits in the CSS vault, gross —
    ///      no fee is skimmed at deposit, so escrow draws are gross-for-gross).
    ///      The caller distributes `used` over the relevant epoch window and
    ///      charges only `cost - used` to the wallet. Owner-scoped: a third
    ///      party publishing into an open CG gets `used == 0` (the escrow is the
    ///      CG owner's budget). No-op for unbound KCs (`contextGraphId == 0`).
    function _useCgEscrow(uint256 contextGraphId, uint96 cost) internal returns (uint96 used) {
        if (contextGraphId == 0 || cost == 0) {
            return 0;
        }
        // Read the per-CG escrow FIRST. While the deposit is dormant (escrow == 0
        // — always true when the registration deposit param is 0, the default)
        // this single light read short-circuits BEFORE the heavier
        // getContextGraphOwner (ERC-721 ownerOf) lookup. PR #1229: doing the owner
        // lookup first added enough gas to the publish path to tip the off-chain
        // publisher's gas estimation and shift its tx signer, breaking
        // publisher[4/4]. Escrow-first keeps the dormant path's footprint minimal.
        uint96 esc = contextGraphStorage.getRegistrationEscrow(contextGraphId);
        if (esc == 0) {
            return 0;
        }
        if (msg.sender != contextGraphStorage.getContextGraphOwner(contextGraphId)) {
            return 0;
        }
        used = esc >= cost ? cost : esc;
        contextGraphStorage.decreaseRegistrationEscrow(contextGraphId, used);
        emit RegistrationEscrowConsumed(contextGraphId, used);
    }

    function _distributeTokens(uint96 tokenAmount, uint256 epochs, uint40 currentEpoch) internal {
        // `epochs > 0` is guaranteed by every caller:
        //   - `publishDirect` → `_executePublishCore` rejects `p.epochs == 0`
        //     with `ZeroEpochs` before reaching this helper.
        //   - `updateDirect` → `_executeUpdateCore` rejects
        //     `deltaTokenAmount > 0 && remainingEpochs == 0` with
        //     `NoRemainingLifetimeForDelta`, and only calls `_distributeTokens`
        //     inside an `if (deltaTokenAmount > 0)` gate.
        // No defensive re-check needed. `extendKnowledgeAssetLifetime`
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
