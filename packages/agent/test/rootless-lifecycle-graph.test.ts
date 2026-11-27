import { describe, expect, it } from 'vitest';
import {
  GRAPH_KA_CONTENT_SCOPE_VERSION,
  MemoryLayer,
} from '@origintrail-official/dkg-core';
import { canonicalRootlessLifecycleGraph } from '../src/rootless-lifecycle-graph.js';

const CG = '0x1111111111111111111111111111111111111111/private-rootless';
const AUTHOR = '0x2222222222222222222222222222222222222222';
const UAL = `did:dkg:gnosis:100/${AUTHOR}/42`;
const STALE = `did:dkg:context-graph:${CG}/assertion/${AUTHOR}/old-name`;

describe('canonicalRootlessLifecycleGraph', () => {
  it.each([
    [MemoryLayer.WorkingMemory, '_working_memory'],
    [MemoryLayer.SharedWorkingMemory, '_shared_memory'],
    [MemoryLayer.VerifiableMemory, '_verifiable_memory'],
  ])('derives the canonical %s graph instead of a stale name-keyed alias', (memoryLayer, slug) => {
    expect(canonicalRootlessLifecycleGraph({
      contextGraphId: CG,
      contentScopeVersion: String(GRAPH_KA_CONTENT_SCOPE_VERSION),
      reservedUal: UAL,
      memoryLayer,
      persistedGraph: STALE,
    })).toBe(`did:dkg:context-graph:${CG}/${slug}/${AUTHOR}/42`);
  });

  it('retains persisted pointers for legacy and malformed records', () => {
    expect(canonicalRootlessLifecycleGraph({
      contextGraphId: CG,
      contentScopeVersion: '1',
      reservedUal: UAL,
      memoryLayer: MemoryLayer.SharedWorkingMemory,
      persistedGraph: STALE,
    })).toBe(STALE);
    expect(canonicalRootlessLifecycleGraph({
      contextGraphId: CG,
      contentScopeVersion: String(GRAPH_KA_CONTENT_SCOPE_VERSION),
      reservedUal: 'not-a-ual',
      memoryLayer: MemoryLayer.SharedWorkingMemory,
      persistedGraph: STALE,
    })).toBe(STALE);
  });

  it('preserves subgraph placement', () => {
    expect(canonicalRootlessLifecycleGraph({
      contextGraphId: CG,
      contentScopeVersion: String(GRAPH_KA_CONTENT_SCOPE_VERSION),
      reservedUal: UAL,
      memoryLayer: MemoryLayer.SharedWorkingMemory,
      subGraphName: 'threats',
      persistedGraph: STALE,
    })).toBe(`did:dkg:context-graph:${CG}/threats/_shared_memory/${AUTHOR}/42`);
  });
});
