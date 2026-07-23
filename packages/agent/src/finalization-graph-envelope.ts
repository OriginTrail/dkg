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

export interface VerifiedGraphScopedFinalizationIdentity {
  ual: string;
  kaId: string;
  merkleRoot: string;
  targetContextGraphId?: string;
}

export interface BuildVerifiedGraphScopedFinalizationEvidenceInput {
  candidate: ParsedGraphScopedFinalization;
  publicQuadsDigest?: string;
  publisherPeerId: string;
  txIndex?: number;
  authorAddress?: string;
  accessPolicy: GraphScopedAccessPolicy;
  allowedPeers: string[];
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

export function buildVerifiedGraphScopedFinalizationEvidence(
  input: BuildVerifiedGraphScopedFinalizationEvidenceInput,
): VerifiedGraphScopedFinalizationEvidence {
  const { candidate } = input;
  return {
    assertionVersion: candidate.assertionVersion,
    publicTripleCount: candidate.publicTripleCount,
    ...(candidate.privateMerkleRoot
      ? { privateMerkleRoot: ethers.hexlify(candidate.privateMerkleRoot) }
      : {}),
    privateTripleCount: candidate.privateTripleCount,
    ...(input.publicQuadsDigest ? { publicQuadsDigest: input.publicQuadsDigest } : {}),
    publisherPeerId: input.publisherPeerId,
    publisherAddress: candidate.msg.publisherAddress,
    transactionHash: candidate.msg.txHash,
    blockNumber: candidate.blockNumber,
    txIndex: input.txIndex ?? 0,
    ...(input.authorAddress ? { authorAddress: input.authorAddress } : {}),
    accessPolicy: input.accessPolicy,
    allowedPeers: [...input.allowedPeers],
    ...(candidate.msg.subGraphName ? { subGraphName: candidate.msg.subGraphName } : {}),
  };
}

export function parseVerifiedGraphScopedFinalizationEvidence(
  value: unknown,
): VerifiedGraphScopedFinalizationEvidence {
  if (!value || typeof value !== 'object') throw new Error('verified evidence is not an object');
  const evidence = value as Record<string, unknown>;
  const allowedPeers = evidence.allowedPeers;
  if (
    !isNonEmptyString(evidence.assertionVersion)
    || !Number.isSafeInteger(evidence.publicTripleCount)
    || Number(evidence.publicTripleCount) < 0
    || !Number.isSafeInteger(evidence.privateTripleCount)
    || Number(evidence.privateTripleCount) < 0
    || (Number(evidence.publicTripleCount) === 0 && Number(evidence.privateTripleCount) === 0)
    || (evidence.privateMerkleRoot !== undefined && !isNonEmptyString(evidence.privateMerkleRoot))
    || (evidence.publicQuadsDigest !== undefined && !isNonEmptyString(evidence.publicQuadsDigest))
    || !isNonEmptyString(evidence.publisherPeerId)
    || !isNonEmptyString(evidence.publisherAddress)
    || !isNonEmptyString(evidence.transactionHash)
    || !Number.isSafeInteger(evidence.blockNumber)
    || Number(evidence.blockNumber) < 0
    || !Number.isSafeInteger(evidence.txIndex)
    || Number(evidence.txIndex) < 0
    || (evidence.authorAddress !== undefined && !isNonEmptyString(evidence.authorAddress))
    || (evidence.accessPolicy !== 'public'
      && evidence.accessPolicy !== 'ownerOnly'
      && evidence.accessPolicy !== 'allowList')
    || !Array.isArray(allowedPeers)
    || allowedPeers.some((peer) => !isNonEmptyString(peer))
    || new Set(allowedPeers).size !== allowedPeers.length
    || (evidence.accessPolicy === 'allowList' && allowedPeers.length === 0)
    || (evidence.accessPolicy !== 'allowList' && allowedPeers.length > 0)
    || (evidence.subGraphName !== undefined && !isNonEmptyString(evidence.subGraphName))
  ) {
    throw new Error('verified evidence has an invalid shape');
  }
  return evidence as unknown as VerifiedGraphScopedFinalizationEvidence;
}

export function verifiedEvidenceMatchesParsedEnvelope(
  evidence: VerifiedGraphScopedFinalizationEvidence,
  candidate: ParsedGraphScopedFinalization,
  identity: VerifiedGraphScopedFinalizationIdentity,
): boolean {
  const messagePrivateRoot = candidate.privateMerkleRoot
    ? ethers.hexlify(candidate.privateMerkleRoot).toLowerCase()
    : undefined;
  return candidate.scope.ual === identity.ual
    && candidate.kaId.toString() === identity.kaId
    && candidate.assertionVersion === evidence.assertionVersion
    && ethers.hexlify(candidate.msg.kcMerkleRoot).toLowerCase() === identity.merkleRoot.toLowerCase()
    && candidate.msg.txHash.toLowerCase() === evidence.transactionHash.toLowerCase()
    && candidate.msg.publisherAddress.toLowerCase() === evidence.publisherAddress.toLowerCase()
    && candidate.blockNumber === evidence.blockNumber
    && candidate.publicTripleCount === evidence.publicTripleCount
    && candidate.privateTripleCount === evidence.privateTripleCount
    && messagePrivateRoot === evidence.privateMerkleRoot?.toLowerCase()
    && (candidate.msg.subGraphName || undefined) === evidence.subGraphName
    && (candidate.msg.targetContextGraphId || undefined) === identity.targetContextGraphId;
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
