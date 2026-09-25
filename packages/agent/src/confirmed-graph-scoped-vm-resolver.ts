import { createGraphKnowledgeAssetScope } from '@origintrail-official/dkg-core';
import {
  readConfirmedGraphKnowledgeAssetMetadataEnvelope,
  workspacePublicQuadsDigest,
  type ConfirmedGraphKnowledgeAssetMetadataEnvelope,
} from '@origintrail-official/dkg-publisher';
import type { Quad, TripleStore } from '@origintrail-official/dkg-storage';
import { verifyExactGraphContent } from './exact-graph-content-verifier.js';

export interface ConfirmedGraphScopedVmResolutionInput {
  contextGraphId: string;
  ual: string;
  assertionVersion?: bigint;
  merkleRoot: Uint8Array;
  kaId: bigint;
  batchId: bigint;
  subGraphName?: string;
}

export type ConfirmedGraphScopedVmInvalidReason =
  | 'metadata'
  | 'identity'
  | 'content-count'
  | 'content-merkle';

export type ConfirmedGraphScopedVmResolution =
  | { status: 'absent' }
  | { status: 'invalid'; reason: ConfirmedGraphScopedVmInvalidReason }
  | {
      status: 'verified';
      envelope: ConfirmedGraphKnowledgeAssetMetadataEnvelope;
      scope: ReturnType<typeof createGraphKnowledgeAssetScope>;
      quads: Quad[];
      publicQuadsDigest: string;
    };

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((byte, index) => byte === right[index]);
}

/**
 * Resolve one exact confirmed graph-scoped VM assertion from its immutable
 * metadata and stored content. Both chain reconciliation and inbox replay use
 * this resolver so they cannot apply different recognition rules.
 */
export async function resolveConfirmedGraphScopedVm(
  store: TripleStore,
  input: ConfirmedGraphScopedVmResolutionInput,
): Promise<ConfirmedGraphScopedVmResolution> {
  return resolveConfirmedGraphScopedVmAgainst(store, input, input.merkleRoot);
}

/**
 * The same recognition without a chain read: the stored content must still
 * verify against the root its own confirmed metadata recorded. The chain-driven
 * sweep uses this to settle an ordinal whose VM copy is already confirmed
 * locally, trusting the root that copy was confirmed at.
 */
export async function resolveLocallyConfirmedGraphScopedVm(
  store: TripleStore,
  input: Omit<ConfirmedGraphScopedVmResolutionInput, 'merkleRoot'>,
): Promise<ConfirmedGraphScopedVmResolution> {
  return resolveConfirmedGraphScopedVmAgainst(store, input, undefined);
}

async function resolveConfirmedGraphScopedVmAgainst(
  store: TripleStore,
  input: Omit<ConfirmedGraphScopedVmResolutionInput, 'merkleRoot'>,
  chainMerkleRoot: Uint8Array | undefined,
): Promise<ConfirmedGraphScopedVmResolution> {
  const stored = await readConfirmedGraphKnowledgeAssetMetadataEnvelope(store, {
    contextGraphId: input.contextGraphId,
    ual: input.ual,
  });
  if (stored.state === 'absent') return { status: 'absent' };
  if (stored.state === 'invalid') {
    return { status: 'invalid', reason: 'metadata' };
  }

  const { envelope } = stored;
  let scope: ReturnType<typeof createGraphKnowledgeAssetScope>;
  try {
    scope = createGraphKnowledgeAssetScope(input.ual, envelope.assertionVersion);
  } catch {
    return { status: 'invalid', reason: 'identity' };
  }
  const packedKaId = (BigInt(scope.agentAddress) << 96n) | BigInt(scope.kaNumber);
  if (
    scope.ual !== input.ual
    || packedKaId !== input.kaId
    || envelope.batchId !== input.batchId
    || (input.assertionVersion !== undefined
      && BigInt(envelope.assertionVersion) !== input.assertionVersion)
    || (chainMerkleRoot !== undefined && !equalBytes(envelope.merkleRoot, chainMerkleRoot))
    || input.subGraphName !== envelope.subGraphName
  ) {
    return { status: 'invalid', reason: 'identity' };
  }

  const content = await verifyExactGraphContent(store, {
    graphUri: envelope.assertionGraph,
    publicTripleCount: envelope.publicTripleCount,
    ...(envelope.privateMerkleRoot
      ? { privateMerkleRoot: envelope.privateMerkleRoot }
      : {}),
    expectedMerkleRoot: chainMerkleRoot ?? envelope.merkleRoot,
    source: 'agent.finalization.resolveConfirmedGraphScopedVm',
  });
  if (content.status === 'count-mismatch') {
    return { status: 'invalid', reason: 'content-count' };
  }
  if (content.status !== 'verified') {
    return { status: 'invalid', reason: 'content-merkle' };
  }
  return {
    status: 'verified',
    envelope,
    scope,
    quads: content.quads,
    publicQuadsDigest: workspacePublicQuadsDigest(content.quads),
  };
}
