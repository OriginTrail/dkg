/**
 * #2812: a settled send() or probeProtocol() must leave nothing attached to
 * the long-lived signals it was given (node.stopSignal and the caller's
 * signal), while its own signals keep their deadline timing.
 *
 * Node's `AbortSignal.any` records every composite as a dependant of each
 * source signal, and keeps a composite with an `AbortSignal.timeout` input
 * alive until an abort listener is added and removed or every source is
 * collected. Built per send against node.stopSignal, those composites piled
 * up for the life of the process, and Node's cleanup walked the whole
 * dependant set for each one it collected, on the main thread.
 */

import { getEventListeners } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProtocolRouter } from '../src/protocol-router.js';
import type { DKGNode } from '../src/node.js';
import type { PeerResolver } from '../src/network/peer-resolver.js';

const FAKE_PEER_ID = '12D3KooWBzj7Hg2cKCdsKL6QcjC5UbLztKTvzCZQHaT4P4ZyJEAA';
const PROTOCOL = '/dkg/test/1.0.0';

/**
 * Size of Node's internal dependant set on `signal` (what `AbortSignal.any`
 * adds to). 0 when the signal never had dependants, and also if a future Node
 * renames the internal symbol; the listener assertions below do not depend on
 * internals.
 */
function dependantCount(signal: AbortSignal): number {
  const symbol = Object.getOwnPropertySymbols(signal).find((s) => s.description === 'kDependantSignals');
  const set = symbol ? (signal as unknown as Record<symbol, Set<unknown> | undefined>)[symbol] : undefined;
  return set?.size ?? 0;
}

function attachedTo(signal: AbortSignal): { listeners: number; dependants: number } {
  return { listeners: getEventListeners(signal, 'abort').length, dependants: dependantCount(signal) };
}

function respondingStream(response = new Uint8Array([0xab])) {
  return {
    writeStatus: 'open' as const,
    send: () => undefined,
    close: async () => undefined,
    abort: () => undefined,
    async *[Symbol.asyncIterator]() {
      yield response;
    },
  };
}

function makeNode(stopSignal: AbortSignal, dialProtocol: (peer: unknown, protocol: string, opts?: { signal?: AbortSignal }) => Promise<unknown>): DKGNode {
  return {
    get stopSignal() {
      return stopSignal;
    },
    libp2p: {
      getConnections: () => [],
      dialProtocol,
      handle: () => undefined,
      unhandle: () => undefined,
      peerStore: { get: async () => { throw new Error('NotFound'); } },
    },
  } as unknown as DKGNode;
}

const peerResolver = { resolve: async () => [] } as unknown as PeerResolver;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ProtocolRouter releases per-send abort signals (#2812)', () => {
  it('leaves nothing on node.stopSignal or the caller signal after successful sends', async () => {
    const stop = new AbortController();
    const caller = new AbortController();
    const router = new ProtocolRouter(makeNode(stop.signal, async () => respondingStream()), { peerResolver });

    for (let i = 0; i < 40; i++) {
      const response = await router.send(FAKE_PEER_ID, PROTOCOL, new Uint8Array([i]), {
        timeoutMs: 60_000,
        signal: caller.signal,
      });
      expect(response).toEqual(new Uint8Array([0xab]));
    }

    expect(attachedTo(stop.signal)).toEqual({ listeners: 0, dependants: 0 });
    expect(attachedTo(caller.signal)).toEqual({ listeners: 0, dependants: 0 });
  });

  it('leaves nothing attached after a send that retried through the backoff', async () => {
    const stop = new AbortController();
    let dials = 0;
    const router = new ProtocolRouter(makeNode(stop.signal, async () => {
      dials += 1;
      if (dials === 1) throw new Error('stream reset');
      return respondingStream();
    }), { peerResolver });

    const response = await router.send(FAKE_PEER_ID, PROTOCOL, new Uint8Array([1]), 60_000);

    expect(response).toEqual(new Uint8Array([0xab]));
    expect(dials).toBe(2);
    expect(attachedTo(stop.signal)).toEqual({ listeners: 0, dependants: 0 });
  });

  it('still times out with a TimeoutError, then leaves nothing attached', async () => {
    const stop = new AbortController();
    const router = new ProtocolRouter(makeNode(stop.signal, (_peer, _protocol, opts) => new Promise((_resolve, reject) => {
      const signal = opts?.signal;
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    })), { peerResolver });

    await expect(router.send(FAKE_PEER_ID, PROTOCOL, new Uint8Array([1]), 50)).rejects.toMatchObject({
      name: 'TimeoutError',
    });
    expect(attachedTo(stop.signal)).toEqual({ listeners: 0, dependants: 0 });
  });

  it('still aborts an in-flight send when the node stops', async () => {
    const stop = new AbortController();
    let dialed: () => void = () => {};
    const dialStarted = new Promise<void>((resolve) => {
      dialed = resolve;
    });
    const router = new ProtocolRouter(makeNode(stop.signal, (_peer, _protocol, opts) => new Promise((_resolve, reject) => {
      dialed();
      opts?.signal?.addEventListener('abort', () => reject(opts.signal?.reason), { once: true });
    })), { peerResolver });

    const sending = router.send(FAKE_PEER_ID, PROTOCOL, new Uint8Array([1]), 60_000);
    await dialStarted;
    stop.abort(new Error('node stopping'));

    await expect(sending).rejects.toThrow('node stopping');
  });

  it('still stops a multi-path loser at the deadline, not when the send settles', async () => {
    const stop = new AbortController();
    let loserSignal: AbortSignal | undefined;
    const remotePeer = { equals: (other: unknown) => String(other) === FAKE_PEER_ID, toString: () => FAKE_PEER_ID };
    const hungLoser = {
      status: 'open' as const,
      remotePeer,
      // Never finishes negotiating on its own; only its signal ends it.
      newStream: (_protocol: string, options?: { signal?: AbortSignal }) => new Promise((_resolve, reject) => {
        loserSignal = options?.signal;
        options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true });
      }),
    };
    const winner = { status: 'open' as const, remotePeer, newStream: async () => respondingStream() };
    const node = makeNode(stop.signal, async () => {
      throw new Error('dialProtocol should not be reached when multi-path wins');
    });
    (node.libp2p as unknown as { getConnections: () => unknown[] }).getConnections = () => [hungLoser, winner];
    const router = new ProtocolRouter(node, { peerResolver });

    const response = await router.send(FAKE_PEER_ID, PROTOCOL, new Uint8Array([1]), { timeoutMs: 150, parallelPaths: 2 });

    expect(response).toEqual(new Uint8Array([0xab]));
    expect(attachedTo(stop.signal)).toEqual({ listeners: 0, dependants: 0 });
    // Settling detaches the send from node.stopSignal, but its own signals
    // keep their timing: the loser is still bound to the send's deadline.
    expect(loserSignal?.aborted).toBe(false);
    await vi.waitFor(() => expect(loserSignal?.aborted).toBe(true), { timeout: 2_000, interval: 20 });
    expect((loserSignal?.reason as Error | undefined)?.name).toBe('TimeoutError');
  });

  it('leaves nothing on node.stopSignal after a protocol probe', async () => {
    const stop = new AbortController();
    const router = new ProtocolRouter(makeNode(stop.signal, async () => respondingStream()), { peerResolver });

    await expect(router.probeProtocol(FAKE_PEER_ID, PROTOCOL, 60_000)).resolves.toBe('supported');
    expect(attachedTo(stop.signal)).toEqual({ listeners: 0, dependants: 0 });
  });
});
