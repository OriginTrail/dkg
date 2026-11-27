import { samePublicRdfTriples } from './same-public-rdf-triples.js';
import {
  computeFlatKCRootV10,
  workspacePublicQuadsDigest,
} from '@origintrail-official/dkg-publisher';
import {
  ExactGraphReadError,
  readExactGraph,
  type Quad,
  type QueryOptions,
  type TripleStore,
} from '@origintrail-official/dkg-storage';

export type ExactGraphContentVerification =
  | {
      status: 'verified';
      graphUri: string;
      /** Exact rows observed in this layer, in the store's spelling. */
      quads: Quad[];
      /** Original operation digest when its RDF spelling differs from the verified store rows. */
      equivalentOperationDigest?: string;
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
    operationQuads?: Quad[];
    source: string;
    /** Caller-owned whole-asset limits; physical query pages remain storage-bounded. */
    readLimits?: { maxQuadCount: number; maxNQuadsBytes: number };
    queryOptions?: Omit<QueryOptions, 'source'>;
  },
): Promise<ExactGraphContentVerification> {
  let quads: Quad[];
  try {
    quads = await readExactGraph(store, input.graphUri, {
      profile: 'bounded-single-result',
      ...input.readLimits,
      expectedQuadCount: input.publicTripleCount,
      outputGraph: '',
      queryOptions: { ...input.queryOptions, source: input.source },
    });
  } catch (error) {
    if (
      error instanceof ExactGraphReadError
      && error.code === 'QUAD_COUNT_MISMATCH'
      && typeof error.actual === 'number'
    ) {
      return {
        status: 'count-mismatch',
        graphUri: input.graphUri,
        actualCount: error.actual,
      };
    }
    throw error;
  }
  const merkleRoot = computeFlatKCRootV10(
    quads,
    input.privateMerkleRoot ? [input.privateMerkleRoot] : [],
  );
  if (!equalBytes(merkleRoot, input.expectedMerkleRoot)) {
    return { status: 'merkle-mismatch', graphUri: input.graphUri };
  }
  let equivalentOperationDigest: string | undefined;
  if (
    input.expectedPublicQuadsDigest !== undefined
    && workspacePublicQuadsDigest(quads) !== input.expectedPublicQuadsDigest
  ) {
    // A store may return decoded Unicode where the original operation used escapes.
    // The chain root alone also equates some *different* RDF literals (e.g. 01 and 1).
    const original = input.operationQuads;
    if (!original || original.length !== input.publicTripleCount
      || workspacePublicQuadsDigest(original) !== input.expectedPublicQuadsDigest
      || !samePublicRdfTriples(original, quads)
      || !equalBytes(computeFlatKCRootV10(original, input.privateMerkleRoot ? [input.privateMerkleRoot] : []), merkleRoot)
    ) {
      return { status: 'head-mismatch', graphUri: input.graphUri };
    }
    equivalentOperationDigest = input.expectedPublicQuadsDigest;
  }
  return {
    status: 'verified',
    graphUri: input.graphUri,
    quads,
    ...(equivalentOperationDigest === undefined ? {} : { equivalentOperationDigest }),
    merkleRoot,
  };
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((byte, index) => byte === right[index]);
}
