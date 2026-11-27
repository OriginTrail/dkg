import { describe, expect, it } from 'vitest';
import {
  classifySwmCatchupPeerOutcome,
  createSwmCatchupPeerSelector,
  SWM_CATCHUP_PEER_NEGATIVE_TTL_MS,
  swmCatchupOwnerPeerIds,
} from '../src/swm/swm-catchup-peer-selection.js';
import {
  sharedMemoryCompletionFields,
  sharedMemoryWorkOutcome,
  type SharedMemoryWorkOutcome,
} from '../src/sync/shared-memory-completion.js';
import {
  emptySharedMemorySyncResult,
  mergeSamePeerSharedMemoryDiagnostics,
  mergeFleetSharedMemoryDiagnostics,
  readSharedMemoryPhaseFailureAttribution,
  recordSharedMemoryPhaseFailure,
} from '../src/sync/shared-memory-diagnostics.js';

describe('SWM catchup peer selection', () => {
  it('initializes zero counters and retains an explicitly failed peer', () => {
    for (const failedPeers of [0, 1]) {
      const result = emptySharedMemorySyncResult(failedPeers);
      for (const [field, value] of Object.entries(result)) {
        expect(value, field).toBe(field === 'failedPeers' ? failedPeers : 0);
      }
      expect(readSharedMemoryPhaseFailureAttribution(result)).toEqual({
        localBudget: 0, transport: 0, materialization: 0,
      });
    }
  });

  it('merges same-peer counters without synthesizing snapshot coverage', () => {
    const prior = emptySharedMemorySyncResult(1);
    const next = emptySharedMemorySyncResult(1);
    Object.assign(prior, { insertedTriples: 2, bytesReceived: 3, metadataContinuationYields: 1 });
    Object.assign(next, { insertedTriples: 5, bytesReceived: 7, resolvedMetadataContinuationYields: 1 });
    recordSharedMemoryPhaseFailure(prior, 'local-budget');
    recordSharedMemoryPhaseFailure(next, 'materialization', 2);
    const coverage = {
      contextGraphId: 'cg', peerIdSuffix: 'authority', snapshotsResolved: 1,
      snapshotsTotal: 2, manifestComplete: false, missingCount: 1,
      missingSample: ['root'], materializationFailures: 0, fromAuthority: true,
    };
    prior.swmCoverage = coverage;
    next.swmCoverage = { ...coverage, fromAuthority: false, snapshotsResolved: 9,
      snapshotsTotal: 10, manifestComplete: true };
    for (const result of [mergeSamePeerSharedMemoryDiagnostics(prior, next),
      mergeSamePeerSharedMemoryDiagnostics(next, prior)]) {
      expect(result).toMatchObject({ insertedTriples: 7, bytesReceived: 10,
        failedPeers: 1, failedPhases: 3, localYieldFailedPhases: 1,
        metadataContinuationYields: 1, resolvedMetadataContinuationYields: 1 });
      expect(result.swmCoverage).toBe(coverage);
      expect(readSharedMemoryPhaseFailureAttribution({ ...result })).toEqual({
        localBudget: 1, transport: 0, materialization: 2,
      });
      expect(JSON.stringify(result)).not.toContain('shared-memory-phase-failure-attribution');
    }
  });

  it.each([
    ['same peer', mergeSamePeerSharedMemoryDiagnostics],
    ['fleet', mergeFleetSharedMemoryDiagnostics],
  ] as const)('preserves an independent target failure when merging a local yield across %s', (_scope, merge) => {
    const yielded = emptySharedMemorySyncResult();
    recordSharedMemoryPhaseFailure(yielded, 'local-budget');
    const failed = emptySharedMemorySyncResult();
    recordSharedMemoryPhaseFailure(failed, 'transport');
    for (const merged of [merge(yielded, failed), merge(failed, yielded)]) {
      const outcome = classifySwmCatchupPeerOutcome(merged);
      expect(outcome).toBe('transportFailed');
      expect(merged.failedPhases).toBe(2);
      expect(merged.localYieldFailedPhases).toBe(1);
      const selector = createSwmCatchupPeerSelector();
      if (outcome) selector.record('cg', 'peer', outcome, 100);
      expect(selector.get('cg', 'peer', 101)).toBe('transportFailed');
      expect(selector.select({ contextGraphId: 'cg', candidatePeers: ['peer', 'unknown'], now: 101 }))
        .toMatchObject({ selectedPeers: ['unknown'], skippedNegativePeers: ['peer'] });
    }
    expect(classifySwmCatchupPeerOutcome(merge(yielded, yielded))).toBeUndefined();
  });

  it('derives legacy counters from one structured cause model', () => {
    const result = emptySharedMemorySyncResult();
    recordSharedMemoryPhaseFailure(result, 'local-budget');
    recordSharedMemoryPhaseFailure(result, 'transport', 2);
    recordSharedMemoryPhaseFailure(result, 'materialization');

    expect(result).toMatchObject({
      localYield: true,
      failedPhases: 4,
      localYieldFailedPhases: 1,
    });
    expect(readSharedMemoryPhaseFailureAttribution(result)).toEqual({
      localBudget: 1,
      transport: 2,
      materialization: 1,
    });
    expect(readSharedMemoryPhaseFailureAttribution({ ...result })).toEqual({
      localBudget: 1,
      transport: 2,
      materialization: 1,
    });
    expect(JSON.parse(JSON.stringify(result))).not.toHaveProperty(
      'shared-memory-phase-failure-attribution',
    );
  });

  it('does not treat an unattributed failed phase as a local yield', () => {
    expect(classifySwmCatchupPeerOutcome({ localYield: true, failedPhases: 1 }))
      .toBe('transportFailed');
  });

  it('round-trips every coherent work outcome through compatibility fields', () => {
    const outcomes: SharedMemoryWorkOutcome[] = [
      'completed', 'timed-out', 'local-budget-yield', 'incomplete',
    ];
    expect(outcomes.map((outcome) => (
      sharedMemoryWorkOutcome(sharedMemoryCompletionFields(outcome))
    ))).toEqual(outcomes);
  });

  it('filters peers known not to advertise the current sync protocol', () => {
    const selector = createSwmCatchupPeerSelector({ fallbackProbeLimit: 3 });

    const result = selector.select({
      contextGraphId: 'cg',
      candidatePeers: ['legacy-peer', 'current-peer'],
      unsupportedPeers: new Set(['legacy-peer']),
      now: 100,
    });

    expect(result.selectedPeers).toEqual(['current-peer']);
    expect(result.skippedUnsupportedPeers).toEqual(['legacy-peer']);
  });

  it('prefers a known-good peer, and asks one peer not known yet as well, another one each time (#3421)', () => {
    const selector = createSwmCatchupPeerSelector();
    selector.record('cg', 'peer-b', 'good', 100);

    const select = () => selector.select({
      contextGraphId: 'cg',
      candidatePeers: ['peer-a', 'peer-b', 'peer-c'],
      now: 101,
    }).selectedPeers;

    expect(select()).toEqual(['peer-b', 'peer-a']);
    expect(select()).toEqual(['peer-b', 'peer-c']);
    expect(select()).toEqual(['peer-b', 'peer-a']);
    selector.record('cg', 'peer-a', 'good', 101);
    selector.record('cg', 'peer-c', 'good', 101);
    expect(select()).toEqual(['peer-a', 'peer-b', 'peer-c']);
  });

  it('does not take a peer that answered with metadata alone for a good source (#3421)', () => {
    // The peer of the issue: asked four times in 45 minutes, "0 data + 304 meta triples" each time.
    const metadataOnly = { insertedTriples: 304, fetchedMetaTriples: 304, fetchedDataTriples: 0, insertedDataTriples: 0 };
    expect(classifySwmCatchupPeerOutcome(metadataOnly)).toBe('empty');
    expect(classifySwmCatchupPeerOutcome({ fetchedMetaTriples: 304 })).toBe('empty');
    expect(classifySwmCatchupPeerOutcome({ ...metadataOnly, insertedDataTriples: 125 })).toBe('good');
    // A producer that reports only the total keeps the old reading.
    expect(classifySwmCatchupPeerOutcome({ insertedTriples: 5 })).toBe('good');

    const selector = createSwmCatchupPeerSelector();
    selector.record('cg', 'metadata-holder', classifySwmCatchupPeerOutcome(metadataOnly), 100);
    expect(selector.select({
      contextGraphId: 'cg',
      candidatePeers: ['metadata-holder', 'data-holder'],
      now: 101,
    }).selectedPeers).toEqual(['data-holder']);
  });

  it('always asks the owner when it is a candidate, whatever it answered before (#3421)', () => {
    const selector = createSwmCatchupPeerSelector();
    selector.record('cg', 'holder', 'good', 100);
    selector.record('cg', 'owner', 'transportFailed', 100);

    expect(selector.select({
      contextGraphId: 'cg',
      candidatePeers: ['holder', 'owner'],
      ownerPeerIds: ['owner'],
      now: 101,
    })).toMatchObject({ selectedPeers: ['owner', 'holder'], skippedNegativePeers: [] });
    // Not connected, or without the current sync protocol: not a candidate, not asked.
    expect(selector.select({
      contextGraphId: 'cg',
      candidatePeers: ['holder'],
      ownerPeerIds: ['owner'],
      now: 101,
    }).selectedPeers).toEqual(['holder']);
    expect(selector.select({
      contextGraphId: 'cg',
      candidatePeers: ['holder', 'owner'],
      unsupportedPeers: new Set(['owner']),
      ownerPeerIds: ['owner'],
      now: 101,
    }).selectedPeers).toEqual(['holder']);
    // With no peer known, the owner comes first and the probe limit applies to the rest.
    expect(createSwmCatchupPeerSelector({ fallbackProbeLimit: 1 }).select({
      contextGraphId: 'cg',
      candidatePeers: ['peer-a', 'peer-b', 'owner'],
      ownerPeerIds: ['owner'],
      now: 101,
    }).selectedPeers).toEqual(['owner', 'peer-a']);
    // An owner that served data is a known-good source: one peer not known yet is asked beside it, in turn.
    const afterGoodOwner = createSwmCatchupPeerSelector();
    afterGoodOwner.record('cg', 'owner', 'good', 100);
    const selectBesideOwner = () => afterGoodOwner.select({
      contextGraphId: 'cg',
      candidatePeers: ['peer-a', 'peer-b', 'owner'],
      ownerPeerIds: ['owner'],
      now: 101,
    }).selectedPeers;
    expect(selectBesideOwner()).toEqual(['owner', 'peer-a']);
    expect(selectBesideOwner()).toEqual(['owner', 'peer-b']);
  });

  it('skips recent empty, denied, and transport-failed peers while an unknown peer exists', () => {
    const selector = createSwmCatchupPeerSelector({ fallbackProbeLimit: 3 });
    selector.record('cg', 'empty-peer', 'empty', 100);
    selector.record('cg', 'denied-peer', 'denied', 100);
    selector.record('cg', 'failed-peer', 'transportFailed', 100);

    const result = selector.select({
      contextGraphId: 'cg',
      candidatePeers: ['empty-peer', 'denied-peer', 'failed-peer', 'unknown-peer'],
      now: 101,
    });

    expect(result.selectedPeers).toEqual(['unknown-peer']);
    expect(result.skippedNegativePeers).toEqual(['empty-peer', 'denied-peer', 'failed-peer']);
  });

  it('keeps cold discovery bounded when no good peer is known', () => {
    const selector = createSwmCatchupPeerSelector({ fallbackProbeLimit: 2 });

    const result = selector.select({
      contextGraphId: 'cg',
      candidatePeers: ['peer-a', 'peer-b', 'peer-c', 'peer-d'],
      now: 100,
    });

    expect(result.selectedPeers).toEqual(['peer-a', 'peer-b']);
  });

  it('uses resolved curator peers for private context graph catchup', () => {
    const selector = createSwmCatchupPeerSelector({ fallbackProbeLimit: 3 });

    const result = selector.select({
      contextGraphId: 'private-cg',
      candidatePeers: ['unrelated-peer', 'curator-peer', 'other-peer'],
      privateCuratorPeerIds: ['curator-peer'],
      now: 100,
    });

    expect(result.scopedCandidatePeers).toEqual(['curator-peer']);
    expect(result.selectedPeers).toEqual(['curator-peer']);
  });

  it('retries a previously skipped peer after the negative TTL expires', () => {
    const selector = createSwmCatchupPeerSelector();
    selector.record('cg', 'peer-a', 'empty', 100);

    expect(selector.select({
      contextGraphId: 'cg',
      candidatePeers: ['peer-a', 'peer-b'],
      now: 101,
    }).selectedPeers).toEqual(['peer-b']);

    expect(selector.select({
      contextGraphId: 'cg',
      candidatePeers: ['peer-a'],
      now: 100 + SWM_CATCHUP_PEER_NEGATIVE_TTL_MS + 1,
    }).selectedPeers).toEqual(['peer-a']);
  });

  it('keeps direct classifier-to-record composition neutral for local yields', () => {
    const selector = createSwmCatchupPeerSelector({ maxEntries: 1 });
    selector.record('cg', 'known-peer', 'good', 100);
    const outcome = classifySwmCatchupPeerOutcome({ localYield: true as const });
    if (outcome) selector.record('cg', 'new-peer', outcome, 101);
    expect(selector.get('cg', 'known-peer', 102)).toBe('good');
    expect(selector.select({ contextGraphId: 'cg', candidatePeers: ['new-peer'], now: 102 }).skippedNegativePeers).toEqual([]);
    expect(selector.get('cg', 'new-peer', 102)).toBeUndefined();
    if (outcome) selector.record('cg', 'known-peer', outcome, 103);
    expect(selector.get('cg', 'known-peer', 104)).toBe('good');
  });

  it('finds the owner\'s peers to ask: none when this node owns the graph or the lookup fails (#3421)', async () => {
    const lookups: Array<[string, { maxPeerIds: number }]> = [];
    const lookup = (result: { curatorIsLocal: boolean; peerIds: string[] } | Error) => ({
      resolveCuratorPeerIdsForCg: async (contextGraphId: string, options: { maxPeerIds: number }) => {
        lookups.push([contextGraphId, options]);
        if (result instanceof Error) throw result;
        return result;
      },
    });

    expect(await swmCatchupOwnerPeerIds(lookup({ curatorIsLocal: false, peerIds: ['owner-1', 'owner-2'] }), 'cg'))
      .toEqual(['owner-1', 'owner-2']);
    expect(await swmCatchupOwnerPeerIds(lookup({ curatorIsLocal: true, peerIds: [] }), 'cg')).toEqual([]);
    expect(await swmCatchupOwnerPeerIds(lookup(new Error('registry unavailable')), 'cg')).toEqual([]);
    expect(lookups).toEqual([['cg', { maxPeerIds: 16 }], ['cg', { maxPeerIds: 16 }], ['cg', { maxPeerIds: 16 }]]);
  });

  it('classifies detailed sync outcomes for cache accounting', () => {
    expect(classifySwmCatchupPeerOutcome({ fetchedDataTriples: 1 })).toBe('good');
    expect(classifySwmCatchupPeerOutcome({ deniedPhases: 1 })).toBe('denied');
    expect(classifySwmCatchupPeerOutcome({ failedPeers: 1 })).toBe('transportFailed');
    const localYield = classifySwmCatchupPeerOutcome({
      localYield: true as const,
    });
    expect(localYield).toBeUndefined();
    // Metadata is no data (#3421): the unattributed failed phase decides.
    expect(classifySwmCatchupPeerOutcome({
      localYield: true as const,
      fetchedMetaTriples: 1,
      failedPhases: 1,
    })).toBe('transportFailed');
    const selector = createSwmCatchupPeerSelector();
    selector.record('cg', 'healthy-peer', 'good', 100);
    if (localYield) selector.record('cg', 'healthy-peer', localYield, 101);
    expect(selector.get('cg', 'healthy-peer', 102)).toBe('good');
    expect(classifySwmCatchupPeerOutcome({
      failedPhases: 1,
      backoffWorthyFailures: 1,
    })).toBe('transportFailed');
    expect(classifySwmCatchupPeerOutcome({
      failedPhases: 1,
    })).toBe('transportFailed');
    expect(classifySwmCatchupPeerOutcome({})).toBe('empty');
  });
});
