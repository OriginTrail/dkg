// SPDX-License-Identifier: Apache-2.0

/**
 * E2E (#3264): a member that reaches a public Context Graph registered on
 * chain only through a Core obtains the graph's definition, and its write
 * into the graph passes the check the write routes make.
 *
 * Real agents over real libp2p on the shared Hardhat chain:
 *  - the owner creates a public graph with a curated publish policy and
 *    registers it on chain;
 *  - a Core is connected to the owner and to the member. It holds no
 *    declaration of the graph: a Core that hosts a registered graph takes its
 *    policy from the chain and never fetches the graph's `_meta`;
 *  - the member dials the Core only and is never connected to the owner.
 *
 * The member subscribes as `POST /api/context-graph/subscribe` does
 * (admission, the subscription, then the catch-up job's definition fetch with
 * the admission's chain proof), and writes as the knowledge-asset routes do:
 * their preflight check, then create, write and share.
 *
 * Before the fix the definition fetch asked the connected peers only. The Core
 * served nothing, so the member held no definition and the routes refused
 * every write with CONTEXT_GRAPH_NOT_FOUND.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import type { DKGAgent } from '../src/index.js';
import { holdsAuthoritativePublicDefinitionV1 } from '../src/context-graph-meta-confirmation.js';
import {
  RealChainAgents,
  connectWithIdentify,
  dialableAddress,
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

describe('E2E: a member that reaches a registered public graph only through a Core (#3264)', () => {
  it('obtains the graph\'s definition with no connection to the owner, and its write into the graph is accepted', async () => {
    const core = await pool.create({
      name: 'CoreOnlyCore',
      operationalKey: HARDHAT_KEYS.CORE_OP,
      listenHost: '127.0.0.1',
      nodeRole: 'core',
    });
    await core.start();
    const owner = await startEdge('CoreOnlyOwner', OWNER_KEY, core);
    const member = await startEdge('CoreOnlyMember', MEMBER_KEY, core);
    const ownerAddress = owner.getDefaultAgentAddress()!.toLowerCase();
    const memberAddress = member.getDefaultAgentAddress()!.toLowerCase();

    // POST /api/context-graph/create with accessPolicy 0, publishPolicy 0 and register: true.
    const contextGraphId = `${ownerAddress}/core-only-member-${RUN}`;
    await owner.createContextGraph({
      id: contextGraphId,
      name: 'Core-only member E2E',
      description: '',
      accessPolicy: 0,
      callerAgentAddress: ownerAddress,
    });
    const registered = await owner.registerContextGraph(contextGraphId, {
      accessPolicy: 0,
      publishPolicy: 0,
      callerAgentAddress: ownerAddress,
    });
    const onChainId = String(registered.onChainId);
    expect(Number(onChainId)).toBeGreaterThan(0);

    // The topology the member meets: its one peer is the Core, which holds no
    // declaration of the graph; the owner is out of its reach.
    expect(isConnected(member, core), 'the member is connected to the Core').toBe(true);
    expect(isConnected(member, owner), 'the member is not connected to the owner').toBe(false);
    expect(await holdsAuthoritativePublicDefinitionV1(core.store, contextGraphId), 'the Core holds no definition').toBe(false);

    // POST /api/context-graph/subscribe: the admission proves the graph
    // registered and public on chain, the subscription carries its on-chain
    // id, and the catch-up job first fetches the definition with that proof.
    const admission = await member.resolveContextGraphSubscriptionBootstrapAuthority(contextGraphId, {
      callerAgentAddress: memberAddress,
      allowSubscriptionFallback: false,
    });
    expect(admission).toMatchObject({ outcome: 'allowed', source: 'registered-chain', reason: 'chain-public' });
    expect(admission.onChainId?.toString(10)).toBe(onChainId);
    member.subscribeToContextGraph(contextGraphId, { syncMode: 'always-on', onChainId });
    const fetched = await member.bootstrapRfc64CatalogContextGraphMetadataFromPeersV1(
      contextGraphId,
      undefined,
      { contextGraphId, onChainId },
    );

    // The definition comes from the chain registration: no peer the member
    // reaches holds a declaration.
    expect(fetched, 'how the member obtained the definition').toBe('chain-attested');
    await expect(holdsAuthoritativePublicDefinitionV1(member.store, contextGraphId), 'the member holds the definition').resolves.toBe(true);
    expect(isConnected(member, owner), 'the member never reached the owner').toBe(false);

    // The write routes' preflight: an unknown graph (no definition) is
    // refused with CONTEXT_GRAPH_NOT_FOUND before any write happens.
    const probe = await member.probeContextGraphWritePreflight(contextGraphId, { callerAgentAddress: memberAddress });
    expect(probe).toMatchObject({
      storeAvailable: true,
      exists: true,
      declarationFound: true,
      accessPolicy: 'public',
      callerAuthorized: true,
    });

    // POST /api/knowledge-assets, then .../swm/share: create, write and share
    // into the graph's shared memory.
    const assertionName = `core-only-member-${RUN}`;
    const subject = `urn:e2e:core-only-member:${RUN}`;
    const label = 'written by a member that reaches only a Core';
    await member.assertion.create(contextGraphId, assertionName);
    await member.assertion.write(contextGraphId, assertionName, [{ subject, predicate: NAME, object: `"${label}"` }]);
    const promoted = await member.assertion.promote(contextGraphId, assertionName);
    expect(promoted.promotedCount).toBeGreaterThan(0);
    const shared = await member.query(
      `SELECT ?name WHERE { <${subject}> <${NAME}> ?name }`,
      { contextGraphId, includeSharedMemory: true },
    );
    expect(shared.bindings.map((row) => String(row['name'])).some((name) => name.includes(label))).toBe(true);
  }, 300_000);
});
