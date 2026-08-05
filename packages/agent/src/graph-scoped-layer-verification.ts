// SPDX-License-Identifier: Apache-2.0

import {
  MemoryLayer,
  assertSafeIri,
  createGraphKnowledgeAssetScope,
  knowledgeAssetLayerGraphUri,
} from '@origintrail-official/dkg-core';
import type { Quad, QueryOptions, TripleStore } from '@origintrail-official/dkg-storage';
import {
  computeFlatKCRootV10 as computeFlatKCRoot,
  type KnowledgeAssetWorkspaceHead,
  workspacePublicQuadsDigest,
} from '@origintrail-official/dkg-publisher';

export type ExactGraphScopedLayerVerification =
  | {
      status: 'verified';
      graphUri: string;
      quads: Quad[];
      merkleRoot: Uint8Array;
    }
  | {
      status: 'count-mismatch';
      graphUri: string;
      actualCount: number;
    }
  | {
      status: 'merkle-mismatch';
      graphUri: string;
    }
  | {
      status: 'head-mismatch';
      graphUri: string;
    };

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((byte, index) => byte === right[index]);
}

/**
 * Verify one exact graph-scoped VM or SWM layer from live payload content.
 * This helper deliberately has no cleanup policy and is shared by foreground
 * finalization and the independent finalized-SWM maintenance component.
 */
export async function verifyExactGraphScopedLayer(input: {
  store: TripleStore;
  contextGraphId: string;
  scope: ReturnType<typeof createGraphKnowledgeAssetScope>;
  layer: MemoryLayer.SharedWorkingMemory | MemoryLayer.VerifiableMemory;
  publicTripleCount: number;
  privateMerkleRoot?: Uint8Array;
  expectedMerkleRoot: Uint8Array;
  expectedPublicQuadsDigest?: KnowledgeAssetWorkspaceHead['publicQuadsDigest'];
  subGraphName?: string;
  queryOptions?: QueryOptions;
}): Promise<ExactGraphScopedLayerVerification> {
  const graphUri = knowledgeAssetLayerGraphUri(
    input.contextGraphId,
    input.layer,
    input.scope,
    input.subGraphName,
  );
  const result = await input.store.query(
    `CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${assertSafeIri(graphUri)}> { ?s ?p ?o } }`,
    input.queryOptions,
  );
  const quads = result.type === 'quads'
    ? result.quads.map((quad) => ({ ...quad, graph: '' }))
    : [];
  if (quads.length !== input.publicTripleCount) {
    return { status: 'count-mismatch', graphUri, actualCount: quads.length };
  }
  const merkleRoot = computeFlatKCRoot(
    quads,
    input.privateMerkleRoot ? [input.privateMerkleRoot] : [],
  );
  if (!equalBytes(merkleRoot, input.expectedMerkleRoot)) {
    return { status: 'merkle-mismatch', graphUri };
  }
  if (
    input.expectedPublicQuadsDigest !== undefined
    && workspacePublicQuadsDigest(quads) !== input.expectedPublicQuadsDigest
  ) {
    return { status: 'head-mismatch', graphUri };
  }
  return { status: 'verified', graphUri, quads, merkleRoot };
}
