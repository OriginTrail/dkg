import { describe, expect, it } from 'vitest';
import {
  applySelectedSwmFreshnessResolution,
  classifySelectedSwmRoundFreshness,
  classifySharedMemoryFreshness,
} from '../src/sync/shared-memory-freshness.js';
import {
  cleanDurableResult,
  result,
} from './selected-swm-test-helpers.js';

describe('shared-memory freshness classification', () => {
  it('owns producer recovery, bounding, and final classification as one invariant', () => {
    const contextGraphId = 'selected-freshness-boundary';
    const incomplete = result(contextGraphId, 1, 2);
    expect(classifySelectedSwmRoundFreshness(contextGraphId, incomplete)).toEqual({
      recoverableSnapshotYieldFailures: 1,
      recoverableMetadataContinuationYields: 0,
      snapshotPlaneComplete: false,
    });
    expect(classifySelectedSwmRoundFreshness(contextGraphId, {
      ...incomplete,
      swmCoverage: {
        ...incomplete.swmCoverage!,
        contextGraphId: 'another-context-graph',
      },
    }).recoverableSnapshotYieldFailures).toBe(0);
    expect(classifySelectedSwmRoundFreshness(contextGraphId, {
      ...incomplete,
      swmCoverage: {
        ...incomplete.swmCoverage!,
        descriptorsAuthoritative: false,
      },
    }).recoverableSnapshotYieldFailures).toBe(0);
    expect(classifySelectedSwmRoundFreshness(contextGraphId, {
      ...incomplete,
      swmCoverage: {
        ...incomplete.swmCoverage!,
        materializationFailures: 1,
      },
    }).recoverableSnapshotYieldFailures).toBe(0);

    const complete = result(contextGraphId, 2, 2);
    expect(classifySelectedSwmRoundFreshness(contextGraphId, {
      ...complete,
      swmCoverage: {
        ...complete.swmCoverage!,
        descriptorsAuthoritative: false,
      },
    }).snapshotPlaneComplete).toBe(false);
    const { descriptorsAuthoritative: _unknown, ...legacyCoverage } = complete.swmCoverage!;
    expect(classifySelectedSwmRoundFreshness(contextGraphId, {
      ...complete,
      swmCoverage: legacyCoverage,
    }).snapshotPlaneComplete).toBe(false);

    const finalRaw = {
      ...complete,
      failedPhases: 1,
      snapshotPlaneIncomplete: 1,
    };
    const resolved = applySelectedSwmFreshnessResolution(finalRaw, {
      recoverableSnapshotYieldFailures: 1,
    });
    expect(classifySharedMemoryFreshness(resolved).phaseFailed).toBe(false);

    expect(classifySharedMemoryFreshness({
      ...finalRaw,
      resolvedSnapshotPlaneIncomplete: 2,
    }).phaseFailed).toBe(true);
    expect(classifySharedMemoryFreshness({
      ...finalRaw,
      failedPhases: 2,
      resolvedSnapshotPlaneIncomplete: 1,
    }).phaseFailed).toBe(true);
    expect(applySelectedSwmFreshnessResolution({
      ...finalRaw,
      failedPhases: Number.NaN,
    }, {
      recoverableSnapshotYieldFailures: 1,
    }).resolvedSnapshotPlaneIncomplete).toBe(0);
    expect(applySelectedSwmFreshnessResolution({
      ...finalRaw,
      snapshotPlaneIncomplete: -1,
    }, {
      recoverableSnapshotYieldFailures: 1,
    }).resolvedSnapshotPlaneIncomplete).toBe(0);

    const retainedMetadataYield = {
      ...cleanDurableResult(),
      timedOutPhases: 1,
      metadataContinuationYields: 1,
    };
    expect(classifySelectedSwmRoundFreshness(
      contextGraphId,
      retainedMetadataYield,
    ).recoverableMetadataContinuationYields).toBe(1);
    const metadataResolved = applySelectedSwmFreshnessResolution(
      {
        ...retainedMetadataYield,
        completedPhases: 2,
      },
      {
        recoverableSnapshotYieldFailures: 0,
        recoverableMetadataContinuationYields: 1,
      },
    );
    expect(classifySharedMemoryFreshness(metadataResolved).timedOut).toBe(false);
    expect(classifySharedMemoryFreshness({
      ...retainedMetadataYield,
      completedPhases: 2,
      resolvedMetadataContinuationYields: 2,
    }).timedOut).toBe(true);
  });
});
