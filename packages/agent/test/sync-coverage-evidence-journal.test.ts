import { describe, expect, it } from 'vitest';
import {
  SyncCoverageEvidenceJournal,
  boundedSyncCoverageContextGraphIds,
} from '../src/sync/coverage-evidence-journal.js';

describe('SyncCoverageEvidenceJournal', () => {
  it('appends immutable transitions and filters by sequence', () => {
    const journal = new SyncCoverageEvidenceJournal(100, 'wave-1', 4);
    const [handle] = journal.startEdgeReconcilerJobs({
      contextGraphIds: ['cg-1'],
      startedAt: 101,
    });
    journal.finishEdgeReconcilerJob(handle!, {
      operationCompleted: true,
      verifiedByContextGraph: new Map([[
        'cg-1',
        { metadata: true, durable: true, sharedMemory: true },
      ]]),
      finishedAt: 102,
    });

    const snapshot = journal.snapshot(1);
    expect(snapshot).toMatchObject({
      schemaVersion: 1,
      processStartedAt: 100,
      waveId: 'wave-1',
      nextSequence: 3,
      droppedBeforeSequence: 0,
    });
    expect(snapshot.entries).toEqual([
      expect.objectContaining({ sequence: 2, state: 'complete', jobId: handle!.jobId }),
    ]);

    snapshot.entries[0]!.verified.metadata = false;
    expect(journal.snapshot(1).entries[0]!.verified.metadata).toBe(true);
  });

  it('reports the exact overwrite boundary for fail-closed collectors', () => {
    const journal = new SyncCoverageEvidenceJournal(100, 'wave-1', 2);
    for (let index = 1; index <= 3; index += 1) {
      journal.startEdgeReconcilerJobs({
        contextGraphIds: [`cg-${index}`],
        startedAt: 100 + index,
      });
    }

    expect(journal.snapshot()).toMatchObject({
      capacity: 2,
      nextSequence: 4,
      droppedBeforeSequence: 1,
      entries: [
        expect.objectContaining({ sequence: 2 }),
        expect.objectContaining({ sequence: 3 }),
      ],
    });
  });

  it('bounds planned context graph identifiers while retaining exact counts', () => {
    const bounded = boundedSyncCoverageContextGraphIds(
      Array.from({ length: 300 }, (_, index) => `cg-${index}`),
    );
    expect(bounded.ids).toHaveLength(32);
    expect(bounded.count).toBe(300);
    expect(bounded.truncated).toBe(true);
  });

  it('omits oversized identifiers and marks the evidence truncated', () => {
    const bounded = boundedSyncCoverageContextGraphIds(['cg-ok', 'x'.repeat(257)]);
    expect(bounded).toEqual({ ids: ['cg-ok'], count: 2, truncated: true });
  });

  it('rejects invalid cursors and capacities', () => {
    expect(() => new SyncCoverageEvidenceJournal(100, 'wave', 0)).toThrow(/capacity/);
    const journal = new SyncCoverageEvidenceJournal(100, 'wave');
    expect(() => journal.snapshot(-1)).toThrow(/afterSequence/);
  });

  it('owns job identity and transition state behind immutable handles', () => {
    const journal = new SyncCoverageEvidenceJournal(100, 'wave-1');
    const selected = ['selected-cg'];
    const automatic = ['automatic-cg'];
    const handle = journal.startCoreAutomaticRound({
      planningLane: 'peer-a',
      trigger: 'connection-open',
      configuredBatchSize: 8,
      effectiveBatchSize: 4,
      explicitSelectedContextGraphIds: selected,
      automaticContextGraphIds: automatic,
      startedAt: 101,
    });

    selected[0] = 'mutated-selected';
    automatic[0] = 'mutated-automatic';
    expect(Object.isFrozen(handle)).toBe(true);
    expect(() => {
      (handle as { jobId: string }).jobId = 'forged';
    }).toThrow(TypeError);
    expect(() => journal.finishCoreAutomaticRound({
      kind: 'core-automatic-round',
      jobId: handle.jobId,
    } as typeof handle, {
      operationCompleted: true,
      verifiedByContextGraph: new Map(),
      finishedAt: 102,
    })).toThrow(/not issued by this module/);

    const terminal = journal.finishCoreAutomaticRound(handle, {
      operationCompleted: true,
      verifiedByContextGraph: new Map([[
        'automatic-cg',
        { metadata: true, durable: true, sharedMemory: true },
      ]]),
      finishedAt: 102,
    });

    expect(terminal).toMatchObject({
      jobId: handle.jobId,
      explicitSelectedContextGraphIds: ['selected-cg'],
      automaticContextGraphIds: ['automatic-cg'],
      state: 'complete',
    });
    expect(() => journal.finishCoreAutomaticRound(handle, {
      operationCompleted: true,
      verifiedByContextGraph: new Map(),
      finishedAt: 103,
    })).toThrow(/unknown or already finished/);
  });
});
