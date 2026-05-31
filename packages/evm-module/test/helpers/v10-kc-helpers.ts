import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { ethers } from 'ethers';

import { signMessage } from './kc-helpers';
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
 * ACK digest (publish) — PRD V10 "Publish Flow" + decision #25 Option B,
 * extended with `merkleLeafCount` (uint256 on wire). Wrapped in
 * `ECDSA.toEthSignedMessageHash` (EIP-191) before recovery:
 *   contextGraphId || merkleRoot || knowledgeAssetsAmount
 *   || uint256(byteSize) || uint256(epochs) || uint256(tokenAmount)
 *   || uint256(merkleLeafCount)
 *
 * ACK digest (update) — same shape with update-specific fields:
 *   contextGraphId (from on-chain) || id || preUpdateMerkleRootCount
 *   || newMerkleRoot || uint256(newByteSize) || uint256(newTokenAmount)
 *   || mintKnowledgeAssetsAmount
 *   || keccak256(abi.encodePacked(knowledgeAssetsToBurn))
 *   || uint256(newMerkleLeafCount)
 *
 * Author attestation (RFC-001) — EIP-712 typed data:
 *   domain   = EIP712Domain(name="KnowledgeAssetsLifecycle", version="2.0.0",
 *                           chainId, verifyingContract=KAV10)
 *   struct   = AuthorAttestation(uint256 contextGraphId, bytes32 merkleRoot,
 *                                address authorAddress, uint8 schemeVersion)
 *   schemeVersion = 1 (only currently-supported scheme)
 *
 * The author attestation digest is built and signed via ethers'
 * `signTypedData` for byte-equality with the contract's
 * `_hashAuthorAttestation`.
 */

export const DEFAULT_CHAIN_ID = 31337n;

export const AUTHOR_SCHEME_VERSION_V1 = 1;

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
    contextGraphId: bigint;
    merkleRoot: string;
    authorAddress: string;
    schemeVersion: number;
  };
};

/**
 * Build the EIP-712 typed-data payload for a V10 author attestation.
 *
 * Domain mirrors the contract's `_hashAuthorAttestation`:
 *   name="KnowledgeAssetsLifecycle", version="2.0.0", chainId, verifyingContract.
 *
 * The struct hash binds (contextGraphId, merkleRoot, authorAddress,
 * schemeVersion). Drift between this builder and the contract will surface
 * as `InvalidAuthorSignature` at publish time.
 */
export function buildAuthorAttestationPayload(args: {
  chainId: bigint;
  kav10Address: string;
  contextGraphId: bigint;
  merkleRoot: string;
  authorAddress: string;
  schemeVersion?: number;
}): AuthorAttestationPayload {
  const schemeVersion = args.schemeVersion ?? AUTHOR_SCHEME_VERSION_V1;
  return {
    domain: {
      name: 'KnowledgeAssetsLifecycle',
      version: '2.0.0',
      chainId: args.chainId,
      verifyingContract: ethers.getAddress(args.kav10Address),
    },
    types: {
      AuthorAttestation: [
        { name: 'contextGraphId', type: 'uint256' },
        { name: 'merkleRoot', type: 'bytes32' },
        { name: 'authorAddress', type: 'address' },
        { name: 'schemeVersion', type: 'uint8' },
      ],
    },
    value: {
      contextGraphId: args.contextGraphId,
      merkleRoot: args.merkleRoot,
      authorAddress: ethers.getAddress(args.authorAddress),
      schemeVersion,
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
  ciphertextChunksRoot: string = ethers.ZeroHash,
  ciphertextChunkCount: number | bigint = 0,
  isImmutable: boolean = false,
): string {
  return ethers.solidityPackedKeccak256(
    [
      'uint256', // chainId
      'address', // kav10Address
      'uint256', // contextGraphId
      'bytes32', // merkleRoot
      'uint256', // knowledgeAssetsAmount
      'uint256', // byteSize (cast to uint256 in contract)
      'uint256', // epochs (cast to uint256 in contract)
      'uint256', // tokenAmount (cast to uint256 in contract)
      'uint256', // merkleLeafCount (cast to uint256 in contract)
      'bytes32', // ciphertextChunksRoot
      'uint256', // ciphertextChunkCount
      'uint256', // isImmutable (0/1)
    ],
    [
      chainId,
      kav10Address,
      contextGraphId,
      merkleRoot,
      knowledgeAssetsAmount,
      byteSize,
      epochs,
      tokenAmount,
      merkleLeafCount,
      ciphertextChunksRoot,
      ciphertextChunkCount,
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
 * BEFORE the update runs — 1 for a fresh KC from a single publish.
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
  newCiphertextChunksRoot: string = ethers.ZeroHash,
  newCiphertextChunkCount: number | bigint = 0,
): string {
  // Inner burn-list keccak matches `keccak256(abi.encodePacked(knowledgeAssetsToBurn))`.
  const innerBurnHash = ethers.solidityPackedKeccak256(
    ['uint256[]'],
    [knowledgeAssetsToBurn],
  );
  return ethers.solidityPackedKeccak256(
    [
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
      'bytes32', // newCiphertextChunksRoot
      'uint256', // newCiphertextChunkCount
    ],
    [
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
      newCiphertextChunksRoot,
      newCiphertextChunkCount,
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
   * RFC-39 Phase A.5 curated-CG ciphertext commitment (optional).
   * Defaults to `bytes32(0)` + `0` — the explicit "no commitment" sentinel
   * the contract treats as: legal on public CGs (default behavior); legal
   * on curated CGs (legacy / pre-LU-11 path — KC won't be sampleable in
   * the curated draw). Curated-CG tests that exercise the sampleable path
   * MUST set both to non-zero values; the contract enforces the
   * paired-or-zero invariant via `IncompleteCiphertextCommitment`.
   *
   * Note: the on-chain ACK digest DOES include these fields plus `isImmutable`
   * (`KnowledgeAssetsLifecycle._executePublishCore` packs
   * `ciphertextChunksRoot || uint256(ciphertextChunkCount) || uint256(isImmutable)`
   * after `merkleLeafCount`). The `buildPublishAckDigest` call below MUST pass
   * the same values the struct carries or the ACK signatures fail recovery
   * with `SignerIsNotNodeOperator`.
   */
  ciphertextChunksRoot?: string;
  ciphertextChunkCount?: number | bigint;
}): Promise<KnowledgeAssetsLifecycle.PublishParamsStruct> {
  const merkleLeafCount = args.merkleLeafCount ?? 1;
  const ciphertextChunksRoot = args.ciphertextChunksRoot ?? ethers.ZeroHash;
  const ciphertextChunkCount = args.ciphertextChunkCount ?? 0;
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
    ciphertextChunksRoot,
    ciphertextChunkCount,
    args.isImmutable,
  );
  const sig = await signAckDigest(
    args.receivingNodes,
    ackDigest,
  );

  const schemeVersion = args.authorSchemeVersion ?? AUTHOR_SCHEME_VERSION_V1;
  const authorSig =
    args.authorSigOverride ??
    (await signAuthorAttestation(
      args.author,
      buildAuthorAttestationPayload({
        chainId: args.chainId,
        kav10Address: args.kav10Address,
        contextGraphId: args.contextGraphId,
        merkleRoot: args.merkleRoot,
        authorAddress: args.author.address,
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
    ciphertextChunksRoot,
    ciphertextChunkCount,
    publisherNodeIdentityId: args.publisherIdentityId,
    authorAddress: args.author.address,
    authorR: authorSig.authorR,
    authorVS: authorSig.authorVS,
    authorSchemeVersion: schemeVersion,
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
      version: '2.0.0',
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
   * RFC-39 curated-CG ciphertext commitment for the update (optional).
   * Defaults to `bytes32(0)` + `0`. The on-chain ACK digest binds BOTH fields
   * (`KnowledgeAssetsLifecycle._executeUpdateCore`), so they MUST be passed
   * here — not spread onto the returned struct after signing — or the receiver
   * quorum signatures fail recovery with `SignerIsNotNodeOperator`.
   */
  newCiphertextChunksRoot?: string;
  newCiphertextChunkCount?: number | bigint;
}): Promise<KnowledgeAssetsLifecycle.UpdateParamsStruct> {
  const newMerkleLeafCount = args.newMerkleLeafCount ?? 1;
  const newCiphertextChunksRoot = args.newCiphertextChunksRoot ?? ethers.ZeroHash;
  const newCiphertextChunkCount = args.newCiphertextChunkCount ?? 0;
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
    newCiphertextChunksRoot,
    newCiphertextChunkCount,
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
    newCiphertextChunksRoot,
    newCiphertextChunkCount,
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
