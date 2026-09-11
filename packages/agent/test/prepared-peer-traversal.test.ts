import { describe, expect, it, vi } from 'vitest';
import {
  describePreparedPeerAttempt,
  runBoundedPreparedPeerTraversal,
  type PreparedPeerAttemptRecord,
  type PreparedPeerPreparation,
} from '../src/sync/prepared-peer-traversal.js';

describe('runBoundedPreparedPeerTraversal', () => {
  it('records skipped, failed, missed and done peers as structured outcomes', async () => {
    const log = vi.fn();
    const preparations: Record<string, PreparedPeerPreparation> = {
      'peer-rejected': { kind: 'skipped', reason: 'not-admitted' },
      'peer-transport': { kind: 'ready' },
      'peer-miss': { kind: 'ready' },
      'peer-holder': { kind: 'ready' },
      'peer-untouched': { kind: 'ready' },
    };
    const transportError = Object.assign(new Error('stream  reset'), { code: 'ECONNRESET' });

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
        if (peerId === 'peer-transport') return { kind: 'continue', error: transportError };
        if (peerId === 'peer-miss') return { kind: 'continue', reason: 'clean-absent' };
        return { kind: 'done', result: peerId };
      },
      log,
    });

    expect(traversal.completion).toBe('done');
    expect(traversal.result).toBe('peer-holder');
    expect(traversal.peerAttempts).toBe(3);
    expect(traversal.attemptedPeerIds).toEqual([
      'peer-rejected', 'peer-dial', 'peer-transport', 'peer-miss', 'peer-holder',
    ]);
    expect(traversal.attempts).toEqual([
      { peerId: 'peer-rejected', outcome: 'skipped', reason: 'not-admitted' },
      { peerId: 'peer-dial', outcome: 'prepare-failed', error: expect.any(Error) },
      { peerId: 'peer-transport', outcome: 'failed', error: transportError },
      { peerId: 'peer-miss', outcome: 'missed', reason: 'clean-absent' },
      { peerId: 'peer-holder', outcome: 'done' },
    ]);
    expect(traversal.attempts.map(describePreparedPeerAttempt)).toEqual([
      'rejected=skipped:not-admitted',
      'eer-dial=prepare:dial timed out',
      'ransport=error:ECONNRESET:stream reset',
      'eer-miss=missed:clean-absent',
      'r-holder=done',
    ]);
    expect(log.mock.calls.map(([message]) => message)).toEqual([
      'Exact fetch from peer-rejected skipped: not-admitted',
      'Exact fetch from peer-dial failed: dial timed out',
      'Exact fetch from peer-transport failed: stream  reset',
    ]);
  });

  it('exhausts a bounded, de-duplicated window and reports a reasonless miss', async () => {
    const selectPeerWindow = vi.fn((peerIds: string[]) => [...peerIds].reverse().concat('peer-unknown'));
    const traversal = await runBoundedPreparedPeerTraversal<never>({
      candidatePeerIds: ['peer-a', 'peer-b', 'peer-a', '', 'peer-c'],
      maxPeers: 2,
      operationLabel: 'Exact fetch from',
      assertCurrent: () => undefined,
      selectPeerWindow,
      preparePeer: async () => ({ kind: 'ready' }),
      attemptPeer: async () => ({ kind: 'continue' }),
      log: vi.fn(),
    });

    expect(selectPeerWindow).toHaveBeenCalledWith(['peer-a', 'peer-b', 'peer-c'], { maxPeers: 2 });
    expect(traversal).toEqual({
      completion: 'exhausted',
      peerAttempts: 2,
      attemptedPeerIds: ['peer-c', 'peer-b'],
      peerWindow: ['peer-c', 'peer-b'],
      attempts: [
        { peerId: 'peer-c', outcome: 'missed' },
        { peerId: 'peer-b', outcome: 'missed' },
      ],
    });
    expect(describePreparedPeerAttempt(traversal.attempts[0]!)).toBe('peer-c=missed');
  });

  it('truncates long error details in the compact description', () => {
    const record: PreparedPeerAttemptRecord = {
      peerId: 'peer-verbose',
      outcome: 'failed',
      error: new Error(`${'x'.repeat(100)}\n\ttail`),
    };
    const description = describePreparedPeerAttempt(record);
    expect(description).toBe(`-verbose=error:${'x'.repeat(72)}`);
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

  it('surfaces a terminal outcome and a thrown attempt without recording later peers', async () => {
    const terminal = new Error('graph binding conflict');
    await expect(runBoundedPreparedPeerTraversal({
      candidatePeerIds: ['peer-a', 'peer-b'],
      maxPeers: 2,
      operationLabel: 'Exact fetch from',
      assertCurrent: () => undefined,
      preparePeer: async () => ({ kind: 'ready' }),
      attemptPeer: async () => ({ kind: 'terminal', error: terminal }),
      log: vi.fn(),
    })).rejects.toBe(terminal);

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

  it('logs a done diagnostic while completing the traversal', async () => {
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

    expect(traversal.completion).toBe('done');
    expect(traversal.result).toBeUndefined();
    expect(traversal.attempts).toEqual([{ peerId: 'peer-a', outcome: 'done' }]);
    expect(log).toHaveBeenCalledWith('Exact fetch from peer-a failed: prefix persisted');
  });
});
