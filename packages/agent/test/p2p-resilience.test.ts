import { describe, it, expect, vi } from 'vitest';
import { DKGAgent } from '../src/index.js';
import { DKGEvent } from '@origintrail-official/dkg-core';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';

/**
 * A rotating bank of well-formed libp2p peer id strings (taken from the
 * testnet relay set). Tests use these purely for their syntactic validity;
 * no actual dial ever completes because we either stub libp2p.dial or the
 * test closes the agent before any network I/O resolves. Using real-looking
 * strings ensures `peerIdFromString` succeeds, so the dial-attempt branch
 * of `maybeDialGossipSender` is exercised rather than the error branch.
 */
const SYNTHETIC_PEER_IDS = [
  '12D3KooWSmU3owJvB9sFw8uApDgKrv2VBMecsGGvgAc4Gq6hB57M',
  '12D3KooWAbLiM6Xy2TfXtFpUrXqttnTSuctW8Lo1mkauaijsNrWw',
  '12D3KooWPyTpqBBtU1AvzSsd5rWXCQzFcGtG44qDmeYenWcpzsge',
  '12D3KooWJqhnnfouiNRUyJBEREpuKtV4A448LUbS6JiVCe8Q82bZ',
  '12D3KooWCV9mkCJkKkyNLvvPNRTsvpGMstN5E4C5jtXUK61S3xan',
];
let peerIdCounter = 0;
function freshPeerIdString(): string {
  const id = SYNTHETIC_PEER_IDS[peerIdCounter % SYNTHETIC_PEER_IDS.length];
  peerIdCounter++;
  return id;
}

describe('p2p resilience hooks', () => {
  describe('reconnect-on-gossip', () => {
    it('dials the sender of a gossip message when not already connected', async () => {
      const agent = await DKGAgent.create({
        name: 'ReconnectOnGossipBasic',
        listenHost: '127.0.0.1',
        chainAdapter: new MockChainAdapter(),
      });
      try {
        await agent.start();

        const dialSpy = vi.spyOn(agent.node.libp2p, 'dial').mockResolvedValue({} as any);
        const remotePeer = freshPeerIdString();

        agent.eventBus.emit(DKGEvent.GOSSIP_MESSAGE, {
          topic: 'dkg/context-graph/test/pub',
          data: new Uint8Array(),
          from: remotePeer,
        });

        // Hook is async; wait for the dial to be issued.
        for (let i = 0; i < 50 && dialSpy.mock.calls.length === 0; i++) {
          await new Promise(r => setTimeout(r, 20));
        }

        expect(dialSpy).toHaveBeenCalled();
      } finally {
        await agent.stop().catch(() => {});
      }
    });

    it('does not dial the sender when already connected', async () => {
      const agent = await DKGAgent.create({
        name: 'ReconnectOnGossipSkipsConnected',
        listenHost: '127.0.0.1',
        chainAdapter: new MockChainAdapter(),
      });
      try {
        await agent.start();

        const dialSpy = vi.spyOn(agent.node.libp2p, 'dial').mockResolvedValue({} as any);
        const remotePeer = freshPeerIdString();

        // Pretend the peer is already connected by stubbing getPeers. We do
        // this instead of opening a real connection so the test doesn't need
        // a live remote node.
        const origGetPeers = agent.node.libp2p.getPeers.bind(agent.node.libp2p);
        vi.spyOn(agent.node.libp2p, 'getPeers').mockImplementation(() => {
          const { peerIdFromString } = require('@libp2p/peer-id');
          return [...origGetPeers(), peerIdFromString(remotePeer)];
        });

        agent.eventBus.emit(DKGEvent.GOSSIP_MESSAGE, {
          topic: 'dkg/context-graph/test/pub',
          data: new Uint8Array(),
          from: remotePeer,
        });

        await new Promise(r => setTimeout(r, 150));
        expect(dialSpy).not.toHaveBeenCalled();
      } finally {
        await agent.stop().catch(() => {});
      }
    });

    it('ignores gossip messages from our own peer id', async () => {
      const agent = await DKGAgent.create({
        name: 'ReconnectOnGossipIgnoresSelf',
        listenHost: '127.0.0.1',
        chainAdapter: new MockChainAdapter(),
      });
      try {
        await agent.start();

        const dialSpy = vi.spyOn(agent.node.libp2p, 'dial').mockResolvedValue({} as any);

        agent.eventBus.emit(DKGEvent.GOSSIP_MESSAGE, {
          topic: 'dkg/context-graph/test/pub',
          data: new Uint8Array(),
          from: agent.node.peerId,
        });

        await new Promise(r => setTimeout(r, 150));
        expect(dialSpy).not.toHaveBeenCalled();
      } finally {
        await agent.stop().catch(() => {});
      }
    });

    it('throttles repeat dial attempts to the same peer within the cooldown window', async () => {
      const agent = await DKGAgent.create({
        name: 'ReconnectOnGossipCooldown',
        listenHost: '127.0.0.1',
        chainAdapter: new MockChainAdapter(),
      });
      try {
        await agent.start();

        // Mocked dial always rejects so no real path is created; we only
        // care about how many times maybeDialGossipSender *attempted* it.
        const dialSpy = vi.spyOn(agent.node.libp2p, 'dial').mockRejectedValue(new Error('no route'));
        const remotePeer = freshPeerIdString();

        for (let i = 0; i < 5; i++) {
          agent.eventBus.emit(DKGEvent.GOSSIP_MESSAGE, {
            topic: 'dkg/context-graph/test/pub',
            data: new Uint8Array(),
            from: remotePeer,
          });
        }

        // Let the async dial attempts settle. With no relayPeers configured
        // the method returns after the single peerStore dial, so ~200ms is
        // plenty.
        await new Promise(r => setTimeout(r, 250));

        // All 5 bursts should collapse to exactly 1 dial attempt via the
        // peerStore path (no relayPeers configured → no relay fallbacks).
        expect(dialSpy).toHaveBeenCalledTimes(1);
      } finally {
        await agent.stop().catch(() => {});
      }
    });
  });

  describe('catchup-on-connection:open', () => {
    it('triggers trySyncFromPeer on connection:open', async () => {
      const agent = await DKGAgent.create({
        name: 'CatchupOnConnectionOpen',
        listenHost: '127.0.0.1',
        chainAdapter: new MockChainAdapter(),
      });
      try {
        await agent.start();

        const calls: string[] = [];
        (agent as any).trySyncFromPeer = async (peerId: string) => {
          calls.push(peerId);
        };

        const remotePeer = freshPeerIdString();
        agent.node.libp2p.dispatchEvent(new CustomEvent('connection:open', {
          detail: {
            remotePeer: { toString: () => remotePeer },
            remoteAddr: { toString: () => '/ip4/1.2.3.4/tcp/1234' },
            direction: 'inbound',
            timeline: { open: Date.now() },
          },
        } as any));

        // The listener uses a 3s setTimeout before firing trySyncFromPeer to
        // let identify complete. Wait long enough to catch it.
        for (let i = 0; i < 200 && calls.length === 0; i++) {
          await new Promise(r => setTimeout(r, 25));
        }
        expect(calls).toContain(remotePeer);
      } finally {
        await agent.stop().catch(() => {});
      }
    }, 15_000);

    it('deduplicates repeat connection:open events within the cooldown window', async () => {
      const agent = await DKGAgent.create({
        name: 'CatchupOnConnectionOpenDedup',
        listenHost: '127.0.0.1',
        chainAdapter: new MockChainAdapter(),
      });
      try {
        await agent.start();

        const calls: string[] = [];
        (agent as any).trySyncFromPeer = async (peerId: string) => {
          calls.push(peerId);
        };

        const remotePeer = freshPeerIdString();

        for (let i = 0; i < 3; i++) {
          agent.node.libp2p.dispatchEvent(new CustomEvent('connection:open', {
            detail: {
              remotePeer: { toString: () => remotePeer },
              remoteAddr: { toString: () => '/ip4/1.2.3.4/tcp/1234' },
              direction: 'inbound',
              timeline: { open: Date.now() },
            },
          } as any));
        }

        // All three events are dispatched synchronously; only the first
        // should register within the cooldown window.
        for (let i = 0; i < 200 && calls.length === 0; i++) {
          await new Promise(r => setTimeout(r, 25));
        }

        // Give any stragglers a chance to land.
        await new Promise(r => setTimeout(r, 250));
        expect(calls.filter(p => p === remotePeer)).toHaveLength(1);
      } finally {
        await agent.stop().catch(() => {});
      }
    }, 15_000);

    it('ignores connection:open for our own peer id', async () => {
      const agent = await DKGAgent.create({
        name: 'CatchupOnConnectionOpenIgnoresSelf',
        listenHost: '127.0.0.1',
        chainAdapter: new MockChainAdapter(),
      });
      try {
        await agent.start();

        const calls: string[] = [];
        (agent as any).trySyncFromPeer = async (peerId: string) => {
          calls.push(peerId);
        };

        agent.node.libp2p.dispatchEvent(new CustomEvent('connection:open', {
          detail: {
            remotePeer: { toString: () => agent.node.peerId },
            remoteAddr: { toString: () => '/ip4/127.0.0.1/tcp/1234' },
            direction: 'outbound',
            timeline: { open: Date.now() },
          },
        } as any));

        await new Promise(r => setTimeout(r, 3500));
        expect(calls).not.toContain(agent.node.peerId);
      } finally {
        await agent.stop().catch(() => {});
      }
    }, 15_000);
  });
});
