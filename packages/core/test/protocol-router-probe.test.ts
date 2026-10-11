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

  it('propagates node shutdown instead of treating it as unsupported', async () => {
    const stop = new AbortController();
    const dialProtocol = vi.fn((_peer, _protocol, options: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        if (options.signal.aborted) reject(options.signal.reason);
        else options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      }));
    const router = new ProtocolRouter({
      libp2p: { dialProtocol }, stopSignal: stop.signal,
    } as unknown as ConstructorParameters<typeof ProtocolRouter>[0]);

    const probe = router.probeProtocol(PEER_ID, ACK_PROTOCOL);
    stop.abort(new Error('node stopped'));
    await expect(probe).rejects.toThrow(/node stopped/);
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
