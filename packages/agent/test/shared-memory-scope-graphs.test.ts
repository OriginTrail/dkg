import { describe, expect, it } from 'vitest';
import {
  contextGraphSharedMemoryMetaUri,
  contextGraphSharedMemoryUri,
} from '@origintrail-official/dkg-core';
import {
  isNamedSubgraphSharedMemoryDataGraph,
  isNamedSubgraphSharedMemoryMetaGraph,
} from '../src/sync/shared-memory-graphs.js';

const CG = '0x0000000000000000000000000000000000000001/scope-test';
const SUBGRAPH = 'research';

describe('named-subgraph Shared Memory graph classification', () => {
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
