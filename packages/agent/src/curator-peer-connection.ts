// SPDX-License-Identifier: Apache-2.0

import { multiaddr } from '@multiformats/multiaddr';
import type { OperationContext } from '@origintrail-official/dkg-core';

interface CuratorPeerConnectionAgent {
  readonly node: {
    libp2p: {
      getConnections(): Array<{ remotePeer: { toString(): string } }>;
      dial(target: unknown, options?: { signal?: AbortSignal }): Promise<unknown>;
      peerStore: { merge(target: unknown, data: { multiaddrs: unknown[] }): Promise<unknown> };
    };
  };
  readonly discovery: {
    findAgentByPeerId(peerId: string): Promise<{ relayAddress?: string } | undefined>;
  };
  readonly peerResolver?: {
    connect(peerId: string, options: {
      signal?: AbortSignal;
      perStepTimeoutMs?: number;
      candidateTimeoutMs?: number;
    }): Promise<{ status: 'connected' | 'unresolved' }>;
  };
  readonly log: { warn(ctx: OperationContext, message: string): void };
}

export function ensureCuratorConnected(
  agent: CuratorPeerConnectionAgent,
  curatorPeerId: string,
  signal: AbortSignal | undefined,
  ctx: OperationContext,
  throwIfAborted: (signal: AbortSignal | undefined) => void,
  addressHint?: string,
): boolean | Promise<boolean> {
  const connections = agent.node.libp2p.getConnections();
  const isConnected = connections.some((connection) => (
    connection.remotePeer.toString() === curatorPeerId
  ));
  if (isConnected) return true;

  return dialCurator(agent, curatorPeerId, signal, ctx, throwIfAborted, addressHint);
}

async function dialCurator(
  agent: CuratorPeerConnectionAgent,
  curatorPeerId: string,
  signal: AbortSignal | undefined,
  ctx: OperationContext,
  throwIfAborted: (signal: AbortSignal | undefined) => void,
  addressHint?: string,
): Promise<boolean> {
  let connections: Array<{ remotePeer: { toString(): string } }> = [];
  let isConnected = false;

  try {
    const { peerIdFromString } = await import('@libp2p/peer-id');
    const peerId = peerIdFromString(curatorPeerId);
    if (addressHint) {
      try {
        const rememberedAddress = multiaddr(addressHint);
        if (rememberedAddress.toString().split('/p2p/').at(-1) === curatorPeerId) {
          await agent.node.libp2p.peerStore.merge(peerId, {
            multiaddrs: [rememberedAddress],
          });
        }
      } catch {
        // An obsolete or malformed local hint cannot prevent normal discovery.
      }
    }
    try {
      await agent.node.libp2p.dial(peerId, { signal });
      throwIfAborted(signal);
      connections = agent.node.libp2p.getConnections();
      isConnected = connections.some((connection) => (
        connection.remotePeer.toString() === curatorPeerId
      ));
    } catch {
      // A regular dial may not have a usable direct address; relay is next.
    }

    if (!isConnected) {
      throwIfAborted(signal);
      const discoveredAgent = await agent.discovery.findAgentByPeerId(curatorPeerId);
      throwIfAborted(signal);
      if (discoveredAgent?.relayAddress) {
        const circuitAddress = multiaddr(
          `${discoveredAgent.relayAddress}/p2p-circuit/p2p/${curatorPeerId}`,
        );
        await agent.node.libp2p.peerStore.merge(peerId, { multiaddrs: [circuitAddress] });
        await agent.node.libp2p.dial(peerId, { signal });
        throwIfAborted(signal);
        connections = agent.node.libp2p.getConnections();
        isConnected = connections.some((connection) => (
          connection.remotePeer.toString() === curatorPeerId
        ));
      }
    }

    if (!isConnected && agent.peerResolver) {
      // A restarted member may retain the curator's authenticated peer ID
      // but lose its in-memory peer-store addresses. The shared resolver can
      // recover a direct address through DHT or the agent directory. Its
      // result is only a transport hint: the libp2p peer ID and the fetched
      // curator metadata are still verified independently below.
      const timeout = AbortSignal.timeout(15_000);
      const dialSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
      await agent.peerResolver.connect(curatorPeerId, {
        signal: dialSignal,
        perStepTimeoutMs: 5_000,
        candidateTimeoutMs: 5_000,
      });
      throwIfAborted(signal);
      connections = agent.node.libp2p.getConnections();
      isConnected = connections.some((connection) => (
        connection.remotePeer.toString() === curatorPeerId
      ));
    }
  } catch (error) {
    throwIfAborted(signal);
    agent.log.warn(
      ctx,
      `Failed to dial curator ${curatorPeerId.slice(-8)} for meta refresh: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return isConnected;
}
