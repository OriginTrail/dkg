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
 * `SignerIsNotNodeOperator` or `InvalidSignature` — which is what T1.5 / T1.6
 * assert for the negative cases, but undesirable for the positive cases.
 *
 * Prefix layout (H5 closure):
 *   (block.chainid, address(KnowledgeAssetsV10), ...)
 *
 * Publisher digest (N26 field order — publish AND update):
 *   (publisherNodeIdentityId, contextGraphId, merkleRoot_or_newMerkleRoot)
 *
 * ACK digest (publish):
 *   publisher fields || knowledgeAssetsAmount || uint256(byteSize)
 *   || uint256(epochs) || uint256(tokenAmount)
 *
 * ACK digest (update):
 *   publisher fields (with on-chain contextGraphId)
 *   || id || preUpdateMerkleRootCount || newMerkleRoot
 *   || uint256(newByteSize) || uint256(newTokenAmount)
 *   || mintKnowledgeAssetsAmount
 *   || keccak256(abi.encodePacked(knowledgeAssetsToBurn))
 *
 * Both digests are wrapped in `ECDSA.toEthSignedMessageHash(...)` (EIP-191)
 * before recovery — `signMessage` in kc-helpers.ts does the EIP-191 wrap for
 * the signer side via `signer.signMessage(getBytes(hash))`.
 */

export const DEFAULT_CHAIN_ID = 31337n;

export type V10SigPack = {
  publisherR: string;
  publisherVS: string;
  receiverRs: string[];
  receiverVSs: string[];
};

/**
 * Build publisher digest (N26 + H5).
 *
 * @param chainId block.chainid (31337 on hardhat, overridable for T1.6 replay
 *                regression)
 * @param kav10Address address(KnowledgeAssetsV10)
 * @param publisherNodeIdentityId publishing node's identity id
 * @param contextGraphId target CG id (for publish — caller-supplied; for update —
 *                       must match on-chain `ContextGraphStorage.kcToContextGraph(id)`)
 * @param merkleRoot publish merkleRoot OR newMerkleRoot (for update)
 */
export function buildPublisherDigest(
  chainId: bigint,
  kav10Address: string,
  publisherNodeIdentityId: number | bigint,
  contextGraphId: bigint,
  merkleRoot: string,
): string {
  return ethers.solidityPackedKeccak256(
    ['uint256', 'address', 'uint72', 'uint256', 'bytes32'],
    [chainId, kav10Address, publisherNodeIdentityId, contextGraphId, merkleRoot],
  );
}

/**
 * Build publish ACK digest. See contract `_executePublishCore`.
 */
export function buildPublishAckDigest(
  chainId: bigint,
  kav10Address: string,
  publisherNodeIdentityId: number | bigint,
  contextGraphId: bigint,
  merkleRoot: string,
  knowledgeAssetsAmount: number | bigint,
  byteSize: number | bigint,
  epochs: number | bigint,
  tokenAmount: bigint,
): string {
  return ethers.solidityPackedKeccak256(
    [
      'uint256', // chainId
      'address', // kav10Address
      'uint72',  // publisherNodeIdentityId
      'uint256', // contextGraphId
      'bytes32', // merkleRoot
      'uint256', // knowledgeAssetsAmount
      'uint256', // byteSize (cast to uint256 in contract)
      'uint256', // epochs (cast to uint256 in contract)
      'uint256', // tokenAmount (cast to uint256 in contract)
    ],
    [
      chainId,
      kav10Address,
      publisherNodeIdentityId,
      contextGraphId,
      merkleRoot,
      knowledgeAssetsAmount,
      byteSize,
      epochs,
      tokenAmount,
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
  publisherNodeIdentityId: number | bigint,
  contextGraphId: bigint,
  id: bigint,
  preUpdateMerkleRootCount: bigint,
  newMerkleRoot: string,
  newByteSize: bigint,
  newTokenAmount: bigint,
  mintKnowledgeAssetsAmount: bigint,
  knowledgeAssetsToBurn: bigint[],
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
      'uint72',  // publisherNodeIdentityId
      'uint256', // contextGraphId (from storage)
      'uint256', // id
      'uint256', // preUpdateMerkleRootCount
      'bytes32', // newMerkleRoot
      'uint256', // newByteSize
      'uint256', // newTokenAmount
      'uint256', // mintKnowledgeAssetsAmount
      'bytes32', // keccak(burn list)
    ],
    [
      chainId,
      kav10Address,
      publisherNodeIdentityId,
      contextGraphId,
      id,
      preUpdateMerkleRootCount,
      newMerkleRoot,
      newByteSize,
      newTokenAmount,
      mintKnowledgeAssetsAmount,
      innerBurnHash,
    ],
  );
}

/**
 * Sign publisher + ACK digests for a publish flow. Receivers are ACK signers;
 * the publishing node also signs the publisher digest (N26 / H5 pins).
 */
export async function signPublishDigests(
  publishingNode: NodeAccounts,
  receivingNodes: NodeAccounts[],
  publisherDigest: string,
  ackDigest: string,
): Promise<V10SigPack> {
  const { r: publisherR, vs: publisherVS } = await signMessage(
    publishingNode.operational,
    publisherDigest,
  );
  const receiverRs: string[] = [];
  const receiverVSs: string[] = [];
  for (const node of receivingNodes) {
    const { r, vs } = await signMessage(node.operational, ackDigest);
    receiverRs.push(r);
    receiverVSs.push(vs);
  }
  return { publisherR, publisherVS, receiverRs, receiverVSs };
}

/**
 * Build a full `PublishParamsStruct` ready for `KnowledgeAssetsV10.publish`
 * or `publishDirect`. Runs the signing flow internally using the node signers.
 */
export async function buildPublishParams(args: {
  chainId: bigint;
  kav10Address: string;
  publishingNode: NodeAccounts;
  receivingNodes: NodeAccounts[];
  publisherIdentityId: number;
  receiverIdentityIds: number[];
  contextGraphId: bigint;
  merkleRoot: string;
  knowledgeAssetsAmount: number;
  byteSize: number;
  epochs: number;
  tokenAmount: bigint;
  isImmutable: boolean;
  publishOperationId: string;
}): Promise<KnowledgeAssetsV10.PublishParamsStruct> {
  const publisherDigest = buildPublisherDigest(
    args.chainId,
    args.kav10Address,
    args.publisherIdentityId,
    args.contextGraphId,
    args.merkleRoot,
  );
  const ackDigest = buildPublishAckDigest(
    args.chainId,
    args.kav10Address,
    args.publisherIdentityId,
    args.contextGraphId,
    args.merkleRoot,
    args.knowledgeAssetsAmount,
    args.byteSize,
    args.epochs,
    args.tokenAmount,
  );
  const sig = await signPublishDigests(
    args.publishingNode,
    args.receivingNodes,
    publisherDigest,
    ackDigest,
  );
  return {
    publishOperationId: args.publishOperationId,
    contextGraphId: args.contextGraphId,
    merkleRoot: args.merkleRoot,
    knowledgeAssetsAmount: args.knowledgeAssetsAmount,
    byteSize: args.byteSize,
    epochs: args.epochs,
    tokenAmount: args.tokenAmount,
    isImmutable: args.isImmutable,
    publisherNodeIdentityId: args.publisherIdentityId,
    publisherNodeR: sig.publisherR,
    publisherNodeVS: sig.publisherVS,
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
  publishingNode: NodeAccounts;
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
}): Promise<KnowledgeAssetsV10.UpdateParamsStruct> {
  const publisherDigest = buildPublisherDigest(
    args.chainId,
    args.kav10Address,
    args.publisherIdentityId,
    args.contextGraphId,
    args.newMerkleRoot,
  );
  const ackDigest = buildUpdateAckDigest(
    args.chainId,
    args.kav10Address,
    args.publisherIdentityId,
    args.contextGraphId,
    args.id,
    args.preUpdateMerkleRootCount,
    args.newMerkleRoot,
    args.newByteSize,
    args.newTokenAmount,
    args.mintKnowledgeAssetsAmount,
    args.knowledgeAssetsToBurn,
  );
  const sig = await signPublishDigests(
    args.publishingNode,
    args.receivingNodes,
    publisherDigest,
    ackDigest,
  );
  return {
    id: args.id,
    updateOperationId: args.updateOperationId,
    newMerkleRoot: args.newMerkleRoot,
    newByteSize: args.newByteSize,
    newTokenAmount: args.newTokenAmount,
    mintKnowledgeAssetsAmount: args.mintKnowledgeAssetsAmount,
    knowledgeAssetsToBurn: args.knowledgeAssetsToBurn,
    publisherNodeIdentityId: args.publisherIdentityId,
    publisherNodeR: sig.publisherR,
    publisherNodeVS: sig.publisherVS,
    identityIds: args.receiverIdentityIds,
    r: sig.receiverRs,
    vs: sig.receiverVSs,
  };
}
