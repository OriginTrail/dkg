// SPDX-License-Identifier: Apache-2.0

import {
  type OperationContext,
  type PeerResolver,
} from '@origintrail-official/dkg-core';
import { verifiedCuratorDialAddress } from './curator-dial-address.js';

interface CuratorPeerConnectionAgent {
  readonly node: { libp2p: { getConnections(): Array<{ remotePeer: { toString(): string } }> } };
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
  throwIfAborted(signal);
  if (agent.node.libp2p.getConnections().some((connection) => (
    connection.remotePeer.toString() === curatorPeerId
  ))) return true;
  return connectCurator(agent, curatorPeerId, signal, ctx, throwIfAborted, addressHint);
}

async function connectCurator(
  agent: CuratorPeerConnectionAgent,
  curatorPeerId: string,
  signal: AbortSignal | undefined,
  ctx: OperationContext,
  throwIfAborted: (signal: AbortSignal | undefined) => void,
  addressHint?: string,
): Promise<boolean> {
  const verifiedAddress = verifiedCuratorDialAddress(addressHint, curatorPeerId);
  try {
    const outcome = await agent.peerResolver.connect(curatorPeerId, {
      signal,
      recovery: {
        verifiedInitialAddress: verifiedAddress,
        initialTimeoutMs: 5_000,
        cachedTimeoutMs: 5_000,
        resolverTimeoutMs: 15_000,
      },
      perStepTimeoutMs: 5_000,
      candidateTimeoutMs: 5_000,
    });
    throwIfAborted(signal);
    return outcome.status === 'connected';
  } catch (error) {
    throwIfAborted(signal);
    agent.log.warn(
      ctx,
      `Failed to dial curator ${curatorPeerId.slice(-8)} for meta refresh: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}
