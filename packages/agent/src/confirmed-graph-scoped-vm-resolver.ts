import {
  assertSafeIri,
  createGraphKnowledgeAssetScope,
} from '@origintrail-official/dkg-core';
import {
  computeFlatKCRootV10,
  readConfirmedGraphKnowledgeAssetMetadataEnvelope,
  workspacePublicQuadsDigest,
  type ConfirmedGraphKnowledgeAssetMetadataEnvelope,
} from '@origintrail-official/dkg-publisher';
import type { Quad, TripleStore } from '@origintrail-official/dkg-storage';

export interface ConfirmedGraphScopedVmResolutionInput {
  contextGraphId: string;
  ual: string;
  merkleRoot: Uint8Array;
  kaId: bigint;
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
    || envelope.batchId !== input.kaId
    || !equalBytes(envelope.merkleRoot, input.merkleRoot)
    || input.subGraphName !== envelope.subGraphName
  ) {
    return { status: 'invalid', reason: 'identity' };
  }

  const result = await store.query(
    `CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${assertSafeIri(envelope.assertionGraph)}> { ?s ?p ?o } }`,
    { source: 'agent.finalization.resolveConfirmedGraphScopedVm' },
  );
  const quads = result.type === 'quads'
    ? result.quads.map((quad) => ({ ...quad, graph: '' }))
    : [];
  if (quads.length !== envelope.publicTripleCount) {
    return { status: 'invalid', reason: 'content-count' };
  }
  const merkleRoot = computeFlatKCRootV10(
    quads,
    envelope.privateMerkleRoot ? [envelope.privateMerkleRoot] : [],
  );
  if (!equalBytes(merkleRoot, input.merkleRoot)) {
    return { status: 'invalid', reason: 'content-merkle' };
  }
  return {
    status: 'verified',
    envelope,
    scope,
    quads,
    publicQuadsDigest: workspacePublicQuadsDigest(quads),
  };
}
