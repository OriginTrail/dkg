import { describe, it, expect } from 'vitest';
import { connectToMultiaddr, primeCatchupConnections } from '../src/p2p/peer-connect.js';

function recorder<A extends unknown[], R>(impl: (...args: A) => R) {
  const calls: A[] = [];
  const fn = (...args: A): R => { calls.push(args); return impl(...args); };
  return Object.assign(fn, { calls });
}

describe('connectToMultiaddr', () => {
  it('dials direct multiaddrs without circuit expansion', async () => {
    const dial = recorder(async () => undefined);
    const merge = recorder(async () => undefined);
    const connections = [{ remotePeer: { toString: () => '12D3KooWAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' } }];

    await connectToMultiaddr({
      getConnections: () => connections as any,
      dial,
      peerStore: { merge },
    }, '/ip4/127.0.0.1/tcp/9090/p2p/12D3KooWAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');

    expect(dial.calls).toHaveLength(1);
    expect(merge.calls).toEqual([]);
  });

  it('dials relay first then target peer for circuit multiaddrs', async () => {
    const dial = recorder(async () => undefined);
    const merge = recorder(async () => undefined);
    const multiaddress = '/ip4/178.104.54.178/tcp/9090/p2p/12D3KooWSmU3owJvB9sFw8uApDgKrv2VBMecsGGvgAc4Gq6hB57M/p2p-circuit/p2p/12D3KooWQz2bQbQueABKRSjV9koF8VYsXk5TdCsUmPf5zAEZg3q6';
    const connections = [{ remotePeer: { toString: () => '12D3KooWQz2bQbQueABKRSjV9koF8VYsXk5TdCsUmPf5zAEZg3q6' } }];

    await connectToMultiaddr({
      getConnections: () => connections as any,
      dial,
      peerStore: { merge },
    }, multiaddress);

    expect(dial.calls).toHaveLength(2);
    expect(merge.calls).toHaveLength(1);
  });

  it('throws when final circuit target never appears', async () => {
    const dial = recorder(async () => undefined);
    const merge = recorder(async () => undefined);
    const multiaddress = '/ip4/178.104.54.178/tcp/9090/p2p/12D3KooWSmU3owJvB9sFw8uApDgKrv2VBMecsGGvgAc4Gq6hB57M/p2p-circuit/p2p/12D3KooWQz2bQbQueABKRSjV9koF8VYsXk5TdCsUmPf5zAEZg3q6';

    await expect(connectToMultiaddr({
      getConnections: () => [],
      dial,
      peerStore: { merge },
    }, multiaddress)).rejects.toThrow('Circuit target peer 12D3KooWQz2bQbQueABKRSjV9koF8VYsXk5TdCsUmPf5zAEZg3q6 not observed before timeout');
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
      return peerId === eligiblePeer;
    });

    expect(merge.calls).toHaveLength(2);
    expect(dial.calls).toHaveLength(2);
    expect(admissionCalls).toEqual([foreignPeer, eligiblePeer]);
  });
});
