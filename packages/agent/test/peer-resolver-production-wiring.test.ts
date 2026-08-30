import { afterEach, describe, expect, it, vi } from 'vitest';
import { DKGAgent } from '../src/index.js';

const TARGET = '12D3KooWQz2bQbQueABKRSjV9koF8VYsXk5TdCsUmPf5zAEZg3q6';
const RELAY = '/ip4/178.104.54.178/tcp/9090/p2p/12D3KooWSmU3owJvB9sFw8uApDgKrv2VBMecsGGvgAc4Gq6hB57M';
const PRIVATE_TARGET = `/ip4/192.168.1.20/tcp/9090/p2p/${TARGET}`;
const CIRCUIT = `${RELAY}/p2p-circuit/p2p/${TARGET}`;

describe('production PeerResolver lifecycle wiring', () => {
  let agent: DKGAgent | undefined;

  afterEach(async () => {
    await agent?.stop().catch(() => undefined);
  });

  it('carries configured relays through peer-id resolution into the transport boundary', async () => {
    agent = await DKGAgent.create({
      name: 'ResolverWiring',
      framework: 'DKG',
      listenPort: 0,
      listenHost: '127.0.0.1',
      skills: [],
    });
    vi.spyOn(agent.node, 'getConfiguredRelayTargets').mockReturnValue([{
      peerId: RELAY.split('/').at(-1)!,
      addresses: [RELAY],
    }]);
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
      [PRIVATE_TARGET, CIRCUIT],
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });
});
