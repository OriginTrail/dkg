import { describe, expect, it } from 'vitest';
import {
  SyncCoverageEvidenceJournal,
  boundedSyncCoverageContextGraphIds,
} from '../src/sync/coverage-evidence-journal.js';

const verified = { metadata: false, durable: false, sharedMemory: false };

describe('SyncCoverageEvidenceJournal', () => {
  it('appends immutable transitions and filters by sequence', () => {
    const journal = new SyncCoverageEvidenceJournal(100, 'wave-1', 4);
    const running = journal.append({
      kind: 'edge-reconciler-job',
      jobId: 'job-1',
      contextGraphId: 'cg-1',
      source: 'reconciler',
      trigger: 'periodic-reconciler',
      syncMode: 'always-on',
      state: 'running',
      verified,
      startedAt: 101,
    });
    journal.append({
      ...running,
      state: 'complete',
      verified: { metadata: true, durable: true, sharedMemory: true },
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
      expect.objectContaining({ sequence: 2, state: 'complete', jobId: 'job-1' }),
    ]);

    snapshot.entries[0]!.verified.metadata = false;
    expect(journal.snapshot(1).entries[0]!.verified.metadata).toBe(true);
  });

  it('reports the exact overwrite boundary for fail-closed collectors', () => {
    const journal = new SyncCoverageEvidenceJournal(100, 'wave-1', 2);
    for (let index = 1; index <= 3; index += 1) {
      journal.append({
        kind: 'edge-reconciler-job',
        jobId: `job-${index}`,
        contextGraphId: `cg-${index}`,
        source: 'reconciler',
        trigger: 'periodic-reconciler',
        syncMode: 'always-on',
        state: 'running',
        verified,
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
});
