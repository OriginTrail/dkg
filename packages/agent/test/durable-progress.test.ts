import { describe, expect, it } from 'vitest';
import {
  classifyDurableProgress,
  createDurableSyncAccumulator,
  createFailedPeerDurableSyncResult,
  createIncompleteDurableSyncResult,
  durableSyncAccumulatorFromResult,
  finalizeDurableSyncCompletion,
  isDurableSyncComplete,
  markDurableTerminalBoundary,
  mergeDurableSyncAccumulators,
} from '../src/sync/durable-progress.js';

describe('classifyDurableProgress', () => {
  it('classifies inserted durable data as reconnect and readiness progress', () => {
    const progress = classifyDurableProgress({
      insertedTriples: 4,
      insertedDataTriples: 4,
      completedPhases: 1,
    });

    expect(progress.insertedDataTriples).toBe(4);
    expect(progress.madeReconnectProgress).toBe(true);
    expect(progress.madeReadinessProgress).toBe(true);
    expect(progress.metadataOnly).toBe(false);
    expect(progress.completedWithoutFailure).toBe(true);
    expect(progress.cleanNonMetadataResponse).toBe(true);
  });

  it('classifies a clean verified private-only response as progress, not metadata-only', () => {
    const progress = classifyDurableProgress({
      insertedTriples: 8,
      insertedDataTriples: 0,
      insertedMetaTriples: 8,
      metaOnlyResponses: 0,
      verifiedPrivateOnlyResponses: 1,
      completedPhases: 1,
    });

    expect(progress.hasVerifiedPrivateOnlyResponse).toBe(true);
    expect(progress.hasCleanVerifiedPrivateOnlyCompletion).toBe(true);
    expect(progress.metadataOnly).toBe(false);
    expect(progress.madeReconnectProgress).toBe(true);
    expect(progress.madeReadinessProgress).toBe(true);
    expect(progress.completedWithoutFailure).toBe(true);
  });

  it('keeps arbitrary metadata-only delivery out of reconnect progress and clean responses', () => {
    const progress = classifyDurableProgress({
      insertedTriples: 8,
      insertedDataTriples: 0,
      insertedMetaTriples: 8,
      metaOnlyResponses: 1,
      completedPhases: 1,
    });

    expect(progress.hasMetadataEvidence).toBe(true);
    expect(progress.metadataOnly).toBe(true);
    expect(progress.madeReconnectProgress).toBe(false);
    expect(progress.cleanNonMetadataResponse).toBe(false);
    expect(progress.completedWithoutFailure).toBe(true);
  });

  it.each([
    ['timeout', { timedOutPhases: 1 }, 'timedOut'],
    ['transport failure', { failedPeers: 1 }, 'transportFailed'],
    ['phase failure', { failedPhases: 1 }, 'phaseFailed'],
    ['denial', { deniedPhases: 1 }, 'denied'],
    ['backpressure', { deferredBackpressure: 1 }, 'deferredByBackpressure'],
    ['rejected KC', { rejectedKcs: 1 }, 'integrityRejected'],
    ['missing metadata rejection', { dataRejectedMissingMeta: 1 }, 'integrityRejected'],
  ] as const)(
    'does not call an inserted-data completion clean after %s',
    (_label, override, expectedFlag) => {
      const progress = classifyDurableProgress({
        insertedTriples: 2,
        insertedDataTriples: 2,
        completedPhases: 1,
        ...override,
      });

      expect(progress[expectedFlag]).toBe(true);
      expect(progress.completedWithoutFailure).toBe(false);
    },
  );

  it('distinguishes a clean empty response from a completed readiness proof', () => {
    const progress = classifyDurableProgress({ insertedTriples: 0 });

    expect(progress.cleanNonMetadataResponse).toBe(true);
    expect(progress.madeReconnectProgress).toBe(false);
    expect(progress.madeReadinessProgress).toBe(false);
    expect(progress.completedWithoutFailure).toBe(false);
    expect(progress.completedReadinessCleanly).toBe(false);
  });

  it('keeps timeout, denial, and integrity rejection out of clean private-only completion', () => {
    for (const override of [
      { timedOutPhases: 1 },
      { deniedPhases: 1 },
      { failedPeers: 1 },
      { failedPhases: 1 },
      { rejectedKcs: 1 },
      { dataRejectedMissingMeta: 1 },
    ]) {
      const progress = classifyDurableProgress({
        insertedTriples: 8,
        insertedDataTriples: 0,
        insertedMetaTriples: 8,
        verifiedPrivateOnlyResponses: 1,
        completedPhases: 1,
        ...override,
      });

      expect(progress.hasCleanVerifiedPrivateOnlyCompletion).toBe(false);
    }
  });

  it('preserves resumed completion as catch-up readiness progress', () => {
    const progress = classifyDurableProgress({
      insertedTriples: 0,
      insertedDataTriples: 0,
      resumedPhases: 1,
      completedPhases: 1,
    });

    expect(progress.madeReconnectProgress).toBe(true);
    expect(progress.madeReadinessProgress).toBe(true);
  });

  it('does not classify an explicitly incomplete durable result as readiness complete', () => {
    const progress = classifyDurableProgress({
      complete: false,
      insertedTriples: 40_000,
      insertedDataTriples: 40_000,
      completedPhases: 1,
      checkpointAdvances: 1,
    });

    expect(progress.madeReadinessProgress).toBe(true);
    expect(progress.completedWithoutFailure).toBe(false);
    expect(progress.completedReadinessCleanly).toBe(false);
  });
});

describe('isDurableSyncComplete', () => {
  it('requires both a lane terminal boundary and a clean completed phase', () => {
    const progress = { completedPhases: 1 };

    expect(isDurableSyncComplete(progress, true)).toBe(true);
    expect(isDurableSyncComplete(progress, false)).toBe(false);
    expect(isDurableSyncComplete({ ...progress, complete: false }, true)).toBe(false);
  });

  it.each([
    ['timeout', { timedOutPhases: 1 }],
    ['transport failure', { failedPeers: 1 }],
    ['phase failure', { failedPhases: 1 }],
    ['denial', { deniedPhases: 1 }],
    ['backpressure', { deferredBackpressure: 1 }],
    ['rejected KC', { rejectedKcs: 1 }],
    ['missing metadata', { dataRejectedMissingMeta: 1 }],
  ])('centralizes %s as a non-complete durable result', (_label, failure) => {
    expect(isDurableSyncComplete({ completedPhases: 1, ...failure }, true)).toBe(false);
  });
});

describe('durable terminal boundary model', () => {
  it('keeps an incomplete lane sticky across later clean boundaries', () => {
    const accumulator = createDurableSyncAccumulator();
    accumulator.diagnostics.completedPhases = 1;

    markDurableTerminalBoundary(accumulator, false);
    markDurableTerminalBoundary(accumulator, true);

    expect(finalizeDurableSyncCompletion(accumulator).complete).toBe(false);
  });

  it('owns clean phase synthesis and authoritative incomplete cleanup', () => {
    const complete = createDurableSyncAccumulator();
    markDurableTerminalBoundary(complete, true, { countCompletedPhase: true });
    expect(finalizeDurableSyncCompletion(complete)).toMatchObject({
      complete: true,
      completedPhases: 1,
    });

    const incomplete = createDurableSyncAccumulator();
    incomplete.diagnostics.completedPhases = 2;
    markDurableTerminalBoundary(incomplete, false, {
      countCompletedPhase: true,
      clearCompletedPhasesWhenIncomplete: true,
    });
    expect(finalizeDurableSyncCompletion(incomplete)).toMatchObject({
      complete: false,
      completedPhases: 0,
    });
  });

  it('does not synthesize a completed phase when a blocking counter is present', () => {
    const accumulator = createDurableSyncAccumulator();
    accumulator.diagnostics.rejectedKcs = 1;

    markDurableTerminalBoundary(accumulator, true, { countCompletedPhase: true });

    expect(finalizeDurableSyncCompletion(accumulator)).toMatchObject({
      complete: false,
      completedPhases: 0,
    });
  });

  it('keeps the neutral merge identity internal and assigns complete only on finalization', () => {
    const completedLane = createDurableSyncAccumulator();
    markDurableTerminalBoundary(completedLane, true, { countCompletedPhase: true });
    const publicLane = finalizeDurableSyncCompletion(completedLane);
    const neutral = createDurableSyncAccumulator();

    expect('complete' in neutral.diagnostics).toBe(false);
    const merged = mergeDurableSyncAccumulators(
      neutral,
      durableSyncAccumulatorFromResult(publicLane),
    );
    expect('complete' in merged.diagnostics).toBe(false);
    expect(finalizeDurableSyncCompletion(merged).complete).toBe(true);
  });
});

describe('durable result factories', () => {
  it('makes incomplete and failed-peer public results self-consistent', () => {
    expect(createIncompleteDurableSyncResult()).toMatchObject({
      complete: false,
      insertedTriples: 0,
      failedPeers: 0,
    });
    expect(createFailedPeerDurableSyncResult()).toMatchObject({
      complete: false,
      insertedTriples: 0,
      failedPeers: 1,
    });
  });
});
