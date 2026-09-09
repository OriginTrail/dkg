import { describe, expect, it } from 'vitest';
import {
  classifySwmCatchupPeerOutcome,
  createSwmCatchupPeerSelector,
  SWM_CATCHUP_PEER_NEGATIVE_TTL_MS,
} from '../src/swm/swm-catchup-peer-selection.js';
import { sharedMemoryLocalYield } from '../src/sync/shared-memory-completion.js';

describe('SWM catchup peer selection', () => {
  it('keeps the local-yield reason plane-neutral', () => {
    expect(sharedMemoryLocalYield()).toEqual({ kind: 'local-budget-yield' });
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

  it('prefers a known-good peer for the context graph over unknown peers', () => {
    const selector = createSwmCatchupPeerSelector();
    selector.record('cg', 'peer-b', 'good', 100);

    const result = selector.select({
      contextGraphId: 'cg',
      candidatePeers: ['peer-a', 'peer-b', 'peer-c'],
      now: 101,
    });

    expect(result.selectedPeers).toEqual(['peer-b']);
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
    const outcome = classifySwmCatchupPeerOutcome({ localYield: sharedMemoryLocalYield() });
    // Runtime regression also covers old JavaScript callers without a guard.
    selector.record('cg', 'new-peer', outcome, 101);
    expect(selector.get('cg', 'known-peer', 102)).toBe('good');
    expect(selector.select({ contextGraphId: 'cg', candidatePeers: ['new-peer'], now: 102 }).skippedNegativePeers).toEqual([]);
    expect(selector.get('cg', 'new-peer', 102)).toBeUndefined();
    selector.record('cg', 'known-peer', outcome, 103);
    expect(selector.get('cg', 'known-peer', 104)).toBe('good');
  });

  it('classifies detailed sync outcomes for cache accounting', () => {
    expect(classifySwmCatchupPeerOutcome({ fetchedDataTriples: 1 })).toBe('good');
    expect(classifySwmCatchupPeerOutcome({ deniedPhases: 1 })).toBe('denied');
    expect(classifySwmCatchupPeerOutcome({ failedPeers: 1 })).toBe('transportFailed');
    const localYield = classifySwmCatchupPeerOutcome({
      localYield: sharedMemoryLocalYield(),
    });
    expect(localYield).toBeUndefined();
    expect(classifySwmCatchupPeerOutcome({
      localYield: sharedMemoryLocalYield(),
      fetchedMetaTriples: 1,
      failedPhases: 1,
    })).toBe('good');
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
