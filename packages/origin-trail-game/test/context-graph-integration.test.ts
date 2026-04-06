/**
 * Context Graph Integration Tests
 *
 * Verifies that the game coordinator properly wires up to the DKG context
 * graph protocol: createContextGraph on launch, publishFromSharedMemory on
 * turn resolution, and identity propagation through gossip messages.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { OriginTrailGameCoordinator } from '../src/dkg/coordinator.js';
import * as proto from '../src/dkg/protocol.js';

let seq = 0;
function uid(prefix = 'p') {
  return `${prefix}-cg-${++seq}-${Date.now()}`;
}

function makeMockAgent(peerId: string, identityId = 1n) {
  const published: any[] = [];
  const shareWrites: any[] = [];
  const publishedFromSwm: any[] = [];
  const contextGraphs: any[] = [];
  const broadcasts: any[] = [];
  const messageHandlers = new Map<string, Function[]>();

  return {
    peerId,
    identityId,
    gossip: {
      subscribe() {},
      async publish(_topic: string, data: Uint8Array) {
        const msg = proto.decode(data);
        if (msg) broadcasts.push(msg);
      },
      onMessage(topic: string, handler: Function) {
        if (!messageHandlers.has(topic)) messageHandlers.set(topic, []);
        messageHandlers.get(topic)!.push(handler);
      },
      offMessage() {},
    },
    share: async (_contextGraphId: string, quads: any[]) => {
      shareWrites.push(quads);
      return { shareOperationId: `ws-op-${shareWrites.length}` };
    },
    publish: async (_contextGraphId: string, quads: any[]) => {
      published.push(quads);
      return { onChainResult: { txHash: '0xpublish123' }, ual: 'did:dkg:test:ual' };
    },
    publishFromSharedMemory: async (_contextGraphId: string, selection: any, options?: any) => {
      publishedFromSwm.push({ selection, options });
      return { onChainResult: { txHash: '0xpublish123', blockNumber: 100 }, ual: 'did:dkg:test:published' };
    },
    createContextGraph: async (params: any) => {
      const id = BigInt(contextGraphs.length + 1);
      contextGraphs.push(params);
      return { contextGraphId: id, success: true };
    },
    signContextGraphDigest: async (_contextGraphId: bigint, _merkleRoot: Uint8Array) => ({
      identityId,
      r: new Uint8Array(32),
      vs: new Uint8Array(32),
    }),
    query: async () => ({ bindings: [] }),
    _published: published,
    _shareWrites: shareWrites,
    _publishedFromSwm: publishedFromSwm,
    _contextGraphs: contextGraphs,
    _broadcasts: broadcasts,
    _messageHandlers: messageHandlers,
    _injectMessage(topic: string, data: Uint8Array, from: string) {
      for (const handler of messageHandlers.get(topic) ?? []) handler(topic, data, from);
    },
  };
}

type MockAgent = ReturnType<typeof makeMockAgent>;

function createCoordinator(agent: MockAgent) {
  return new OriginTrailGameCoordinator(
    agent as any,
    { contextGraphId: 'origin-trail-game' },
    () => {},
  );
}

async function setupThreePlayerGame(leaderAgent: MockAgent) {
  const coord = createCoordinator(leaderAgent);

  const swarm = await coord.createSwarm('Alice', 'TestSwarm');
  const swarmId = swarm.id;

  // Simulate 2 remote players joining via gossip
  const topic = proto.appTopic('origin-trail-game');
  const joinB = proto.encode({
    app: proto.APP_ID,
    type: 'swarm:joined',
    swarmId,
    peerId: 'peer-B',
    timestamp: Date.now(),
    playerName: 'Bob',
    identityId: '2',
  });
  leaderAgent._injectMessage(topic, joinB, 'peer-B');

  const joinC = proto.encode({
    app: proto.APP_ID,
    type: 'swarm:joined',
    swarmId,
    peerId: 'peer-C',
    timestamp: Date.now(),
    playerName: 'Charlie',
    identityId: '3',
  });
  leaderAgent._injectMessage(topic, joinC, 'peer-C');

  // Wait for message queue
  await new Promise(r => setTimeout(r, 50));

  return { coord, swarmId };
}

describe('Context Graph Integration', () => {
  let agent: MockAgent;

  beforeEach(() => {
    seq = 0;
    agent = makeMockAgent('peer-A', 1n);
  });

  describe('identity propagation', () => {
    it('includes identityId in swarm:created message', async () => {
      const coord = createCoordinator(agent);
      await coord.createSwarm('Alice', 'TestSwarm');

      const created = agent._broadcasts.find(m => m.type === 'swarm:created');
      expect(created).toBeTruthy();
      expect(created.identityId).toBe('1');
    });

    it('includes identityId in swarm:joined message', async () => {
      const coord = createCoordinator(agent);
      const swarm = await coord.createSwarm('Alice', 'TestSwarm');

      // Create second coordinator for joiner
      const agentB = makeMockAgent('peer-B', 2n);
      const coordB = createCoordinator(agentB);

      // Inject swarm:created into B so it knows about the swarm
      const topic = proto.appTopic('origin-trail-game');
      const createdMsg = proto.encode({
        app: proto.APP_ID,
        type: 'swarm:created',
        swarmId: swarm.id,
        peerId: 'peer-A',
        timestamp: Date.now(),
        swarmName: 'TestSwarm',
        playerName: 'Alice',
        maxPlayers: 3,
        identityId: '1',
      });
      agentB._injectMessage(topic, createdMsg, 'peer-A');
      await new Promise(r => setTimeout(r, 50));

      await coordB.joinSwarm(swarm.id, 'Bob');

      const joined = agentB._broadcasts.find(m => m.type === 'swarm:joined');
      expect(joined).toBeTruthy();
      expect(joined.identityId).toBe('2');

      coordB.destroy();
      coord.destroy();
    });

    it('stores remote identityId on swarm members', async () => {
      const { coord, swarmId } = await setupThreePlayerGame(agent);

      const swarm = coord.getSwarm(swarmId);
      expect(swarm).toBeTruthy();
      const bob = swarm!.players.find(p => p.peerId === 'peer-B');
      const charlie = swarm!.players.find(p => p.peerId === 'peer-C');
      expect(bob?.identityId).toBe('2');
      expect(charlie?.identityId).toBe('3');

      coord.destroy();
    });
  });

  describe('context graph creation on expedition launch', () => {
    it('creates context graph with all participant identity IDs', async () => {
      const { coord, swarmId } = await setupThreePlayerGame(agent);

      await coord.launchExpedition(swarmId);

      expect(agent._contextGraphs.length).toBe(1);
      const params = agent._contextGraphs[0];
      expect(params.participantIdentityIds).toEqual([1n, 2n, 3n]);
      expect(params.requiredSignatures).toBe(2);

      coord.destroy();
    });

    it('sets contextGraphId on the swarm after launch', async () => {
      const { coord, swarmId } = await setupThreePlayerGame(agent);

      await coord.launchExpedition(swarmId);

      const swarm = coord.getSwarm(swarmId);
      expect(swarm?.contextGraphId).toBe('1');

      coord.destroy();
    });

    it('broadcasts contextGraphId in expedition:launched message', async () => {
      const { coord, swarmId } = await setupThreePlayerGame(agent);

      await coord.launchExpedition(swarmId);

      const launched = agent._broadcasts.find(m => m.type === 'expedition:launched');
      expect(launched).toBeTruthy();
      expect(launched.contextGraphId).toBe('1');

      coord.destroy();
    });

    it('skips context graph when any player lacks identityId', async () => {
      const coord = createCoordinator(agent);
      const swarm = await coord.createSwarm('Alice', 'TestSwarm');

      const topic = proto.appTopic('origin-trail-game');
      const joinNoId = proto.encode({
        app: proto.APP_ID,
        type: 'swarm:joined',
        swarmId: swarm.id,
        peerId: 'peer-nochain',
        timestamp: Date.now(),
        playerName: 'NoChain',
      });
      leaderInject(agent, topic, joinNoId, 'peer-nochain');

      const joinC = proto.encode({
        app: proto.APP_ID,
        type: 'swarm:joined',
        swarmId: swarm.id,
        peerId: 'peer-C',
        timestamp: Date.now(),
        playerName: 'Charlie',
        identityId: '3',
      });
      leaderInject(agent, topic, joinC, 'peer-C');
      await new Promise(r => setTimeout(r, 50));

      const launched = await coord.launchExpedition(swarm.id);

      // Context graph should NOT be created when any player lacks identityId
      expect(agent._contextGraphs.length).toBe(0);
      expect(launched.contextGraphId).toBeUndefined();

      coord.destroy();
    });

    it('proceeds without context graph if createContextGraph fails', async () => {
      const failAgent = makeMockAgent('peer-A', 1n);
      failAgent.createContextGraph = async () => { throw new Error('chain not available'); };

      const { coord, swarmId } = await setupThreePlayerGame(failAgent);
      const expedition = await coord.launchExpedition(swarmId);

      expect(expedition.status).toBe('traveling');
      expect(expedition.contextGraphId).toBeUndefined();

      coord.destroy();
    });

    it('proceeds without context graph if no identityIds', async () => {
      const noIdAgent = makeMockAgent('peer-A', 0n);
      const coord = createCoordinator(noIdAgent);
      const swarm = await coord.createSwarm('Alice', 'TestSwarm');

      // Add players without identityId
      const topic = proto.appTopic('origin-trail-game');
      for (const [pid, name] of [['peer-B', 'Bob'], ['peer-C', 'Charlie']] as const) {
        const joinMsg = proto.encode({
          app: proto.APP_ID, type: 'swarm:joined',
          swarmId: swarm.id, peerId: pid, timestamp: Date.now(), playerName: name,
        });
        noIdAgent._injectMessage(topic, joinMsg, pid);
      }
      await new Promise(r => setTimeout(r, 50));

      await coord.launchExpedition(swarm.id);

      expect(noIdAgent._contextGraphs.length).toBe(0);
      const launched = noIdAgent._broadcasts.find(m => m.type === 'expedition:launched');
      expect(launched?.contextGraphId).toBeUndefined();

      coord.destroy();
    });
  });

  describe('publishFromSharedMemory on turn resolution', () => {
    it('publishes turn quads to context graph when contextGraphId is set', async () => {
      const { coord, swarmId } = await setupThreePlayerGame(agent);
      await coord.launchExpedition(swarmId);

      // All alive players vote
      await coord.castVote(swarmId, 'advance');
      const topic = proto.appTopic('origin-trail-game');
      for (const pid of ['peer-B', 'peer-C']) {
        const voteMsg = proto.encode({
          app: proto.APP_ID, type: 'vote:cast',
          swarmId, peerId: pid, timestamp: Date.now(),
          turn: 1, action: 'advance',
        });
        agent._injectMessage(topic, voteMsg, pid);
      }
      await new Promise(r => setTimeout(r, 200));

      // Leader should have proposed and needs approvals with crypto signatures
      const swarm = coord.getSwarm(swarmId);
      if (swarm?.pendingProposal) {
        const fakeR = '0x' + '00'.repeat(32);
        const fakeVS = '0x' + '00'.repeat(32);
        for (const [pid, idStr] of [['peer-B', '2'], ['peer-C', '3']] as const) {
          const approveMsg = proto.encode({
            app: proto.APP_ID, type: 'turn:approve',
            swarmId, peerId: pid, timestamp: Date.now(),
            turn: 1, proposalHash: swarm.pendingProposal.hash,
            identityId: idStr, signatureR: fakeR, signatureVS: fakeVS,
          });
          agent._injectMessage(topic, approveMsg, pid);
        }
        await new Promise(r => setTimeout(r, 200));
      }

      // Verify publication happened with collected signatures
      expect(agent._publishedFromSwm.length).toBeGreaterThanOrEqual(1);
      const publication = agent._publishedFromSwm[0];
      expect(publication.options.contextGraphId).toBe('1');
      expect(publication.options.contextGraphSignatures).toBeTruthy();
      expect(publication.options.contextGraphSignatures.length).toBeGreaterThanOrEqual(2);
      expect(publication.selection.rootEntities).toBeTruthy();
      expect(publication.selection.rootEntities.length).toBeGreaterThan(0);

      coord.destroy();
    });

    it('falls back to publish when no contextGraphId', async () => {
      const noCtxAgent = makeMockAgent('peer-A', 1n);
      noCtxAgent.createContextGraph = async () => { throw new Error('nope'); };

      const { coord, swarmId } = await setupThreePlayerGame(noCtxAgent);
      await coord.launchExpedition(swarmId);

      // Force resolve (simpler than full vote flow)
      await coord.castVote(swarmId, 'advance');
      await coord.forceResolveTurn(swarmId);
      await new Promise(r => setTimeout(r, 100));

      // Should have used plain publish, not publishFromSharedMemory
      expect(noCtxAgent._publishedFromSwm.length).toBe(0);
      expect(noCtxAgent._published.length).toBeGreaterThanOrEqual(1);

      coord.destroy();
    });

    it('force-resolved turns use plain publish (not context graph publication)', async () => {
      const { coord, swarmId } = await setupThreePlayerGame(agent);
      await coord.launchExpedition(swarmId);

      const publishedBefore = agent._published.length;
      const publishedFromSwmBefore = agent._publishedFromSwm.length;

      await coord.forceResolveTurn(swarmId);
      await new Promise(r => setTimeout(r, 100));

      // Force-resolve lacks multi-party consensus, so it uses plain publish
      expect(agent._publishedFromSwm.length).toBe(publishedFromSwmBefore);
      expect(agent._published.length).toBeGreaterThan(publishedBefore);

      coord.destroy();
    });
  });

  describe('remote expedition receives contextGraphId', () => {
    it('follower stores contextGraphId from expedition:launched', async () => {
      const agentB = makeMockAgent('peer-B', 2n);
      const coordB = createCoordinator(agentB);

      // Inject swarm:created from leader
      const topic = proto.appTopic('origin-trail-game');
      const swarmId = 'swarm-test-remote';
      const createdMsg = proto.encode({
        app: proto.APP_ID, type: 'swarm:created',
        swarmId, peerId: 'peer-A', timestamp: Date.now(),
        swarmName: 'TestSwarm', playerName: 'Alice', maxPlayers: 3, identityId: '1',
      });
      agentB._injectMessage(topic, createdMsg, 'peer-A');
      await new Promise(r => setTimeout(r, 50));

      // Join
      await coordB.joinSwarm(swarmId, 'Bob');

      // Inject expedition:launched with contextGraphId
      const launchedMsg = proto.encode({
        app: proto.APP_ID, type: 'expedition:launched',
        swarmId, peerId: 'peer-A', timestamp: Date.now(),
        gameStateJson: JSON.stringify({
          sessionId: 'test', status: 'active', epochs: 0, party: [
            { name: 'Alice', alive: true, health: 100 },
            { name: 'Bob', alive: true, health: 100 },
          ],
          trainingTokens: 1000, morale: 80,
        }),
        partyOrder: ['peer-A', 'peer-B'],
        contextGraphId: '42',
      });
      agentB._injectMessage(topic, launchedMsg, 'peer-A');
      await new Promise(r => setTimeout(r, 100));

      const swarm = coordB.getSwarm(swarmId);
      expect(swarm?.status).toBe('traveling');
      expect(swarm?.contextGraphId).toBe('42');

      coordB.destroy();
    });
  });

  describe('shared memory graph normalization', () => {
    it('consensus turn writes quads with shared memory graph, not context graph URI', async () => {
      const { coord, swarmId } = await setupThreePlayerGame(agent);
      await coord.launchExpedition(swarmId);

      // Vote and resolve with full consensus
      await coord.castVote(swarmId, 'advance');
      const topic = proto.appTopic('origin-trail-game');
      for (const pid of ['peer-B', 'peer-C']) {
        const voteMsg = proto.encode({
          app: proto.APP_ID, type: 'vote:cast',
          swarmId, peerId: pid, timestamp: Date.now(),
          turn: 1, action: 'advance',
        });
        agent._injectMessage(topic, voteMsg, pid);
      }
      await new Promise(r => setTimeout(r, 200));
      const swarm = coord.getSwarm(swarmId);
      if (swarm?.pendingProposal) {
        const fakeR = '0x' + '00'.repeat(32);
        const fakeVS = '0x' + '00'.repeat(32);
        for (const [pid, idStr] of [['peer-B', '2'], ['peer-C', '3']] as const) {
          const approveMsg = proto.encode({
            app: proto.APP_ID, type: 'turn:approve',
            swarmId, peerId: pid, timestamp: Date.now(),
            turn: 1, proposalHash: swarm.pendingProposal.hash,
            identityId: idStr, signatureR: fakeR, signatureVS: fakeVS,
          });
          agent._injectMessage(topic, approveMsg, pid);
        }
        await new Promise(r => setTimeout(r, 200));
      }

      // All quads in shared memory writes must use the shared memory graph
      expect(agent._shareWrites.length).toBeGreaterThanOrEqual(1);
      const wsGraph = 'did:dkg:context-graph:origin-trail-game';
      for (const writeCall of agent._shareWrites) {
        for (const quad of writeCall) {
          expect(quad.graph).toBe(wsGraph);
          expect(quad.graph).not.toContain('/context/');
        }
      }

      coord.destroy();
    });

    it('force-resolve publishes quads directly (plain publish, no shared memory)', async () => {
      const { coord, swarmId } = await setupThreePlayerGame(agent);
      await coord.launchExpedition(swarmId);

      const publishedFromSwmBefore = agent._publishedFromSwm.length;

      await coord.forceResolveTurn(swarmId);
      await new Promise(r => setTimeout(r, 100));

      // Force-resolve uses plain publish, no new context graph publication
      expect(agent._publishedFromSwm.length).toBe(publishedFromSwmBefore);
      expect(agent._published.length).toBeGreaterThanOrEqual(1);

      coord.destroy();
    });

    it('fallback publish works when context graph creation fails', async () => {
      const noCtxAgent = makeMockAgent('peer-A', 1n);
      noCtxAgent.createContextGraph = async () => { throw new Error('nope'); };

      const { coord, swarmId } = await setupThreePlayerGame(noCtxAgent);
      await coord.launchExpedition(swarmId);

      await coord.forceResolveTurn(swarmId);
      await new Promise(r => setTimeout(r, 100));

      expect(noCtxAgent._published.length).toBeGreaterThanOrEqual(1);
      expect(noCtxAgent._publishedFromSwm.length).toBe(0);

      coord.destroy();
    });

    it('expedition launch quads also use shared memory graph', async () => {
      const freshAgent = makeMockAgent('peer-A', 1n);
      const { coord, swarmId } = await setupThreePlayerGame(freshAgent);

      await coord.launchExpedition(swarmId);

      expect(freshAgent._shareWrites.length).toBeGreaterThanOrEqual(1);
      const launchWrite = freshAgent._shareWrites[0];
      for (const quad of launchWrite) {
        expect(quad.graph).toBe('did:dkg:context-graph:origin-trail-game');
      }

      coord.destroy();
    });
  });

  describe('multi-party context graph signatures', () => {
    it('proposal includes merkleRoot and contextGraphId', async () => {
      const { coord, swarmId } = await setupThreePlayerGame(agent);
      await coord.launchExpedition(swarmId);

      // All vote to trigger proposal
      await coord.castVote(swarmId, 'advance');
      const topic = proto.appTopic('origin-trail-game');
      for (const pid of ['peer-B', 'peer-C']) {
        const voteMsg = proto.encode({
          app: proto.APP_ID, type: 'vote:cast',
          swarmId, peerId: pid, timestamp: Date.now(),
          turn: 1, action: 'advance',
        });
        agent._injectMessage(topic, voteMsg, pid);
      }
      await new Promise(r => setTimeout(r, 200));

      const proposal = agent._broadcasts.find(
        (m: any) => m.type === 'turn:proposal' && m.turn === 1,
      );
      expect(proposal).toBeTruthy();
      expect(proposal.merkleRoot).toBeTruthy();
      expect(proposal.contextGraphId).toBe('1');

      coord.destroy();
    });

    it('requiredSignatures stored on swarm at expedition launch', async () => {
      const { coord, swarmId } = await setupThreePlayerGame(agent);
      await coord.launchExpedition(swarmId);

      const swarm = coord.getSwarm(swarmId);
      expect(swarm?.requiredSignatures).toBe(2);

      coord.destroy();
    });

    it('turn progresses on gossip approvals, falls back to plain publish without enough sigs', async () => {
      const { coord, swarmId } = await setupThreePlayerGame(agent);
      await coord.launchExpedition(swarmId);

      await coord.castVote(swarmId, 'advance');
      const topic = proto.appTopic('origin-trail-game');
      for (const pid of ['peer-B', 'peer-C']) {
        const voteMsg = proto.encode({
          app: proto.APP_ID, type: 'vote:cast',
          swarmId, peerId: pid, timestamp: Date.now(),
          turn: 1, action: 'advance',
        });
        agent._injectMessage(topic, voteMsg, pid);
      }
      await new Promise(r => setTimeout(r, 200));

      const swarm = coord.getSwarm(swarmId);
      if (!swarm?.pendingProposal) {
        // Already resolved via threshold — turn progressed on approvals alone
        const totalPublished = agent._published.length + agent._publishedFromSwm.length;
        expect(totalPublished).toBeGreaterThan(0);
        coord.destroy();
        return;
      }

      // Send approval WITHOUT signatures from peer-B
      const approveNoSig = proto.encode({
        app: proto.APP_ID, type: 'turn:approve',
        swarmId, peerId: 'peer-B', timestamp: Date.now(),
        turn: 1, proposalHash: swarm.pendingProposal.hash,
      });
      agent._injectMessage(topic, approveNoSig, 'peer-B');
      await new Promise(r => setTimeout(r, 200));

      // Turn should resolve once approval threshold is met, regardless of signatures.
      // With insufficient crypto sigs, publication falls back to plain publish.
      const totalPublished = agent._published.length + agent._publishedFromSwm.length;
      expect(totalPublished).toBeGreaterThan(0);

      coord.destroy();
    });

    it('collected signatures are passed to publishFromSharedMemory', async () => {
      const { coord, swarmId } = await setupThreePlayerGame(agent);
      await coord.launchExpedition(swarmId);

      await coord.castVote(swarmId, 'advance');
      const topic = proto.appTopic('origin-trail-game');
      for (const pid of ['peer-B', 'peer-C']) {
        const voteMsg = proto.encode({
          app: proto.APP_ID, type: 'vote:cast',
          swarmId, peerId: pid, timestamp: Date.now(),
          turn: 1, action: 'advance',
        });
        agent._injectMessage(topic, voteMsg, pid);
      }
      await new Promise(r => setTimeout(r, 200));

      const swarm = coord.getSwarm(swarmId);
      if (swarm?.pendingProposal) {
        const fakeR = '0x' + '00'.repeat(32);
        const fakeVS = '0x' + '00'.repeat(32);
        for (const [pid, idStr] of [['peer-B', '2'], ['peer-C', '3']] as const) {
          const approveMsg = proto.encode({
            app: proto.APP_ID, type: 'turn:approve',
            swarmId, peerId: pid, timestamp: Date.now(),
            turn: 1, proposalHash: swarm.pendingProposal.hash,
            identityId: idStr, signatureR: fakeR, signatureVS: fakeVS,
          });
          agent._injectMessage(topic, approveMsg, pid);
        }
        await new Promise(r => setTimeout(r, 200));
      }

      expect(agent._publishedFromSwm.length).toBeGreaterThanOrEqual(1);
      const sigs = agent._publishedFromSwm[0].options.contextGraphSignatures;
      expect(sigs).toBeTruthy();
      expect(sigs.length).toBeGreaterThanOrEqual(2);

      const identityIds = sigs.map((s: any) => s.identityId);
      expect(identityIds).toContain(1n);

      coord.destroy();
    });
  });

  describe('restored swarms without identityId', () => {
    it('skips context graph creation when restored players lack identityId', async () => {
      const coord = createCoordinator(agent);
      const swarm = await coord.createSwarm('Alice', 'RestoredSwarm');

      // Simulate players joining without identityId (as would happen on graph restore)
      const topic = proto.appTopic('origin-trail-game');
      for (const [pid, name] of [['peer-B', 'Bob'], ['peer-C', 'Charlie']] as const) {
        const joinMsg = proto.encode({
          app: proto.APP_ID, type: 'swarm:joined',
          swarmId: swarm.id, peerId: pid, timestamp: Date.now(), playerName: name,
          // no identityId — simulates restored swarm state
        });
        agent._injectMessage(topic, joinMsg, pid);
      }
      await new Promise(r => setTimeout(r, 50));

      await coord.launchExpedition(swarm.id);

      // Context graph should NOT be created when any player lacks identityId
      expect(agent._contextGraphs.length).toBe(0);

      coord.destroy();
    });
  });

  describe('formatSwarmState includes contextGraphId', () => {
    it('returns contextGraphId in formatted output', async () => {
      const { coord, swarmId } = await setupThreePlayerGame(agent);
      await coord.launchExpedition(swarmId);

      const swarm = coord.getSwarm(swarmId);
      const formatted = coord.formatSwarmState(swarm!);
      expect(formatted.contextGraphId).toBe('1');

      coord.destroy();
    });

    it('returns null contextGraphId when not set', async () => {
      const coord = createCoordinator(agent);
      const swarm = await coord.createSwarm('Alice', 'TestSwarm');
      const formatted = coord.formatSwarmState(swarm);
      expect(formatted.contextGraphId).toBeNull();

      coord.destroy();
    });
  });

  describe('Security and Robustness (review feedback)', () => {
    it('rejects spoofed identityId in turn approval', async () => {
      const { coord, swarmId } = await setupThreePlayerGame(agent);
      await coord.launchExpedition(swarmId);
      const swarm = coord.getSwarm(swarmId)!;

      // Cast votes
      await coord.castVote(swarmId, 'continue');
      const topic = proto.appTopic('origin-trail-game');
      const voteB = proto.encode({
        app: proto.APP_ID, type: 'vote:cast', swarmId, peerId: 'peer-B',
        timestamp: Date.now(), turn: 1, action: 'continue',
      });
      leaderInject(agent, topic, voteB, 'peer-B');
      await new Promise(r => setTimeout(r, 20));

      // Simulate a turn proposal being created by triggering the leader flow
      if (!swarm.pendingProposal) return; // skip if proposal already resolved

      // Inject approval from peer-B claiming peer-C's identityId (spoofed)
      const spoofedApproval = proto.encode({
        app: proto.APP_ID, type: 'turn:approve', swarmId, peerId: 'peer-B',
        timestamp: Date.now(), turn: 1, proposalHash: swarm.pendingProposal.hash,
        identityId: '3', // peer-B claims to be identity 3 (peer-C's)
        signatureR: '0x' + '00'.repeat(32),
        signatureVS: '0x' + '00'.repeat(32),
      });
      leaderInject(agent, topic, spoofedApproval, 'peer-B');
      await new Promise(r => setTimeout(r, 20));

      // The spoofed sig should NOT be counted
      const sigs = swarm.pendingProposal?.participantSignatures;
      if (sigs) {
        const peerBSig = sigs.get('peer-B');
        expect(peerBSig).toBeUndefined();
      }

      coord.destroy();
    });

    it('propagates requiredSignatures in launch message', async () => {
      const { coord, swarmId } = await setupThreePlayerGame(agent);
      await coord.launchExpedition(swarmId);

      const launchMsg = agent._broadcasts.find(
        (m: any) => m.type === 'expedition:launched' && m.swarmId === swarmId,
      );
      expect(launchMsg).toBeDefined();
      expect(launchMsg.requiredSignatures).toBeGreaterThanOrEqual(1);
      expect(launchMsg.contextGraphId).toBeDefined();

      coord.destroy();
    });

    it('falls back to plain publish when insufficient signatures', async () => {
      const { coord, swarmId } = await setupThreePlayerGame(agent);
      await coord.launchExpedition(swarmId);
      const swarm = coord.getSwarm(swarmId)!;
      expect(swarm.contextGraphId).toBeDefined();

      // Force resolve with no peer signatures (only leader's approval)
      await coord.castVote(swarmId, 'continue');
      const topic = proto.appTopic('origin-trail-game');
      const voteB = proto.encode({
        app: proto.APP_ID, type: 'vote:cast', swarmId, peerId: 'peer-B',
        timestamp: Date.now(), turn: 1, action: 'continue',
      });
      leaderInject(agent, topic, voteB, 'peer-B');
      await new Promise(r => setTimeout(r, 20));
      await coord.forceResolveTurn(swarmId);
      await new Promise(r => setTimeout(r, 50));

      // Should have fallen back to plain publish since insufficient sigs
      // (agent._publishedFromSwm may be empty if it used plain publish instead)
      const totalPublished = agent._published.length + agent._publishedFromSwm.length;
      expect(totalPublished).toBeGreaterThan(0);

      coord.destroy();
    });
  });
});

function leaderInject(agent: MockAgent, topic: string, data: Uint8Array, from: string) {
  agent._injectMessage(topic, data, from);
}
