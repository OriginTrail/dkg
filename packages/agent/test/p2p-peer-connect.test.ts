import { describe, it, expect, vi } from 'vitest';
import { connectToMultiaddr } from '../src/p2p/peer-connect.js';

describe('connectToMultiaddr', () => {
  it('dials direct multiaddrs without circuit expansion', async () => {
    const dial = vi.fn(async () => undefined);
    const merge = vi.fn(async () => undefined);

    await connectToMultiaddr({
      getConnections: () => [],
      dial,
      peerStore: { merge },
    }, '/ip4/127.0.0.1/tcp/9090/p2p/12D3KooWAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');

    expect(dial).toHaveBeenCalledTimes(1);
    expect(merge).not.toHaveBeenCalled();
  });

  it('dials relay first then target peer for circuit multiaddrs', async () => {
    const dial = vi.fn(async () => undefined);
    const merge = vi.fn(async () => undefined);
    const multiaddress = '/ip4/178.104.54.178/tcp/9090/p2p/12D3KooWSmU3owJvB9sFw8uApDgKrv2VBMecsGGvgAc4Gq6hB57M/p2p-circuit/p2p/12D3KooWQz2bQbQueABKRSjV9koF8VYsXk5TdCsUmPf5zAEZg3q6';

    await connectToMultiaddr({
      getConnections: () => [],
      dial,
      peerStore: { merge },
    }, multiaddress);

    expect(dial).toHaveBeenCalledTimes(2);
    expect(merge).toHaveBeenCalledTimes(1);
  });
});
