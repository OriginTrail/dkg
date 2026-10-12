import { describe, expect, it, vi } from 'vitest';
import { toSyncTransportFailureError } from '../src/sync/error-tags.js';
import { formatSyncNotServable, readSyncNotServableReply } from '../src/sync/not-servable.js';
import { sendSyncRequest } from '../src/p2p/sync-transport.js';
import {
  describeSyncPeerGraphHold,
  observeSyncPageFetch,
  syncPeerGraphHoldScope,
  syncPeerGraphHoldsFor,
  SyncPeerGraphHeldError,
  SyncPeerGraphHolds,
  SYNC_PEER_GRAPH_HOLD_BASE_MS,
  SYNC_PEER_GRAPH_HOLD_JITTER,
  SYNC_PEER_GRAPH_HOLD_MAX_MS,
  type SyncPeerGraphHold,
} from '../src/sync/requester/peer-graph-holds.js';
import { isKnownRetryableSyncTransportInterruption, isSyncBackoffWorthyError } from '../src/sync/error-tags.js';

/**
 * A peer that cannot serve one whole-graph fetch is held for that fetch only:
 * the hold grows with each consecutive refusal up to a cap, ends by itself, and
 * clears once the fetch completes from that peer.
 */

const PEER = '12D3KooWHoldsTestResponderPeerAAAAAAAA';
const OTHER_PEER = '12D3KooWHoldsTestResponderPeerBBBBBBBB';
const META = 'meta';

function holds(random = 0) {
  let now = 5_000_000;
  const ledger = new SyncPeerGraphHolds({ now: () => now, random: () => random });
  return { ledger, now: () => now, advance: (ms: number) => { now += ms; } };
}

describe('per-peer graph holds', () => {
  it('holds one graph for one peer and leaves other graphs and peers alone', () => {
    const { ledger, now } = holds();
    const hold = ledger.refused(PEER, 'big', META, { reason: 'store-deadline' });
    expect(hold).toEqual({
      peerId: PEER,
      contextGraphId: 'big',
      scope: META,
      reason: 'store-deadline',
      refusals: 1,
      heldUntil: now() + SYNC_PEER_GRAPH_HOLD_BASE_MS,
    });
    expect(ledger.current(PEER, 'big', META)).toEqual(hold);
    expect(ledger.current(PEER, 'small', META)).toBeUndefined();
    expect(ledger.current(OTHER_PEER, 'big', META)).toBeUndefined();
    // Another fetch of the same graph from the same peer is not held either.
    expect(ledger.current(PEER, 'big', 'data')).toBeUndefined();
    expect(ledger.snapshot()).toEqual([hold]);
  });

  it('names the fetches a hold applies to, and none for the others', () => {
    const wholeGraph = { includeSharedMemory: false, phase: 'meta' };
    expect(syncPeerGraphHoldScope(wholeGraph)).toBe('meta');
    expect(syncPeerGraphHoldScope({ ...wholeGraph, phase: 'data' })).toBe('data');
    expect(syncPeerGraphHoldScope({ ...wholeGraph, sinceBatchId: '7' })).toBe('meta from a batch id');
    expect(syncPeerGraphHoldScope({ ...wholeGraph, includeSharedMemory: true })).toBeUndefined();
    expect(syncPeerGraphHoldScope({ ...wholeGraph, assetUals: ['did:dkg:x/0x1/1'] })).toBeUndefined();
    expect(syncPeerGraphHoldScope({ ...wholeGraph, recovery: true })).toBeUndefined();
  });

  it('ends by itself, and doubles up to the cap while the peer keeps refusing', () => {
    const { ledger, now, advance } = holds();
    const periods: number[] = [];
    for (let refusal = 1; refusal <= 5; refusal += 1) {
      const hold = ledger.refused(PEER, 'big', META, { reason: 'store-deadline' })!;
      expect(hold.refusals).toBe(refusal);
      periods.push(hold.heldUntil - now());
      advance(hold.heldUntil - now() - 1);
      expect(ledger.current(PEER, 'big', META)).toEqual(hold);
      advance(1);
      // The hold is over: the fetch is sent again.
      expect(ledger.current(PEER, 'big', META)).toBeUndefined();
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
    ledger.refused(PEER, 'big', META, { reason: 'store-deadline' });
    advance(SYNC_PEER_GRAPH_HOLD_BASE_MS);
    ledger.refused(PEER, 'big', META, { reason: 'store-deadline' });
    ledger.served(PEER, 'big', META);
    expect(ledger.current(PEER, 'big', META)).toBeUndefined();
    const hold = ledger.refused(PEER, 'big', META, { reason: 'too-large' })!;
    expect(hold.refusals).toBe(1);
    expect(hold.heldUntil - now()).toBe(SYNC_PEER_GRAPH_HOLD_BASE_MS);
  });

  it('treats a refusal that arrives during a hold as the same refusal', () => {
    const { ledger, advance } = holds();
    const first = ledger.refused(PEER, 'big', META, { reason: 'store-deadline' })!;
    advance(1_000);
    expect(ledger.refused(PEER, 'big', META, { reason: 'store-deadline' })).toBeUndefined();
    expect(ledger.snapshot()).toEqual([first]);
  });

  it('honours the time the responder asks for, up to its own cap', () => {
    const { ledger, now } = holds();
    const longer = ledger.refused(PEER, 'a', META, { reason: 'store-deadline', retryAfterMs: 25 * 60_000 })!;
    expect(longer.heldUntil - now()).toBe(25 * 60_000);
    const shorter = ledger.refused(PEER, 'b', META, { reason: 'store-deadline', retryAfterMs: 1_000 })!;
    expect(shorter.heldUntil - now()).toBe(SYNC_PEER_GRAPH_HOLD_BASE_MS);
    const absurd = ledger.refused(PEER, 'c', META, { reason: 'store-deadline', retryAfterMs: 10 ** 11 })!;
    expect(absurd.heldUntil - now()).toBe(SYNC_PEER_GRAPH_HOLD_MAX_MS);
  });

  it('only ever lengthens a hold with jitter', () => {
    const { ledger, now } = holds(1);
    const hold = ledger.refused(PEER, 'big', META, { reason: 'store-deadline' })!;
    expect(hold.heldUntil - now()).toBe(SYNC_PEER_GRAPH_HOLD_BASE_MS * (1 + SYNC_PEER_GRAPH_HOLD_JITTER));
  });

  it('forgets a hold that was not followed by another attempt within a whole cap', () => {
    const { ledger, advance } = holds();
    ledger.refused(PEER, 'big', META, { reason: 'store-deadline' });
    advance(SYNC_PEER_GRAPH_HOLD_BASE_MS + SYNC_PEER_GRAPH_HOLD_MAX_MS);
    // Any later refusal prunes the stale record.
    ledger.refused(PEER, 'another', META, { reason: 'store-deadline' });
    expect(ledger.refused(PEER, 'big', META, { reason: 'store-deadline' })!.refusals).toBe(1);
  });

  it('stays bounded: the oldest hold is dropped once more are recorded than it keeps', () => {
    const { ledger } = holds();
    for (let index = 0; index <= 4_096; index += 1) {
      ledger.refused(PEER, `graph-${index}`, META, { reason: 'store-deadline' });
    }
    expect(ledger.snapshot()).toHaveLength(4_096);
    expect(ledger.current(PEER, 'graph-0', META)).toBeUndefined();
    expect(ledger.current(PEER, 'graph-1', META)).toBeDefined();
    expect(ledger.current(PEER, 'graph-4096', META)).toBeDefined();
  });

  it('keeps one ledger per agent object', () => {
    const agent = {};
    expect(syncPeerGraphHoldsFor(agent)).toBe(syncPeerGraphHoldsFor(agent));
    expect(syncPeerGraphHoldsFor({})).not.toBe(syncPeerGraphHoldsFor(agent));
  });

  it('describes a hold for the log without the full peer id', () => {
    const { ledger, now } = holds();
    const hold = ledger.refused(PEER, 'big', META, { reason: 'store-deadline' })!;
    expect(describeSyncPeerGraphHold(hold, now())).toBe(
      `Context graph "big" (meta) is not syncable from peer ${PEER.slice(-8)} right now `
      + '(store-deadline, 1 in a row); asking again in about 10 min',
    );
  });

  it('fails a held fetch with an error nothing reads as a peer or transport failure', () => {
    const { ledger, now } = holds();
    const hold = ledger.refused(PEER, 'big', META, { reason: 'store-deadline' })!;
    const error = new SyncPeerGraphHeldError(hold, now());
    expect(error.name).toBe('SyncPeerGraphHeldError');
    expect(error.hold).toBe(hold);
    expect(error.message).toBe(`not sent: ${describeSyncPeerGraphHold(hold, now())}`);
    // Neither a reason to back the whole peer off nor an interruption to retry.
    expect(isSyncBackoffWorthyError(error)).toBe(false);
    expect(isKnownRetryableSyncTransportInterruption(error)).toBe(false);
    expect(readSyncNotServableReply(error)).toBeNull();
  });
});

/** A failure as the transport hands it up: the peer's reply to a request that was sent. */
function replied(text: string): Error {
  return toSyncTransportFailureError(new Error(text));
}

describe('page fetch outcomes feed the holds', () => {
  const wholeGraph = { peerId: PEER, contextGraphId: 'big', scope: META };

  it('holds the graph when a whole-graph durable fetch is refused as not servable', async () => {
    const { ledger } = holds();
    const reported: SyncPeerGraphHold[] = [];
    await observeSyncPageFetch(
      ledger,
      wholeGraph,
      Promise.reject(replied(formatSyncNotServable('store-deadline', 20 * 60_000))),
      (hold) => reported.push(hold),
    );
    expect(ledger.current(PEER, 'big', META)).toBeDefined();
    expect(reported).toHaveLength(1);
    expect(reported[0]).toMatchObject({ scope: META, reason: 'store-deadline', refusals: 1 });
  });

  it('holds the graph on the plain store-deadline text of a responder without the reply', async () => {
    const { ledger } = holds();
    const onHold = vi.fn();
    await observeSyncPageFetch(
      ledger,
      wholeGraph,
      Promise.reject(replied('oxigraph-server query exceeded its store deadline after 30000ms')),
      onHold,
    );
    expect(ledger.current(PEER, 'big', META)).toBeDefined();
    expect(onHold).toHaveBeenCalledTimes(1);
  });

  it('reads the reply only from a failure that came back from the peer', async () => {
    const { ledger } = holds();
    const onHold = vi.fn();
    // The same words from this node's own store, met while building a request.
    const local = new Error('oxigraph-server query exceeded its store deadline after 30000ms');
    expect(readSyncNotServableReply(local)).toBeNull();
    expect(readSyncNotServableReply(replied(local.message))).toEqual({ reason: 'store-deadline' });
    await observeSyncPageFetch(ledger, wholeGraph, Promise.reject(local), onHold);
    expect(ledger.snapshot()).toEqual([]);
    expect(onHold).not.toHaveBeenCalled();
  });

  it('never rejects, even when reporting the hold throws', async () => {
    const { ledger } = holds();
    await expect(observeSyncPageFetch(
      ledger,
      wholeGraph,
      Promise.reject(replied(formatSyncNotServable('too-large', 1))),
      () => { throw new Error('logger failed'); },
    )).resolves.toBeUndefined();
    expect(ledger.current(PEER, 'big', META)).toBeDefined();
  });

  it('ignores other failures, and fetches that holds do not apply to', async () => {
    const { ledger } = holds();
    const onHold = vi.fn();
    await observeSyncPageFetch(ledger, wholeGraph, Promise.reject(replied('request timeout')), onHold);
    await expect(observeSyncPageFetch(
      ledger,
      { ...wholeGraph, scope: undefined },
      Promise.reject(replied(formatSyncNotServable('store-deadline', 1))),
      onHold,
    )).resolves.toBeUndefined();
    expect(ledger.snapshot()).toEqual([]);
    expect(onHold).not.toHaveBeenCalled();
  });

  it('clears the hold when that same fetch completes, and only then', async () => {
    const { ledger, advance } = holds();
    ledger.refused(PEER, 'big', META, { reason: 'store-deadline' });
    advance(SYNC_PEER_GRAPH_HOLD_BASE_MS);
    const onHold = vi.fn();
    // Another fetch of the graph completing, or this one ending incomplete,
    // says nothing about the walk that was refused.
    await observeSyncPageFetch(ledger, { ...wholeGraph, scope: 'data' }, Promise.resolve({ completed: true }), onHold);
    await observeSyncPageFetch(ledger, wholeGraph, Promise.resolve({ completed: false }), onHold);
    expect(ledger.refused(PEER, 'big', META, { reason: 'store-deadline' })!.refusals).toBe(2);
    advance(2 * SYNC_PEER_GRAPH_HOLD_BASE_MS);
    await observeSyncPageFetch(ledger, wholeGraph, Promise.resolve({ completed: true }), onHold);
    expect(ledger.refused(PEER, 'big', META, { reason: 'store-deadline' })!.refusals).toBe(1);
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

  it('still retries a failure of its own request building that carries the same words', async () => {
    const send = vi.fn(async () => new Uint8Array([2]));
    let builds = 0;
    const result = sendSyncRequest({
      remotePeerId: PEER,
      timeoutMs: 1_000,
      retryAttempts: 2,
      contextGraphId: 'big',
      offset: 0,
      requestFactory: async () => {
        builds += 1;
        if (builds === 1) throw new Error('oxigraph-server query exceeded its store deadline after 30000ms');
        return new Uint8Array([1]);
      },
      send,
      protocolId: '/dkg/10.0.2/sync',
      onRetry: vi.fn(),
      plane: 'durable',
      phase: 'meta',
    });
    await expect(result).resolves.toEqual(new Uint8Array([2]));
    expect(builds).toBe(2);
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
