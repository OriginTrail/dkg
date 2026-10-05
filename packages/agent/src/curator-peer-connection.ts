// SPDX-License-Identifier: Apache-2.0

import { multiaddr } from '@multiformats/multiaddr';
import type { OperationContext, PeerResolver } from '@origintrail-official/dkg-core';
import { verifiedCuratorDialAddress } from './curator-dial-address.js';

interface CuratorPeerConnectionAgent {
  readonly node: {
    libp2p: {
      getConnections(): Array<{ remotePeer: { toString(): string } }>;
      dial(target: unknown, options?: { signal?: AbortSignal }): Promise<unknown>;
      peerStore: { merge(target: unknown, data: { multiaddrs: unknown[] }): Promise<unknown> };
    };
  };
  readonly peerResolver: Pick<PeerResolver, 'connect'>;
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
        const verifiedAddress = verifiedCuratorDialAddress(addressHint, curatorPeerId);
        if (verifiedAddress) {
          await agent.node.libp2p.peerStore.merge(peerId, {
            multiaddrs: [multiaddr(verifiedAddress)],
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
      // A regular dial may not have a usable direct address; resolution is next.
    }

    if (!isConnected) {
      // The shared resolver owns DHT, directory, and relay fallbacks. Its
      // status is only a transport hint; verify the connected peer below.
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
