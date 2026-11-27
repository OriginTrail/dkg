import { vi } from 'vitest';
import { peerIdFromString } from '@libp2p/peer-id';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { PROTOCOL_SYNC, type OperationContext } from '@origintrail-official/dkg-core';
import type { PeerSyncSession } from '../../src/sync/peer-sync-session.js';
import { DKGAgent } from '../../src/index.js';
import type { PeerCapabilityRegistry } from '../../src/p2p/peer-capability.js';
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
  peerCapabilityRegistry: PeerCapabilityRegistry;
  peerSyncSession: PeerSyncSession;
  lastSyncDisconnectedAt: Map<string, number>;
  log: { warn(ctx: OperationContext, message: string): void };
}

/**
 * The `connection:open` listeners the agent adds once its libp2p node first
 * runs. The `node.start` spy removes itself on that start, so a test can still
 * spy on `node.start` for a restart of its own.
 */
function captureAgentConnectionOpenListeners(agent: DKGAgent) {
  const captured = { transport: undefined as unknown, listeners: [] as Array<(event: CustomEvent) => void> };
  const startNode = agent.node.start.bind(agent.node);
  const start = vi.spyOn(agent.node, 'start').mockImplementation(async () => {
    start.mockRestore();
    await startNode();
    const transport = agent.node.libp2p;
    const addEventListener = transport.addEventListener.bind(transport);
    vi.spyOn(transport, 'addEventListener').mockImplementation((type, listener, options) => {
      if (type === 'connection:open' && typeof listener === 'function') {
        captured.listeners.push(listener as (event: CustomEvent) => void);
      }
      addEventListener(type, listener, options);
    });
    captured.transport = transport;
  });
  return captured;
}

export async function createPeerEventFixture() {
  const agent = await DKGAgent.create({
    name: 'PeerEventLifecycle', listenHost: '127.0.0.1', chainAdapter: new MockChainAdapter(),
  });
  const connectionOpen = captureAgentConnectionOpenListeners(agent);
  await agent.start();
  const state = agent as unknown as PeerEventState;
  const transport = agent.node.libp2p;
  const peer = peerIdFromString('12D3KooWSmU3owJvB9sFw8uApDgKrv2VBMecsGGvgAc4Gq6hB57M');
  const peerId = peer.toString();
  // peer:update events in this fixture come from a live connection.
  vi.spyOn(transport, 'getPeers').mockReturnValue([peer]);
  const session = new PeerSyncSessionTestDriver(() => state.peerSyncSession);
  return {
    agent, peer, peerId,
    get state() {
      return {
        session,
        knownCorePeerIds: state.peerCapabilityRegistry.snapshotCorePeerIds(),
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
    /**
     * Hand an open connection to the agent's own `connection:open` listeners
     * only. Dispatched on the running node, it would also reach libp2p's
     * connection manager, which keeps an open connection and closes it at stop.
     */
    openConnection(connection: object) {
      if (transport !== connectionOpen.transport || agent.node.libp2p !== transport) {
        throw new Error('openConnection serves the first node lifetime of the fixture only');
      }
      const event = new CustomEvent('connection:open', { detail: connection });
      for (const listener of connectionOpen.listeners) listener(event);
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
