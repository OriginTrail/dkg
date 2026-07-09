import { describe, expect, it, vi, beforeEach } from 'vitest';

const peerConnectMocks = vi.hoisted(() => ({
  connectToMultiaddr: vi.fn(async () => undefined),
  ensurePeerConnected: vi.fn(async () => undefined),
  primeCatchupConnections: vi.fn(async () => undefined),
}));

vi.mock('../src/p2p/peer-connect.js', () => peerConnectMocks);

import { AgentRegistryMethods } from '../src/dkg-agent-registry.js';

const PEER_ID = '12D3KooWQz2bQbQueABKRSjV9koF8VYsXk5TdCsUmPf5zAEZg3q6';
const DIRECT_MULTIADDR = `/ip4/127.0.0.1/tcp/9090/p2p/${PEER_ID}`;

function makeAgent(overrides: Record<string, unknown> = {}): any {
  const agent: any = {
    node: {
      peerId: '12D3KooWLocalExplicitConnectAdmissionTest11111111111',
      libp2p: {
        getConnections: vi.fn(() => []),
        dial: vi.fn(async () => undefined),
      },
    },
    peerResolver: {
      resolve: vi.fn(async () => [DIRECT_MULTIADDR]),
    },
    networkAdmissionCoordinator: {
      enabled: true,
      ensureAdmitted: vi.fn(async () => false),
    },
    log: { info: vi.fn() },
    ...overrides,
  };
  agent.assertPeerAdmittedForExplicitConnect =
    AgentRegistryMethods.prototype.assertPeerAdmittedForExplicitConnect;
  return agent;
}

describe('explicit connect network admission', () => {
  beforeEach(() => {
    peerConnectMocks.connectToMultiaddr.mockClear();
    peerConnectMocks.ensurePeerConnected.mockClear();
    peerConnectMocks.primeCatchupConnections.mockClear();
  });

  it('rejects a multiaddr connect when the target peer fails network admission', async () => {
    const agent = makeAgent();

    await expect(
      AgentRegistryMethods.prototype.connectTo.call(agent, DIRECT_MULTIADDR),
    ).rejects.toMatchObject({ code: 'NETWORK_ADMISSION_REJECTED' });

    expect(peerConnectMocks.connectToMultiaddr).toHaveBeenCalledOnce();
    expect(agent.networkAdmissionCoordinator.ensureAdmitted).toHaveBeenCalledWith(
      PEER_ID,
      expect.objectContaining({ operationName: 'connect' }),
      undefined,
    );
  });

  it('rejects network-scoped multiaddrs without a target peer id before dialing', async () => {
    const agent = makeAgent();

    await expect(
      AgentRegistryMethods.prototype.connectTo.call(agent, '/ip4/127.0.0.1/tcp/9090'),
    ).rejects.toMatchObject({ code: 'INVALID_PEER_ID' });

    expect(peerConnectMocks.connectToMultiaddr).not.toHaveBeenCalled();
  });

  it('rejects a peer-id connect when the dial succeeds but admission fails', async () => {
    const agent = makeAgent();

    await expect(
      AgentRegistryMethods.prototype.connectToPeerId.call(agent, PEER_ID, { timeoutMs: 5_000 }),
    ).rejects.toMatchObject({ code: 'NETWORK_ADMISSION_REJECTED' });

    expect(agent.peerResolver.resolve).toHaveBeenCalledWith(
      PEER_ID,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(agent.node.libp2p.dial).toHaveBeenCalledOnce();
    expect(agent.networkAdmissionCoordinator.ensureAdmitted).toHaveBeenCalledWith(
      PEER_ID,
      expect.objectContaining({ operationName: 'connect' }),
      expect.objectContaining({ signal: expect.any(AbortSignal), timeoutMs: expect.any(Number) }),
    );
  });

  it('rejects an already-connected peer-id connect when admission fails before success', async () => {
    const agent = makeAgent({
      node: {
        peerId: '12D3KooWLocalExplicitConnectAdmissionTest11111111111',
        libp2p: {
          getConnections: vi.fn(() => [{ remotePeer: { toString: () => PEER_ID } }]),
          dial: vi.fn(async () => undefined),
        },
      },
    });

    await expect(
      AgentRegistryMethods.prototype.connectToPeerId.call(agent, PEER_ID, { timeoutMs: 5_000 }),
    ).rejects.toMatchObject({ code: 'NETWORK_ADMISSION_REJECTED' });

    expect(agent.networkAdmissionCoordinator.ensureAdmitted).toHaveBeenCalledWith(
      PEER_ID,
      expect.objectContaining({ operationName: 'connect' }),
      expect.objectContaining({ signal: expect.any(AbortSignal), timeoutMs: expect.any(Number) }),
    );
    expect(agent.peerResolver.resolve).not.toHaveBeenCalled();
    expect(agent.node.libp2p.dial).not.toHaveBeenCalled();
    expect(agent.log.info).not.toHaveBeenCalledWith(
      expect.objectContaining({ operationName: 'connect' }),
      expect.stringContaining('Already connected'),
    );
  });
});
