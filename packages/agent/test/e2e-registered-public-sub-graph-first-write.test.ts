/**
 * E2E (#3293): a member's first write into a named sub-graph of a public
 * context graph registered on chain, with real agents, real libp2p and the
 * real ContextGraphStorage contract on Hardhat.
 *
 * The owner creates and registers the graph and registers a sub-graph. A
 * member connects and subscribes as POST /api/context-graph/subscribe does:
 * the chain admits it, it subscribes, and its catch-up job pulls the graph's
 * definition from a connected peer with the chain proof (#3264). Then the
 * member makes the calls POST /api/knowledge-assets and swm/share make
 * (create, write, share) naming the sub-graph, without creating the sub-graph
 * on its own node first. That used to fail ("Sub-graph ... has not been
 * registered", HTTP 500) until shared memory of the sub-graph reached the
 * member by sync.
 *
 * Covered here end to end: the owner's responder serves its sub-graph
 * registration in the `_meta` pages of the definition and the member registers
 * it with the definition; a sub-graph the owner registers later is found at
 * the owner when the member's first write names it; a sub-graph nobody
 * registered is refused with SUB_GRAPH_NOT_FOUND. The unit counterparts are in
 * registered-public-sub-graph-first-write.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ethers } from 'ethers';
import { SUB_GRAPH_NOT_FOUND_CODE } from '@origintrail-official/dkg-publisher';
import { RealChainAgents, connectWithIdentify, pollUntil } from './_helpers/real-chain-agent.js';
import type { DKGAgent } from '../src/index.js';
import {
  HARDHAT_KEYS,
  createProvider,
  getSharedContext,
  revertSnapshot,
  takeSnapshot,
} from '../../chain/test/evm-test-context.js';
import { mintTokens } from '../../chain/test/hardhat-harness.js';

const NAME = 'http://schema.org/name';
/** Same on every node: a run of this file never collides with another run's graphs. */
const RUN = Date.now().toString(36);
const REPORTS = 'reports';

let fileSnapshot: string;
beforeAll(async () => {
  fileSnapshot = await takeSnapshot();
  // Registering a Context Graph pulls the registration deposit when one is set.
  const { hubAddress } = getSharedContext();
  const registrar = new ethers.Wallet(HARDHAT_KEYS.CORE_OP);
  await mintTokens(createProvider(), hubAddress, HARDHAT_KEYS.DEPLOYER, registrar.address, ethers.parseEther('50000000'));
});
afterAll(async () => {
  await revertSnapshot(fileSnapshot);
});

/** POST /api/knowledge-assets (create + write), then swm/share, naming the sub-graph. */
async function writeAndShare(author: DKGAgent, contextGraphId: string, name: string, subGraphName: string) {
  const scope = { subGraphName };
  await author.assertion.create(contextGraphId, name, scope);
  await author.assertion.write(contextGraphId, name, [{ subject: `urn:e2e:3293:${RUN}:${name}`, predicate: NAME, object: `"${name}"` }], scope);
  return author.assertion.promote(contextGraphId, name, scope);
}

async function subGraphNames(agent: DKGAgent, contextGraphId: string): Promise<string[]> {
  return (await agent.listSubGraphs(contextGraphId)).map((subGraph) => subGraph.name).sort();
}

describe('E2E: a member\'s first write into a sub-graph of a registered public graph (#3293)', () => {
  const pool = new RealChainAgents();
  const tempDirs: string[] = [];
  let owner: { agent: DKGAgent; address: string };
  let member: { agent: DKGAgent; address: string };
  let contextGraphId: string;
  let onChainId: string;

  /**
   * An agent as a daemon runs it. The data directory matters: with one, the
   * release default follows a graph through the author catalogs, so a
   * registered graph is catalog-authoritative and gets no legacy durable sync
   * of `_meta`; an agent without one runs in legacy mode and tests another node.
   */
  async function startAgent(name: string, operationalKey: string) {
    const dataDir = await mkdtemp(join(tmpdir(), 'dkg-e2e-3293-'));
    tempDirs.push(dataDir);
    const agent = await pool.create({ name, operationalKey, listenHost: '127.0.0.1', dataDir });
    await agent.start();
    return { agent, address: agent.getDefaultAgentAddress()!.toLowerCase() };
  }

  afterAll(async () => {
    await pool.stopAll();
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  }, 60_000);

  it('the owner registers the graph on chain and a sub-graph; the member subscribes and holds the definition', async () => {
    owner = await startAgent('SubGraphOwner3293', HARDHAT_KEYS.CORE_OP);
    member = await startAgent('SubGraphMember3293', HARDHAT_KEYS.EXTRA1);

    contextGraphId = `${owner.address}/one-graph-${RUN}`;
    await owner.agent.createContextGraph({
      id: contextGraphId,
      name: 'Sub-graph first write E2E',
      description: '',
      accessPolicy: 0,
      callerAgentAddress: owner.address,
    });
    const registered = await owner.agent.registerContextGraph(contextGraphId, {
      accessPolicy: 0,
      publishPolicy: 1,
      callerAgentAddress: owner.address,
    });
    onChainId = String(registered.onChainId);
    expect(Number(onChainId)).toBeGreaterThan(0);
    await owner.agent.createSubGraph(contextGraphId, REPORTS);
    expect(await subGraphNames(owner.agent, contextGraphId)).toEqual([REPORTS]);

    await connectWithIdentify(member.agent, owner.agent);
    // POST /api/context-graph/subscribe: the chain admits the subscription...
    const admission = await pollUntil(
      () => member.agent.resolveContextGraphSubscriptionBootstrapAuthority(contextGraphId, {
        callerAgentAddress: member.address,
        allowSubscriptionFallback: false,
      }),
      (decision) => decision.outcome === 'allowed',
      60_000,
      1_000,
    );
    expect(admission).toMatchObject({ outcome: 'allowed', source: 'registered-chain', reason: 'chain-public' });
    expect(admission.onChainId?.toString(10)).toBe(onChainId);
    // ...it subscribes, and its catch-up job pulls the definition with the chain proof.
    member.agent.subscribeToContextGraph(contextGraphId, { syncMode: 'always-on', onChainId });
    await member.agent.reconcileRfc64CatalogResponsibilityV1(contextGraphId);
    const definition = await pollUntil(
      () => member.agent.bootstrapRfc64CatalogContextGraphMetadataFromPeersV1(
        contextGraphId,
        undefined,
        { contextGraphId, onChainId },
      ).catch(() => 'failed' as const),
      (outcome) => outcome === 'fetched' || outcome === 'already-confirmed',
      60_000,
      1_000,
    );
    expect(['fetched', 'already-confirmed']).toContain(definition);
    expect(await member.agent.contextGraphExists(contextGraphId)).toBe(true);

    // The owner's sub-graph came with the definition.
    expect(await subGraphNames(member.agent, contextGraphId)).toEqual([REPORTS]);
  }, 300_000);

  it('the member\'s first write and share into the owner\'s sub-graph go through', async () => {
    expect(contextGraphId, 'not evaluated: the graph was not set up').toBeDefined();

    const shared = await writeAndShare(member.agent, contextGraphId, `report-${RUN}`, REPORTS);

    expect(shared.sealed).toBe(true);
    expect(shared.promotedCount).toBeGreaterThan(0);
  }, 120_000);

  it('a sub-graph the owner registers later is found at the owner on the member\'s first write into it', async () => {
    expect(contextGraphId, 'not evaluated: the graph was not set up').toBeDefined();
    await owner.agent.createSubGraph(contextGraphId, 'drafts');
    expect(await subGraphNames(member.agent, contextGraphId)).toEqual([REPORTS]);

    const shared = await writeAndShare(member.agent, contextGraphId, `draft-${RUN}`, 'drafts');

    expect(shared.sealed).toBe(true);
    expect(await subGraphNames(member.agent, contextGraphId)).toEqual(['drafts', REPORTS]);
  }, 120_000);

  it('a write into a sub-graph nobody registered is refused with SUB_GRAPH_NOT_FOUND', async () => {
    expect(contextGraphId, 'not evaluated: the graph was not set up').toBeDefined();

    // Peers other than the owner may be connected (local discovery), so their number is not fixed.
    await expect(member.agent.assertion.create(contextGraphId, `stray-${RUN}`, { subGraphName: 'nowhere' })).rejects.toMatchObject({
      code: SUB_GRAPH_NOT_FOUND_CODE,
      message: expect.stringMatching(/none of the \d+ peer\(s\) of the context graph asked holds it/),
    });
    expect(await subGraphNames(member.agent, contextGraphId)).toEqual(['drafts', REPORTS]);
  }, 120_000);
});
