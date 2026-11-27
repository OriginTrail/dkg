// SPDX-License-Identifier: Apache-2.0

/**
 * One confirmed named-KA publish awaiting recovery: the queued request, the
 * recovery evidence the chain proved for it, and a chain whose latest root is
 * the publish's own. Shared by the suites about what a deferred recovery says
 * (the normalizer's message and diagnostics, the agent's pending warning).
 */

import { ethers } from 'ethers';
import {
  MockChainAdapter,
  type KnowledgeAssetVersionSnapshotReadOptions,
  type KnowledgeAssetVersionSnapshotUnavailable,
} from '@origintrail-official/dkg-chain';
import { GRAPH_KA_CONTENT_SCOPE_VERSION } from '@origintrail-official/dkg-core';
import type {
  AsyncKnowledgeAssetVmPublishRecoveryEvidence,
  KnowledgeAssetVmPublishRequest,
} from '@origintrail-official/dkg-publisher';

type Hex = `0x${string}`;
type BigIntString = `${bigint}`;

export const CHAIN_ID = 'evm:31337';
export const AUTHOR = '0x00a9d0dcab936a418ffebc734476c91d4027d359' as Hex;
export const PUBLISHER = `0x${'22'.repeat(20)}` as Hex;
export const ASSET_NAME = 'campaign-v2-3p95mib-ka-018';
export const SEAL_MERKLE_ROOT = `0x${'12'.repeat(32)}` as Hex;
export const TX_HASH = `0x${'ab'.repeat(32)}` as Hex;
const KA_NUMBER = 402n;
const RESERVED_KA_ID = (BigInt(ethers.getAddress(AUTHOR)) << 96n) | KA_NUMBER;
const GRAPH_LOCAL_UAL = `did:dkg:${CHAIN_ID}/${AUTHOR}/${KA_NUMBER}`;

/** What every deferral of this recovery carries. */
export const DEFERRED = { code: 'KA_VM_RECOVERY_INCONSISTENT' };

/** The deferral for a missing version view, as it read before a cause was appended. */
export const NO_VIEW_REASON = 'the current KA version could not be established from a single coherent chain view; '
  + 'recovery is deferred rather than deciding supersession from a weaker signal';
export const NO_VIEW_DEFERRAL = `Named KA recovery rejected for "${ASSET_NAME}": ${NO_VIEW_REASON}`;

/** Both configured endpoints were asked and neither supplied a view. */
export const NO_ENDPOINT_SERVES: KnowledgeAssetVersionSnapshotUnavailable = {
  reason: 'endpoints-failed',
  endpointCount: 2,
  endpoints: [
    { position: 1, host: 'rpc.example', stage: 'pinned-read', failure: 'http-client-error', httpStatus: 400 },
    { position: 2, host: 'backup.example', stage: 'head-block', failure: 'network' },
  ],
};
export const NO_ENDPOINT_SERVES_WORDS = 'endpoint 1 of 2 (rpc.example) refused a block-pinned read (http 400); '
  + 'endpoint 2 of 2 (backup.example) could not be reached for the head block read';

export function seededChain(): MockChainAdapter {
  const chain = new MockChainAdapter(CHAIN_ID);
  chain.__registerKC({
    kaId: RESERVED_KA_ID,
    contextGraphId: 1n,
    merkleRootHex: SEAL_MERKLE_ROOT,
    chunks: [],
  });
  return chain;
}

export type SnapshotRead = (
  kaId: bigint,
  options?: KnowledgeAssetVersionSnapshotReadOptions,
) => Promise<unknown>;

/** The seeded chain with its version read replaced. */
export function chainWithSnapshotRead(read: SnapshotRead): MockChainAdapter {
  const chain = seededChain();
  (chain as unknown as { readKnowledgeAssetVersionSnapshot: SnapshotRead })
    .readKnowledgeAssetVersionSnapshot = read;
  return chain;
}

/** A version read that reports `report` and answers `null`. */
export function unavailableRead(report: KnowledgeAssetVersionSnapshotUnavailable): SnapshotRead {
  return async (_kaId, options) => {
    options?.onUnavailable?.(report);
    return null;
  };
}

/** A complete view that shows this publish as the current version. */
export function currentView() {
  return { latestRoot: SEAL_MERKLE_ROOT, rootCount: 1n, latestAuthor: AUTHOR, latestPublisher: PUBLISHER, blockNumber: 300 };
}

export function baseRequest(): KnowledgeAssetVmPublishRequest {
  return {
    contextGraphId: '1',
    name: ASSET_NAME,
    shareOperationId: 'share-op-1966',
    roots: [],
    contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
    kaUal: GRAPH_LOCAL_UAL,
    assertionVersion: '1',
    publicTripleCount: 1,
    privateTripleCount: 0,
    seal: {
      merkleRoot: SEAL_MERKLE_ROOT,
      authorAddress: AUTHOR,
      signature: { r: `0x${'34'.repeat(32)}` as Hex, vs: `0x${'56'.repeat(32)}` as Hex },
      schemeVersion: 1,
      reservedKaId: RESERVED_KA_ID.toString() as BigIntString,
    },
    sealChainId: '31337',
    sealKav10Address: `0x${'44'.repeat(20)}` as Hex,
    sealFinalizedAtIso: '2026-01-01T00:00:00.000Z',
    sealMerkleRoot: SEAL_MERKLE_ROOT,
    intentKey: `sha256:${'ab'.repeat(32)}`,
    kaNumber: KA_NUMBER.toString(),
  };
}

export function queuedTx(): { txHash: string; merkleRoot?: string } {
  return { txHash: TX_HASH, merkleRoot: SEAL_MERKLE_ROOT };
}

function evidence(
  publishProof: AsyncKnowledgeAssetVmPublishRecoveryEvidence['publishProof'],
): AsyncKnowledgeAssetVmPublishRecoveryEvidence {
  return {
    inclusion: {
      txHash: TX_HASH,
      blockNumber: 77,
      blockHash: `0x${'cd'.repeat(32)}` as Hex,
      blockTimestamp: 1_700_000_077,
    },
    finalization: {
      mode: 'published',
      txHash: TX_HASH,
      ual: GRAPH_LOCAL_UAL,
      batchId: RESERVED_KA_ID.toString() as BigIntString,
      startKAId: RESERVED_KA_ID.toString() as BigIntString,
      endKAId: RESERVED_KA_ID.toString() as BigIntString,
      publisherAddress: PUBLISHER,
    },
    publishProof,
  };
}

/** Evidence that carries a history position, so a missing view defers. */
export function positionedEvidence(position = '1'): AsyncKnowledgeAssetVmPublishRecoveryEvidence {
  return evidence({ merkleRoot: SEAL_MERKLE_ROOT, authorAddress: AUTHOR, txIndex: 4, merkleRootCount: position });
}

/** Evidence from before the position was recorded: it settles by the latest root. */
export function legacyEvidence(): AsyncKnowledgeAssetVmPublishRecoveryEvidence {
  return evidence({ merkleRoot: SEAL_MERKLE_ROOT, authorAddress: AUTHOR, txIndex: 4 });
}
