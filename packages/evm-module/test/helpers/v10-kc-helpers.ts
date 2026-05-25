import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { ethers } from 'ethers';

import { signMessage } from './kc-helpers';
import { NodeAccounts } from './types';
import { KnowledgeAssetsV10 } from '../../typechain';

/**
 * V10 publish/update test helpers.
 *
 * Digest construction must match `KnowledgeAssetsV10.sol` EXACTLY. Any drift
 * between the contract and these helpers will fail at ECDSA.tryRecover with
 * `SignerIsNotNodeOperator`, `InvalidSignature`, or `InvalidAuthorSignature`.
 *
 * RFC-001: per-publish publisher signature is removed; every publish now
 * carries an EIP-712 author attestation.
 *
 * ACK digest prefix (H5 closure):
 *   (block.chainid, address(KnowledgeAssetsV10), ...)
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
 *   domain   = EIP712Domain(name="KnowledgeAssetsV10", version="10.1",
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
 *   name="KnowledgeAssetsV10", version="10.1", chainId, verifyingContract.
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
      name: 'KnowledgeAssetsV10',
      version: '10.1',
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
    ],
  );
}

/**
 * Build update ACK digest. See contract `_executeUpdateCore`.
 *
 * `contextGraphId` is read by the contract from on-chain
 * `ContextGraphStorage.kcToContextGraph(id)` — the caller CANNOT override it
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
 * Build a full `PublishParamsStruct` ready for `KnowledgeAssetsV10.publish`.
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
   * Note: the on-chain ACK digest does NOT include these fields (RFC-38
   * §5.4.2 — Phase A cosigned ACK is unchanged; the LU-11 ciphertext
   * commitment is off-chain ACK material only). So the existing
   * `buildPublishAckDigest` call below correctly omits them.
   */
  ciphertextChunksRoot?: string;
  ciphertextChunkCount?: number | bigint;
}): Promise<KnowledgeAssetsV10.PublishParamsStruct> {
  const merkleLeafCount = args.merkleLeafCount ?? 1;
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
    ciphertextChunksRoot: args.ciphertextChunksRoot ?? ethers.ZeroHash,
    ciphertextChunkCount: args.ciphertextChunkCount ?? 0,
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
 * Build a full `UpdateParamsStruct` for `KnowledgeAssetsV10.update` / `updateDirect`.
 *
 * Requires the on-chain `contextGraphId` (read by the test from
 * `ContextGraphStorage.kcToContextGraph(id)`) and the pre-update merkle-root
 * count (read from `KnowledgeCollectionStorage.getKnowledgeCollectionMetadata(id)`).
 */
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
  /** Defaults to 1 for fixtures that only assert economics / signatures. */
  newMerkleLeafCount?: number;
}): Promise<KnowledgeAssetsV10.UpdateParamsStruct> {
  const newMerkleLeafCount = args.newMerkleLeafCount ?? 1;
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
  );
  const sig = await signAckDigest(args.receivingNodes, ackDigest);
  return {
    id: args.id,
    updateOperationId: args.updateOperationId,
    newMerkleRoot: args.newMerkleRoot,
    newByteSize: args.newByteSize,
    newTokenAmount: args.newTokenAmount,
    newMerkleLeafCount,
    mintKnowledgeAssetsAmount: args.mintKnowledgeAssetsAmount,
    knowledgeAssetsToBurn: args.knowledgeAssetsToBurn,
    // Codex PR #630 R1 #2 — RFC-39 Phase A.5 commitment refresh. Default
    // both to zero so the existing public-CG fixtures (which never
    // touch curated ciphertext) stay green. Curated-rotation tests
    // override these explicitly via the returned struct.
    newCiphertextChunksRoot: ethers.ZeroHash,
    newCiphertextChunkCount: 0,
    publisherNodeIdentityId: args.publisherIdentityId,
    identityIds: args.receiverIdentityIds,
    r: sig.receiverRs,
    vs: sig.receiverVSs,
  };
}
