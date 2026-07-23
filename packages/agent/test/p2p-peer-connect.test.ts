import { describe, it, expect } from 'vitest';
import { peerIdFromString } from '@libp2p/peer-id';
import { parseMultiaddrConnectTarget } from '../src/p2p/multiaddr-peer-target.js';
import {
  connectToMultiaddr,
  ensurePeerConnected,
  primeCatchupConnections,
} from '../src/p2p/peer-connect.js';

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

describe('ensurePeerConnected', () => {
  it('falls back to operator-configured relays when discovery has no target profile', async () => {
    const relayAddress = '/ip4/178.104.54.178/tcp/9090/p2p/12D3KooWSmU3owJvB9sFw8uApDgKrv2VBMecsGGvgAc4Gq6hB57M';
    const targetPeerId = '12D3KooWQz2bQbQueABKRSjV9koF8VYsXk5TdCsUmPf5zAEZg3q6';
    const dial = recorder(async (target: any) => {
      if (target.toString() === targetPeerId && dial.calls.length === 1) {
        throw new Error('private DHT addresses are unreachable');
      }
      return undefined;
    });
    const merge = recorder(async () => undefined);

    await ensurePeerConnected({
      getConnections: () => [],
      dial,
      peerStore: { merge },
    }, {
      findAgentByPeerId: async () => null,
    } as any, targetPeerId, [relayAddress]);

    expect(dial.calls.map(([target]) => target.toString())).toEqual([
      targetPeerId,
      relayAddress,
      targetPeerId,
    ]);
    expect(merge.calls[0]?.[1].multiaddrs.map((addr) => addr.toString())).toEqual([
      `${relayAddress}/p2p-circuit/p2p/${targetPeerId}`,
    ]);
  });

  it('continues to configured relays when agent-directory lookup throws', async () => {
    const relayAddress = '/ip4/178.104.54.178/tcp/9090/p2p/12D3KooWSmU3owJvB9sFw8uApDgKrv2VBMecsGGvgAc4Gq6hB57M';
    const targetPeerId = '12D3KooWQz2bQbQueABKRSjV9koF8VYsXk5TdCsUmPf5zAEZg3q6';
    const dial = recorder(async (target: any) => {
      if (target.toString() === targetPeerId && dial.calls.length === 1) {
        throw new Error('no known usable route');
      }
      return undefined;
    });

    await ensurePeerConnected({
      getConnections: () => [],
      dial,
      peerStore: { merge: async () => undefined },
    }, {
      findAgentByPeerId: async () => {
        throw new Error('agents store overloaded');
      },
    } as any, targetPeerId, [relayAddress]);

    expect(dial.calls.map(([target]) => target.toString())).toEqual([
      targetPeerId,
      relayAddress,
      targetPeerId,
    ]);
  });
});
