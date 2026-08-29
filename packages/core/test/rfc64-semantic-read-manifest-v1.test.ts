import { describe, expect, it } from 'vitest';

import {
  MAX_RFC64_SEMANTIC_RECORD_RESPONSE_BYTES_V1,
  RFC64_SEMANTIC_READ_BACKENDS_V1,
  RFC64_SEMANTIC_READ_CONCURRENCY_CLASS_V1,
  RFC64_SEMANTIC_READ_QUERY_IDS_V1,
  RFC64_SEMANTIC_RECORD_ROW_COUNTS_V1,
  assertRfc64SemanticReadOperationV1,
  compileRfc64SemanticReadOperationV1,
  type ContextGraphIdV1,
  type EvmAddressV1,
  type NetworkIdV1,
  type Rfc64SemanticReadQueryIdV1,
  type Rfc64SemanticRecordCoordinateV1,
  type SubGraphNameV1,
} from '../src/index.js';

const NETWORK = 'otp:20430' as NetworkIdV1;
const CONTEXT_GRAPH = (
  '0x0123456789abcdef0123456789abcdef01234567/14'
) as ContextGraphIdV1;
const SUBGRAPH = 'research' as SubGraphNameV1;
const AUTHOR = '0x89abcdef0123456789abcdef0123456789abcdef' as EvmAddressV1;

const CASES: readonly {
  readonly queryId: Rfc64SemanticReadQueryIdV1;
  readonly coordinate: Rfc64SemanticRecordCoordinateV1;
}[] = [
  {
    queryId: 'SYNC_HEAD_REF_GET_V1',
    coordinate: {
      recordType: 'CurrentAuthorCatalogRefV1',
      networkId: NETWORK,
      contextGraphId: CONTEXT_GRAPH,
      subGraphName: SUBGRAPH,
      authorAddress: AUTHOR,
    },
  },
  {
    queryId: 'SYNC_MUTATION_GUARD_GET_V1',
    coordinate: {
      recordType: 'SubgraphMutationGuardV1',
      networkId: NETWORK,
      contextGraphId: CONTEXT_GRAPH,
      subGraphName: SUBGRAPH,
    },
  },
  {
    queryId: 'SYNC_MUTATION_GUARD_GET_V1',
    coordinate: {
      recordType: 'ContextGraphMutationGuardV1',
      networkId: NETWORK,
      contextGraphId: CONTEXT_GRAPH,
    },
  },
  {
    queryId: 'SYNC_RECONCILE_TARGET_GET_V1',
    coordinate: {
      recordType: 'SubgraphReconcileTargetGuardV1',
      networkId: NETWORK,
      contextGraphId: CONTEXT_GRAPH,
      subGraphName: SUBGRAPH,
    },
  },
  {
    queryId: 'SYNC_APPLIED_SEAL_GET_V1',
    coordinate: {
      recordType: 'AppliedSubgraphSealV1',
      networkId: NETWORK,
      contextGraphId: CONTEXT_GRAPH,
      subGraphName: SUBGRAPH,
    },
  },
  {
    queryId: 'SYNC_APPLIED_SET_GET_V1',
    coordinate: {
      recordType: 'AppliedSubgraphSetRefV1',
      networkId: NETWORK,
      contextGraphId: CONTEXT_GRAPH,
    },
  },
  {
    queryId: 'SYNC_APPLIED_CG_SEAL_GET_V1',
    coordinate: {
      recordType: 'AppliedContextGraphSealV1',
      networkId: NETWORK,
      contextGraphId: CONTEXT_GRAPH,
    },
  },
];

describe('RFC-64 semantic read manifest v1', () => {
  it('covers every semantic record through the six closed read IDs', () => {
    expect(RFC64_SEMANTIC_READ_QUERY_IDS_V1).toHaveLength(6);
    expect(new Set(CASES.map(({ coordinate }) => coordinate.recordType))).toEqual(
      new Set(Object.keys(RFC64_SEMANTIC_RECORD_ROW_COUNTS_V1)),
    );
  });

  it('renders byte-identical bounded queries for Oxigraph and Blazegraph', () => {
    expect(RFC64_SEMANTIC_READ_BACKENDS_V1).toEqual(['oxigraph', 'blazegraph']);
    for (const fixture of CASES) {
      const oxigraph = compileRfc64SemanticReadOperationV1({
        backend: 'oxigraph',
        ...fixture,
      });
      const blazegraph = compileRfc64SemanticReadOperationV1({
        backend: 'blazegraph',
        ...fixture,
      });
      expect(blazegraph.sparql, fixture.coordinate.recordType).toBe(oxigraph.sparql);
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
      expect(() => assertRfc64SemanticReadOperationV1(oxigraph)).not.toThrow();
      expect(Object.isFrozen(oxigraph)).toBe(true);
    }
  });

  it('freezes the exact current-author query vector', () => {
    const operation = compileRfc64SemanticReadOperationV1({
      backend: 'oxigraph',
      ...CASES[0],
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

  it('rejects query IDs paired with the wrong record type', () => {
    expect(() => compileRfc64SemanticReadOperationV1({
      backend: 'oxigraph',
      queryId: 'SYNC_APPLIED_SET_GET_V1',
      coordinate: CASES[0].coordinate,
    })).toThrow(/cannot read CurrentAuthorCatalogRefV1/u);
  });

  it('rejects unknown IDs, uncertified backends, and input adornment', () => {
    expect(() => compileRfc64SemanticReadOperationV1({
      backend: 'sparql-http',
      ...CASES[0],
    })).toThrow(/backend is not certified/u);
    expect(() => compileRfc64SemanticReadOperationV1({
      backend: 'oxigraph',
      queryId: 'SYNC_RAW_QUERY_V1',
      coordinate: CASES[0].coordinate,
    })).toThrow(/query ID is not in the v1 manifest/u);
    expect(() => compileRfc64SemanticReadOperationV1({
      backend: 'oxigraph',
      ...CASES[0],
      sparql: 'SELECT * WHERE { ?s ?p ?o }',
    })).toThrow(/invalid field set/u);
  });

  it('rejects any operation altered after compilation', () => {
    const operation = compileRfc64SemanticReadOperationV1({
      backend: 'blazegraph',
      ...CASES[4],
    });
    for (const mutation of [
      { sparql: `${operation.sparql}\nOFFSET 1` },
      { graphIri: 'urn:wrong' },
      { rowCeiling: operation.rowCeiling + 1 },
      { responseByteCeiling: operation.responseByteCeiling + 1 },
      { concurrencyClass: 'generic-query' },
    ]) {
      expect(() => assertRfc64SemanticReadOperationV1({
        ...operation,
        ...mutation,
      })).toThrow(/differs from manifest/u);
    }
  });

  it('rejects accessor-bearing operation fields without invoking the accessor', () => {
    const operation = compileRfc64SemanticReadOperationV1({
      backend: 'oxigraph',
      ...CASES[6],
    });
    let invoked = false;
    const input = { ...operation } as Record<string, unknown>;
    Object.defineProperty(input, 'sparql', {
      enumerable: true,
      get() {
        invoked = true;
        return operation.sparql;
      },
    });
    expect(() => assertRfc64SemanticReadOperationV1(input)).toThrow(/invalid field set/u);
    expect(invoked).toBe(false);
  });
});
