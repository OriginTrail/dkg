/**
 * E2E (#2827): a member joins a PUBLIC context graph that was never registered
 * on chain, then both sides share Shared Working Memory.
 *
 * Two real agents over real libp2p on the shared Hardhat chain, so the member
 * resolves authority through the finalized Context Graph index exactly like a
 * daemon does. Before the fix:
 *   - the member never installed the curator's allowlist (its post-approval
 *     metadata pull only accepted a private definition);
 *   - the curator's first share after the approval switched to sender-key
 *     encryption, the member rejected the key, and the promote failed;
 *   - the member's own shares never left working memory, because its SWM
 *     authority for a graph it did not create resolved as unavailable.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeTestKaNumberAllocator } from './_helpers/ka-allocator.js';
import { TEST_SNAPSHOT_CONFIG } from '../../../scripts/testing/snapshot-storage.js';
import { DKGAgent } from '../src/index.js';
import type { ContextGraphSubscriptionRecord } from '../src/index.js';
import {
  getSharedContext,
  takeSnapshot,
  revertSnapshot,
  HARDHAT_KEYS,
} from '../../chain/test/evm-test-context.js';
import { makeAdapterConfig } from '../../chain/test/hardhat-harness.js';
import { MemoryAuthorityIndexStore } from '../../chain/test/helpers/context-graph-authority-index.js';
import { EVMChainAdapter } from '../../chain/src/evm-adapter.js';

const NAME = 'http://schema.org/name';
const CURATOR_ENTITY = 'urn:dkg:e2e-2827:curator-after-join';
const MEMBER_ENTITY = 'urn:dkg:e2e-2827:member-after-join';

function sleep(ms: number) { return new Promise((resolve) => setTimeout(resolve, ms)); }

/**
 * A daemon wires the finalized Context Graph authority index into its chain
 * adapter; the plain test adapter does not, and without it a member resolves
 * authority through the legacy path and never reaches the #2827 failure.
 */
function createIndexedEVMAdapter(privateKey: string): EVMChainAdapter {
  const { rpcUrl, hubAddress } = getSharedContext();
  return new EVMChainAdapter({
    ...makeAdapterConfig(rpcUrl, hubAddress, privateKey),
    localContextGraphAuthorityIndexStore: new MemoryAuthorityIndexStore(),
  });
}

function makeChainConfig(operationalKey: string) {
  const { rpcUrl, hubAddress } = getSharedContext();
  return {
    rpcUrl,
    hubAddress,
    operationalKeys: [operationalKey],
    chainId: 'evm:31337',
  };
}

async function pollUntil<T>(
  fn: () => Promise<T>,
  pred: (value: T) => boolean,
  timeoutMs = 30_000,
  stepMs = 500,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = await fn();
  while (!pred(last) && Date.now() < deadline) {
    await sleep(stepMs);
    last = await fn();
  }
  return last;
}

async function sharedMemoryNames(agent: DKGAgent, contextGraphId: string, subject: string): Promise<string[]> {
  const result = await agent.query(
    `SELECT ?name WHERE { <${subject}> <${NAME}> ?name }`,
    { contextGraphId, includeSharedMemory: true },
  ).catch(() => ({ bindings: [] as Array<Record<string, unknown>> }));
  return result.bindings.map((row) => String(row['name']));
}

let fileSnapshot: string;
beforeAll(async () => {
  fileSnapshot = await takeSnapshot();
});
afterAll(async () => {
  await revertSnapshot(fileSnapshot);
});

// --- Step helpers: each names one phase and asserts its own outcome. ---

async function createPublicP2pGraph(curator: DKGAgent, contextGraphId: string, curatorAgent: string): Promise<void> {
  await curator.createContextGraph({
    id: contextGraphId,
    name: 'Public P2P join E2E',
    description: '',
    accessPolicy: 0,
    callerAgentAddress: curatorAgent,
  });
  expect(await curator.isCuratorOf(contextGraphId)).toBe(true);
}

/** The daemon's subscribe admission: prove finalized name absence, fetch the owner-signed seed, accept it. */
async function acceptOwnerSignedPolicy(member: DKGAgent, contextGraphId: string): Promise<void> {
  const admission = await member.resolveContextGraphSubscriptionBootstrapAuthority(contextGraphId);
  expect(admission.outcome, JSON.stringify(admission)).toBe('allowed');
  member.subscribeToContextGraph(contextGraphId, { syncMode: 'always-on' });
  await member.reconcileRfc64CatalogResponsibilityV1(contextGraphId);
  const accepted = await pollUntil(
    async () => member.hasAcceptedRfc64PublicUnregisteredAuthorityV1(contextGraphId),
    (value) => value === true,
    60_000,
    1_000,
  );
  expect(accepted, 'member accepted the owner-signed public policy').toBe(true);
}

async function joinAndApprove(input: {
  curator: DKGAgent;
  member: DKGAgent;
  contextGraphId: string;
  curatorAgent: string;
  memberAgent: string;
}): Promise<void> {
  const { curator, member, contextGraphId, curatorAgent, memberAgent } = input;
  const delegation = await member.signJoinRequest(contextGraphId);
  const forwarded = await member.forwardJoinRequest(contextGraphId, delegation, undefined, curator.peerId);
  expect(forwarded.delivered, `forward result: ${JSON.stringify(forwarded)}`).toBeGreaterThanOrEqual(1);
  await pollUntil(
    () => curator.listPendingJoinRequests(contextGraphId),
    (rows) => rows.some((row: any) => String(row.agentAddress).toLowerCase() === memberAgent),
  );
  await curator.approveJoinRequest(contextGraphId, memberAgent, curatorAgent);
  const status = await pollUntil(
    () => member.getJoinRequestStatus(contextGraphId, memberAgent),
    (value) => value === 'approved',
  );
  expect(status, 'join status on the member').toBe('approved');
}

/** The member's OWN projection is what its SWM gate reads; #2827 left it without an allowlist. */
async function expectMemberAllowlist(member: DKGAgent, contextGraphId: string, agents: string[]): Promise<void> {
  const allowed = await pollUntil(
    async () => (await member.getContextGraphAllowedAgents(contextGraphId).catch(() => []))
      .map((address) => address.toLowerCase()),
    (addresses) => agents.every((agent) => addresses.includes(agent)),
    60_000,
  );
  expect(allowed, 'member allowlist').toEqual(expect.arrayContaining(agents));
}

async function shareAndExpectDelivery(input: {
  from: DKGAgent;
  to: DKGAgent;
  contextGraphId: string;
  assertionName: string;
  subject: string;
  label: string;
}): Promise<void> {
  const { from, to, contextGraphId, assertionName, subject, label } = input;
  await from.assertion.create(contextGraphId, assertionName);
  await from.assertion.write(contextGraphId, assertionName, [
    { subject, predicate: NAME, object: `"${label}"` },
  ]);
  await from.assertion.promote(contextGraphId, assertionName);
  const names = await pollUntil(
    () => sharedMemoryNames(to, contextGraphId, subject),
    (values) => values.length > 0,
    150_000,
    2_000,
  );
  expect(names.some((name) => name.includes(label)), `${assertionName} delivered`).toBe(true);
}

describe('E2E: SWM after a join on a public, unregistered context graph (#2827)', () => {
  const tempDirs: string[] = [];
  const agents: DKGAgent[] = [];

  afterAll(async () => {
    for (const agent of agents) {
      try { await agent.stop(); } catch { /* already stopped */ }
    }
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  // One irreversible state machine, so one test: a failing phase stops the
  // scenario instead of cascading into later phases on half-built state.
  it('lets a join-approved member of a public P2P graph share SWM both ways, across a member restart', async () => {
    const curatorDataDir = await mkdtemp(join(tmpdir(), 'dkg-e2e-2827-curator-'));
    const memberDataDir = await mkdtemp(join(tmpdir(), 'dkg-e2e-2827-member-'));
    tempDirs.push(curatorDataDir, memberDataDir);
    const memberPersistedSubscriptions = new Map<string, ContextGraphSubscriptionRecord>();
    const createMember = (chainAdapter: EVMChainAdapter) => DKGAgent.create({
      ...TEST_SNAPSHOT_CONFIG,
      kaNumberAllocator: makeTestKaNumberAllocator(),
      name: 'PublicMember',
      listenPort: 0,
      skills: [],
      chainAdapter,
      nodeRole: 'edge',
      dataDir: memberDataDir,
      contextGraphSubscriptionStore: {
        loadAll: async () => [...memberPersistedSubscriptions.values()],
        save: async (record) => { memberPersistedSubscriptions.set(record.id, { ...record }); },
        delete: async (id) => { memberPersistedSubscriptions.delete(id); },
      },
      chainConfig: makeChainConfig(HARDHAT_KEYS.EXTRA1),
    });

    // Two edges on indexed chain adapters, with distinct operational keys (so
    // distinct default agents), connected over libp2p.
    const curatorChain = createIndexedEVMAdapter(HARDHAT_KEYS.CORE_OP);
    const memberChain = createIndexedEVMAdapter(HARDHAT_KEYS.EXTRA1);
    expect(curatorChain.contextGraphAuthorityIndexRevisionReader).toBeDefined();
    expect(memberChain.contextGraphAuthorityIndexRevisionReader).toBeDefined();
    const curator = await DKGAgent.create({
      ...TEST_SNAPSHOT_CONFIG,
      kaNumberAllocator: makeTestKaNumberAllocator(),
      name: 'PublicCurator',
      listenPort: 0,
      skills: [],
      chainAdapter: curatorChain,
      nodeRole: 'edge',
      dataDir: curatorDataDir,
      chainConfig: makeChainConfig(HARDHAT_KEYS.CORE_OP),
    });
    agents.push(curator);
    let member = await createMember(memberChain);
    agents.push(member);
    await curator.start();
    await member.start();
    await sleep(800);
    const curatorAddr = curator.multiaddrs.find((a) => a.includes('/tcp/') && !a.includes('/p2p-circuit'))!;
    await member.connectTo(curatorAddr);
    await sleep(1_500);
    expect(member.node.libp2p.getPeers().length).toBeGreaterThanOrEqual(1);

    const curatorAgent = curator.getDefaultAgentAddress()!.toLowerCase();
    const memberAgent = member.getDefaultAgentAddress()!.toLowerCase();
    expect(memberAgent).not.toBe(curatorAgent);
    const contextGraphId = `${curatorAgent}/public-p2p-join-e2e`;

    await createPublicP2pGraph(curator, contextGraphId, curatorAgent);
    await acceptOwnerSignedPolicy(member, contextGraphId);
    await joinAndApprove({ curator, member, contextGraphId, curatorAgent, memberAgent });
    await expectMemberAllowlist(member, contextGraphId, [curatorAgent, memberAgent]);
    await shareAndExpectDelivery({
      from: curator, to: member, contextGraphId,
      assertionName: 'curator-after-join', subject: CURATOR_ENTITY, label: 'Curator after join',
    });

    // The member restarts before it has authored anything here: restarting
    // after authoring hits a separate author-catalog projection failure
    // (#2832), not the #2827 defects.
    await member.stop();
    member = await createMember(createIndexedEVMAdapter(HARDHAT_KEYS.EXTRA1));
    agents.push(member);
    await member.start();
    await member.connectTo(curatorAddr);
    await expectMemberAllowlist(member, contextGraphId, [curatorAgent, memberAgent]);
    await shareAndExpectDelivery({
      from: member, to: curator, contextGraphId,
      assertionName: 'member-after-restart', subject: `${MEMBER_ENTITY}:after-restart`, label: 'Member after restart',
    });
    await shareAndExpectDelivery({
      from: curator, to: member, contextGraphId,
      assertionName: 'curator-after-restart', subject: `${CURATOR_ENTITY}:after-restart`, label: 'Curator after member restart',
    });
  }, 900_000);
});
