import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { ethers } from 'ethers';

import { signMessage } from './ka-helpers';
import { NodeAccounts } from './types';
import { KnowledgeAssetsLifecycle } from '../../typechain';

/**
 * V10 publish/update test helpers.
 *
 * Digest construction must match `KnowledgeAssetsLifecycle.sol` EXACTLY. Any drift
 * between the contract and these helpers will fail at ECDSA.tryRecover with
 * `SignerIsNotNodeOperator`, `InvalidSignature`, or `InvalidAuthorSignature`.
 *
 * RFC-001: per-publish publisher signature is removed; every publish now
 * carries an EIP-712 author attestation.
 *
 * ACK digest prefix (H5 closure):
 *   (block.chainid, address(KnowledgeAssetsLifecycle), ...)
 *
 * ACK digest (publish) — OT-RFC-49 / WS-B Trap 3: `ACK_DIGEST_VERSION` is the
 * FIRST packed member and the ciphertext pair became the catalog pair. Wrapped
 * in `ECDSA.toEthSignedMessageHash` (EIP-191) before recovery:
 *   ACK_DIGEST_VERSION || chainId || kav10Address || contextGraphId || merkleRoot
 *   || knowledgeAssetsAmount || uint256(byteSize) || uint256(epochs)
 *   || uint256(tokenAmount) || uint256(merkleLeafCount)
 *   || catalogRoot || uint256(catalogLeafCount) || uint256(isImmutable)
 *
 * ACK digest (update) — same `ACK_DIGEST_VERSION` prefix + catalog pair:
 *   ACK_DIGEST_VERSION || chainId || kav10Address || contextGraphId (from on-chain)
 *   || id || preUpdateMerkleRootCount || newMerkleRoot || uint256(newByteSize)
 *   || uint256(newTokenAmount) || mintKnowledgeAssetsAmount
 *   || keccak256(abi.encodePacked(knowledgeAssetsToBurn))
 *   || uint256(newMerkleLeafCount) || newCatalogRoot || uint256(newCatalogLeafCount)
 *
 * Author attestation (RFC-001) — EIP-712 typed data:
 *   domain   = EIP712Domain(name="KnowledgeAssetsLifecycle", version="3.0.0",
 *                           chainId, verifyingContract=KAV10)
 *   struct   = AuthorAttestation(bytes32 merkleRoot, address authorAddress,
 *                                uint8 schemeVersion, uint256 reservedKaId)  // #1116: no contextGraphId
 *   schemeVersion = 1 (only currently-supported scheme)
 *
 * The author attestation digest is built and signed via ethers'
 * `signTypedData` for byte-equality with the contract's
 * `_hashAuthorAttestation`.
 */

export const DEFAULT_CHAIN_ID = 31337n;

export const AUTHOR_SCHEME_VERSION_V1 = 1;

/**
 * OT-RFC-49 / WS-B Trap 3 — ACK-digest domain-separation version, prepended as
 * the FIRST `abi.encodePacked` member of BOTH the publish and update ACK
 * preimages. MUST equal `KnowledgeAssetsLifecycle.ACK_DIGEST_VERSION` (and the
 * off-chain `@origintrail-official/dkg-core` `ACK_DIGEST_VERSION = 1n`), or
 * every ACK signature recovers to the wrong address and the contract reverts
 * `SignerIsNotNodeOperator`.
 */
export const ACK_DIGEST_VERSION = 1n;

/**
 * OT-RFC-43 Option 1 (variant 1a) — pack a deterministic, author-namespaced
 * KA id. The high 160 bits MUST be the AUTHOR (the EIP-712 attestation signer
 * / NFT mint recipient), NOT the publisher / msg.sender. The contract enforces
 * `(reservedKaId >> 96) == uint160(authorAddress)` at mint, so a value built
 * for the wrong author reverts `KaIdNamespaceMismatch`.
 *
 *   kaId = (uint160(authorAddress) << 96) | uint96(number)
 */
export function packReservedKaId(
  authorAddress: string,
  num: number | bigint,
): bigint {
  return (BigInt(ethers.getAddress(authorAddress)) << 96n) | BigInt(num);
}

/**
 * Per-author monotonic counter for fresh `reservedKaId` numbers, so tests that
 * publish several KAs (under the same or different authors) never collide on a
 * `(author, number)` pair unless they deliberately reuse one. Keyed by the
 * checksummed author address.
 */
const _reservedKaIdCounters = new Map<string, bigint>();

/**
 * Allocate a fresh, never-before-used packed `reservedKaId` for `authorAddress`.
 * Numbers start at 1 and increment per author. Use `packReservedKaId` directly
 * when a test must pin or deliberately reuse an exact number.
 */
export function nextReservedKaId(authorAddress: string): bigint {
  const key = ethers.getAddress(authorAddress);
  const next = (_reservedKaIdCounters.get(key) ?? 0n) + 1n;
  _reservedKaIdCounters.set(key, next);
  return packReservedKaId(key, next);
}

export type V10SigPack = {
  receiverRs: string[];
  receiverVSs: string[];
};

export type AuthorSig = {
  authorR: string;
  authorVS: string;
};

export type AuthorAttestationPayload = {
  domain: ethers.TypedDataDomain;
  types: Record<string, { name: string; type: string }[]>;
  value: {
    merkleRoot: string;
    authorAddress: string;
    schemeVersion: number;
    reservedKaId: bigint;
  };
};

/**
 * Build the EIP-712 typed-data payload for a V10 author attestation.
 *
 * Domain mirrors the contract's `_hashAuthorAttestation`:
 *   name="KnowledgeAssetsLifecycle", version="3.0.0", chainId, verifyingContract.
 *
 * #1116: the struct hash binds (merkleRoot, authorAddress, schemeVersion,
 * reservedKaId) — `contextGraphId` was REMOVED (the seal is now
 * context-graph-independent). Drift between this builder and the contract will
 * surface as `InvalidAuthorSignature` at publish time.
 */
export function buildAuthorAttestationPayload(args: {
  chainId: bigint;
  kav10Address: string;
  merkleRoot: string;
  authorAddress: string;
  reservedKaId: bigint;
  schemeVersion?: number;
}): AuthorAttestationPayload {
  const schemeVersion = args.schemeVersion ?? AUTHOR_SCHEME_VERSION_V1;
  return {
    domain: {
      name: 'KnowledgeAssetsLifecycle',
      version: '3.0.0',
      chainId: args.chainId,
      verifyingContract: ethers.getAddress(args.kav10Address),
    },
    types: {
      AuthorAttestation: [
        { name: 'merkleRoot', type: 'bytes32' },
        { name: 'authorAddress', type: 'address' },
        { name: 'schemeVersion', type: 'uint8' },
        { name: 'reservedKaId', type: 'uint256' },
      ],
    },
    value: {
      merkleRoot: args.merkleRoot,
      authorAddress: ethers.getAddress(args.authorAddress),
      schemeVersion,
      reservedKaId: args.reservedKaId,
    },
  };
}

/**
 * Sign an author attestation with an ethers signer (EOA path).
 *
 * Returns the compact `(r, vs)` form that the contract expects; the EIP-712
 * `signTypedData` flavor of `signer` produces a 65-byte `(r, s, v)` signature
 * which we split + repack here.
 */
export async function signAuthorAttestation(
  signer: SignerWithAddress,
  payload: AuthorAttestationPayload,
): Promise<AuthorSig> {
  const fullSig = await signer.signTypedData(
    payload.domain,
    payload.types,
    payload.value,
  );
  // ethers.Signature has `compactSerialized` which gives the 64-byte (r, vs)
  // form via `r || vs` — but exposing r and vs as separate bytes32 is what
  // the contract expects.
  const split = ethers.Signature.from(fullSig);
  return {
    authorR: split.r,
    authorVS: split.yParityAndS,
  };
}

/**
 * Build publish ACK digest. See contract `_executePublishCore`.
 *
 * Field set per PRD V10 "Publish Flow" + decision #25 Option B. Does NOT
 * include `publisherNodeIdentityId` — that field is in the publisher
 * digest only (T1.5b locks this shape by negative regression).
 */
export function buildPublishAckDigest(
  chainId: bigint,
  kav10Address: string,
  contextGraphId: bigint,
  merkleRoot: string,
  knowledgeAssetsAmount: number | bigint,
  byteSize: number | bigint,
  epochs: number | bigint,
  tokenAmount: bigint,
  merkleLeafCount: number | bigint,
  catalogRoot: string = ethers.ZeroHash,
  catalogLeafCount: number | bigint = 0,
  isImmutable: boolean = false,
): string {
  // OT-RFC-49 / WS-B Trap 3: `ACK_DIGEST_VERSION` is the FIRST packed member,
  // and the former ciphertext pair at positions 10/11 is now
  // `catalogRoot`/`catalogLeafCount` (same bytes32/uint256 widths). Mirrors
  // `KnowledgeAssetsLifecycle._executePublishCore` and the off-chain
  // `computePublishACKDigest`.
  return ethers.solidityPackedKeccak256(
    [
      'uint256', // ACK_DIGEST_VERSION
      'uint256', // chainId
      'address', // kav10Address
      'uint256', // contextGraphId
      'bytes32', // merkleRoot
      'uint256', // knowledgeAssetsAmount
      'uint256', // byteSize (cast to uint256 in contract)
      'uint256', // epochs (cast to uint256 in contract)
      'uint256', // tokenAmount (cast to uint256 in contract)
      'uint256', // merkleLeafCount (cast to uint256 in contract)
      'bytes32', // catalogRoot
      'uint256', // catalogLeafCount
      'uint256', // isImmutable (0/1)
    ],
    [
      ACK_DIGEST_VERSION,
      chainId,
      kav10Address,
      contextGraphId,
      merkleRoot,
      knowledgeAssetsAmount,
      byteSize,
      epochs,
      tokenAmount,
      merkleLeafCount,
      catalogRoot,
      catalogLeafCount,
      isImmutable ? 1 : 0,
    ],
  );
}

/**
 * Build update ACK digest. See contract `_executeUpdateCore`.
 *
 * `contextGraphId` is read by the contract from on-chain
 * `ContextGraphStorage.kaToContextGraph(id)` — the caller CANNOT override it
 * in the signed payload. The test fixture must therefore pass the same value
 * the contract will look up, or signature verification will fail.
 *
 * `preUpdateMerkleRootCount` is the length of `knowledgeCollections[id].merkleRoots`
 * BEFORE the update runs — 1 for a fresh KA from a single publish.
 */
export function buildUpdateAckDigest(
  chainId: bigint,
  kav10Address: string,
  contextGraphId: bigint,
  id: bigint,
  preUpdateMerkleRootCount: bigint,
  newMerkleRoot: string,
  newByteSize: bigint,
  newTokenAmount: bigint,
  mintKnowledgeAssetsAmount: bigint,
  knowledgeAssetsToBurn: bigint[],
  newMerkleLeafCount: number | bigint,
  newCatalogRoot: string = ethers.ZeroHash,
  newCatalogLeafCount: number | bigint = 0,
): string {
  // Inner burn-list keccak matches `keccak256(abi.encodePacked(knowledgeAssetsToBurn))`.
  const innerBurnHash = ethers.solidityPackedKeccak256(
    ['uint256[]'],
    [knowledgeAssetsToBurn],
  );
  // OT-RFC-49 / WS-B Trap 3: `ACK_DIGEST_VERSION` prepended; the former
  // ciphertext pair at positions 12/13 is now
  // `newCatalogRoot`/`newCatalogLeafCount`. Mirrors
  // `KnowledgeAssetsLifecycle._executeUpdateCore` and the off-chain
  // `computeUpdateACKDigest`.
  return ethers.solidityPackedKeccak256(
    [
      'uint256', // ACK_DIGEST_VERSION
      'uint256', // chainId
      'address', // kav10Address
      'uint256', // contextGraphId (from storage)
      'uint256', // id
      'uint256', // preUpdateMerkleRootCount
      'bytes32', // newMerkleRoot
      'uint256', // newByteSize
      'uint256', // newTokenAmount
      'uint256', // mintKnowledgeAssetsAmount
      'bytes32', // keccak(burn list)
      'uint256', // newMerkleLeafCount
      'bytes32', // newCatalogRoot
      'uint256', // newCatalogLeafCount
    ],
    [
      ACK_DIGEST_VERSION,
      chainId,
      kav10Address,
      contextGraphId,
      id,
      preUpdateMerkleRootCount,
      newMerkleRoot,
      newByteSize,
      newTokenAmount,
      mintKnowledgeAssetsAmount,
      innerBurnHash,
      newMerkleLeafCount,
      newCatalogRoot,
      newCatalogLeafCount,
    ],
  );
}

/**
 * Sign the ACK digest with each receiving node's operational key.
 *
 * RFC-001: the per-publish publisher signature is removed; this helper now
 * only produces the ACK quorum signatures. Author attestation is signed
 * separately via `signAuthorAttestation`.
 */
export async function signAckDigest(
  receivingNodes: NodeAccounts[],
  ackDigest: string,
): Promise<V10SigPack> {
  const receiverRs: string[] = [];
  const receiverVSs: string[] = [];
  for (const node of receivingNodes) {
    const { r, vs } = await signMessage(node.operational, ackDigest);
    receiverRs.push(r);
    receiverVSs.push(vs);
  }
  return { receiverRs, receiverVSs };
}

/**
 * Build a full `PublishParamsStruct` ready for `KnowledgeAssetsLifecycle.publish`.
 * Runs the ACK signing flow internally and produces an EOA author attestation
 * over the publish payload.
 */
export async function buildPublishParams(args: {
  chainId: bigint;
  kav10Address: string;
  receivingNodes: NodeAccounts[];
  publisherIdentityId: number;
  receiverIdentityIds: number[];
  /** Author signer (EOA). Provides `authorAddress` + the EIP-712 signature. */
  author: SignerWithAddress;
  contextGraphId: bigint;
  merkleRoot: string;
  knowledgeAssetsAmount: number;
  byteSize: number;
  epochs: number;
  tokenAmount: bigint;
  isImmutable: boolean;
  /** Defaults to 1 for fixtures that only assert economics / signatures. */
  merkleLeafCount?: number;
  publishOperationId: string;
  /** Allow overriding `authorSchemeVersion` for negative-path tests. */
  authorSchemeVersion?: number;
  /** Allow injecting a pre-computed author signature (for negative-path tests). */
  authorSigOverride?: AuthorSig;
  /**
   * OT-RFC-43 Option 1 (variant 1a): the packed KA id this publish claims:
   *   reservedKaId = (uint160(author) << 96) | uint96(number)
   * Defaults to a freshly-allocated, never-reused id in the author's namespace
   * (`nextReservedKaId(author.address)`). Negative-path / collision tests pass
   * an explicit value (e.g. a wrong-namespace id, or a deliberately reused
   * `reservedKaId`). NB: deliberately NOT part of the ACK digest — the
   * namespace is enforced on-chain, not signed over.
   */
  reservedKaId?: bigint;
  /**
   * OT-RFC-49 / WS-B curated-CG PUBLIC `_catalog` commitment.
   * Defaults to `bytes32(0)` + `0`, which is legal only on public CGs.
   * Curated-CG publishes MUST set both fields to non-zero values; otherwise
   * KAV10 reverts before the KA can enter value-weighted sampling.
   * The contract enforces both the required-curated and paired-or-zero
   * invariants via `CuratedCGRequiresCatalogCommitment` and
   * `IncompleteCatalogCommitment`.
   *
   * Note: the on-chain ACK digest DOES include these fields plus `isImmutable`
   * (`KnowledgeAssetsLifecycle._executePublishCore` packs
   * `catalogRoot || uint256(catalogLeafCount) || uint256(isImmutable)`
   * after `merkleLeafCount`). The `buildPublishAckDigest` call below MUST pass
   * the same values the struct carries or the ACK signatures fail recovery
   * with `SignerIsNotNodeOperator`.
   */
  catalogRoot?: string;
  catalogLeafCount?: number | bigint;
}): Promise<KnowledgeAssetsLifecycle.PublishParamsStruct> {
  const merkleLeafCount = args.merkleLeafCount ?? 1;
  const catalogRoot = args.catalogRoot ?? ethers.ZeroHash;
  const catalogLeafCount = args.catalogLeafCount ?? 0;
  const ackDigest = buildPublishAckDigest(
    args.chainId,
    args.kav10Address,
    args.contextGraphId,
    args.merkleRoot,
    args.knowledgeAssetsAmount,
    args.byteSize,
    args.epochs,
    args.tokenAmount,
    merkleLeafCount,
    catalogRoot,
    catalogLeafCount,
    args.isImmutable,
  );
  const sig = await signAckDigest(
    args.receivingNodes,
    ackDigest,
  );

  const schemeVersion = args.authorSchemeVersion ?? AUTHOR_SCHEME_VERSION_V1;
  // OT-RFC-43 Option 1 (1a): author-namespaced packed id. Defaults to a
  // fresh, unused number in the author's namespace; pinned/reused values
  // come through `args.reservedKaId` for collision / negative tests. Resolved
  // BEFORE the author attestation so the author signs the exact slot that the
  // publish mints (OT-RFC-43 §F2 — `reservedKaId` is bound into the digest).
  const reservedKaId = args.reservedKaId ?? nextReservedKaId(args.author.address);
  const authorSig =
    args.authorSigOverride ??
    (await signAuthorAttestation(
      args.author,
      buildAuthorAttestationPayload({
        chainId: args.chainId,
        kav10Address: args.kav10Address,
        // #1116: AuthorAttestation no longer binds contextGraphId (it stays in
        // PublishParams for the on-chain mint target / authorization).
        merkleRoot: args.merkleRoot,
        authorAddress: args.author.address,
        reservedKaId,
        schemeVersion,
      }),
    ));

  return {
    publishOperationId: args.publishOperationId,
    contextGraphId: args.contextGraphId,
    merkleRoot: args.merkleRoot,
    knowledgeAssetsAmount: args.knowledgeAssetsAmount,
    byteSize: args.byteSize,
    epochs: args.epochs,
    tokenAmount: args.tokenAmount,
    isImmutable: args.isImmutable,
    merkleLeafCount,
    catalogRoot,
    catalogLeafCount,
    publisherNodeIdentityId: args.publisherIdentityId,
    authorAddress: args.author.address,
    authorR: authorSig.authorR,
    authorVS: authorSig.authorVS,
    authorSchemeVersion: schemeVersion,
    reservedKaId,
    identityIds: args.receiverIdentityIds,
    r: sig.receiverRs,
    vs: sig.receiverVSs,
  };
}

/**
 * Build a full `UpdateParamsStruct` for `KnowledgeAssetsLifecycle.update` / `updateDirect`.
 *
 * Requires the on-chain `contextGraphId` (read by the test from
 * `ContextGraphStorage.kaToContextGraph(id)`) and the pre-update merkle-root
 * count (read from `DKGKnowledgeAssets.getKnowledgeAssetMetadata(id)`).
 */
export type UpdateAuthorAttestationPayload = {
  domain: ethers.TypedDataDomain;
  types: Record<string, { name: string; type: string }[]>;
  value: {
    kaId: bigint;
    newMerkleRoot: string;
    authorAddress: string;
    schemeVersion: number;
  };
};

export function buildUpdateAuthorAttestationPayload(args: {
  chainId: bigint;
  kav10Address: string;
  kaId: bigint;
  newMerkleRoot: string;
  authorAddress: string;
  schemeVersion?: number;
}): UpdateAuthorAttestationPayload {
  const schemeVersion = args.schemeVersion ?? AUTHOR_SCHEME_VERSION_V1;
  return {
    domain: {
      name: 'KnowledgeAssetsLifecycle',
      version: '3.0.0',
      chainId: args.chainId,
      verifyingContract: ethers.getAddress(args.kav10Address),
    },
    types: {
      UpdateAuthorAttestation: [
        { name: 'kaId', type: 'uint256' },
        { name: 'newMerkleRoot', type: 'bytes32' },
        { name: 'authorAddress', type: 'address' },
        { name: 'schemeVersion', type: 'uint8' },
      ],
    },
    value: {
      kaId: args.kaId,
      newMerkleRoot: args.newMerkleRoot,
      authorAddress: ethers.getAddress(args.authorAddress),
      schemeVersion,
    },
  };
}

export async function signUpdateAuthorAttestation(
  signer: SignerWithAddress,
  payload: UpdateAuthorAttestationPayload,
): Promise<AuthorSig> {
  const fullSig = await signer.signTypedData(
    payload.domain,
    payload.types,
    payload.value,
  );
  const split = ethers.Signature.from(fullSig);
  return {
    authorR: split.r,
    authorVS: split.yParityAndS,
  };
}

export async function buildUpdateParams(args: {
  chainId: bigint;
  kav10Address: string;
  receivingNodes: NodeAccounts[];
  publisherIdentityId: number;
  receiverIdentityIds: number[];
  contextGraphId: bigint;
  id: bigint;
  preUpdateMerkleRootCount: bigint;
  newMerkleRoot: string;
  newByteSize: bigint;
  newTokenAmount: bigint;
  mintKnowledgeAssetsAmount: bigint;
  knowledgeAssetsToBurn: bigint[];
  updateOperationId: string;
  /** KA owner / attestation signer. */
  author: SignerWithAddress;
  /** Defaults to 1 for fixtures that only assert economics / signatures. */
  newMerkleLeafCount?: number;
  /**
   * OT-RFC-49 / WS-B curated-CG PUBLIC `_catalog` commitment for the update
   * (optional). Defaults to `bytes32(0)` + `0`, which is legal on public-CG
   * updates and metadata-only updates for legacy curated KAs that do not yet
   * have a commitment. Curated paid updates MUST set both fields to non-zero
   * values. The on-chain ACK digest binds BOTH fields
   * (`KnowledgeAssetsLifecycle._executeUpdateCore`), so they MUST be passed
   * here — not spread onto the returned struct after signing — or the receiver
   * quorum signatures fail recovery with `SignerIsNotNodeOperator`.
   */
  newCatalogRoot?: string;
  newCatalogLeafCount?: number | bigint;
}): Promise<KnowledgeAssetsLifecycle.UpdateParamsStruct> {
  const newMerkleLeafCount = args.newMerkleLeafCount ?? 1;
  const newCatalogRoot = args.newCatalogRoot ?? ethers.ZeroHash;
  const newCatalogLeafCount = args.newCatalogLeafCount ?? 0;
  const ackDigest = buildUpdateAckDigest(
    args.chainId,
    args.kav10Address,
    args.contextGraphId,
    args.id,
    args.preUpdateMerkleRootCount,
    args.newMerkleRoot,
    args.newByteSize,
    args.newTokenAmount,
    args.mintKnowledgeAssetsAmount,
    args.knowledgeAssetsToBurn,
    newMerkleLeafCount,
    newCatalogRoot,
    newCatalogLeafCount,
  );
  const sig = await signAckDigest(args.receivingNodes, ackDigest);
  const updateAttPayload = buildUpdateAuthorAttestationPayload({
    chainId: args.chainId,
    kav10Address: args.kav10Address,
    kaId: args.id,
    newMerkleRoot: args.newMerkleRoot,
    authorAddress: await args.author.getAddress(),
  });
  const authorSig = await signUpdateAuthorAttestation(args.author, updateAttPayload);
  return {
    id: args.id,
    updateOperationId: args.updateOperationId,
    newMerkleRoot: args.newMerkleRoot,
    newByteSize: args.newByteSize,
    newTokenAmount: args.newTokenAmount,
    newMerkleLeafCount,
    mintKnowledgeAssetsAmount: args.mintKnowledgeAssetsAmount,
    knowledgeAssetsToBurn: args.knowledgeAssetsToBurn,
    newCatalogRoot,
    newCatalogLeafCount,
    publisherNodeIdentityId: args.publisherIdentityId,
    identityIds: args.receiverIdentityIds,
    r: sig.receiverRs,
    vs: sig.receiverVSs,
    authorAddress: await args.author.getAddress(),
    authorR: authorSig.authorR,
    authorVS: authorSig.authorVS,
    authorSchemeVersion: AUTHOR_SCHEME_VERSION_V1,
  };
}
