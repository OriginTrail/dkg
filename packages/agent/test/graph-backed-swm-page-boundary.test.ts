import { describe, expect, it } from 'vitest';
import type { Quad } from '@origintrail-official/dkg-storage';
import type { GraphScopedSwmRecoveryDescriptor } from '../src/sync/graph-scoped-swm-recovery.js';
import { planBoundedGraphBackedSwmDataPage } from '../src/sync/requester/shared-memory-sync.js';

const quad = (graph: string, index: number): Quad => ({
  subject: `urn:subject:${index}`,
  predicate: 'http://schema.org/value',
  object: `"${index}"`,
  graph,
});

const descriptor = (graph: string, count: number): GraphScopedSwmRecoveryDescriptor => ({
  metaGraph: 'urn:meta',
  headSubject: `urn:head:${graph}`,
  operationSubject: `urn:op:${graph}`,
  kaUal: `did:dkg:test:1/${encodeURIComponent(graph)}`,
  assertionVersion: '1',
  assertionGraph: `urn:assertion:${graph}`,
  shareOperationId: `op-${graph}`,
  publicQuadsDigest: `urn:digest:${graph}`,
  publicQuadsCount: count,
  privateTripleCount: 0,
  publicSnapshotGraph: graph,
  publisherPeerId: 'peer',
  metadataQuads: [],
});

describe('graph-backed SWM DATA graph boundaries', () => {
  it('rewinds a timed-out suffix to the first row of its partial immutable graph', () => {
    const graphA = 'urn:snapshot:a';
    const graphB = 'urn:snapshot:b';
    const result = planBoundedGraphBackedSwmDataPage({
      quads: [quad(graphA, 0), quad(graphA, 1), quad(graphB, 0)],
      descriptors: [descriptor(graphA, 2), descriptor(graphB, 2)],
      resumedFromOffset: 100,
      rawResumedFromOffset: 100,
      nextOffset: 103,
      rawNextOffset: 103,
      quadRawOffsets: [100, 101, 102],
      completed: false,
    });

    expect(result).not.toBeNull();
    expect([...result!.completeGraphs]).toEqual([graphA]);
    expect(result).toMatchObject({ safeNextOffset: 102, safeRawNextOffset: 102, rewound: true });
  });

  it('advances across whole graphs and subsequent legacy rows', () => {
    const graphA = 'urn:snapshot:a';
    const result = planBoundedGraphBackedSwmDataPage({
      quads: [quad(graphA, 0), quad(graphA, 1), quad('urn:legacy', 0)],
      descriptors: [descriptor(graphA, 2)],
      resumedFromOffset: 0,
      nextOffset: 3,
      completed: false,
    });

    expect(result).not.toBeNull();
    expect([...result!.completeGraphs]).toEqual([graphA]);
    expect(result).toMatchObject({ safeNextOffset: 3, safeRawNextOffset: 3, rewound: false });
  });

  it('rejects a terminal short graph as an integrity mismatch', () => {
    const graphA = 'urn:snapshot:a';
    expect(planBoundedGraphBackedSwmDataPage({
      quads: [quad(graphA, 0)],
      descriptors: [descriptor(graphA, 2)],
      resumedFromOffset: 0,
      nextOffset: 1,
      completed: true,
    })).toBeNull();
  });

  it('rejects non-contiguous graph-backed groups', () => {
    const graphA = 'urn:snapshot:a';
    expect(planBoundedGraphBackedSwmDataPage({
      quads: [quad(graphA, 0), quad('urn:legacy', 0), quad(graphA, 1)],
      descriptors: [descriptor(graphA, 2)],
      resumedFromOffset: 0,
      nextOffset: 3,
      completed: false,
    })).toBeNull();
  });
});
