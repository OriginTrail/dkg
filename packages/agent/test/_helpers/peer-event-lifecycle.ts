import { vi } from 'vitest';
import { peerIdFromString } from '@libp2p/peer-id';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { PROTOCOL_SYNC, type OperationContext } from '@origintrail-official/dkg-core';
import type { PeerSyncSession } from '../../src/sync/peer-sync-session.js';
import { DKGAgent } from '../../src/index.js';
import { PeerSyncSessionTestDriver } from './peer-sync-session-driver.js';

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

export async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 12; index++) await Promise.resolve();
}

// Expose protected state once. All workflow spies use DKGAgent's real signatures.
interface PeerEventState {
  knownCorePeerIds: Set<string>;
  peerSyncSession: PeerSyncSession;
  lastSyncDisconnectedAt: Map<string, number>;
  log: { warn(ctx: OperationContext, message: string): void };
}

export async function createPeerEventFixture() {
  const agent = await DKGAgent.create({
    name: 'PeerEventLifecycle', listenHost: '127.0.0.1', chainAdapter: new MockChainAdapter(),
  });
  await agent.start();
  const state = agent as unknown as PeerEventState;
  const transport = agent.node.libp2p;
  const peer = peerIdFromString('12D3KooWSmU3owJvB9sFw8uApDgKrv2VBMecsGGvgAc4Gq6hB57M');
  const peerId = peer.toString();
  const session = new PeerSyncSessionTestDriver(() => state.peerSyncSession);
  return {
    agent, peer, peerId,
    get state() {
      return {
        session,
        knownCorePeerIds: state.knownCorePeerIds,
        disconnectTimestamp: (id: string) => state.lastSyncDisconnectedAt.get(id),
        log: state.log,
      };
    },
    dispatchUpdate(protocols: readonly string[] = [PROTOCOL_SYNC]) {
      transport.dispatchEvent(new CustomEvent('peer:update', { detail: { peer: { id: peer, protocols } } }));
    },
    dispatchOpen() {
      transport.dispatchEvent(new CustomEvent('connection:open', {
        detail: { remotePeer: peer, direction: 'inbound' },
      }));
    },
    dispatchClose() {
      transport.dispatchEvent(new CustomEvent('connection:close', {
        detail: {
          remotePeer: peer,
          remoteAddr: { toString: () => '/ip4/127.0.0.1/tcp/1234' },
          timeline: { open: 0, close: 1 },
        },
      }));
    },
    async close() {
      vi.restoreAllMocks();
      await agent.stop();
    },
  };
}
