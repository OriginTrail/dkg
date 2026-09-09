import { describe, expect, it } from 'vitest';
import {
  contextGraphSharedMemoryMetaUri,
  contextGraphSharedMemoryUri,
} from '@origintrail-official/dkg-core';
import {
  describeSharedMemoryGraphs,
  isNamedSubgraphSharedMemoryDataGraph,
  isNamedSubgraphSharedMemoryMetaGraph,
  parseSharedMemoryDataGraph,
  parseSharedMemoryMetaGraph,
} from '../src/sync/shared-memory-graphs.js';

const CG = '0x0000000000000000000000000000000000000001/scope-test';
const SUBGRAPH = 'research';

describe('named-subgraph Shared Memory graph classification', () => {
  it('returns one canonical descriptor for root and named data/meta graphs', () => {
    const root = describeSharedMemoryGraphs(CG)!;
    const named = describeSharedMemoryGraphs(CG, SUBGRAPH)!;

    expect(parseSharedMemoryMetaGraph(CG, root.metaGraph)).toEqual(root);
    expect(parseSharedMemoryDataGraph(CG, `${root.dataGraph}/0xabc/7`)).toEqual(root);
    expect(parseSharedMemoryMetaGraph(CG, named.metaGraph)).toEqual(named);
    expect(parseSharedMemoryDataGraph(CG, `${named.dataGraph}/0xabc/7`)).toEqual(named);
    expect(named).toMatchObject({
      subGraphName: SUBGRAPH,
      ownershipKey: `${CG}\0${SUBGRAPH}`,
      dataGraph: contextGraphSharedMemoryUri(CG, SUBGRAPH),
      metaGraph: contextGraphSharedMemoryMetaUri(CG, SUBGRAPH),
    });
  });

  it('rejects invalid or near-miss graph addresses', () => {
    expect(describeSharedMemoryGraphs(CG, '_reserved')).toBeUndefined();
    expect(parseSharedMemoryMetaGraph(CG, `${contextGraphSharedMemoryMetaUri(CG, SUBGRAPH)}/child`)).toBeUndefined();
    expect(parseSharedMemoryDataGraph(CG, `${contextGraphSharedMemoryUri(CG, SUBGRAPH)}/staging/op`)).toBeUndefined();
    expect(parseSharedMemoryDataGraph(CG, `did:dkg:context-graph:${CG}/other/_shared_memoryish`)).toBeUndefined();
  });

  it('accepts only named-subgraph data buckets and canonical per-KA descendants', () => {
    const root = contextGraphSharedMemoryUri(CG);
    const named = contextGraphSharedMemoryUri(CG, SUBGRAPH);

    expect(isNamedSubgraphSharedMemoryDataGraph(CG, named)).toBe(true);
    expect(isNamedSubgraphSharedMemoryDataGraph(CG, `${named}/0xabc/7`)).toBe(true);
    expect(isNamedSubgraphSharedMemoryDataGraph(CG, root)).toBe(false);
    expect(isNamedSubgraphSharedMemoryDataGraph(CG, `${root}/0xabc/7`)).toBe(false);
    expect(isNamedSubgraphSharedMemoryDataGraph(CG, `${named}/staging/op`)).toBe(false);
    expect(isNamedSubgraphSharedMemoryDataGraph(CG, `${named}/0xabc/not-a-number`)).toBe(false);
    expect(isNamedSubgraphSharedMemoryDataGraph(CG, `${root}/_private`)).toBe(false);
  });

  it('accepts only exact named-subgraph metadata graphs', () => {
    const root = contextGraphSharedMemoryMetaUri(CG);
    const named = contextGraphSharedMemoryMetaUri(CG, SUBGRAPH);

    expect(isNamedSubgraphSharedMemoryMetaGraph(CG, named)).toBe(true);
    expect(isNamedSubgraphSharedMemoryMetaGraph(CG, root)).toBe(false);
    expect(isNamedSubgraphSharedMemoryMetaGraph(CG, `${named}/child`)).toBe(false);
    expect(isNamedSubgraphSharedMemoryMetaGraph(CG, `${root}/child/_shared_memory_meta`)).toBe(false);
  });
});
