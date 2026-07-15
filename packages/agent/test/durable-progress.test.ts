import { describe, expect, it } from 'vitest';
import { classifyDurableProgress } from '../src/sync/durable-progress.js';

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
});
