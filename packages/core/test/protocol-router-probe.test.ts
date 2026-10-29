import { describe, expect, it, vi } from 'vitest';
import { ProtocolRouter } from '../src/protocol-router.js';
import type { Network } from '../src/network/network.js';
import { DKGNode } from '../src/node.js';
import { multiaddr } from '@multiformats/multiaddr';

const PEER_ID = '12D3KooWPvHB21rJUKQuPb7sZDCyveJmtsL3PryNN3y99n6hqRNh';
const ACK_PROTOCOL = '/dkg/10.0.1/storage-ack';

describe('ProtocolRouter.probeProtocol', () => {
  it('checks live negotiation after admission without sending request bytes', async () => {
    const abort = vi.fn();
    const send = vi.fn();
    const dialProtocol = vi.fn(async () => ({ abort, send }));
    const isPeerAccepted = vi.fn(async () => true);
    const resolve = vi.fn(async () => []);
    const router = new ProtocolRouter({
      libp2p: { dialProtocol },
      stopSignal: new AbortController().signal,
    } as unknown as ConstructorParameters<typeof ProtocolRouter>[0], {
      isPeerAccepted,
      peerResolver: { resolve } as unknown as NonNullable<ConstructorParameters<typeof ProtocolRouter>[1]>['peerResolver'],
    });

    expect(await router.probeProtocol(PEER_ID, ACK_PROTOCOL)).toBe('supported');
    expect(isPeerAccepted).toHaveBeenCalledWith(PEER_ID, ACK_PROTOCOL, 'outbound', expect.any(Object));
    expect(resolve).toHaveBeenCalledWith(PEER_ID, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(dialProtocol).toHaveBeenCalledWith(expect.any(Object), ACK_PROTOCOL, expect.any(Object));
    expect(abort).toHaveBeenCalledOnce();
    expect(send).not.toHaveBeenCalled();
  });

  it('does not negotiate with a peer rejected by network admission', async () => {
    const dialProtocol = vi.fn();
    const router = new ProtocolRouter({
      libp2p: { dialProtocol },
      stopSignal: new AbortController().signal,
    } as unknown as ConstructorParameters<typeof ProtocolRouter>[0], {
      isPeerAccepted: async () => false,
    });

    expect(await router.probeProtocol(PEER_ID, ACK_PROTOCOL)).toBe('unavailable');
    expect(dialProtocol).not.toHaveBeenCalled();
  });

  it('uses an injected Network for both probe and ordinary sends', async () => {
    const rawDial = vi.fn(() => { throw new Error('raw libp2p dial must not run'); });
    const probeAbort = vi.fn();
    const payloadSend = vi.fn();
    const streams = [
      { abort: probeAbort, send: vi.fn() },
      {
        writeStatus: 'open', send: payloadSend, close: async () => undefined, abort: vi.fn(),
        async *[Symbol.asyncIterator]() { yield new Uint8Array([7]); },
      },
    ];
    const dialProtocol = vi.fn(async () => streams.shift() as Awaited<ReturnType<Network['dialProtocol']>>);
    const network: Network = {
      localId: 'self', localAddresses: [], isStarted: true,
      dialProtocol,
      handle: async () => undefined,
      unhandle: async () => undefined,
      getConnections: () => [],
      addKnownAddresses: async () => undefined,
      start: async () => undefined,
      stop: async () => undefined,
    };
    const resolve = vi.fn(async () => []);
    const router = new ProtocolRouter({
      libp2p: { dialProtocol: rawDial, getConnections: () => [], peerStore: { get: async () => { throw new Error('NotFound'); } } },
      stopSignal: new AbortController().signal,
    } as unknown as ConstructorParameters<typeof ProtocolRouter>[0], {
      network,
      peerResolver: { resolve } as unknown as NonNullable<ConstructorParameters<typeof ProtocolRouter>[1]>['peerResolver'],
    });

    expect(await router.probeProtocol(PEER_ID, ACK_PROTOCOL)).toBe('supported');
    expect(await router.send(PEER_ID, ACK_PROTOCOL, new Uint8Array([5]))).toEqual(new Uint8Array([7]));
    expect(dialProtocol).toHaveBeenCalledTimes(2);
    expect(dialProtocol).toHaveBeenCalledWith(PEER_ID, ACK_PROTOCOL, expect.any(Object));
    expect(probeAbort).toHaveBeenCalledOnce();
    expect(payloadSend).toHaveBeenCalledWith(new Uint8Array([5]));
    expect(rawDial).not.toHaveBeenCalled();
  });

  it('distinguishes unsupported negotiation from transport failure and timeout', async () => {
    const dialProtocol = vi.fn()
      .mockRejectedValueOnce(new Error('protocol selection failed'))
      .mockRejectedValueOnce(new Error('All multiaddr dials failed'))
      .mockImplementationOnce((_peer, _protocol, options: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
        }));
    const router = new ProtocolRouter({
      libp2p: { dialProtocol },
      stopSignal: new AbortController().signal,
    } as unknown as ConstructorParameters<typeof ProtocolRouter>[0]);

    expect(await router.probeProtocol(PEER_ID, ACK_PROTOCOL)).toBe('unsupported');
    expect(await router.probeProtocol(PEER_ID, ACK_PROTOCOL)).toBe('unavailable');
    expect(await router.probeProtocol(PEER_ID, ACK_PROTOCOL, 5)).toBe('unavailable');
  });

  it.each(['node', 'caller'] as const)('propagates %s shutdown instead of treating it as unsupported', async owner => {
    const stop = new AbortController();
    const caller = new AbortController();
    const dialProtocol = vi.fn((_peer, _protocol, options: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        if (options.signal.aborted) reject(options.signal.reason);
        else options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      }));
    const router = new ProtocolRouter({
      libp2p: { dialProtocol }, stopSignal: stop.signal,
    } as unknown as ConstructorParameters<typeof ProtocolRouter>[0]);

    const probe = router.probeProtocol(PEER_ID, ACK_PROTOCOL, 3_000, caller.signal);
    await vi.waitFor(() => expect(dialProtocol).toHaveBeenCalledOnce());
    (owner === 'node' ? stop : caller).abort(new Error(`${owner} stopped`));
    await expect(probe).rejects.toThrow(`${owner} stopped`);
  });

  it('propagates caller cancellation during a live probe', async () => {
    const external = new AbortController();
    let signalReady!: () => void;
    const dialStarted = new Promise<void>((resolve) => { signalReady = resolve; });
    const dialProtocol = vi.fn((_peer, _protocol, options: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        expect(options.signal.aborted).toBe(false);
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
        signalReady();
      }));
    const router = new ProtocolRouter({
      libp2p: { dialProtocol }, stopSignal: new AbortController().signal,
    } as unknown as ConstructorParameters<typeof ProtocolRouter>[0]);
    const probe = router.probeProtocol(PEER_ID, ACK_PROTOCOL, 3_000, external.signal);
    await dialStarted;
    external.abort(new Error('caller cancelled'));
    await expect(probe).rejects.toThrow('caller cancelled');
    expect(dialProtocol).toHaveBeenCalledOnce();
  });

  describe('on an open connection (GH#3447)', () => {
    const refusal = () => Object.assign(new Error('protocol selection failed'), { name: 'UnsupportedProtocolError' });
    const connection = (limits?: object) => ({
      status: 'open',
      ...(limits ? { limits } : {}),
      remotePeer: { toString: () => PEER_ID, equals: (other: unknown) => String(other) === PEER_ID },
      newStream: vi.fn(async (): Promise<unknown> => { throw refusal(); }),
    });
    function fixture(connections: unknown[], directAddresses: readonly string[] = []) {
      const dialProtocol = vi.fn(async (): Promise<unknown> => { throw new Error('All multiaddr dials failed'); });
      const resolve = vi.fn(async () => []);
      const router = new ProtocolRouter({
        stopSignal: new AbortController().signal,
        libp2p: {
          getConnections: () => connections,
          peerStore: { get: async () => ({ addresses: directAddresses.map((address) => ({ multiaddr: { toString: () => address } })) }) },
        },
      } as unknown as ConstructorParameters<typeof ProtocolRouter>[0], {
        network: { dialProtocol } as unknown as Network,
        peerResolver: { resolve } as unknown as NonNullable<ConstructorParameters<typeof ProtocolRouter>[1]>['peerResolver'],
      });
      return { router, dialProtocol, resolve };
    }

    it('negotiates on an open connection, with no resolver call or dial', async () => {
      const direct = connection();
      const abort = vi.fn();
      direct.newStream.mockResolvedValueOnce({ abort });
      const f = fixture([direct]);

      expect(await f.router.probeProtocol(PEER_ID, ACK_PROTOCOL)).toBe('supported');
      expect(abort).toHaveBeenCalledOnce();
      expect(f.resolve).not.toHaveBeenCalled();
      expect(f.dialProtocol).not.toHaveBeenCalled();
    });

    it('ends on a refusal from an open connection, with no resolver call or dial', async () => {
      const direct = connection();
      const f = fixture([direct]);

      expect(await f.router.probeProtocol(PEER_ID, ACK_PROTOCOL)).toBe('unsupported');
      expect(direct.newStream).toHaveBeenCalledOnce();
      expect(f.resolve).not.toHaveBeenCalled();
      expect(f.dialProtocol).not.toHaveBeenCalled();
    });

    it('answers unsupported, not unavailable, for a refusal over the open circuit after a failed dial', async () => {
      const circuit = connection({});
      const f = fixture([circuit], ['/ip4/192.168.1.20/tcp/4001']);

      expect(await f.router.probeProtocol(PEER_ID, ACK_PROTOCOL)).toBe('unsupported');
      expect(f.dialProtocol).toHaveBeenCalledOnce();
      expect(circuit.newStream).toHaveBeenCalledOnce();
      expect(circuit.newStream).toHaveBeenCalledWith(ACK_PROTOCOL, expect.objectContaining({ runOnLimitedConnection: true }));
    });

    it('takes the next route after any other stream failure', async () => {
      const direct = connection();
      direct.newStream.mockRejectedValueOnce(new Error('stream reset'));
      const f = fixture([direct]);
      const abort = vi.fn();
      f.dialProtocol.mockResolvedValueOnce({ abort });

      expect(await f.router.probeProtocol(PEER_ID, ACK_PROTOCOL)).toBe('supported');
      expect(f.resolve).toHaveBeenCalledOnce();
      expect(f.dialProtocol).toHaveBeenCalledOnce();
      expect(abort).toHaveBeenCalledOnce();
    });
  });

  it('discovers a handler registered after an existing libp2p connection', async () => {
    const a = new DKGNode({ listenAddresses: ['/ip4/127.0.0.1/tcp/0'], enableMdns: false });
    const b = new DKGNode({ listenAddresses: ['/ip4/127.0.0.1/tcp/0'], enableMdns: false });
    try {
      await a.start();
      await b.start();
      await a.libp2p.dial(multiaddr(b.multiaddrs[0]));
      const requester = new ProtocolRouter(a);
      const receiver = new ProtocolRouter(b);
      expect(await requester.probeProtocol(b.peerId, ACK_PROTOCOL)).toBe('unsupported');
      const handler = vi.fn(async () => new Uint8Array([1]));
      receiver.register(ACK_PROTOCOL, handler);
      expect(await requester.probeProtocol(b.peerId, ACK_PROTOCOL)).toBe('supported');
      expect(handler).not.toHaveBeenCalled();
      // Let the remote stream-reset callback drain before closing the nodes.
      await new Promise((resolve) => setTimeout(resolve, 300));
    } finally {
      await a.stop();
      await b.stop();
    }
  }, 15_000);
});
