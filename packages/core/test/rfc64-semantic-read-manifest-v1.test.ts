import { describe, expect, it } from 'vitest';

import {
  MAX_RFC64_SEMANTIC_RECORD_RESPONSE_BYTES_V1,
  RFC64_SEMANTIC_READ_BACKENDS_V1,
  RFC64_SEMANTIC_READ_CONCURRENCY_CLASS_V1,
  RFC64_SEMANTIC_READ_QUERY_IDS_V1,
  RFC64_SEMANTIC_RECORD_ROW_COUNTS_V1,
  compileRfc64SemanticReadOperationV1,
  compileRfc64SemanticReadOperationV2,
  deriveRfc64ContextGraphSemanticAddressesV1,
  deriveRfc64CurrentAuthorCatalogRefAddressV1,
  deriveRfc64SubgraphSemanticAddressesV1,
  type ContextGraphIdV1,
  type EvmAddressV1,
  type NetworkIdV1,
  type Rfc64SemanticReadQueryIdV1,
  type Rfc64SemanticAddressV1,
  type Rfc64SemanticRecordCoordinateV1,
  type SubGraphNameV1,
} from '../src/index.js';

const NETWORK = 'otp:20430' as NetworkIdV1;
const CONTEXT_GRAPH = (
  '0x0123456789abcdef0123456789abcdef01234567/14'
) as ContextGraphIdV1;
const SUBGRAPH = 'research' as SubGraphNameV1;
const AUTHOR = '0x89abcdef0123456789abcdef0123456789abcdef' as EvmAddressV1;
const SCOPE = { networkId: NETWORK, contextGraphId: CONTEXT_GRAPH };
const SUBGRAPH_ADDRESSES = deriveRfc64SubgraphSemanticAddressesV1({
  ...SCOPE,
  subGraphName: SUBGRAPH,
});
const CONTEXT_GRAPH_ADDRESSES = deriveRfc64ContextGraphSemanticAddressesV1(SCOPE);

const CASES: readonly {
  readonly expectedQueryId: Rfc64SemanticReadQueryIdV1;
  readonly expectedAddress: Rfc64SemanticAddressV1;
  readonly coordinate: Rfc64SemanticRecordCoordinateV1;
}[] = [
  {
    expectedQueryId: 'SYNC_HEAD_REF_GET_V1',
    expectedAddress: deriveRfc64CurrentAuthorCatalogRefAddressV1({
      ...SCOPE,
      subGraphName: SUBGRAPH,
      authorAddress: AUTHOR,
    }),
    coordinate: {
      recordType: 'CurrentAuthorCatalogRefV1',
      networkId: NETWORK,
      contextGraphId: CONTEXT_GRAPH,
      subGraphName: SUBGRAPH,
      authorAddress: AUTHOR,
    },
  },
  {
    expectedQueryId: 'SYNC_MUTATION_GUARD_GET_V1',
    expectedAddress: SUBGRAPH_ADDRESSES.mutationGuard,
    coordinate: {
      recordType: 'SubgraphMutationGuardV1',
      networkId: NETWORK,
      contextGraphId: CONTEXT_GRAPH,
      subGraphName: SUBGRAPH,
    },
  },
  {
    expectedQueryId: 'SYNC_MUTATION_GUARD_GET_V1',
    expectedAddress: CONTEXT_GRAPH_ADDRESSES.mutationGuard,
    coordinate: {
      recordType: 'ContextGraphMutationGuardV1',
      networkId: NETWORK,
      contextGraphId: CONTEXT_GRAPH,
    },
  },
  {
    expectedQueryId: 'SYNC_RECONCILE_TARGET_GET_V1',
    expectedAddress: SUBGRAPH_ADDRESSES.reconcileTarget,
    coordinate: {
      recordType: 'SubgraphReconcileTargetGuardV1',
      networkId: NETWORK,
      contextGraphId: CONTEXT_GRAPH,
      subGraphName: SUBGRAPH,
    },
  },
  {
    expectedQueryId: 'SYNC_APPLIED_SEAL_GET_V1',
    expectedAddress: SUBGRAPH_ADDRESSES.appliedSeal,
    coordinate: {
      recordType: 'AppliedSubgraphSealV1',
      networkId: NETWORK,
      contextGraphId: CONTEXT_GRAPH,
      subGraphName: SUBGRAPH,
    },
  },
  {
    expectedQueryId: 'SYNC_APPLIED_SET_GET_V1',
    expectedAddress: CONTEXT_GRAPH_ADDRESSES.appliedSetRef,
    coordinate: {
      recordType: 'AppliedSubgraphSetRefV1',
      networkId: NETWORK,
      contextGraphId: CONTEXT_GRAPH,
    },
  },
  {
    expectedQueryId: 'SYNC_APPLIED_CG_SEAL_GET_V1',
    expectedAddress: CONTEXT_GRAPH_ADDRESSES.appliedSeal,
    coordinate: {
      recordType: 'AppliedContextGraphSealV1',
      networkId: NETWORK,
      contextGraphId: CONTEXT_GRAPH,
    },
  },
];

describe('RFC-64 semantic read manifest v1', () => {
  it('compiles one backend-neutral operation for every certified store route', () => {
    for (const fixture of CASES) {
      const operation = compileRfc64SemanticReadOperationV2(fixture.coordinate);
      expect(operation.queryId).toBe(fixture.expectedQueryId);
      expect(operation.graphIri).toBe(fixture.expectedAddress.graphUri);
      expect(operation.subjectIri).toBe(fixture.expectedAddress.subject);
      expect('backend' in operation).toBe(false);

      for (const backend of RFC64_SEMANTIC_READ_BACKENDS_V1) {
        const legacy = compileRfc64SemanticReadOperationV1({
          backend,
          coordinate: fixture.coordinate,
        });
        const { backend: route, ...compiled } = legacy;
        expect(route).toBe(backend);
        expect(compiled).toEqual(operation);
      }
    }
  });

  it('covers every semantic record through the six closed read IDs', () => {
    expect(RFC64_SEMANTIC_READ_QUERY_IDS_V1).toHaveLength(6);
    expect(new Set(CASES.map(({ coordinate }) => coordinate.recordType))).toEqual(
      new Set(Object.keys(RFC64_SEMANTIC_RECORD_ROW_COUNTS_V1)),
    );
    const emittedIds = CASES.map(({ coordinate }) => compileRfc64SemanticReadOperationV1({
      backend: 'oxigraph',
      coordinate,
    }).queryId);
    expect(new Set(emittedIds)).toEqual(new Set(RFC64_SEMANTIC_READ_QUERY_IDS_V1));
  });

  it('renders byte-identical bounded queries for Oxigraph and Blazegraph', () => {
    expect(RFC64_SEMANTIC_READ_BACKENDS_V1).toEqual(['oxigraph', 'blazegraph']);
    for (const fixture of CASES) {
      const oxigraph = compileRfc64SemanticReadOperationV1({
        backend: 'oxigraph',
        coordinate: fixture.coordinate,
      });
      const blazegraph = compileRfc64SemanticReadOperationV1({
        backend: 'blazegraph',
        coordinate: fixture.coordinate,
      });
      expect(blazegraph.sparql, fixture.coordinate.recordType).toBe(oxigraph.sparql);
      expect(oxigraph.queryId).toBe(fixture.expectedQueryId);
      expect(oxigraph.graphIri).toBe(fixture.expectedAddress.graphUri);
      expect(oxigraph.subjectIri).toBe(fixture.expectedAddress.subject);
      expect(oxigraph.expectedRowCount).toBe(
        RFC64_SEMANTIC_RECORD_ROW_COUNTS_V1[fixture.coordinate.recordType],
      );
      expect(oxigraph.rowCeiling).toBe(oxigraph.expectedRowCount + 1);
      expect(oxigraph.responseByteCeiling).toBe(
        MAX_RFC64_SEMANTIC_RECORD_RESPONSE_BYTES_V1,
      );
      expect(oxigraph.concurrencyClass).toBe(
        RFC64_SEMANTIC_READ_CONCURRENCY_CLASS_V1,
      );
      expect(oxigraph.sparql).toContain(`GRAPH <${oxigraph.graphIri}>`);
      expect(oxigraph.sparql).toContain(`<${oxigraph.subjectIri}> ?p ?o`);
      expect(oxigraph.sparql).toMatch(new RegExp(`LIMIT ${oxigraph.rowCeiling}$`, 'u'));
      expect(oxigraph.sparql).not.toMatch(
        /GRAPH\s+\?|ORDER\s+BY|OFFSET|VALUES|SERVICE|SELECT\s+DISTINCT/iu,
      );
      expect(Object.isFrozen(oxigraph)).toBe(true);
    }
  });

  it('freezes the exact current-author query vector', () => {
    const operation = compileRfc64SemanticReadOperationV1({
      backend: 'oxigraph',
      coordinate: CASES[0].coordinate,
    });
    expect(operation.sparql).toBe(
      'SELECT ?p ?o\n'
      + 'WHERE {\n'
      + '  GRAPH <did:dkg:context-graph:'
      + '0x0123456789abcdef0123456789abcdef01234567/14/_sync/catalog/'
      + '0x8e38ab4dfb3e25028a2c1863a0d246817222e60842f7bebe997bc5d60bbcf66e/'
      + '0x89abcdef0123456789abcdef0123456789abcdef/current> {\n'
      + '    <urn:dkg:sync:catalog:otp%3A20430:'
      + '0x0123456789abcdef0123456789abcdef01234567%2F14:'
      + '0x8e38ab4dfb3e25028a2c1863a0d246817222e60842f7bebe997bc5d60bbcf66e:'
      + '0x89abcdef0123456789abcdef0123456789abcdef> ?p ?o .\n'
      + '  }\n'
      + '}\n'
      + 'LIMIT 11',
    );
  });

  it('rejects uncertified backends and input adornment', () => {
    expect(() => compileRfc64SemanticReadOperationV1({
      backend: 'sparql-http',
      coordinate: CASES[0].coordinate,
    })).toThrow(/backend is not certified/u);
    expect(() => compileRfc64SemanticReadOperationV1({
      backend: 'oxigraph',
      queryId: 'SYNC_RAW_QUERY_V1',
      coordinate: CASES[0].coordinate,
    })).toThrow(/invalid field set/u);
    expect(() => compileRfc64SemanticReadOperationV1({
      backend: 'oxigraph',
      coordinate: CASES[0].coordinate,
      sparql: 'SELECT * WHERE { ?s ?p ?o }',
    })).toThrow(/invalid field set/u);
  });

  it('rejects accessor-bearing input fields without invoking the accessor', () => {
    let invoked = false;
    const input: Record<string, unknown> = { backend: 'oxigraph' };
    Object.defineProperty(input, 'coordinate', {
      enumerable: true,
      get() {
        invoked = true;
        return CASES[6].coordinate;
      },
    });
    expect(() => compileRfc64SemanticReadOperationV1(input)).toThrow(/invalid field set/u);
    expect(invoked).toBe(false);
  });
});
