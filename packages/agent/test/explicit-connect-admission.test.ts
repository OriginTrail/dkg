import { describe, expect, it, vi, beforeEach } from 'vitest';
import { peerIdFromString } from '@libp2p/peer-id';

const peerConnectMocks = vi.hoisted(() => ({
  connectToMultiaddr: vi.fn(async () => undefined),
  ensurePeerConnected: vi.fn(async () => undefined),
  primeCatchupConnections: vi.fn(async () => undefined),
}));

vi.mock('../src/p2p/peer-connect.js', () => peerConnectMocks);

import { AgentRegistryMethods } from '../src/dkg-agent-registry.js';
import { NetworkAdmissionCoordinator } from '../src/p2p/network-admission-coordinator.js';
import { NetworkAdmissionService } from '../src/p2p/network-admission.js';

const PEER_ID = '12D3KooWQz2bQbQueABKRSjV9koF8VYsXk5TdCsUmPf5zAEZg3q6';
const PEER_ID_CID = peerIdFromString(PEER_ID).toCID().toString();
const SELF_PEER_ID = '12D3KooWDCuLesNUYHGEUY5ksEsfJGbShbZ9ep2Pu7uqCNGvgwnb';
const DIRECT_MULTIADDR = `/ip4/127.0.0.1/tcp/9090/p2p/${PEER_ID}`;
const DIRECT_MULTIADDR_CID = `/ip4/127.0.0.1/tcp/9090/p2p/${PEER_ID_CID}`;

function makeAgent(overrides: Record<string, unknown> = {}): any {
  const agent: any = {
    node: {
      peerId: SELF_PEER_ID,
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
      ensureExplicitConnectAdmitted: vi.fn(async () => false),
    },
    log: { info: vi.fn() },
    ...overrides,
  };
  agent.assertPeerAdmittedForExplicitConnect =
    AgentRegistryMethods.prototype.assertPeerAdmittedForExplicitConnect;
  return agent;
}

function admittedCoordinator(peerId: string): NetworkAdmissionCoordinator {
  const admission = new NetworkAdmissionService({
    networkId: 'network-a',
    selfPeerId: SELF_PEER_ID,
  });
  admission.markVerifiedSameNetwork(peerId);
  return new NetworkAdmissionCoordinator({
    admission,
    identity: { networkId: 'network-a' },
    selfPeerId: SELF_PEER_ID,
    sign: async () => new Uint8Array(),
    sendIdentityProbe: vi.fn(async () => {
      throw new Error('probe should not run for an already admitted peer');
    }),
    getConnections: () => [],
    deletePeerFromPeerStore: vi.fn(),
  });
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
    expect(peerConnectMocks.connectToMultiaddr).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        kind: 'direct',
        multiaddress: DIRECT_MULTIADDR,
        targetPeerId: PEER_ID,
      }),
      expect.any(Function),
    );
    expect(agent.networkAdmissionCoordinator.ensureExplicitConnectAdmitted).toHaveBeenCalledWith(
      PEER_ID,
      expect.objectContaining({ operationName: 'connect' }),
      undefined,
    );
  });

  it('rejects network-scoped multiaddrs without a target peer id before dialing', async () => {
    const agent = makeAgent({
      networkAdmissionCoordinator: admittedCoordinator(PEER_ID),
    });

    await expect(
      AgentRegistryMethods.prototype.connectTo.call(agent, '/ip4/127.0.0.1/tcp/9090'),
    ).rejects.toMatchObject({ code: 'INVALID_PEER_ID' });

    expect(peerConnectMocks.connectToMultiaddr).not.toHaveBeenCalled();
  });

  it('rejects malformed multiaddr target peer ids before dialing', async () => {
    const agent = makeAgent({
      networkAdmissionCoordinator: admittedCoordinator(PEER_ID),
    });

    await expect(
      AgentRegistryMethods.prototype.connectTo.call(agent, '/ip4/127.0.0.1/tcp/9090/p2p/not-a-peer-id'),
    ).rejects.toMatchObject({ code: 'INVALID_PEER_ID' });

    expect(peerConnectMocks.connectToMultiaddr).not.toHaveBeenCalled();
  });

  it('accepts alternate-encoded target peer ids through the admission boundary', async () => {
    const agent = makeAgent({
      networkAdmissionCoordinator: admittedCoordinator(PEER_ID),
    });

    await expect(
      AgentRegistryMethods.prototype.connectTo.call(agent, DIRECT_MULTIADDR_CID),
    ).resolves.toBeUndefined();

    expect(peerConnectMocks.connectToMultiaddr).toHaveBeenCalledOnce();
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
    expect(agent.networkAdmissionCoordinator.ensureExplicitConnectAdmitted).toHaveBeenCalledWith(
      PEER_ID,
      expect.objectContaining({ operationName: 'connect' }),
      expect.objectContaining({
        signal: expect.any(AbortSignal),
        timeoutMs: expect.any(Number),
      }),
    );
  });

  it('rejects an already-connected peer-id connect when admission fails before success', async () => {
    const agent = makeAgent({
      node: {
        peerId: SELF_PEER_ID,
        libp2p: {
          getConnections: vi.fn(() => [{ remotePeer: { toString: () => PEER_ID } }]),
          dial: vi.fn(async () => undefined),
        },
      },
    });

    await expect(
      AgentRegistryMethods.prototype.connectToPeerId.call(agent, PEER_ID, { timeoutMs: 5_000 }),
    ).rejects.toMatchObject({ code: 'NETWORK_ADMISSION_REJECTED' });

    expect(agent.networkAdmissionCoordinator.ensureExplicitConnectAdmitted).toHaveBeenCalledWith(
      PEER_ID,
      expect.objectContaining({ operationName: 'connect' }),
      expect.objectContaining({
        signal: expect.any(AbortSignal),
        timeoutMs: expect.any(Number),
      }),
    );
    expect(agent.peerResolver.resolve).not.toHaveBeenCalled();
    expect(agent.node.libp2p.dial).not.toHaveBeenCalled();
    expect(agent.log.info).not.toHaveBeenCalledWith(
      expect.objectContaining({ operationName: 'connect' }),
      expect.stringContaining('Already connected'),
    );
  });
});
