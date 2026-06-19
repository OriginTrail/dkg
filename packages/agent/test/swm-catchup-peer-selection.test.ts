import { describe, expect, it } from 'vitest';
import {
  classifySwmCatchupPeerOutcome,
  createSwmCatchupPeerSelector,
  SWM_CATCHUP_PEER_NEGATIVE_TTL_MS,
} from '../src/swm/swm-catchup-peer-selection.js';

describe('SWM catchup peer selection', () => {
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

  it('classifies detailed sync outcomes for cache accounting', () => {
    expect(classifySwmCatchupPeerOutcome({ fetchedDataTriples: 1 })).toBe('good');
    expect(classifySwmCatchupPeerOutcome({ deniedPhases: 1 })).toBe('denied');
    expect(classifySwmCatchupPeerOutcome({ failedPeers: 1 })).toBe('transportFailed');
    expect(classifySwmCatchupPeerOutcome({})).toBe('empty');
  });
});
