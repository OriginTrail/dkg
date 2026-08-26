import {
  computeFlatKCRootV10,
  workspacePublicQuadsDigest,
} from '@origintrail-official/dkg-publisher';
import {
  ExactGraphReadError,
  readExactGraphPaged,
  type Quad,
  type TripleStore,
} from '@origintrail-official/dkg-storage';

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
  let quads: Quad[];
  try {
    quads = await readExactGraphPaged(store, input.graphUri, {
      expectedQuadCount: input.publicTripleCount,
      outputGraph: '',
      queryOptions: { source: input.source },
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
