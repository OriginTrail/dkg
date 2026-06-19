import { describe, expect, it, vi } from 'vitest';
import {
  classifySwmFanoutPeerOutcome,
  createSwmFanoutPeerSelector,
  SWM_FANOUT_PEER_NEGATIVE_TTL_MS,
  type SelectSwmFanoutPeersInput,
} from '../src/swm/swm-fanout-peer-selection.js';
import { SwmSubstrateMethods } from '../src/dkg-agent-swm-substrate.js';

describe('active SWM fanout peer selection', () => {
  it('prefers known-good public peers and bounds unknown probes', () => {
    const selector = createSwmFanoutPeerSelector({ unknownProbeLimit: 2 });
    selector.record('cg', 'peer-b', 'good', 100);

    const result = selector.select({
      contextGraphId: 'cg',
      candidatePeers: ['peer-a', 'peer-b', 'peer-c', 'peer-d'],
      enumerationSource: 'topic-subscribers',
      now: 101,
    });

    expect(result.knownGoodPeers).toEqual(['peer-b']);
    expect(result.unknownProbedPeers).toEqual(['peer-a', 'peer-c']);
    expect(result.selectedPeers).toEqual(['peer-b', 'peer-a', 'peer-c']);
  });

  it('excludes recent non-terminal and failed public peers during the negative TTL', () => {
    const selector = createSwmFanoutPeerSelector({ unknownProbeLimit: 3 });
    selector.record('cg', 'peer-non-terminal', 'nonTerminal', 100);
    selector.record('cg', 'peer-failed', 'failed', 100);
    selector.record('cg', 'peer-unsupported', 'unsupported', 100);

    const result = selector.select({
      contextGraphId: 'cg',
      candidatePeers: ['peer-non-terminal', 'peer-failed', 'peer-unsupported', 'peer-unknown'],
      enumerationSource: 'topic-subscribers',
      now: 101,
    });

    expect(result.selectedPeers).toEqual(['peer-unknown']);
    expect(result.skippedRecentPeers).toEqual(['peer-non-terminal', 'peer-failed', 'peer-unsupported']);
  });

  it('does not fall back to recent negative public peers when no unknown peer exists', () => {
    const selector = createSwmFanoutPeerSelector({ unknownProbeLimit: 3 });
    selector.record('cg', 'peer-a', 'nonTerminal', 100);

    const result = selector.select({
      contextGraphId: 'cg',
      candidatePeers: ['peer-a'],
      enumerationSource: 'topic-subscribers',
      now: 101,
    });

    expect(result.selectedPeers).toEqual([]);
    expect(result.skippedRecentPeers).toEqual(['peer-a']);
  });

  it('retries a skipped public peer after the negative TTL expires', () => {
    const selector = createSwmFanoutPeerSelector();
    selector.record('cg', 'peer-a', 'failed', 100);

    expect(selector.select({
      contextGraphId: 'cg',
      candidatePeers: ['peer-a'],
      enumerationSource: 'topic-subscribers',
      now: 101,
    }).selectedPeers).toEqual([]);

    expect(selector.select({
      contextGraphId: 'cg',
      candidatePeers: ['peer-a'],
      enumerationSource: 'topic-subscribers',
      now: 100 + SWM_FANOUT_PEER_NEGATIVE_TTL_MS + 1,
    }).selectedPeers).toEqual(['peer-a']);
  });

  it('keeps different context graphs and peers isolated', () => {
    const selector = createSwmFanoutPeerSelector();
    selector.record('cg-a', 'peer-a', 'failed', 100);

    expect(selector.select({
      contextGraphId: 'cg-b',
      candidatePeers: ['peer-a'],
      enumerationSource: 'topic-subscribers',
      now: 101,
    }).selectedPeers).toEqual(['peer-a']);

    expect(selector.select({
      contextGraphId: 'cg-a',
      candidatePeers: ['peer-b'],
      enumerationSource: 'topic-subscribers',
      now: 101,
    }).selectedPeers).toEqual(['peer-b']);
  });

  it('leaves curated allowlist fanout unchanged', () => {
    const selector = createSwmFanoutPeerSelector();
    selector.record('curated-cg', 'offline-allowlist-peer', 'failed', 100);

    const result = selector.select({
      contextGraphId: 'curated-cg',
      candidatePeers: ['offline-allowlist-peer', 'online-allowlist-peer'],
      enumerationSource: 'allowlist',
      now: 101,
    });

    expect(result.selectedPeers).toEqual(['offline-allowlist-peer', 'online-allowlist-peer']);
    expect(result.skippedRecentPeers).toEqual([]);
  });

  it('classifies active substrate outcomes for selector accounting', () => {
    expect(classifySwmFanoutPeerOutcome({ outcome: 'delivered', error: '' })).toBe('good');
    expect(classifySwmFanoutPeerOutcome({ outcome: 'retryable', error: '' })).toBe('nonTerminal');
    expect(classifySwmFanoutPeerOutcome({ outcome: 'queued', error: '' })).toBe('nonTerminal');
    expect(classifySwmFanoutPeerOutcome({ outcome: 'inFlight', error: '' })).toBe('nonTerminal');
    expect(classifySwmFanoutPeerOutcome({ outcome: 'failed', error: 'dial timeout' })).toBe('failed');
    expect(classifySwmFanoutPeerOutcome({ outcome: 'failed', error: 'protocol not supported' })).toBe('unsupported');
  });

  it('watchdog top-up records non-terminal outcomes and rearms once', async () => {
    const recordSwmFanoutPeerRecord = vi.fn();
    const rearmWatchdog = vi.fn();
    const selector = createSwmFanoutPeerSelector({ unknownProbeLimit: 3 });
    const fakeAgent = fakeTopUpAgent({
      selector,
      sendReliable: vi.fn(async () => ({
        delivered: false,
        queued: true,
        attempts: 1,
        messageId: 'm-peer-a',
        error: 'queued for retry',
        nextAttemptAtMs: 200,
      })),
      recordSwmFanoutPeerRecord,
      rearmWatchdog,
    });

    await SwmSubstrateMethods.prototype.swmSubstrateTopUp.call(fakeAgent, {
      shareOperationId: 'op',
      cgId: 'cg',
      payload: new Uint8Array([1]),
      missingPeers: ['peer-a'],
    });

    expect(recordSwmFanoutPeerRecord).toHaveBeenCalledWith('cg', expect.objectContaining({
      peerId: 'peer-a',
      outcome: 'queued',
    }));
    expect(rearmWatchdog).toHaveBeenCalledWith('op');
  });

  it('watchdog top-up skips a recent non-terminal peer inside TTL', async () => {
    const sendReliable = vi.fn();
    const selector = createSwmFanoutPeerSelector({ unknownProbeLimit: 3 });
    selector.record('cg', 'peer-a', 'nonTerminal', 100);
    const fakeAgent = fakeTopUpAgent({
      selector,
      now: 101,
      sendReliable,
    });

    await SwmSubstrateMethods.prototype.swmSubstrateTopUp.call(fakeAgent, {
      shareOperationId: 'op',
      cgId: 'cg',
      payload: new Uint8Array([1]),
      missingPeers: ['peer-a'],
    });

    expect(sendReliable).not.toHaveBeenCalled();
  });
});

function fakeTopUpAgent(input: {
  selector: ReturnType<typeof createSwmFanoutPeerSelector>;
  now?: number;
  sendReliable: ReturnType<typeof vi.fn>;
  recordSwmFanoutPeerRecord?: ReturnType<typeof vi.fn>;
  recordSwmFanoutPeerOutcome?: ReturnType<typeof vi.fn>;
  rearmWatchdog?: ReturnType<typeof vi.fn>;
}) {
  return {
    log: {
      info: vi.fn(),
      warn: vi.fn(),
    },
    isPeerDialable: vi.fn(async () => true),
    messenger: {
      sendReliable: input.sendReliable,
    },
    swmAckQuorum: {
      inspect: vi.fn(() => ({
        shareOperationId: 'op',
        cgId: 'cg',
        expectedMembers: ['peer-a'],
        acked: [],
        ackPct: 0,
        watchdogFired: true,
        startedAtMs: 0,
        watchdogArmedAtMs: 0,
        watchdogMs: 30_000,
        deadlineHardMs: 300_000,
        enumerationSource: 'topic-subscribers',
      })),
      onAck: vi.fn(),
      dropPeer: vi.fn(),
      rearmWatchdog: input.rearmWatchdog ?? vi.fn(),
    },
    selectSwmFanoutPeersForActiveShare: (selectionInput: SelectSwmFanoutPeersInput) => (
      input.selector.select({ ...selectionInput, now: input.now })
    ),
    recordSwmFanoutPeerRecord: input.recordSwmFanoutPeerRecord ?? vi.fn(),
    recordSwmFanoutPeerOutcome: input.recordSwmFanoutPeerOutcome ?? vi.fn(),
  };
}
