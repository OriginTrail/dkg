// SPDX-License-Identifier: Apache-2.0

import { ethers } from 'ethers';
import {
  buildKnowledgeAssetUal,
  type ChainAdapter,
} from '@origintrail-official/dkg-chain';
import { createGraphKnowledgeAssetScope } from '@origintrail-official/dkg-core';
import type {
  AsyncKnowledgeAssetVmPublishRecoveryEvidence,
  KnowledgeAssetVmPublishRequest,
  LiftJobBroadcastMetadata,
} from '@origintrail-official/dkg-publisher';
import { unpackKnowledgeAssetId } from './ka-identity.js';

export interface RecoveredNamedKaPublish {
  readonly reservedKaId: bigint;
  /**
   * The single canonical graph-local identity of this named KA (author address + low-96 KA
   * number), derived from the request — never the raw resolver wire form. This is what a normal
   * publish records, and it is used both to drive local materialization and to stamp the asset's
   * `publishedUal`. The immutable identity is `reservedKaId`; this is its graph-local rendering.
   */
  readonly localUal: string;
  readonly txHash: string;
  readonly receiptBlockNumber: number;
  readonly transaction: {
    readonly merkleRoot: string;
    readonly authorAddress: string;
    readonly publisherAddress: string;
    readonly blockHash: string;
    readonly txIndex: number;
  };
  readonly materialization: {
    readonly merkleRoot: string;
    readonly authorAddress: string;
    readonly publisherAddress: string;
    readonly versionBlock: number;
    readonly superseded: boolean;
  };
}

function recoveryInconsistent(name: string, message: string): Error {
  return Object.assign(new Error(`Named KA recovery rejected for "${name}": ${message}`), {
    code: 'KA_VM_RECOVERY_INCONSISTENT',
  });
}

/**
 * Case-insensitive comparison, named for exactly what it does. It is the right test for both
 * kinds of evidence compared here: hex evidence (tx hashes, merkle roots) whose casing is not
 * significant, and the two published-UAL representations, whose only case-variable segment is
 * the embedded hex address — every other segment is already canonical by construction
 * (`buildKnowledgeAssetUal` lowercases, `createGraphKnowledgeAssetScope` canonicalizes).
 */
function equalsIgnoreCase(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

/**
 * Validate immutable transaction evidence, then separately resolve the chain's
 * current version for local materialization. A later update must never make the
 * original confirmed publish unrecoverable or regress the VM pointer.
 */
export async function normalizeRecoveredNamedKaPublish(input: {
  readonly request: KnowledgeAssetVmPublishRequest;
  // Only the broadcast metadata (queued tx hash + optional merkle root) is read here; a
  // structural type keeps the boundary honest instead of taking the whole queue-job union.
  readonly job: { readonly broadcast: LiftJobBroadcastMetadata };
  readonly recovery: AsyncKnowledgeAssetVmPublishRecoveryEvidence;
  readonly chain: ChainAdapter;
}): Promise<RecoveredNamedKaPublish> {
  const { request, job, recovery, chain } = input;
  const inconsistent = (message: string): Error => recoveryInconsistent(request.name, message);

  if (!equalsIgnoreCase(job.broadcast.txHash, recovery.inclusion.txHash)) {
    throw inconsistent(
      `resolved inclusion tx ${recovery.inclusion.txHash} does not match queued tx ${job.broadcast.txHash}`,
    );
  }
  if (!recovery.finalization.txHash || !equalsIgnoreCase(job.broadcast.txHash, recovery.finalization.txHash)) {
    throw inconsistent('resolved finalization is not bound to the queued transaction hash');
  }
  if (job.broadcast.merkleRoot && !equalsIgnoreCase(job.broadcast.merkleRoot, request.sealMerkleRoot)) {
    throw inconsistent(
      `queued broadcast merkle root ${job.broadcast.merkleRoot} does not match seal ${request.sealMerkleRoot}`,
    );
  }

  let immutableIdentity: {
    reservedKaId: bigint;
    sealedAuthor: string;
    localUal: string;
  };
  try {
    const sealedAuthor = ethers.getAddress(request.seal.authorAddress);
    let reservedKaId: bigint;
    if (request.seal.reservedKaId !== undefined) {
      reservedKaId = BigInt(request.seal.reservedKaId);
    } else if (request.kaNumber !== undefined) {
      reservedKaId = (BigInt(sealedAuthor) << 96n) | BigInt(request.kaNumber);
    } else {
      throw new Error('the immutable request has no reserved KA id');
    }
    if (reservedKaId < 0n) throw new Error('reserved KA id must be non-negative');

    const unpacked = unpackKnowledgeAssetId(reservedKaId);
    if (unpacked.agentAddress.toLowerCase() !== sealedAuthor.toLowerCase()) {
      throw new Error('reserved KA id author bits do not match the signed author address');
    }
    if (request.kaUal === undefined || request.assertionVersion === undefined) {
      throw new Error('the immutable request has no graph-scoped KA identity');
    }
    const localScope = createGraphKnowledgeAssetScope(
      request.kaUal,
      request.assertionVersion,
    );
    if (localScope.chainId !== chain.chainId) {
      throw new Error('queued graph UAL is not bound to the recovery chain');
    }
    if (
      localScope.agentAddress.toLowerCase() !== unpacked.agentAddress.toLowerCase()
      || BigInt(localScope.kaNumber) !== unpacked.kaNumber
    ) {
      throw new Error(
        `queued graph UAL ${localScope.ual} does not identify reserved KA id ${reservedKaId.toString()}`,
      );
    }
    immutableIdentity = { reservedKaId, sealedAuthor, localUal: localScope.ual };
  } catch (error) {
    throw inconsistent(`invalid reserved KA identity: ${error instanceof Error ? error.message : String(error)}`);
  }
  const { reservedKaId, sealedAuthor, localUal } = immutableIdentity;

  const { batchId, startKAId, endKAId, ual, publisherAddress } = recovery.finalization;
  if (!batchId || !startKAId || !endKAId) {
    throw inconsistent('chain recovery did not return a singleton V10 KA range');
  }
  for (const [field, value] of [
    ['batchId', batchId],
    ['startKAId', startKAId],
    ['endKAId', endKAId],
  ] as const) {
    let parsed: bigint;
    try {
      parsed = BigInt(value);
    } catch {
      throw inconsistent(`${field} ${value} is not a valid KA id`);
    }
    if (parsed !== reservedKaId) {
      throw inconsistent(`${field} ${value} does not match reserved KA id ${reservedKaId.toString()}`);
    }
  }
  if (!ual) throw inconsistent('chain recovery did not return the published UAL');
  // The normalized identity is always the canonical graph-local `localUal`, never the raw
  // resolver wire form. Cross-check the returned `ual` against the SAME reserved packed KA id
  // in either proven-equivalent representation — both already bound to chain truth by the
  // batchId/startKAId/endKAId === reservedKaId (above) and the author-bit / localScope checks,
  // all independent of `ual`. Match the graph-local form first (the shape the CLI resolver
  // surfaces for named KAs); only when it does not match do we resolve and compare the
  // canonical chain-receipt form (DKGKnowledgeAssets contract + packed id) the generic mapper
  // produces — so the common named-KA path never needs the contract address. Every other UAL
  // fails closed; `ual` is validated here and never exported.
  if (!equalsIgnoreCase(ual, localUal)) {
    let expectedReceiptUal: string;
    try {
      if (!chain.getDKGKnowledgeAssetsAddress) {
        throw new Error('the configured chain adapter cannot resolve the DKGKnowledgeAssets address');
      }
      const knowledgeAssetsContract = await chain.getDKGKnowledgeAssetsAddress();
      expectedReceiptUal = buildKnowledgeAssetUal(
        chain.chainId,
        ethers.getAddress(knowledgeAssetsContract),
        reservedKaId,
      );
    } catch (error) {
      throw inconsistent(
        `could not resolve the canonical receipt UAL: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!equalsIgnoreCase(ual, expectedReceiptUal)) {
      throw inconsistent(
        `published receipt UAL ${ual} does not match the graph-local UAL ${localUal} or the canonical receipt UAL ${expectedReceiptUal}`,
      );
    }
  }
  if (!publisherAddress || !ethers.isAddress(publisherAddress)) {
    throw inconsistent('chain recovery did not return a valid publisher address');
  }
  const transactionPublisher = ethers.getAddress(publisherAddress);

  const proof = recovery.publishProof;
  const blockHash = recovery.inclusion.blockHash;
  if (!blockHash || !/^0x[0-9a-fA-F]{64}$/.test(blockHash)) {
    throw inconsistent('chain recovery did not return a valid canonical block hash');
  }
  if (!equalsIgnoreCase(proof.merkleRoot, request.sealMerkleRoot)) {
    throw inconsistent(
      `transaction merkle root ${proof.merkleRoot} does not match queued seal ${request.sealMerkleRoot}`,
    );
  }
  if (!ethers.isAddress(proof.authorAddress)) {
    throw inconsistent('chain recovery did not return the transaction author');
  }
  if (!Number.isSafeInteger(proof.txIndex) || proof.txIndex < 0) {
    throw inconsistent('chain recovery did not return a valid transaction index');
  }
  const transactionAuthor = ethers.getAddress(proof.authorAddress);
  if (transactionAuthor === ethers.ZeroAddress || transactionAuthor.toLowerCase() !== sealedAuthor.toLowerCase()) {
    throw inconsistent(
      `transaction author ${transactionAuthor} does not match sealed author ${sealedAuthor}`,
    );
  }

  if (!chain.getLatestMerkleRoot) {
    throw inconsistent('the configured chain adapter cannot resolve the current KA merkle root');
  }
  const latestMerkleRoot = ethers.hexlify(await chain.getLatestMerkleRoot(reservedKaId));
  const superseded = !equalsIgnoreCase(latestMerkleRoot, proof.merkleRoot);
  let materializationAuthor = transactionAuthor;
  let materializationPublisher = transactionPublisher;
  let versionBlock = recovery.inclusion.blockNumber;

  if (superseded) {
    if (!chain.getLatestMerkleRootAuthor || !chain.getLatestMerkleRootPublisher || !chain.getBlockNumber) {
      throw inconsistent('the configured chain adapter cannot safely materialize a superseding KA version');
    }
    materializationAuthor = ethers.getAddress(await chain.getLatestMerkleRootAuthor(reservedKaId));
    materializationPublisher = ethers.getAddress(await chain.getLatestMerkleRootPublisher(reservedKaId));
    versionBlock = await chain.getBlockNumber();
    if (materializationAuthor === ethers.ZeroAddress || materializationPublisher === ethers.ZeroAddress) {
      throw inconsistent('the superseding KA version has an invalid author or publisher');
    }
  }

  return {
    reservedKaId,
    localUal,
    txHash: recovery.inclusion.txHash,
    receiptBlockNumber: recovery.inclusion.blockNumber,
    transaction: {
      merkleRoot: ethers.hexlify(proof.merkleRoot),
      authorAddress: transactionAuthor,
      publisherAddress: transactionPublisher,
      blockHash,
      txIndex: proof.txIndex,
    },
    materialization: {
      merkleRoot: latestMerkleRoot,
      authorAddress: materializationAuthor,
      publisherAddress: materializationPublisher,
      versionBlock,
      superseded,
    },
  };
}
