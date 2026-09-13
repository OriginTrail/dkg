import { describe, expect, it, vi } from 'vitest';
import {
  runBoundedPreparedPeerTraversal,
  type PreparedPeerPreparation,
} from '../src/sync/prepared-peer-traversal.js';

describe('runBoundedPreparedPeerTraversal', () => {
  it('records skipped, failed, missed and done peers and counts only real attempts', async () => {
    const log = vi.fn();
    const preparations: Record<string, PreparedPeerPreparation> = {
      'peer-rejected': { kind: 'skipped', reason: 'not-admitted' },
      'peer-transport': { kind: 'ready' },
      'peer-miss': { kind: 'ready' },
      'peer-holder': { kind: 'ready' },
      'peer-untouched': { kind: 'ready' },
    };
    const transportError = new Error('stream reset');

    const traversal = await runBoundedPreparedPeerTraversal<string>({
      candidatePeerIds: ['peer-rejected', 'peer-dial', 'peer-transport', 'peer-miss', 'peer-holder', 'peer-untouched'],
      maxPeers: 6,
      operationLabel: 'Exact fetch from',
      assertCurrent: () => undefined,
      preparePeer: async (peerId) => {
        if (peerId === 'peer-dial') throw new Error('dial timed out');
        return preparations[peerId]!;
      },
      attemptPeer: async (peerId) => {
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
    const onWindowSelected = vi.fn();
    const traversal = await runBoundedPreparedPeerTraversal<never>({
      candidatePeerIds: ['peer-a', 'peer-b', 'peer-a', '', 'peer-c'],
      maxPeers: 2,
      operationLabel: 'Exact fetch from',
      assertCurrent: () => undefined,
      selectPeerWindow,
      onWindowSelected,
      preparePeer: async () => ({ kind: 'ready' }),
      attemptPeer: async () => ({ kind: 'missed', reason: 'unresolved' }),
      log: vi.fn(),
    });

    expect(selectPeerWindow).toHaveBeenCalledWith(['peer-a', 'peer-b', 'peer-c'], { maxPeers: 2 });
    expect(onWindowSelected).toHaveBeenCalledWith({
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

  it('propagates cancellation observed after a failed preparation instead of continuing', async () => {
    const controller = new AbortController();
    const reason = new Error('owner stopped');
    const attemptPeer = vi.fn(async () => ({ kind: 'done' as const }));

    await expect(runBoundedPreparedPeerTraversal({
      candidatePeerIds: ['peer-stalled', 'peer-next'],
      maxPeers: 2,
      operationLabel: 'Exact fetch from',
      assertCurrent: () => {
        if (controller.signal.aborted) throw controller.signal.reason;
      },
      preparePeer: async () => {
        controller.abort(reason);
        throw new Error('dial aborted');
      },
      attemptPeer,
      log: vi.fn(),
    })).rejects.toBe(reason);
    expect(attemptPeer).not.toHaveBeenCalled();
  });

  it('surfaces a terminal outcome and a thrown attempt without visiting later peers', async () => {
    const terminal = new Error('graph binding conflict');
    const preparePeer = vi.fn(async () => ({ kind: 'ready' as const }));
    await expect(runBoundedPreparedPeerTraversal({
      candidatePeerIds: ['peer-a', 'peer-b'],
      maxPeers: 2,
      operationLabel: 'Exact fetch from',
      assertCurrent: () => undefined,
      preparePeer,
      attemptPeer: async () => ({ kind: 'terminal', error: terminal }),
      log: vi.fn(),
    })).rejects.toBe(terminal);
    expect(preparePeer).toHaveBeenCalledTimes(1);

    const thrown = new Error('unexpected');
    await expect(runBoundedPreparedPeerTraversal({
      candidatePeerIds: ['peer-a'],
      maxPeers: 1,
      operationLabel: 'Exact fetch from',
      assertCurrent: () => undefined,
      preparePeer: async () => ({ kind: 'ready' }),
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
      preparePeer: async () => ({ kind: 'ready' }),
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
