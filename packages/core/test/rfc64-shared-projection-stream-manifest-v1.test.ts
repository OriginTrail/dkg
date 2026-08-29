import { describe, expect, it } from 'vitest';

import {
  assertAuthorCatalogRowV1,
  assertAuthorCatalogScopeV1,
  type AuthorCatalogRowV1,
  type AuthorCatalogScopeV1,
} from '../src/author-catalog-codec.js';
import {
  verifyCatalogSealBindingV1,
  type CatalogSealDeploymentProfileV1,
} from '../src/catalog-seal-binding.js';
import {
  assertCanonicalGraphScopedAuthorSealV1,
  canonicalizeCanonicalGraphScopedAuthorSealBytesV1,
  type CanonicalGraphScopedAuthorSealV1,
} from '../src/canonical-graph-scoped-author-seal.js';
import {
  RFC64_SHARED_PROJECTION_STREAM_PROTOCOL_BYTES_V1,
  Rfc64SharedProjectionStreamManifestErrorV1,
  compileRfc64SharedProjectionStreamOperationV1,
} from '../src/rfc64-shared-projection-stream-manifest-v1.js';

const AUTHOR = '0x3333333333333333333333333333333333333333';
const KAV10 = '0x4444444444444444444444444444444444444444';
const KA_ID =
  '23158417847463239084714197001737581570653996933112267175388663934063917137927';
const SEAL_DIGEST =
  '0x8fc37c7f66831aea9b2a0ed35aac26bb6eec2eb3042ed0dcdd2e023d3087632a';
const ZERO_DIGEST = `0x${'00'.repeat(32)}`;
const SCOPE = validScope({
  networkId: 'otp:20430',
  contextGraphId: 'a/b',
  governanceChainId: '20430',
  governanceContractAddress: '0x5555555555555555555555555555555555555555',
  ownershipTransitionDigest: null,
  subGraphName: null,
  authorAddress: AUTHOR,
  era: '0',
  bucketCount: '1',
});
const ROW = validRow({
  kaId: KA_ID,
  assertionCoordinate: 'name λ',
  assertionVersion: '2',
  projectionId: 'cg-shared-v1',
  projectionDigest: ZERO_DIGEST,
  sealDigest: SEAL_DIGEST,
  transfer: {
    codec: 'dkg-ka-bundle-v1',
    projectionId: 'cg-shared-v1',
    projectionDigest: ZERO_DIGEST,
    byteLength: '16',
    chunkSize: '262144',
    chunkCount: '1',
    blobDigest: `0x${'11'.repeat(32)}`,
    chunkTreeRoot: `0x${'22'.repeat(32)}`,
  },
});
const PROFILE = {
  networkId: 'otp:20430',
  assertedAtChainId: '20430',
  assertedAtKav10Address: KAV10,
} as CatalogSealDeploymentProfileV1;
const SEAL = validSeal({
  assertionMerkleRoot: `0x${'aa'.repeat(32)}`,
  authorAddress: AUTHOR,
  authorAttestationR: `0x${'11'.repeat(32)}`,
  authorAttestationVS: `0x${'22'.repeat(32)}`,
  authorSchemeVersion: '1',
  assertedAtChainId: '20430',
  assertedAtKav10Address: KAV10,
  reservedKaId: KA_ID,
  assertionFinalizedAt: '2026-07-19T12:34:56.789Z',
  contentScopeVersion: '2',
  kaUal: `did:dkg:otp:20430/${AUTHOR}/7`,
  assertionVersion: '2',
  publicTripleCount: '12977',
  privateTripleCount: '0',
  privateMerkleRoot: null,
});

describe('RFC-64 shared-projection stream manifest v1', () => {
  it('derives the sole graph, commitment subject, and signed ceiling from verified inputs', () => {
    const sealBinding = verifyCatalogSealBindingV1(
      SCOPE,
      ROW,
      canonicalizeCanonicalGraphScopedAuthorSealBytesV1(SEAL),
      PROFILE,
    );
    const operation = compileRfc64SharedProjectionStreamOperationV1({
      sealBinding,
    });

    const graph =
      `did:dkg:context-graph:v1/root/a%2Fb/_shared_memory/${AUTHOR}/7`;
    expect(operation).toMatchObject({
      queryId: 'SYNC_KA_SHARED_PROJECTION_STREAM_V1',
      graphIri: graph,
      projectionDigest: ZERO_DIGEST,
      publicTripleCount: '12977',
      signedByteCeiling: 16,
      protocolByteCeiling: RFC64_SHARED_PROJECTION_STREAM_PROTOCOL_BYTES_V1,
      resultKind: 'quad-stream',
      concurrencyClass: 'rfc64-shared-projection-v1',
    });
    expect(operation.commitmentSubject).toBe(
      `did:dkg:otp:20430/${AUTHOR}/7/_cg-shared-v1`,
    );
    expect(operation.sparql).toBe(
      `CONSTRUCT { ?s ?p ?o }\nWHERE {\n  GRAPH <${graph}> {\n    ?s ?p ?o .\n  }\n}`,
    );
    expect(Object.isFrozen(operation)).toBe(true);
  });

  it('derives a subgraph placement without admitting caller-selected targets', () => {
    const scope = validScope({ ...SCOPE, subGraphName: 'curated' });
    const sealBinding = verifyCatalogSealBindingV1(
      scope,
      ROW,
      canonicalizeCanonicalGraphScopedAuthorSealBytesV1(SEAL),
      PROFILE,
    );
    const operation = compileRfc64SharedProjectionStreamOperationV1({
      sealBinding,
    });
    expect(operation.graphIri).toBe(
      `did:dkg:context-graph:v1/subgraph/a%2Fb/curated/_shared_memory/${AUTHOR}/7`,
    );
    expect(operation.sparql).not.toMatch(/OFFSET|ORDER BY|VALUES|GRAPH \?g/);
  });

  it('cannot alias a named lane with a slash-containing root context graph', () => {
    const namedScope = validScope({
      ...SCOPE,
      contextGraphId: 'a/b',
      subGraphName: 'curated',
    });
    const rootScope = validScope({
      ...SCOPE,
      contextGraphId: 'a/b/curated',
      subGraphName: null,
    });
    const named = compileRfc64SharedProjectionStreamOperationV1({
      sealBinding: verifyCatalogSealBindingV1(
        namedScope,
        ROW,
        canonicalizeCanonicalGraphScopedAuthorSealBytesV1(SEAL),
        PROFILE,
      ),
    });
    const root = compileRfc64SharedProjectionStreamOperationV1({
      sealBinding: verifyCatalogSealBindingV1(
        rootScope,
        ROW,
        canonicalizeCanonicalGraphScopedAuthorSealBytesV1(SEAL),
        PROFILE,
      ),
    });

    expect(named.graphIri).not.toBe(root.graphIri);
    expect(named.graphIri).toContain(':v1/subgraph/');
    expect(root.graphIri).toContain(':v1/root/');
  });

  it('does not expose a raw scope/row rebinding surface beside the verified proof', () => {
    const sealBinding = verifyCatalogSealBindingV1(
      SCOPE,
      ROW,
      canonicalizeCanonicalGraphScopedAuthorSealBytesV1(SEAL),
      PROFILE,
    );
    expect(() => compileRfc64SharedProjectionStreamOperationV1({
      catalogScope: SCOPE,
      catalogRow: ROW,
      sealBinding,
    })).toThrow(Rfc64SharedProjectionStreamManifestErrorV1);
  });

  it('rejects accessor-backed request fields without invoking them', () => {
    let invoked = false;
    const input = {
      sealBinding: Object.freeze(Object.create(null)),
    };
    Object.defineProperty(input, 'sealBinding', {
      enumerable: true,
      get() {
        invoked = true;
        return Object.freeze(Object.create(null));
      },
    });
    expect(() => compileRfc64SharedProjectionStreamOperationV1(input))
      .toThrow(Rfc64SharedProjectionStreamManifestErrorV1);
    expect(invoked).toBe(false);
  });
});

function validScope(value: unknown): AuthorCatalogScopeV1 {
  assertAuthorCatalogScopeV1(value);
  return value;
}

function validRow(value: unknown): AuthorCatalogRowV1 {
  assertAuthorCatalogRowV1(value);
  return value;
}

function validSeal(value: unknown): CanonicalGraphScopedAuthorSealV1 {
  assertCanonicalGraphScopedAuthorSealV1(value);
  return value;
}
