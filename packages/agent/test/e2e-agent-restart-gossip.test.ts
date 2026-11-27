/**
 * E2E: a same-instance `stop()` -> `start()` keeps a member receiving gossip.
 *
 * Two real DKGAgent instances over real libp2p and the Hardhat chain. B
 * subscribes to A's context graph and receives A's shared-memory write over
 * GossipSub. Then B restarts IN PLACE (same instance, new libp2p node, new
 * GossipSubManager) and A writes again: B must receive that write too. Without
 * the restart contract B kept a stale "already subscribed" registry, never
 * subscribed on the new manager and stayed deaf to the graph.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { makeTestKaNumberAllocator } from './_helpers/ka-allocator.js';
import { DKGAgent as RealDKGAgent } from '../src/index.js';
import { DKGEvent, contextGraphSharedMemoryTopic } from '@origintrail-official/dkg-core';
import { createEVMAdapter, getSharedContext, createProvider, takeSnapshot, revertSnapshot, HARDHAT_KEYS } from '../../chain/test/evm-test-context.js';
import { mintTokens } from '../../chain/test/hardhat-harness.js';
import { ethers } from 'ethers';

type DKGAgent = RealDKGAgent;
const DKGAgent = {
  create(config: Parameters<typeof RealDKGAgent.create>[0]) {
    return RealDKGAgent.create({
      rfc64CatalogActivation: { enabled: false },
      ...config,
    });
  },
};

const CONTEXT_GRAPH = 'agent-restart-gossip-e2e';
const NAME_QUERY = (entity: string) =>
  `SELECT ?name WHERE { <${entity}> <http://schema.org/name> ?name }`;
const SWM_VIEW = { contextGraphId: CONTEXT_GRAPH, includeSharedMemory: true } as const;
const ENTITY_BEFORE = 'urn:e2e:restart-gossip:entity:before-restart';
const ENTITY_AFTER = 'urn:e2e:restart-gossip:entity:after-restart';

interface WireIdSource {
  gossipWireIdFor(contextGraphId: string): string;
}

interface SharedMemoryHandlerSource {
  getOrCreateSharedMemoryHandler(): {
    handle(data: Uint8Array, from: string): Promise<{ applied: boolean }>;
  };
}

let _fileSnapshot: string;
beforeAll(async () => {
  _fileSnapshot = await takeSnapshot();
  const { hubAddress } = getSharedContext();
  const provider = createProvider();
  const coreOp = new ethers.Wallet(HARDHAT_KEYS.CORE_OP);
  await mintTokens(provider, hubAddress, HARDHAT_KEYS.DEPLOYER, coreOp.address, ethers.parseEther('50000000'));
});
afterAll(async () => {
  await revertSnapshot(_fileSnapshot);
});

async function eventually<T>(
  what: string,
  read: () => Promise<T> | T,
  accept: (value: T) => boolean,
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  while (Date.now() < deadline) {
    try {
      last = await read();
      if (accept(last)) return last;
    } catch {
      // Not ready yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${what} (last: ${JSON.stringify(last)})`);
}

/**
 * A graph-scoped SWM write: WM assertion, then promote to shared memory. A
 * receiver refuses the legacy root-scoped `share()` on gossip (the write only
 * reaches a peer through catch-up), so this is the write that exercises the
 * member gossip handler.
 */
async function promoteToSharedMemory(
  agent: DKGAgent,
  name: string,
  entity: string,
  label: string,
): Promise<void> {
  await agent.assertion.create(CONTEXT_GRAPH, name);
  await agent.assertion.write(CONTEXT_GRAPH, name, [
    { subject: entity, predicate: 'http://schema.org/name', object: `"${label}"` },
  ]);
  await agent.assertion.promote(CONTEXT_GRAPH, name);
}

describe('Agent restart gossip E2E (2 nodes)', () => {
  let nodeA: DKGAgent;
  let nodeB: DKGAgent;
  let swmTopic: string;
  const receivedOnB: Array<{ topic: string; from: string }> = [];

  afterAll(async () => {
    try {
      await nodeA?.stop();
      await nodeB?.stop();
    } catch (err) {
      console.warn('Teardown:', err);
    }
  });

  it('bootstraps two nodes, connects them and lets B subscribe to A\'s graph', async () => {
    nodeA = await DKGAgent.create({
      kaNumberAllocator: makeTestKaNumberAllocator(),
      name: 'RestartGossipA',
      listenPort: 0,
      chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
      nodeRole: 'core',
    });
    nodeB = await DKGAgent.create({
      kaNumberAllocator: makeTestKaNumberAllocator(),
      name: 'RestartGossipB',
      listenPort: 0,
      chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
      nodeRole: 'core',
      // No automatic catch-up on connect or by timer: after B's one explicit
      // metadata sync below, a write can only reach B through gossip.
      syncOnConnectEnabled: false,
      syncReconcilerEnabled: false,
    });
    await nodeA.start();
    await nodeB.start();
    // The eventBus is shared across B's sessions: it records what B's gossip
    // layer delivered, whichever manager received it.
    nodeB.eventBus.on(DKGEvent.GOSSIP_MESSAGE, (evt) => {
      const { topic, from } = evt as { topic: string; from: string };
      receivedOnB.push({ topic, from });
    });

    const addrA = nodeA.multiaddrs.find((a) => a.includes('/tcp/') && !a.includes('/p2p-circuit'))!;
    await nodeB.connectTo(addrA);

    await nodeA.createContextGraph({
      id: CONTEXT_GRAPH,
      name: 'Agent restart gossip E2E',
      description: 'Same-instance restart keeps gossip flowing',
    });
    await nodeA.registerContextGraph(CONTEXT_GRAPH);
    swmTopic = contextGraphSharedMemoryTopic((nodeA as unknown as WireIdSource).gossipWireIdFor(CONTEXT_GRAPH));

    nodeB.subscribeToContextGraph(CONTEXT_GRAPH);
    // B's member-mode SWM subscription needs A's metadata first: pull it once,
    // explicitly. Then B joins the topic mesh, and A must see B as a subscriber
    // before it publishes.
    await nodeB.syncContextGraphFromConnectedPeers(CONTEXT_GRAPH, { includeSharedMemory: true });
    await eventually(
      'A to see B subscribed to the shared-memory topic',
      () => nodeA.gossip.getSubscribers(swmTopic),
      (subscribers) => subscribers.includes(nodeB.peerId),
    );
  }, 60_000);

  it('B receives A\'s shared-memory write over gossip before the restart', async () => {
    await promoteToSharedMemory(nodeA, 'before-restart', ENTITY_BEFORE, 'Before restart');
    const rows = await eventually(
      'B to apply the pre-restart write',
      () => nodeB.query(NAME_QUERY(ENTITY_BEFORE), SWM_VIEW),
      (result) => result.bindings.length > 0,
    );
    expect(String(rows.bindings[0]['name'])).toMatch(/Before restart/);
    expect(receivedOnB.some((m) => m.topic === swmTopic && m.from === nodeA.peerId)).toBe(true);
  }, 60_000);

  it('after B restarts in place, A\'s next write still reaches B over gossip', async () => {
    const managerBeforeRestart = nodeB.gossip;
    receivedOnB.length = 0;

    await nodeB.stop();
    await nodeB.start();
    expect(nodeB.gossip).not.toBe(managerBeforeRestart);
    // B's listen port changed with the new libp2p node: dial A again.
    const addrA = nodeA.multiaddrs.find((a) => a.includes('/tcp/') && !a.includes('/p2p-circuit'))!;
    await nodeB.connectTo(addrA);

    // The restarted node must rejoin the topic on its NEW manager: A sees it as
    // a subscriber again, and it holds the durable subscription intent.
    await eventually(
      'A to see the restarted B subscribed to the shared-memory topic',
      () => nodeA.gossip.getSubscribers(swmTopic),
      (subscribers) => subscribers.includes(nodeB.peerId),
    );
    expect(nodeB.gossip.subscribedTopics).toContain(swmTopic);
    receivedOnB.length = 0;
    // Every shared-memory message funnels into this handler singleton, whether
    // it came over gossip or over the point-to-point fan-out to the topic's
    // subscribers. B runs no catch-up sync, so an applied write proves a live
    // delivery reached the restarted node; the gossip event and the handler on
    // the new manager, asserted below, pin the gossip path itself.
    const handleSpy = vi.spyOn(
      (nodeB as unknown as SharedMemoryHandlerSource).getOrCreateSharedMemoryHandler(),
      'handle',
    );

    await promoteToSharedMemory(nodeA, 'after-restart', ENTITY_AFTER, 'After restart');
    const rows = await eventually(
      'the restarted B to apply the post-restart write',
      () => nodeB.query(NAME_QUERY(ENTITY_AFTER), SWM_VIEW),
      (result) => result.bindings.length > 0,
    );
    expect(String(rows.bindings[0]['name'])).toMatch(/After restart/);
    // A gossip message on the topic reached the restarted node, from A, its
    // shared-memory handler applied the write, and the topic handler sits on
    // the NEW manager.
    expect(receivedOnB.some((m) => m.topic === swmTopic && m.from === nodeA.peerId)).toBe(true);
    const outcomes = await Promise.all(
      handleSpy.mock.calls
        .map((call, index) => ({ from: call[1], result: handleSpy.mock.results[index]!.value as Promise<{ applied: boolean }> }))
        .filter(({ from }) => from === nodeA.peerId)
        .map(({ result }) => result),
    );
    expect(outcomes.some((outcome) => outcome.applied)).toBe(true);
    const handlersOnNewManager = (nodeB.gossip as unknown as { topicHandlers: Map<string, Set<unknown>> })
      .topicHandlers.get(swmTopic);
    expect(handlersOnNewManager?.size ?? 0).toBeGreaterThan(0);
    handleSpy.mockRestore();
    // Write order is kept: the pre-restart write survived the restart too.
    const before = await nodeB.query(NAME_QUERY(ENTITY_BEFORE), SWM_VIEW);
    expect(before.bindings.length).toBeGreaterThan(0);
  }, 90_000);
});
