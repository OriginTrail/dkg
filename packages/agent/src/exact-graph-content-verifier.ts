import { assertSafeIri } from '@origintrail-official/dkg-core';
import {
  computeFlatKCRootV10,
  workspacePublicQuadsDigest,
} from '@origintrail-official/dkg-publisher';
import type { Quad, TripleStore } from '@origintrail-official/dkg-storage';

export type ExactGraphContentVerification =
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

export type VerifiedExactGraphContent = Extract<
  ExactGraphContentVerification,
  { status: 'verified' }
>;

/** Verify the exact public content stored in one named graph. */
export async function verifyExactGraphContent(
  store: TripleStore,
  input: {
    graphUri: string;
    publicTripleCount: number;
    privateMerkleRoot?: Uint8Array;
    expectedMerkleRoot: Uint8Array;
    expectedPublicQuadsDigest?: string;
    source: string;
  },
): Promise<ExactGraphContentVerification> {
  const result = await store.query(
    `CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${assertSafeIri(input.graphUri)}> { ?s ?p ?o } }`,
    { source: input.source },
  );
  const quads = result.type === 'quads'
    ? result.quads.map((quad) => ({ ...quad, graph: '' }))
    : [];
  if (quads.length !== input.publicTripleCount) {
    return {
      status: 'count-mismatch',
      graphUri: input.graphUri,
      actualCount: quads.length,
    };
  }
  const merkleRoot = computeFlatKCRootV10(
    quads,
    input.privateMerkleRoot ? [input.privateMerkleRoot] : [],
  );
  if (!equalBytes(merkleRoot, input.expectedMerkleRoot)) {
    return { status: 'merkle-mismatch', graphUri: input.graphUri };
  }
  if (
    input.expectedPublicQuadsDigest !== undefined
    && workspacePublicQuadsDigest(quads) !== input.expectedPublicQuadsDigest
  ) {
    return { status: 'head-mismatch', graphUri: input.graphUri };
  }
  return {
    status: 'verified',
    graphUri: input.graphUri,
    quads,
    merkleRoot,
  };
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((byte, index) => byte === right[index]);
}
