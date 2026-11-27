// SPDX-License-Identifier: Apache-2.0

/**
 * E2E (#3264): a member that reaches a public Context Graph registered on
 * chain only through a Core obtains the graph's definition, and its write
 * into the graph passes the check the write routes make.
 *
 * Real agents over real libp2p on the shared Hardhat chain:
 *  - the owner creates a public graph with a curated publish policy and
 *    registers it on chain;
 *  - a Core is connected to the owner and to the member. It does not host
 *    the graph and holds no declaration of it;
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
 *
 * Two more cases cover a Core that comes to host such a graph and keeps the
 * owner's definition of it, sub-graph registrations included, which it then
 * serves to the member. Its agents run with data directories, as a daemon's
 * do: a registered graph is then catalog-authoritative and gets no legacy
 * durable sync of `_meta`, so the definition reaches the member only through
 * the metadata fetch. The owner registers the sub-graph `reports`, and the
 * member writes into it.
 *
 * Both start while nothing else lets the Core name the owner's node: its
 * agent registry has no entry for the owner yet and its rotating peer
 * selection misses the owner's node. The Core takes the owner's node for one
 * of the owner's nodes only from an envelope the owner's wallet signed that
 * names that node and that the node delivered itself:
 *  - the owner's flow as a relay-only owner runs it: the owner's only write
 *    before its publish is a share into the graph's root, which the catalog
 *    owns, so the share reaches no Core; then a real publish, whose
 *    StorageACK the Core signs. The owner's node offers the Cores it is
 *    connected to the tie when it shares and before it asks for StorageACKs;
 *  - the owner shares into its sub-graph first (that share also reaches the
 *    Core, as no Core subscribes to the graph yet), then the StorageACK gate
 *    runs with the owner's node as the requester.
 * In both the Core asks the owner's node for the definition at once instead
 * of waiting until its rotating peer selection reaches it. Once subscribed,
 * the member may dial the owner's node itself (a catalog replay towards the
 * graph's author), so the member's own log, not its connections, shows that
 * it took the definition and the sub-graph registration from the Core.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ethers } from 'ethers';
import type { DKGAgent } from '../src/index.js';
import { holdsAuthoritativePublicDefinitionV1 } from '../src/context-graph-meta-confirmation.js';
import {
  CORE_HOSTED_DEFINITION_RETRY_DELAYS_MS,
  coreHostedOwnerPeerTie,
  holdsCoreHostedOwnerDefinition,
} from '../src/core-hosted-definition.js';
import {
  RealChainAgents,
  connectWithIdentify,
  dialableAddress,
  pollUntil,
} from './_helpers/real-chain-agent.js';
import {
  REPORTS,
  definitionLog,
  expectFetchedFromTiedOwnerNode,
  isConnected,
  memberWritesIntoReports,
  subGraphNames,
} from './_helpers/core-hosted-definition-e2e.js';
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
const tempDirs: string[] = [];
let fileSnapshot: string;

/** A data directory for an agent that runs as a daemon's does (the hosting cases). */
async function dataDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `dkg-e2e-core-only-member-${prefix}-`));
  tempDirs.push(dir);
  return dir;
}

beforeAll(async () => {
  fileSnapshot = await takeSnapshot();
  // Registering a Context Graph pulls the registration deposit.
  const { hubAddress } = getSharedContext();
  const owner = new ethers.Wallet(OWNER_KEY);
  await mintTokens(createProvider(), hubAddress, HARDHAT_KEYS.DEPLOYER, owner.address, ethers.parseEther('50000000'));
});
// Stopping a Core and two Edges that still have sync and catalog work in flight can take more than the default
// 10 s hook budget on a slower runner; the other real-node suites give their teardown 120 s as well.
afterEach(async () => {
  vi.restoreAllMocks();
  await pool.stopAll();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
}, 120_000);
afterAll(async () => {
  await revertSnapshot(fileSnapshot);
});

/** An Edge that dials `core` at start and runs no mDNS: it reaches only the peers the test connects. */
async function startEdge(name: string, operationalKey: string, core: DKGAgent, withDataDir = false): Promise<DKGAgent> {
  const agent = await pool.create({
    name,
    operationalKey,
    listenHost: '127.0.0.1',
    ...(withDataDir ? { dataDir: await dataDir(name) } : {}),
    bootstrapPeers: [dialableAddress(core)],
  });
  await agent.start();
  await connectWithIdentify(agent, core);
  return agent;
}

/**
 * A Core, the owner and a member, each with a data directory, and the owner's
 * public graph with a curated publish policy, registered on chain, with the
 * sub-graph `reports` (POST /api/context-graph/create with register: true,
 * then POST /api/sub-graph/create). The member's one peer is the Core.
 */
async function ownerGraphWithReports(prefix: string, label: string) {
  const core = await pool.create({
    name: `${prefix}Core`,
    operationalKey: HARDHAT_KEYS.CORE_OP,
    listenHost: '127.0.0.1',
    dataDir: await dataDir(`${prefix}-core`),
    nodeRole: 'core',
  });
  await core.start();
  const owner = await startEdge(`${prefix}Owner`, OWNER_KEY, core, true);
  const member = await startEdge(`${prefix}Member`, MEMBER_KEY, core, true);
  const ownerAddress = owner.getDefaultAgentAddress()!.toLowerCase();
  const contextGraphId = `${ownerAddress}/${label}-${RUN}`;
  await owner.createContextGraph({
    id: contextGraphId,
    name: `${label} E2E`,
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
  expect(isConnected(member, core), 'the member is connected to the Core').toBe(true);
  expect(isConnected(member, owner), 'the member is not connected to the owner').toBe(false);
  expect(await holdsCoreHostedOwnerDefinition(core.store, contextGraphId, ownerAddress), 'the Core holds no definition yet').toBe(false);
  return { core, owner, member, ownerAddress, contextGraphId, onChainId };
}

/**
 * White-box: minutes after a graph is created a Core may not be able to name
 * the owner's node. Its agent registry has no entry for the owner yet, and its
 * peer selection's window (which rotates over every connected peer) does not
 * reach the owner's node in this attempt.
 */
function coreCannotNameOwnerNode(core: DKGAgent, member: DKGAgent): void {
  vi.spyOn(core.discovery, 'findAgents').mockResolvedValue([]);
  vi.spyOn(core, 'resolveRfc64UnregisteredAuthoritySeedPeersV1').mockReturnValue([member.peerId]);
}

/** The Core holds the owner's definition with its sub-graph, long before the first retry of an attempt that found nothing. */
async function expectCoreHoldsDefinitionSoonAfter(core: DKGAgent, contextGraphId: string, ownerAddress: string, verdictAt: number): Promise<void> {
  const held = await pollUntil(
    async () => await holdsCoreHostedOwnerDefinition(core.store, contextGraphId, ownerAddress)
      && (await subGraphNames(core, contextGraphId)).includes(REPORTS),
    (outcome) => outcome,
    10_000,
    50,
  );
  expect(held, 'the Core holds the owner\'s definition with its sub-graph').toBe(true);
  expect(Date.now() - verdictAt, 'how long after the verdict the Core held it').toBeLessThan(CORE_HOSTED_DEFINITION_RETRY_DELAYS_MS[0]!);
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

describe('E2E: a Core that comes to host a registered public graph asks the owner\'s node for its definition', () => {
  it('a Core asks the owner\'s node for the definition at once when the owner\'s only write before its publish is into the root', async () => {
    const { core, owner, member, ownerAddress, contextGraphId, onChainId } = await ownerGraphWithReports('RootFlow', 'root-flow');
    coreCannotNameOwnerNode(core, member);
    const lines = definitionLog(core, contextGraphId);
    const swmUpdates = vi.spyOn(core, 'handleSwmUpdate');
    const verdicts: Array<{ readonly at: number; readonly ok: boolean; readonly requester: string | undefined }> = [];
    const gate = core.ensureStorageAckVmPromotion.bind(core);
    vi.spyOn(core, 'ensureStorageAckVmPromotion').mockImplementation(async (request) => {
      const verdict = await gate(request);
      verdicts.push({ at: Date.now(), ok: verdict.ok, requester: request.publisherPeerId });
      return verdict;
    });

    // The owner's only write before its publish: an assertion shared into the
    // root, which the catalog owns. The share goes to no follower and no Core.
    const name = `root-manifest-${RUN}`;
    await owner.assertion.create(contextGraphId, name);
    await owner.assertion.write(
      contextGraphId,
      name,
      [{ subject: `urn:e2e:root-flow:${RUN}`, predicate: NAME, object: '"the owner\'s root entry"' }],
    );
    await owner.assertion.promote(contextGraphId, name);
    const tied = await pollUntil(() => coreHostedOwnerPeerTie(core, contextGraphId), (peerId) => peerId === owner.peerId, 30_000, 100);
    expect(tied, 'the owner\'s node offered the Core the tie when it shared').toBe(owner.peerId);
    expect(swmUpdates.mock.calls.filter(([, from]) => from === owner.peerId).length, 'only the offer reached the Core').toBeLessThanOrEqual(1);
    expect(await holdsCoreHostedOwnerDefinition(core.store, contextGraphId, ownerAddress), 'the Core holds no definition yet').toBe(false);

    // POST /api/knowledge-assets/:name/vm/publish: the owner asks the Core for its StorageACK.
    await pollUntil(() => (core as unknown as { vmReconcileRuntimeReady: boolean }).vmReconcileRuntimeReady, (ready) => ready, 60_000, 200);
    const published = await owner.publishFromFinalizedAssertion(contextGraphId, name);
    expect(published.status).toBe('confirmed');
    const verdict = verdicts.find((entry) => entry.ok);
    expect(verdict?.requester, 'the Core signed a StorageACK the owner\'s node asked for').toBe(owner.peerId);

    await expectCoreHoldsDefinitionSoonAfter(core, contextGraphId, ownerAddress, verdict!.at);
    await expectFetchedFromTiedOwnerNode(core, contextGraphId, lines, owner.peerId);

    await memberWritesIntoReports(member, { core, owner }, contextGraphId, onChainId);
  }, 300_000);

  it('a Core that signs the owner\'s StorageACK asks the owner\'s node for the definition at once after the owner shared into its sub-graph', async () => {
    const { core, owner, member, ownerAddress, contextGraphId, onChainId } = await ownerGraphWithReports('AckRequester', 'ack-requester');
    coreCannotNameOwnerNode(core, member);
    const lines = definitionLog(core, contextGraphId);

    // The owner shares its first assertion into the graph. No Core subscribes
    // to the graph, so the share also goes to the Core, which does not host
    // the graph yet and refuses it; the owner's signed share ties its node.
    const ownerScope = { subGraphName: REPORTS };
    await owner.assertion.create(contextGraphId, `owner-report-${RUN}`, ownerScope);
    await owner.assertion.write(
      contextGraphId,
      `owner-report-${RUN}`,
      [{ subject: `urn:e2e:ack-requester-owner:${RUN}`, predicate: NAME, object: '"the owner\'s report"' }],
      ownerScope,
    );
    await owner.assertion.promote(contextGraphId, `owner-report-${RUN}`, ownerScope);
    const tied = await pollUntil(() => coreHostedOwnerPeerTie(core, contextGraphId), (peerId) => peerId === owner.peerId, 30_000, 100);
    expect(tied, 'the owner\'s signed share tied its node on the Core').toBe(owner.peerId);
    expect(await holdsCoreHostedOwnerDefinition(core.store, contextGraphId, ownerAddress), 'the Core holds no definition yet').toBe(false);

    // The StorageACK finality gate, as the handler calls it for the owner's
    // publish: the requester is the owner's node.
    const verdict = await pollUntil(
      () => core.ensureStorageAckVmPromotion({
        contextGraphId: onChainId,
        swmGraphId: contextGraphId,
        operation: 'publish',
        publisherPeerId: owner.peerId,
      }),
      (outcome) => outcome.ok === true,
      60_000,
      1_000,
    );
    expect(verdict).toEqual({ ok: true });
    await expectCoreHoldsDefinitionSoonAfter(core, contextGraphId, ownerAddress, Date.now());
    await expectFetchedFromTiedOwnerNode(core, contextGraphId, lines, owner.peerId);
    expect(await subGraphNames(core, contextGraphId), 'the Core registered the owner\'s sub-graph').toEqual([REPORTS]);

    await memberWritesIntoReports(member, { core, owner }, contextGraphId, onChainId);
  }, 300_000);
});
