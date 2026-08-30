import { describe, it, expect } from 'vitest';
import { peerIdFromString } from '@libp2p/peer-id';
import { parseMultiaddrConnectTarget } from '../src/p2p/multiaddr-peer-target.js';
import {
  connectToMultiaddr,
  ensurePeerConnected,
  primeCatchupConnections,
} from '../src/p2p/peer-connect.js';
import { waitForPeerProtocol } from '../src/p2p/protocol-readiness.js';

function recorder<A extends unknown[], R>(impl: (...args: A) => R) {
  const calls: A[] = [];
  const fn = (...args: A): R => { calls.push(args); return impl(...args); };
  return Object.assign(fn, { calls });
}

describe('connectToMultiaddr', () => {
  it('dials direct multiaddrs without circuit expansion', async () => {
    const dial = recorder(async () => undefined);
    const merge = recorder(async () => undefined);
    const peerId = '12D3KooWQz2bQbQueABKRSjV9koF8VYsXk5TdCsUmPf5zAEZg3q6';
    const connections = [{ remotePeer: { toString: () => peerId } }];

    await connectToMultiaddr({
      getConnections: () => connections as any,
      dial,
      peerStore: { merge },
    }, parseMultiaddrConnectTarget(`/ip4/127.0.0.1/tcp/9090/p2p/${peerId}`));

    expect(dial.calls).toHaveLength(1);
    expect(merge.calls).toEqual([]);
  });

  it('confirms direct CID-form target peer ids against canonical connections', async () => {
    const dial = recorder(async () => undefined);
    const merge = recorder(async () => undefined);
    const peerId = '12D3KooWQz2bQbQueABKRSjV9koF8VYsXk5TdCsUmPf5zAEZg3q6';
    const cidPeerId = peerIdFromString(peerId).toCID().toString();
    const connections = [{ remotePeer: { toString: () => peerId } }];

    await connectToMultiaddr({
      getConnections: () => connections as any,
      dial,
      peerStore: { merge },
    }, parseMultiaddrConnectTarget(`/ip4/127.0.0.1/tcp/9090/p2p/${cidPeerId}`));

    expect(dial.calls).toHaveLength(1);
    expect(merge.calls).toEqual([]);
  });

  it('dials relay first then target peer for circuit multiaddrs', async () => {
    const dial = recorder(async () => undefined);
    const merge = recorder(async () => undefined);
    const relayAddress = '/ip4/178.104.54.178/tcp/9090/p2p/12D3KooWSmU3owJvB9sFw8uApDgKrv2VBMecsGGvgAc4Gq6hB57M';
    const targetPeerId = '12D3KooWQz2bQbQueABKRSjV9koF8VYsXk5TdCsUmPf5zAEZg3q6';
    const multiaddress = `${relayAddress}/p2p-circuit/p2p/${targetPeerId}`;
    const connections = [{ remotePeer: { toString: () => targetPeerId } }];

    await connectToMultiaddr({
      getConnections: () => connections as any,
      dial,
      peerStore: { merge },
    }, parseMultiaddrConnectTarget(multiaddress));

    expect(dial.calls).toHaveLength(2);
    expect(dial.calls[0]?.[0]?.toString()).toBe(relayAddress);
    expect(dial.calls[1]?.[0]?.toString()).toBe(targetPeerId);
    expect(merge.calls).toHaveLength(1);
    expect(merge.calls[0]?.[0]?.toString()).toBe(targetPeerId);
    expect(merge.calls[0]?.[1].multiaddrs.map((addr) => addr.toString())).toEqual([multiaddress]);
  });

  it('confirms circuit CID-form target peer ids against canonical connections', async () => {
    const dial = recorder(async () => undefined);
    const merge = recorder(async () => undefined);
    const relayPeerId = '12D3KooWSmU3owJvB9sFw8uApDgKrv2VBMecsGGvgAc4Gq6hB57M';
    const targetPeerId = '12D3KooWQz2bQbQueABKRSjV9koF8VYsXk5TdCsUmPf5zAEZg3q6';
    const targetPeerIdCid = peerIdFromString(targetPeerId).toCID().toString();
    const multiaddress = `/ip4/178.104.54.178/tcp/9090/p2p/${relayPeerId}/p2p-circuit/p2p/${targetPeerIdCid}`;
    const connections = [{ remotePeer: { toString: () => targetPeerId } }];

    await connectToMultiaddr({
      getConnections: () => connections as any,
      dial,
      peerStore: { merge },
    }, parseMultiaddrConnectTarget(multiaddress));

    expect(dial.calls).toHaveLength(2);
    expect(dial.calls[0]?.[0]?.toString()).toBe(`/ip4/178.104.54.178/tcp/9090/p2p/${relayPeerId}`);
    expect(dial.calls[1]?.[0]?.toString()).toBe(targetPeerId);
    expect(merge.calls).toHaveLength(1);
    expect(merge.calls[0]?.[0]?.toString()).toBe(targetPeerId);
    expect(merge.calls[0]?.[1].multiaddrs.map((addr) => addr.toString())).toEqual([multiaddress]);
  });

  it('throws when final circuit target never appears', async () => {
    const dial = recorder(async () => undefined);
    const merge = recorder(async () => undefined);
    const multiaddress = '/ip4/178.104.54.178/tcp/9090/p2p/12D3KooWSmU3owJvB9sFw8uApDgKrv2VBMecsGGvgAc4Gq6hB57M/p2p-circuit/p2p/12D3KooWQz2bQbQueABKRSjV9koF8VYsXk5TdCsUmPf5zAEZg3q6';

    await expect(connectToMultiaddr({
      getConnections: () => [],
      dial,
      peerStore: { merge },
    }, parseMultiaddrConnectTarget(multiaddress))).rejects.toThrow('Circuit target peer 12D3KooWQz2bQbQueABKRSjV9koF8VYsXk5TdCsUmPf5zAEZg3q6 not observed before timeout');
  });
});

describe('primeCatchupConnections', () => {
  it('dials discovered peers before running the caller admission proof', async () => {
    const dial = recorder(async () => undefined);
    const merge = recorder(async () => undefined);
    const relayAddress = '/ip4/178.104.54.178/tcp/9090/p2p/12D3KooWSmU3owJvB9sFw8uApDgKrv2VBMecsGGvgAc4Gq6hB57M';
    const eligiblePeer = '12D3KooWQz2bQbQueABKRSjV9koF8VYsXk5TdCsUmPf5zAEZg3q6';
    const foreignPeer = '12D3KooWR5C8ajtPigVGnBwDGTZ4XAtCepRs2WCgfPuBPrgGqcNK';
    const admissionCalls: string[] = [];

    await primeCatchupConnections({
      getConnections: () => [],
      dial,
      peerStore: { merge },
    }, {
      findAgents: async () => [
        { peerId: foreignPeer, relayAddress },
        { peerId: eligiblePeer, relayAddress },
      ],
    } as any, 'self-peer', async (peerId) => {
      admissionCalls.push(peerId);
    });

    expect(merge.calls).toHaveLength(2);
    expect(dial.calls).toHaveLength(2);
    expect(admissionCalls).toEqual([foreignPeer, eligiblePeer]);
  });
});

describe('abortable recovery connection helpers', () => {
  it('forwards cancellation to the real direct-dial path', async () => {
    const peerId = '12D3KooWQz2bQbQueABKRSjV9koF8VYsXk5TdCsUmPf5zAEZg3q6';
    const controller = new AbortController();
    let observedSignal: AbortSignal | undefined;
    const dialStarted = Promise.withResolvers<void>();
    const dial = (_peer: unknown, options?: { signal?: AbortSignal }) => {
      observedSignal = options?.signal;
      dialStarted.resolve();
      return new Promise<never>((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => {
          reject(new DOMException('dial aborted', 'AbortError'));
        }, { once: true });
      });
    };
    let discoveryCalled = false;

    const connection = ensurePeerConnected({
      getConnections: () => [],
      dial,
      peerStore: { merge: async () => undefined },
    }, {
      findAgentByPeerId: async () => {
        discoveryCalled = true;
        return undefined;
      },
    } as any, peerId, { signal: controller.signal });

    await dialStarted.promise;
    controller.abort();
    await expect(connection).rejects.toMatchObject({ name: 'AbortError' });
    expect(observedSignal).toBe(controller.signal);
    expect(discoveryCalled).toBe(false);
  });

  it('forwards cancellation through discovery after direct dial fails', async () => {
    const peerId = '12D3KooWQz2bQbQueABKRSjV9koF8VYsXk5TdCsUmPf5zAEZg3q6';
    const controller = new AbortController();
    const discoveryStarted = Promise.withResolvers<void>();
    let observedSignal: AbortSignal | undefined;

    const connection = ensurePeerConnected({
      getConnections: () => [],
      dial: async () => { throw new Error('direct dial failed'); },
      peerStore: { merge: async () => undefined },
    }, {
      findAgentByPeerId: async (_peerId: string, options?: { signal?: AbortSignal }) => {
        observedSignal = options?.signal;
        discoveryStarted.resolve();
        return new Promise<never>((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => {
            reject(new DOMException('discovery aborted', 'AbortError'));
          }, { once: true });
        });
      },
    } as any, peerId, { signal: controller.signal });

    await discoveryStarted.promise;
    controller.abort();
    await expect(connection).rejects.toMatchObject({ name: 'AbortError' });
    expect(observedSignal).toBe(controller.signal);
  });

  it('forwards cancellation to the relay fallback dial', async () => {
    const peerId = '12D3KooWQz2bQbQueABKRSjV9koF8VYsXk5TdCsUmPf5zAEZg3q6';
    const relayAddress = '/ip4/178.104.54.178/tcp/9090/p2p/12D3KooWSmU3owJvB9sFw8uApDgKrv2VBMecsGGvgAc4Gq6hB57M';
    const dialSignals: Array<AbortSignal | undefined> = [];
    const merge = recorder(async () => undefined);
    let dialAttempt = 0;
    const dial = async (_peer: unknown, options?: { signal?: AbortSignal }) => {
      dialSignals.push(options?.signal);
      dialAttempt += 1;
      if (dialAttempt === 1) throw new Error('direct dial failed');
    };

    const controller = new AbortController();
    await ensurePeerConnected({
      getConnections: () => [],
      dial,
      peerStore: { merge },
    }, {
      findAgentByPeerId: async () => ({ peerId, relayAddress }),
    } as any, peerId, { signal: controller.signal });

    expect(dialSignals).toEqual([controller.signal, controller.signal]);
    expect(merge.calls).toHaveLength(1);
  });

  it('walks resolver-provided relay circuits without another directory lookup', async () => {
    const peerId = '12D3KooWQz2bQbQueABKRSjV9koF8VYsXk5TdCsUmPf5zAEZg3q6';
    const relayAddress = '/ip4/178.104.54.178/tcp/9090/p2p/12D3KooWSmU3owJvB9sFw8uApDgKrv2VBMecsGGvgAc4Gq6hB57M';
    const circuitAddress = `${relayAddress}/p2p-circuit/p2p/${peerId}`;
    const dial = recorder(async (target: any) => {
      if (dial.calls.length === 1) throw new Error('stale peerStore route');
      return undefined;
    });
    let discoveryCalled = false;

    await ensurePeerConnected({
      getConnections: () => dial.calls.length >= 3
        ? [{ remotePeer: { toString: () => peerId } }]
        : [],
      dial,
      peerStore: { merge: async () => undefined },
    }, {
      findAgentByPeerId: async () => {
        discoveryCalled = true;
        return undefined;
      },
    } as any, peerId, { resolvedAddresses: [circuitAddress] });

    expect(dial.calls.map(([target]) => target.toString())).toEqual([
      peerId,
      relayAddress,
      peerId,
    ]);
    expect(discoveryCalled).toBe(false);
  });

  it('interrupts the real protocol-readiness delay', async () => {
    const controller = new AbortController();
    let reads = 0;
    const readiness = waitForPeerProtocol(
      {
        get: async () => {
          reads += 1;
          return { protocols: [] };
        },
      },
      { toString: () => 'peer-under-test' },
      '/dkg/test/sync',
      3,
      10_000,
      controller.signal,
    );

    await Promise.resolve();
    controller.abort();
    await expect(readiness).rejects.toMatchObject({ name: 'AbortError' });
    expect(reads).toBe(1);
  });
});
