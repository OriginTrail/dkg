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
    expect(dial.calls[1]?.[0]?.toString()).toBe(multiaddress);
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
    expect(dial.calls[1]?.[0]?.toString()).toBe(
      parseMultiaddrConnectTarget(multiaddress).multiaddress,
    );
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

  it('forwards one cancellation signal to both real circuit dial stages', async () => {
    const controller = new AbortController();
    const relayPeerId = '12D3KooWSmU3owJvB9sFw8uApDgKrv2VBMecsGGvgAc4Gq6hB57M';
    const targetPeerId = '12D3KooWQz2bQbQueABKRSjV9koF8VYsXk5TdCsUmPf5zAEZg3q6';
    const circuitAddress = `/ip4/178.104.54.178/tcp/9090/p2p/${relayPeerId}/p2p-circuit/p2p/${targetPeerId}`;
    const dial = recorder(async () => undefined);

    await connectToMultiaddr({
      getConnections: () => [{ remotePeer: { toString: () => targetPeerId } }],
      dial,
      peerStore: { merge: async () => undefined },
    }, parseMultiaddrConnectTarget(circuitAddress), undefined, {
      signal: controller.signal,
    });

    expect(dial.calls).toHaveLength(2);
    const observedSignals = dial.calls.map(([, options]) => options?.signal);
    expect(observedSignals[0]).toBe(observedSignals[1]);
    expect(observedSignals[0]).not.toBe(controller.signal);
    controller.abort();
    expect(observedSignals[0]?.aborted).toBe(true);
  });

  it('aborts promptly while waiting to confirm an explicit circuit', async () => {
    const controller = new AbortController();
    const targetPeerId = '12D3KooWQz2bQbQueABKRSjV9koF8VYsXk5TdCsUmPf5zAEZg3q6';
    const circuitAddress = `/ip4/178.104.54.178/tcp/9090/p2p/12D3KooWSmU3owJvB9sFw8uApDgKrv2VBMecsGGvgAc4Gq6hB57M/p2p-circuit/p2p/${targetPeerId}`;
    const dial = recorder(async () => undefined);
    const connection = connectToMultiaddr({
      getConnections: () => [],
      dial,
      peerStore: { merge: async () => undefined },
    }, parseMultiaddrConnectTarget(circuitAddress), undefined, {
      signal: controller.signal,
    });

    while (dial.calls.length < 2) await new Promise((resolve) => setTimeout(resolve, 1));
    controller.abort();
    await expect(connection).rejects.toMatchObject({ name: 'AbortError' });
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
  it('forwards cancellation to the canonical resolver connection boundary', async () => {
    const peerId = '12D3KooWQz2bQbQueABKRSjV9koF8VYsXk5TdCsUmPf5zAEZg3q6';
    const controller = new AbortController();
    let observedSignal: AbortSignal | undefined;
    const connectStarted = Promise.withResolvers<void>();
    const connect = (_peer: string, options?: { signal?: AbortSignal }) => {
      observedSignal = options?.signal;
      connectStarted.resolve();
      return new Promise<never>((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => {
          reject(new DOMException('connect aborted', 'AbortError'));
        }, { once: true });
      });
    };

    const connection = ensurePeerConnected({ connect } as any, peerId, {
      signal: controller.signal,
    });

    await connectStarted.promise;
    controller.abort();
    await expect(connection).rejects.toMatchObject({ name: 'AbortError' });
    expect(observedSignal).toBe(controller.signal);
  });

  it('keeps non-abort recovery connection failures non-fatal', async () => {
    const peerId = '12D3KooWQz2bQbQueABKRSjV9koF8VYsXk5TdCsUmPf5zAEZg3q6';
    await expect(ensurePeerConnected({
      connect: async () => { throw new Error('unreachable'); },
    } as any, peerId)).resolves.toBeUndefined();
  });

  it('preserves a peer-store-only connection outcome with no resolved addresses', async () => {
    const peerId = '12D3KooWQz2bQbQueABKRSjV9koF8VYsXk5TdCsUmPf5zAEZg3q6';
    const outcome = { status: 'connected' as const, resolvedAddresses: [] };

    await expect(ensurePeerConnected({
      connect: async () => outcome,
    } as any, peerId)).resolves.toBe(outcome);
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
