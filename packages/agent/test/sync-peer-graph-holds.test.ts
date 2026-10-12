import { describe, expect, it, vi } from 'vitest';
import { formatSyncNotServable } from '../src/sync/not-servable.js';
import { sendSyncRequest } from '../src/p2p/sync-transport.js';
import {
  describeSyncPeerGraphHold,
  observeSyncPageFetch,
  syncPeerGraphHoldsFor,
  SyncPeerGraphHolds,
  SYNC_PEER_GRAPH_HOLD_BASE_MS,
  SYNC_PEER_GRAPH_HOLD_JITTER,
  SYNC_PEER_GRAPH_HOLD_MAX_MS,
  type SyncPeerGraphHold,
} from '../src/sync/requester/peer-graph-holds.js';

/**
 * A peer that cannot serve one graph is held for that graph only: the hold
 * grows with each consecutive refusal up to a cap, ends by itself, and clears
 * once the graph syncs from that peer.
 */

const PEER = '12D3KooWHoldsTestResponderPeerAAAAAAAA';
const OTHER_PEER = '12D3KooWHoldsTestResponderPeerBBBBBBBB';

function holds(random = 0) {
  let now = 5_000_000;
  const ledger = new SyncPeerGraphHolds({ now: () => now, random: () => random });
  return { ledger, now: () => now, advance: (ms: number) => { now += ms; } };
}

describe('per-peer graph holds', () => {
  it('holds one graph for one peer and leaves other graphs and peers alone', () => {
    const { ledger, now } = holds();
    const hold = ledger.refused(PEER, 'big', { reason: 'store-deadline' });
    expect(hold).toEqual({
      peerId: PEER,
      contextGraphId: 'big',
      reason: 'store-deadline',
      refusals: 1,
      heldUntil: now() + SYNC_PEER_GRAPH_HOLD_BASE_MS,
    });
    expect(ledger.heldAmong(PEER, ['small', 'big', 'other'])).toEqual(['big']);
    expect(ledger.heldAmong(OTHER_PEER, ['small', 'big'])).toEqual([]);
    expect(ledger.snapshot()).toEqual([hold]);
  });

  it('ends by itself, and doubles up to the cap while the peer keeps refusing', () => {
    const { ledger, now, advance } = holds();
    const periods: number[] = [];
    for (let refusal = 1; refusal <= 5; refusal += 1) {
      const hold = ledger.refused(PEER, 'big', { reason: 'store-deadline' })!;
      expect(hold.refusals).toBe(refusal);
      periods.push(hold.heldUntil - now());
      advance(hold.heldUntil - now() - 1);
      expect(ledger.heldAmong(PEER, ['big'])).toEqual(['big']);
      advance(1);
      // The hold is over: the graph is asked for again.
      expect(ledger.heldAmong(PEER, ['big'])).toEqual([]);
      expect(ledger.snapshot()).toEqual([]);
    }
    expect(periods).toEqual([
      SYNC_PEER_GRAPH_HOLD_BASE_MS,
      2 * SYNC_PEER_GRAPH_HOLD_BASE_MS,
      4 * SYNC_PEER_GRAPH_HOLD_BASE_MS,
      SYNC_PEER_GRAPH_HOLD_MAX_MS,
      SYNC_PEER_GRAPH_HOLD_MAX_MS,
    ]);
  });

  it('starts over once the graph syncs from the peer', () => {
    const { ledger, now, advance } = holds();
    ledger.refused(PEER, 'big', { reason: 'store-deadline' });
    advance(SYNC_PEER_GRAPH_HOLD_BASE_MS);
    ledger.refused(PEER, 'big', { reason: 'store-deadline' });
    ledger.served(PEER, 'big');
    expect(ledger.heldAmong(PEER, ['big'])).toEqual([]);
    const hold = ledger.refused(PEER, 'big', { reason: 'too-large' })!;
    expect(hold.refusals).toBe(1);
    expect(hold.heldUntil - now()).toBe(SYNC_PEER_GRAPH_HOLD_BASE_MS);
  });

  it('treats a refusal that arrives during a hold as the same refusal', () => {
    const { ledger, advance } = holds();
    const first = ledger.refused(PEER, 'big', { reason: 'store-deadline' })!;
    advance(1_000);
    expect(ledger.refused(PEER, 'big', { reason: 'store-deadline' })).toBeUndefined();
    expect(ledger.snapshot()).toEqual([first]);
  });

  it('honours the time the responder asks for, up to its own cap', () => {
    const { ledger, now } = holds();
    const longer = ledger.refused(PEER, 'a', { reason: 'store-deadline', retryAfterMs: 25 * 60_000 })!;
    expect(longer.heldUntil - now()).toBe(25 * 60_000);
    const shorter = ledger.refused(PEER, 'b', { reason: 'store-deadline', retryAfterMs: 1_000 })!;
    expect(shorter.heldUntil - now()).toBe(SYNC_PEER_GRAPH_HOLD_BASE_MS);
    const absurd = ledger.refused(PEER, 'c', { reason: 'store-deadline', retryAfterMs: 10 ** 11 })!;
    expect(absurd.heldUntil - now()).toBe(SYNC_PEER_GRAPH_HOLD_MAX_MS);
  });

  it('only ever lengthens a hold with jitter', () => {
    const { ledger, now } = holds(1);
    const hold = ledger.refused(PEER, 'big', { reason: 'store-deadline' })!;
    expect(hold.heldUntil - now()).toBe(SYNC_PEER_GRAPH_HOLD_BASE_MS * (1 + SYNC_PEER_GRAPH_HOLD_JITTER));
  });

  it('forgets a hold that was not followed by another attempt within a whole cap', () => {
    const { ledger, advance } = holds();
    ledger.refused(PEER, 'big', { reason: 'store-deadline' });
    advance(SYNC_PEER_GRAPH_HOLD_BASE_MS + SYNC_PEER_GRAPH_HOLD_MAX_MS);
    // Any later refusal prunes the stale record.
    ledger.refused(PEER, 'another', { reason: 'store-deadline' });
    expect(ledger.refused(PEER, 'big', { reason: 'store-deadline' })!.refusals).toBe(1);
  });

  it('stays bounded: the oldest hold is dropped once more are recorded than it keeps', () => {
    const { ledger } = holds();
    for (let index = 0; index <= 4_096; index += 1) {
      ledger.refused(PEER, `graph-${index}`, { reason: 'store-deadline' });
    }
    expect(ledger.snapshot()).toHaveLength(4_096);
    expect(ledger.heldAmong(PEER, ['graph-0', 'graph-1', 'graph-4096'])).toEqual(['graph-1', 'graph-4096']);
  });

  it('keeps one ledger per agent object', () => {
    const agent = {};
    expect(syncPeerGraphHoldsFor(agent)).toBe(syncPeerGraphHoldsFor(agent));
    expect(syncPeerGraphHoldsFor({})).not.toBe(syncPeerGraphHoldsFor(agent));
  });

  it('describes a hold for the log without the full peer id', () => {
    const { ledger, now } = holds();
    const hold = ledger.refused(PEER, 'big', { reason: 'store-deadline' })!;
    expect(describeSyncPeerGraphHold(hold, now())).toBe(
      `Context graph "big" is not syncable from peer ${PEER.slice(-8)} right now `
      + '(store-deadline, 1 in a row); asking again in about 10 min',
    );
  });
});

describe('page fetch outcomes feed the holds', () => {
  const wholeGraph = { peerId: PEER, contextGraphId: 'big', phase: 'meta', wholeGraphDurable: true };

  it('holds the graph when a whole-graph durable fetch is refused as not servable', async () => {
    const { ledger } = holds();
    const reported: SyncPeerGraphHold[] = [];
    await observeSyncPageFetch(
      ledger,
      wholeGraph,
      Promise.reject(new Error(formatSyncNotServable('store-deadline', 20 * 60_000))),
      (hold) => reported.push(hold),
    );
    expect(ledger.heldAmong(PEER, ['big'])).toEqual(['big']);
    expect(reported).toHaveLength(1);
    expect(reported[0]).toMatchObject({ reason: 'store-deadline', refusals: 1 });
  });

  it('holds the graph on the plain store-deadline text of a responder without the reply', async () => {
    const { ledger } = holds();
    const onHold = vi.fn();
    await observeSyncPageFetch(
      ledger,
      wholeGraph,
      Promise.reject(new Error('oxigraph-server query exceeded its store deadline after 30000ms')),
      onHold,
    );
    expect(ledger.heldAmong(PEER, ['big'])).toEqual(['big']);
    expect(onHold).toHaveBeenCalledTimes(1);
  });

  it('ignores other failures, and fetches that are not whole-graph durable sync', async () => {
    const { ledger } = holds();
    const onHold = vi.fn();
    await observeSyncPageFetch(ledger, wholeGraph, Promise.reject(new Error('request timeout')), onHold);
    await observeSyncPageFetch(
      ledger,
      { ...wholeGraph, wholeGraphDurable: false },
      Promise.reject(new Error(formatSyncNotServable('store-deadline', 1))),
      onHold,
    );
    expect(ledger.snapshot()).toEqual([]);
    expect(onHold).not.toHaveBeenCalled();
  });

  it('clears the hold when the data phase completes, and only then', async () => {
    const { ledger, advance } = holds();
    ledger.refused(PEER, 'big', { reason: 'store-deadline' });
    advance(SYNC_PEER_GRAPH_HOLD_BASE_MS);
    const onHold = vi.fn();
    // Metadata arriving, or an incomplete data phase, proves nothing yet.
    await observeSyncPageFetch(ledger, wholeGraph, Promise.resolve({ completed: true }), onHold);
    await observeSyncPageFetch(ledger, { ...wholeGraph, phase: 'data' }, Promise.resolve({ completed: false }), onHold);
    expect(ledger.refused(PEER, 'big', { reason: 'store-deadline' })!.refusals).toBe(2);
    advance(2 * SYNC_PEER_GRAPH_HOLD_BASE_MS);
    await observeSyncPageFetch(ledger, { ...wholeGraph, phase: 'data' }, Promise.resolve({ completed: true }), onHold);
    expect(ledger.refused(PEER, 'big', { reason: 'store-deadline' })!.refusals).toBe(1);
  });
});

describe('a not-servable reply is not retried within the fetch', () => {
  const request = (send: Parameters<typeof sendSyncRequest>[0]['send'], onRetry = vi.fn()) => sendSyncRequest({
    remotePeerId: PEER,
    timeoutMs: 1_000,
    retryAttempts: 3,
    contextGraphId: 'big',
    offset: 0,
    requestFactory: async () => new Uint8Array([1]),
    send,
    protocolId: '/dkg/10.0.2/sync',
    onRetry,
    plane: 'durable',
    phase: 'meta',
  });

  it('sends the request once when the responder says it cannot serve it', async () => {
    const send = vi.fn(async () => { throw new Error(formatSyncNotServable('store-deadline', 600_000)); });
    const onRetry = vi.fn();
    await expect(request(send, onRetry)).rejects.toThrow(/request not servable/);
    expect(send).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it('sends the request once on the plain store-deadline text', async () => {
    const send = vi.fn(async () => {
      throw new Error('oxigraph-server query exceeded its store deadline after 30000ms');
    });
    await expect(request(send)).rejects.toThrow(/store deadline/);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('still retries an ordinary busy responder', async () => {
    let calls = 0;
    const send = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error('sync responder queue wait exceeded');
      return new Uint8Array([2]);
    });
    await expect(request(send)).resolves.toEqual(new Uint8Array([2]));
    expect(send).toHaveBeenCalledTimes(2);
  });
});
