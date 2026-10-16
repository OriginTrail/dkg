// SPDX-License-Identifier: Apache-2.0

/**
 * E2E: a Core that hosts a public Context Graph registered on chain keeps the
 * owner's definition of it and serves it, so a member that reaches the graph
 * only through the Core obtains the definition, sub-graph registrations
 * included, and makes its first write into a sub-graph the owner registered.
 *
 * Real agents over real libp2p on the shared Hardhat chain:
 *  - the owner creates a public graph with a curated publish policy, registers
 *    it on chain and registers the sub-graph `reports`;
 *  - a Core is connected to the owner and to the member. It comes to host the
 *    graph as the StorageACK gate makes it host one (`recordCoreHostedPublicCg`
 *    with the graph's on-chain id); hosting makes it fetch the owner's
 *    definition;
 *  - the member dials the Core only and is never connected to the owner.
 *
 * The member subscribes as `POST /api/context-graph/subscribe` does
 * (admission, the subscription, then the catch-up job's definition fetch with
 * the admission's chain proof) and writes as the knowledge-asset routes do,
 * naming the sub-graph. Without the Core's copy the member's definition came
 * from the chain alone (type and policy, no curator, no sub-graphs) and its
 * write into `reports` was refused with SUB_GRAPH_NOT_FOUND.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import type { DKGAgent } from '../src/index.js';
import {
  CORE_HOSTED_DEFINITION_SERVE_COOLDOWN_MS,
  holdsCoreHostedOwnerDefinition,
} from '../src/core-hosted-definition.js';
import {
  RealChainAgents,
  connectWithIdentify,
  dialableAddress,
  pollUntil,
  sleep,
} from './_helpers/real-chain-agent.js';
import {
  HARDHAT_KEYS,
  createProvider,
  getSharedContext,
  revertSnapshot,
  takeSnapshot,
} from '../../chain/test/evm-test-context.js';
import { mintTokens } from '../../chain/test/hardhat-harness.js';

const NAME = 'http://schema.org/name';
/** A run of this file never collides with another run's graphs. */
const RUN = Date.now().toString(36);
const OWNER_KEY = HARDHAT_KEYS.EXTRA2;
const MEMBER_KEY = HARDHAT_KEYS.EXTRA1;
const REPORTS = 'reports';

const pool = new RealChainAgents();
let fileSnapshot: string;
beforeAll(async () => {
  fileSnapshot = await takeSnapshot();
  // Registering a Context Graph pulls the registration deposit.
  const { hubAddress } = getSharedContext();
  const owner = new ethers.Wallet(OWNER_KEY);
  await mintTokens(createProvider(), hubAddress, HARDHAT_KEYS.DEPLOYER, owner.address, ethers.parseEther('50000000'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await pool.stopAll();
});
afterAll(async () => {
  await revertSnapshot(fileSnapshot);
});

/** An Edge that dials `core` at start and runs no mDNS: it reaches only the peers the test connects. */
async function startEdge(name: string, operationalKey: string, core: DKGAgent): Promise<DKGAgent> {
  const agent = await pool.create({
    name,
    operationalKey,
    listenHost: '127.0.0.1',
    bootstrapPeers: [dialableAddress(core)],
  });
  await agent.start();
  await connectWithIdentify(agent, core);
  return agent;
}

function isConnected(from: DKGAgent, to: DKGAgent): boolean {
  const remote = to.node.libp2p.peerId.toString();
  return from.node.libp2p.getConnections().some((connection) => connection.remotePeer.toString() === remote);
}

async function subGraphNames(agent: DKGAgent, contextGraphId: string): Promise<string[]> {
  return (await agent.listSubGraphs(contextGraphId)).map((subGraph) => subGraph.name).sort();
}

describe('E2E: a Core serves the owner\'s definition of a hosted registered public graph', () => {
  it('a member that reaches only the Core gets the definition and writes into the owner\'s sub-graph', async () => {
    const core = await pool.create({
      name: 'HostedDefinitionCore',
      operationalKey: HARDHAT_KEYS.CORE_OP,
      listenHost: '127.0.0.1',
      nodeRole: 'core',
    });
    await core.start();
    const owner = await startEdge('HostedDefinitionOwner', OWNER_KEY, core);
    const member = await startEdge('HostedDefinitionMember', MEMBER_KEY, core);
    const ownerAddress = owner.getDefaultAgentAddress()!.toLowerCase();
    const memberAddress = member.getDefaultAgentAddress()!.toLowerCase();

    // POST /api/context-graph/create with accessPolicy 0, publishPolicy 1 and
    // register: true, then POST /api/sub-graph/create.
    const contextGraphId = `${ownerAddress}/hosted-definition-${RUN}`;
    await owner.createContextGraph({
      id: contextGraphId,
      name: 'Hosted definition E2E',
      description: '',
      accessPolicy: 0,
      callerAgentAddress: ownerAddress,
    });
    const registered = await owner.registerContextGraph(contextGraphId, {
      accessPolicy: 0,
      publishPolicy: 1,
      callerAgentAddress: ownerAddress,
    });
    const onChainId = String(registered.onChainId);
    expect(Number(onChainId)).toBeGreaterThan(0);
    await owner.createSubGraph(contextGraphId, REPORTS);

    // The topology the member meets: its one peer is the Core; the owner is out of its reach.
    expect(isConnected(member, core), 'the member is connected to the Core').toBe(true);
    expect(isConnected(member, owner), 'the member is not connected to the owner').toBe(false);
    expect(await holdsCoreHostedOwnerDefinition(core.store, contextGraphId, ownerAddress), 'the Core holds no definition yet').toBe(false);

    // The Core comes to host the graph (what the StorageACK finality gate does
    // on the first public ACK for it). Hosting makes it keep the owner's definition.
    const recorded = await pollUntil(
      () => core.recordCoreHostedPublicCg(onChainId, contextGraphId, { durable: false, nudge: false }),
      (outcome) => outcome === 'recorded' || outcome === 'already-recorded',
      60_000,
      1_000,
    );
    expect(['recorded', 'already-recorded']).toContain(recorded);
    const held = await pollUntil(
      () => holdsCoreHostedOwnerDefinition(core.store, contextGraphId, ownerAddress),
      (outcome) => outcome,
      60_000,
      500,
    );
    expect(held, 'the Core holds the owner\'s definition').toBe(true);
    expect(await subGraphNames(core, contextGraphId), 'the Core registered the owner\'s sub-graph').toEqual([REPORTS]);

    // POST /api/context-graph/subscribe: the admission proves the graph
    // registered and public on chain, the subscription carries its on-chain
    // id, and the catch-up job first fetches the definition with that proof.
    const admission = await member.resolveContextGraphSubscriptionBootstrapAuthority(contextGraphId, {
      callerAgentAddress: memberAddress,
      allowSubscriptionFallback: false,
    });
    expect(admission).toMatchObject({ outcome: 'allowed', source: 'registered-chain', reason: 'chain-public' });
    member.subscribeToContextGraph(contextGraphId, { syncMode: 'always-on', onChainId });
    const fetched = await member.bootstrapRfc64CatalogContextGraphMetadataFromPeersV1(
      contextGraphId,
      undefined,
      { contextGraphId, onChainId },
    );

    // The definition came from a connected peer, the Core, not from the chain alone.
    expect(fetched, 'how the member obtained the definition').toBe('fetched');
    expect(await holdsCoreHostedOwnerDefinition(member.store, contextGraphId, ownerAddress), 'the member holds the owner\'s definition').toBe(true);
    expect(await subGraphNames(member, contextGraphId), 'the member lists the owner\'s sub-graph').toEqual([REPORTS]);
    expect(isConnected(member, owner), 'the member never reached the owner').toBe(false);

    // POST /api/knowledge-assets naming the sub-graph, then .../swm/share.
    const scope = { subGraphName: REPORTS };
    const assertionName = `report-${RUN}`;
    const subject = `urn:e2e:hosted-definition:${RUN}`;
    await member.assertion.create(contextGraphId, assertionName, scope);
    await member.assertion.write(contextGraphId, assertionName, [{ subject, predicate: NAME, object: '"a report"' }], scope);
    const promoted = await member.assertion.promote(contextGraphId, assertionName, scope);
    expect(promoted.promotedCount).toBeGreaterThan(0);

    // A sub-graph the owner registers later reaches the member through the
    // Core, which refreshes its copy from the owner before it serves it, once
    // the copy is older than the serve cooldown.
    await owner.createSubGraph(contextGraphId, 'drafts');
    await sleep(CORE_HOSTED_DEFINITION_SERVE_COOLDOWN_MS + 1_000);
    const draftScope = { subGraphName: 'drafts' };
    await member.assertion.create(contextGraphId, `draft-${RUN}`, draftScope);
    expect(await subGraphNames(member, contextGraphId)).toEqual(['drafts', REPORTS]);
    expect(isConnected(member, owner), 'the member still never reached the owner').toBe(false);
  }, 300_000);
});
