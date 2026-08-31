import { describe, expect, it } from 'vitest';

// Import strictly through the package barrel so this test fails if a newly
// exposed RFC-64 symbol is dropped from src/index.ts, even while the direct
// module-level behavior tests stay green.
import {
  MAX_KA_TRANSFER_BYTES_V1,
  MAX_RFC64_PENDING_TARGET_DIGESTS_V1,
  RFC64_SEMANTIC_READ_QUERY_IDS_V1,
  RFC64_DIGEST_LIST_DATATYPE_IRI_V1,
  RFC64_SEMANTIC_NULL_IRI_V1,
  RFC64_SUBGRAPH_KEY_DOMAIN_V1,
  TypedRdfStoreRowErrorV1,
  assertCanonicalChainId,
  assertCanonicalDecimalU64,
  assertCanonicalDecimalU256,
  assertCanonicalDigest,
  assertCanonicalHexBytes,
  assertCanonicalKaId,
  assertCanonicalTimestampMs,
  assertKaTransferDescriptorV1,
  canonicalizeKaTransferDescriptorV1,
  computeRfc64SubGraphKeyV1,
  compileRfc64SemanticReadOperationV2,
  decodeRfc64SemanticRecordStoreRowsV1,
  deriveRfc64ContextGraphSemanticAddressesV1,
  deriveRfc64CurrentAuthorCatalogRefAddressV1,
  deriveRfc64SubgraphSemanticAddressesV1,
  parseCanonicalDecimalU64,
  parseCanonicalDecimalU256,
  parseCanonicalKaTransferDescriptorV1,
  projectRfc64SemanticRecordStoreRowsV1,
  renderRfc64SemanticStoreRowV1,
  renderTypedRdfStoreRowV1,
  snapshotRfc64SemanticRecordCoordinateV1,
  snapshotRfc64SemanticRecordV1,
  snapshotTypedRdfStoreRowV1,
  typedRdfLiteralV1,
  typedRdfNamedNodeV1,
} from '../src/index.js';

const VALID_MIN = {
  codec: 'dkg-ka-bundle-v1',
  projectionId: 'cg-shared-v1',
  projectionDigest: `0x${'00'.repeat(32)}`,
  byteLength: '16',
  chunkSize: '262144',
  chunkCount: '1',
  blobDigest: `0x${'11'.repeat(32)}`,
  chunkTreeRoot: `0x${'22'.repeat(32)}`,
};
const VALID_MIN_CANONICAL =
  '{"blobDigest":"0x1111111111111111111111111111111111111111111111111111111111111111","byteLength":"16","chunkCount":"1","chunkSize":"262144","chunkTreeRoot":"0x2222222222222222222222222222222222222222222222222222222222222222","codec":"dkg-ka-bundle-v1","projectionDigest":"0x0000000000000000000000000000000000000000000000000000000000000000","projectionId":"cg-shared-v1"}';

describe('RFC-64 transfer descriptor + wire scalars public package barrel', () => {
  it('re-exports the KA transfer descriptor API from ../src/index.js', () => {
    expect(typeof assertKaTransferDescriptorV1).toBe('function');
    expect(MAX_KA_TRANSFER_BYTES_V1).toBe(1_073_741_824n);
    expect(() => assertKaTransferDescriptorV1(VALID_MIN)).not.toThrow();
    expect(canonicalizeKaTransferDescriptorV1(VALID_MIN)).toBe(VALID_MIN_CANONICAL);
    expect(parseCanonicalKaTransferDescriptorV1(VALID_MIN_CANONICAL)).toEqual(VALID_MIN);
  });

  it('re-exports the dormant RFC-64 semantic-address API', () => {
    expect(RFC64_SUBGRAPH_KEY_DOMAIN_V1).toBe('dkg-subgraph-key-v1\n');
    for (const [name, fn] of [
      ['computeRfc64SubGraphKeyV1', computeRfc64SubGraphKeyV1],
      [
        'deriveRfc64CurrentAuthorCatalogRefAddressV1',
        deriveRfc64CurrentAuthorCatalogRefAddressV1,
      ],
      ['deriveRfc64SubgraphSemanticAddressesV1', deriveRfc64SubgraphSemanticAddressesV1],
      [
        'deriveRfc64ContextGraphSemanticAddressesV1',
        deriveRfc64ContextGraphSemanticAddressesV1,
      ],
    ] as const) {
      expect(typeof fn, name).toBe('function');
    }
    expect(computeRfc64SubGraphKeyV1(null)).toBe(
      '0x746bfff91a7c229a180489f0149b250944da97e5038b125af5df5a74916518e4',
    );
  });

  it('re-exports the dormant RFC-64 semantic-record codec', () => {
    expect(RFC64_SEMANTIC_NULL_IRI_V1).toBe('urn:dkg:sync:null');
    expect(RFC64_DIGEST_LIST_DATATYPE_IRI_V1).toBe(
      'http://dkg.io/ontology/digestListV1',
    );
    expect(MAX_RFC64_PENDING_TARGET_DIGESTS_V1).toBe(64);
    expect(RFC64_SEMANTIC_READ_QUERY_IDS_V1).toHaveLength(6);
    for (const [name, fn] of [
      ['compileRfc64SemanticReadOperationV2', compileRfc64SemanticReadOperationV2],
      ['decodeRfc64SemanticRecordStoreRowsV1', decodeRfc64SemanticRecordStoreRowsV1],
      ['projectRfc64SemanticRecordStoreRowsV1', projectRfc64SemanticRecordStoreRowsV1],
      ['renderRfc64SemanticStoreRowV1', renderRfc64SemanticStoreRowV1],
      ['snapshotRfc64SemanticRecordCoordinateV1', snapshotRfc64SemanticRecordCoordinateV1],
      ['snapshotRfc64SemanticRecordV1', snapshotRfc64SemanticRecordV1],
    ] as const) {
      expect(typeof fn, name).toBe('function');
    }
  });

  it('re-exports the typed RDF store-row API with its generic error contract', () => {
    for (const [name, fn] of [
      ['renderTypedRdfStoreRowV1', renderTypedRdfStoreRowV1],
      ['snapshotTypedRdfStoreRowV1', snapshotTypedRdfStoreRowV1],
      ['typedRdfLiteralV1', typedRdfLiteralV1],
      ['typedRdfNamedNodeV1', typedRdfNamedNodeV1],
    ] as const) {
      expect(typeof fn, name).toBe('function');
    }

    const valid = {
      subjectIri: 'urn:test:subject',
      predicateIri: 'urn:test:predicate',
      graphIri: 'urn:test:graph',
      object: typedRdfNamedNodeV1('urn:test:object'),
    };
    expect(snapshotTypedRdfStoreRowV1(valid)).toEqual(valid);
    expect(renderTypedRdfStoreRowV1(valid)).toEqual({
      subject: 'urn:test:subject',
      predicate: 'urn:test:predicate',
      object: '<urn:test:object>',
      graph: 'urn:test:graph',
    });

    for (const [input, code] of [
      [{ ...valid, subjectIri: 42 }, 'row-schema'],
      [{ ...valid, subjectIri: 'urn:has space' }, 'row-term'],
    ] as const) {
      let failure: unknown;
      try {
        snapshotTypedRdfStoreRowV1(input);
      } catch (cause) {
        failure = cause;
      }
      expect(failure).toBeInstanceOf(TypedRdfStoreRowErrorV1);
      expect((failure as TypedRdfStoreRowErrorV1).code).toBe(code);
    }
  });

  it('re-exports the full canonical wire scalar API from ../src/index.js', () => {
    // Export-surface check: every newly exposed scalar symbol must be present on
    // the barrel, so dropping any from src/index.ts fails here.
    for (const [name, fn] of [
      ['assertCanonicalChainId', assertCanonicalChainId],
      ['assertCanonicalDecimalU64', assertCanonicalDecimalU64],
      ['assertCanonicalDecimalU256', assertCanonicalDecimalU256],
      ['assertCanonicalDigest', assertCanonicalDigest],
      ['assertCanonicalHexBytes', assertCanonicalHexBytes],
      ['assertCanonicalKaId', assertCanonicalKaId],
      ['assertCanonicalTimestampMs', assertCanonicalTimestampMs],
      ['parseCanonicalDecimalU64', parseCanonicalDecimalU64],
      ['parseCanonicalDecimalU256', parseCanonicalDecimalU256],
    ] as const) {
      expect(typeof fn, name).toBe('function');
    }
    // Representative behavior through the barrel.
    expect(() => assertCanonicalDecimalU64('16', 'byteLength')).not.toThrow();
    expect(() => assertCanonicalDecimalU64('01', 'byteLength')).toThrow();
    expect(parseCanonicalDecimalU256('255', 'x')).toBe(255n);
    expect(() => assertCanonicalDigest(`0x${'11'.repeat(32)}`, 'digest')).not.toThrow();
    expect(() => assertCanonicalDigest(`0x${'GG'.repeat(32)}`, 'digest')).toThrow();
  });
});
