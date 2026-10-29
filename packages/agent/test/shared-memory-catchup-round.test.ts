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
import { classifyDurableProgress } from '../src/sync/durable-progress.js';

function round(values: Partial<SharedMemorySyncResult>): SharedMemorySyncResult {
  return { ...emptySharedMemorySyncResult(), ...values };
}

const syntheticRounds = [
  {
    peerId: 'peer-data',
    continuation: false,
    result: round({
      insertedTriples: 3,
      fetchedDataTriples: 3,
      insertedDataTriples: 3,
      completedPhases: 1,
      bytesReceived: 96,
    }),
  },
  {
    peerId: 'peer-denied',
    continuation: false,
    result: round({ deniedPhases: 1, failedPhases: 1 }),
  },
  {
    peerId: 'peer-denied',
    continuation: true,
    result: round({ deniedPhases: 1, failedPhases: 1 }),
  },
  {
    peerId: 'peer-deferred',
    continuation: true,
    result: round({
      deferredBackpressure: 1,
      failedPhases: 1,
      localYield: true,
      localYieldFailedPhases: 1,
    }),
  },
] as const;

function inlineFold() {
  const aggregate = createSharedMemoryCatchupRoundAggregation();
  for (const item of syntheticRounds) {
    foldSharedMemoryRound(aggregate, item.peerId, item.result, {
      countJobDeferral: !item.continuation,
    });
  }
  return aggregate;
}

function workerFold() {
  const aggregate = createSharedMemoryCatchupRoundAggregation();
  for (const item of syntheticRounds) {
    foldSharedMemoryRound(aggregate, item.peerId, item.result, {
      progress: classifyDurableProgress(item.result),
      countJobDeferral: !item.continuation,
    });
  }
  return aggregate;
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

  it('keeps inline and Worker diagnostics and distinct-peer counters identical', () => {
    const inline = inlineFold();
    const worker = workerFold();

    expect(worker.diagnostics).toEqual(inline.diagnostics);
    expect(worker.insertedDataTriples).toBe(inline.insertedDataTriples);
    expect(worker.cleanDataTriples).toBe(inline.cleanDataTriples);
    expect(worker.jobDeferredBackpressure).toBe(inline.jobDeferredBackpressure);
    expect(worker.peers.denied.size).toBe(inline.peers.denied.size);
    expect(worker.peers.responded.size).toBe(inline.peers.responded.size);

    expect(inline.peers.denied).toEqual(new Set(['peer-denied']));
    expect(inline.diagnostics.deniedPhases).toBe(2);
    expect(inline.diagnostics.deferredBackpressure).toBe(1);
    expect(inline.jobDeferredBackpressure).toBe(0);
    expect(sharedMemoryCatchupPlaneProven(inline)).toBe(true);
  });
});
