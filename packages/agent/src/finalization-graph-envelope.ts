import {
  GRAPH_KA_CONTENT_SCOPE_VERSION,
  createGraphKnowledgeAssetScope,
  validateContextGraphId,
  validateSubGraphName,
  type FinalizationMessageMsg,
} from '@origintrail-official/dkg-core';
import { ethers } from 'ethers';

export type GraphScopedAccessPolicy = 'public' | 'ownerOnly' | 'allowList';

export interface ParsedGraphScopedFinalization {
  msg: FinalizationMessageMsg;
  scope: ReturnType<typeof createGraphKnowledgeAssetScope>;
  assertionVersion: string;
  kaId: bigint;
  blockNumber: number;
  startKAId: bigint;
  endKAId: bigint;
  batchId: bigint;
  publicTripleCount: number;
  privateTripleCount: number;
  privateMerkleRoot?: Uint8Array;
  wireAccessPolicy?: GraphScopedAccessPolicy;
  allowedPeers: string[];
}

export type GraphScopedFinalizationRejectionReason =
  | 'decode-failed'
  | 'unsupported-content-scope'
  | 'missing-ual'
  | 'invalid-transaction-hash'
  | 'invalid-merkle-root'
  | 'invalid-publisher-address'
  | 'legacy-root-entities'
  | 'context-graph-mismatch'
  | 'invalid-context-graph'
  | 'invalid-subgraph'
  | 'missing-assertion-version'
  | 'invalid-identity'
  | 'non-canonical-ual'
  | 'invalid-triple-count'
  | 'invalid-private-commitment'
  | 'invalid-access-policy'
  | 'invalid-allowed-peers'
  | 'invalid-block-number'
  | 'invalid-target-context-graph'
  | 'invalid-ka-identifiers';

export type GraphScopedFinalizationAdmission =
  | { ok: true; value: ParsedGraphScopedFinalization }
  | { ok: false; reason: GraphScopedFinalizationRejectionReason };

export interface VerifiedGraphScopedFinalizationEvidence {
  assertionVersion: string;
  publicTripleCount: number;
  privateMerkleRoot?: string;
  privateTripleCount: number;
  publicQuadsDigest?: string;
  publisherPeerId: string;
  publisherAddress: string;
  transactionHash: string;
  blockNumber: number;
  txIndex: number;
  authorAddress?: string;
  accessPolicy: GraphScopedAccessPolicy;
  allowedPeers: string[];
  subGraphName?: string;
}

function reject(reason: GraphScopedFinalizationRejectionReason): GraphScopedFinalizationAdmission {
  return { ok: false, reason };
}

function protoToNumber(value: number | bigint | { low: number; high: number; unsigned: boolean }): number {
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'number') return value;
  return ((value.high >>> 0) * 0x100000000) + (value.low >>> 0);
}

function protoToBigInt(
  value: string | number | bigint | { low: number; high: number; unsigned: boolean },
): bigint {
  if (typeof value === 'string') return BigInt(value);
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return BigInt(value);
  return (BigInt(value.high >>> 0) << 32n) | BigInt(value.low >>> 0);
}

/** Single typed admission boundary shared by live processing and durable replay. */
export function parseGraphScopedFinalization(
  msg: FinalizationMessageMsg,
  topicContextGraphId: string,
): GraphScopedFinalizationAdmission {
  if (msg.contentScopeVersion !== GRAPH_KA_CONTENT_SCOPE_VERSION) {
    return reject('unsupported-content-scope');
  }
  if (!msg.ual) return reject('missing-ual');
  if (!/^0x[0-9a-fA-F]{64}$/.test(msg.txHash)) return reject('invalid-transaction-hash');
  if (msg.kcMerkleRoot.length !== 32) return reject('invalid-merkle-root');
  if (!ethers.isAddress(msg.publisherAddress)) return reject('invalid-publisher-address');
  if (msg.rootEntities.length !== 0) return reject('legacy-root-entities');
  if (msg.contextGraphId && msg.contextGraphId !== topicContextGraphId) {
    return reject('context-graph-mismatch');
  }
  if (msg.contextGraphId && !validateContextGraphId(msg.contextGraphId).valid) {
    return reject('invalid-context-graph');
  }
  if (msg.subGraphName && !validateSubGraphName(msg.subGraphName).valid) {
    return reject('invalid-subgraph');
  }

  const assertionVersion = String(msg.assertionVersion ?? '').trim();
  if (!assertionVersion) return reject('missing-assertion-version');
  let scope: ReturnType<typeof createGraphKnowledgeAssetScope>;
  try {
    scope = createGraphKnowledgeAssetScope(msg.ual, assertionVersion);
  } catch {
    return reject('invalid-identity');
  }
  if (scope.ual !== msg.ual) return reject('non-canonical-ual');

  const publicTripleCount = Number(msg.publicTripleCount ?? 0);
  const privateTripleCount = Number(msg.privateTripleCount ?? 0);
  if (
    !Number.isSafeInteger(publicTripleCount)
    || publicTripleCount < 0
    || !Number.isSafeInteger(privateTripleCount)
    || privateTripleCount < 0
    || (publicTripleCount === 0 && privateTripleCount === 0)
  ) return reject('invalid-triple-count');

  const privateMerkleRoot = msg.privateMerkleRoot?.length
    ? new Uint8Array(msg.privateMerkleRoot)
    : undefined;
  if (
    (privateTripleCount > 0 && privateMerkleRoot?.length !== 32)
    || (privateTripleCount === 0 && privateMerkleRoot !== undefined)
  ) return reject('invalid-private-commitment');

  const accessPolicy = msg.accessPolicy || undefined;
  if (
    accessPolicy !== undefined
    && accessPolicy !== 'public'
    && accessPolicy !== 'ownerOnly'
    && accessPolicy !== 'allowList'
  ) return reject('invalid-access-policy');
  const rawAllowedPeers = msg.allowedPeers ?? [];
  const allowedPeers = [...new Set(rawAllowedPeers.map((peer) => peer.trim()).filter(Boolean))];
  if (
    allowedPeers.length !== rawAllowedPeers.length
    || (accessPolicy === 'allowList' && allowedPeers.length === 0)
    || (accessPolicy !== 'allowList' && allowedPeers.length > 0)
  ) return reject('invalid-allowed-peers');

  try {
    const kaId = (BigInt(scope.agentAddress) << 96n) | BigInt(scope.kaNumber);
    const blockNumber = protoToNumber(msg.blockNumber);
    if (!Number.isSafeInteger(blockNumber) || blockNumber < 0) {
      return reject('invalid-block-number');
    }
    const targetContextGraphId = msg.targetContextGraphId || undefined;
    if (
      targetContextGraphId !== undefined
      && (!/^\d+$/.test(targetContextGraphId) || BigInt(targetContextGraphId) <= 0n)
    ) return reject('invalid-target-context-graph');
    const startKAId = protoToBigInt(msg.startKAId);
    const endKAId = protoToBigInt(msg.endKAId);
    const batchId = protoToBigInt(msg.batchId);
    if (startKAId !== kaId || endKAId !== kaId || batchId !== kaId) {
      return reject('invalid-ka-identifiers');
    }
    return {
      ok: true,
      value: {
        msg,
        scope,
        assertionVersion,
        kaId,
        blockNumber,
        startKAId,
        endKAId,
        batchId,
        publicTripleCount,
        privateTripleCount,
        ...(privateMerkleRoot ? { privateMerkleRoot } : {}),
        ...(accessPolicy ? { wireAccessPolicy: accessPolicy } : {}),
        allowedPeers,
      },
    };
  } catch {
    return reject('invalid-ka-identifiers');
  }
}
