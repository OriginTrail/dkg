import { describe, expect, it } from 'vitest';
import {
  createSharedMemoryCatchupRoundAggregation,
  foldSharedMemoryRound,
  sharedMemoryCatchupPlaneProven,
} from '../src/sync/shared-memory-catchup-round.js';
import {
  emptySharedMemorySyncResult,
  type SharedMemorySyncResult,
} from '../src/sync/shared-memory-diagnostics.js';

function round(values: Partial<SharedMemorySyncResult>): SharedMemorySyncResult {
  return { ...emptySharedMemorySyncResult(), ...values };
}

describe('#2105 shared-memory catch-up round aggregation', () => {
  it('uses canonical response evidence for legacy data-only and partially deferred rounds', () => {
    const aggregate = createSharedMemoryCatchupRoundAggregation();
    const legacy = round({ insertedTriples: 3, deferredBackpressure: 1 });
    delete (legacy as Partial<SharedMemorySyncResult>).insertedDataTriples;
    const progress = foldSharedMemoryRound(aggregate, 'legacy-peer', legacy);
    expect(progress.responded).toBe(true);
    expect(progress.hasBlockingFailure).toBe(true);
    expect(aggregate.peers.responded.has('legacy-peer')).toBe(true);
    expect(aggregate.insertedDataTriples).toBe(3);
    expect(sharedMemoryCatchupPlaneProven(aggregate)).toBe(false);
    expect(aggregate.jobDeferredBackpressure).toBe(1);
  });

  it('preserves clean already-held readiness without counting it as inserted data', () => {
    const aggregate = createSharedMemoryCatchupRoundAggregation();
    foldSharedMemoryRound(aggregate, 'held-peer', round({ completedPhases: 1, alreadyHeldAssets: 2 }));
    expect(aggregate.cleanDataTriples).toBe(0);
    expect(aggregate.cleanHeldAssets).toBe(2);
    expect(sharedMemoryCatchupPlaneProven(aggregate)).toBe(true);
    foldSharedMemoryRound(aggregate, 'yield-peer', round({ deferredBackpressure: 1 }), { countJobDeferral: false });
    expect(sharedMemoryCatchupPlaneProven(aggregate)).toBe(true);
    expect(aggregate.jobDeferredBackpressure).toBe(0);
    expect(aggregate.diagnostics.deferredBackpressure).toBe(1);
  });

  it('owns the accumulated diagnostics across successive rounds', () => {
    const aggregate = createSharedMemoryCatchupRoundAggregation();
    foldSharedMemoryRound(aggregate, 'peer-a', round({ bytesReceived: 10 }));
    const firstRound = aggregate.diagnostics;
    foldSharedMemoryRound(aggregate, 'peer-b', round({ bytesReceived: 20 }));
    expect(firstRound.bytesReceived).toBe(10);
    expect(aggregate.diagnostics.bytesReceived).toBe(30);
  });

});
