import { afterEach, describe, expect, it, vi } from 'vitest';
import { DKGAgent } from '../src/index.js';

const TARGET = '12D3KooWQz2bQbQueABKRSjV9koF8VYsXk5TdCsUmPf5zAEZg3q6';
const PRIVATE_TARGET = `/ip4/192.168.1.20/tcp/9090/p2p/${TARGET}`;

describe('production PeerResolver lifecycle wiring', () => {
  let agent: DKGAgent | undefined;

  afterEach(async () => {
    await agent?.stop().catch(() => undefined);
  });

  it('passes resolver output unchanged into the transport-owned connection policy', async () => {
    agent = await DKGAgent.create({
      name: 'ResolverWiring',
      framework: 'DKG',
      listenPort: 0,
      listenHost: '127.0.0.1',
      skills: [],
    });
    await agent.start();

    // Exercise the real DKGAgent lifecycle-created resolver and the public
    // peer-id connection path; only the transport boundary is replaced so
    // this does not depend on an external relay in CI.
    const resolver = (agent as any).peerResolver;
    const transport = resolver.network;
    vi.spyOn(transport, 'findPeer').mockResolvedValue([PRIVATE_TARGET]);
    vi.spyOn(transport, 'addKnownAddresses').mockResolvedValue(undefined);
    const connectPeer = vi.spyOn(transport, 'connectPeer').mockResolvedValue(undefined);
    vi.spyOn(
      (agent as any).networkAdmissionCoordinator,
      'ensureExplicitConnectAdmitted',
    ).mockResolvedValue(true);

    await agent.connectToPeerId(TARGET, { timeoutMs: 5_000 });

    expect(connectPeer).toHaveBeenCalledOnce();
    expect(connectPeer).toHaveBeenCalledWith(
      TARGET,
      [PRIVATE_TARGET],
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });
});
