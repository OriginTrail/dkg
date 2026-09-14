import { describe, expect, it, vi } from 'vitest';
import {
  runBoundedPreparedPeerTraversal,
  type PreparedPeerWindowSelection,
} from '../src/sync/prepared-peer-traversal.js';

describe('runBoundedPreparedPeerTraversal', () => {
  it('records skipped, failed, missed and done peers and counts only real attempts', async () => {
    const log = vi.fn();
    const transportError = new Error('stream reset');
    const dialError = new Error('dial timed out');

    const traversal = await runBoundedPreparedPeerTraversal<string>({
      candidatePeerIds: ['peer-rejected', 'peer-dial', 'peer-transport', 'peer-miss', 'peer-holder', 'peer-untouched'],
      maxPeers: 6,
      operationLabel: 'Exact fetch from',
      assertCurrent: () => undefined,
      attemptPeer: async (peerId) => {
        if (peerId === 'peer-rejected') return { kind: 'skipped', reason: 'not-admitted' };
        if (peerId === 'peer-dial') return { kind: 'prepare-failed', error: dialError };
        if (peerId === 'peer-transport') return { kind: 'failed', error: transportError };
        if (peerId === 'peer-miss') return { kind: 'missed', reason: 'clean-absent' };
        return { kind: 'done', result: peerId };
      },
      log,
    });

    expect(traversal).toEqual({
      completion: 'done',
      result: 'peer-holder',
      peerAttempts: 3,
      attempts: [
        { peerId: 'peer-rejected', kind: 'skipped', reason: 'not-admitted' },
        { peerId: 'peer-dial', kind: 'prepare-failed', error: expect.any(Error) },
        { peerId: 'peer-transport', kind: 'failed', error: transportError },
        { peerId: 'peer-miss', kind: 'missed', reason: 'clean-absent' },
        { peerId: 'peer-holder', kind: 'done' },
      ],
    });
    expect(log.mock.calls.map(([message]) => message)).toEqual([
      'Exact fetch from peer-rejected skipped: not-admitted',
      'Exact fetch from peer-dial failed: dial timed out',
      'Exact fetch from peer-transport failed: stream reset',
    ]);
  });

  it('exhausts a bounded, de-duplicated window selected from unique candidates', async () => {
    const selectPeerWindow = vi.fn((peerIds: string[]) => [...peerIds].reverse().concat('peer-unknown'));
    let selection: PreparedPeerWindowSelection | undefined;
    const traversal = await runBoundedPreparedPeerTraversal<never>({
      candidatePeerIds: ['peer-a', 'peer-b', 'peer-a', '', 'peer-c'],
      maxPeers: 2,
      selectPeerWindow,
      operationLabel: 'Exact fetch from',
      assertCurrent: () => undefined,
      onWindowSelected: (selected) => { selection = selected; },
      attemptPeer: async () => ({ kind: 'missed', reason: 'unresolved' }),
      log: vi.fn(),
    });

    expect(selectPeerWindow).toHaveBeenCalledWith(['peer-a', 'peer-b', 'peer-c'], { maxPeers: 2 });
    expect(selection).toEqual({
      candidatePeerIds: ['peer-a', 'peer-b', 'peer-c'],
      selectedPeerIds: ['peer-c', 'peer-b'],
      maxPeers: 2,
    });
    expect(traversal).toEqual({
      completion: 'exhausted',
      peerAttempts: 2,
      attempts: [
        { peerId: 'peer-c', kind: 'missed', reason: 'unresolved' },
        { peerId: 'peer-b', kind: 'missed', reason: 'unresolved' },
      ],
    });
  });

  it('passes stable traversal position into the caller-owned attempt', async () => {
    const observed: unknown[] = [];
    const traversal = await runBoundedPreparedPeerTraversal<string>({
      candidatePeerIds: ['peer-a', 'peer-b'],
      maxPeers: 2,
      operationLabel: 'Positioned fetch from',
      assertCurrent: () => undefined,
      attemptPeer: async (peerId, position) => {
        observed.push(['attempt', peerId, position]);
        return peerId === 'peer-a'
          ? { kind: 'missed', reason: 'not-here' }
          : { kind: 'done', result: `found:${peerId}` };
      },
      log: vi.fn(),
    });

    expect(traversal.result).toBe('found:peer-b');
    expect(observed).toEqual([
      ['attempt', 'peer-a', expect.objectContaining({ index: 0, remainingPeers: 2, totalPeers: 2 })],
      ['attempt', 'peer-b', expect.objectContaining({ index: 1, remainingPeers: 1, totalPeers: 2 })],
    ]);
  });

  it('propagates cancellation observed after a failed preparation instead of continuing', async () => {
    const controller = new AbortController();
    const reason = new Error('owner stopped');
    const attemptPeer = vi.fn(async () => {
      controller.abort(reason);
      return { kind: 'prepare-failed' as const, error: new Error('dial aborted') };
    });

    await expect(runBoundedPreparedPeerTraversal({
      candidatePeerIds: ['peer-stalled', 'peer-next'],
      maxPeers: 2,
      operationLabel: 'Exact fetch from',
      assertCurrent: () => {
        if (controller.signal.aborted) throw controller.signal.reason;
      },
      attemptPeer,
      log: vi.fn(),
    })).rejects.toBe(reason);
    expect(attemptPeer).toHaveBeenCalledTimes(1);
    expect(attemptPeer).toHaveBeenCalledWith('peer-stalled', expect.any(Object));
  });

  it('surfaces a terminal outcome and a thrown attempt without visiting later peers', async () => {
    const terminal = new Error('graph binding conflict');
    const attemptPeer = vi.fn(async () => ({ kind: 'terminal' as const, error: terminal }));
    await expect(runBoundedPreparedPeerTraversal({
      candidatePeerIds: ['peer-a', 'peer-b'],
      maxPeers: 2,
      operationLabel: 'Exact fetch from',
      assertCurrent: () => undefined,
      attemptPeer,
      log: vi.fn(),
    })).rejects.toBe(terminal);
    expect(attemptPeer).toHaveBeenCalledTimes(1);

    const thrown = new Error('unexpected');
    await expect(runBoundedPreparedPeerTraversal({
      candidatePeerIds: ['peer-a'],
      maxPeers: 1,
      operationLabel: 'Exact fetch from',
      assertCurrent: () => undefined,
      attemptPeer: async () => { throw thrown; },
      log: vi.fn(),
    })).rejects.toBe(thrown);
  });

  it('logs a done diagnostic while completing the traversal without a result', async () => {
    const log = vi.fn();
    const traversal = await runBoundedPreparedPeerTraversal<never>({
      candidatePeerIds: ['peer-a'],
      maxPeers: 1,
      operationLabel: 'Exact fetch from',
      assertCurrent: () => undefined,
      attemptPeer: async () => ({ kind: 'done', diagnostic: new Error('prefix persisted') }),
      log,
    });

    expect(traversal).toEqual({
      completion: 'done',
      peerAttempts: 1,
      attempts: [{ peerId: 'peer-a', kind: 'done' }],
    });
    expect(log).toHaveBeenCalledWith('Exact fetch from peer-a failed: prefix persisted');
  });
});
