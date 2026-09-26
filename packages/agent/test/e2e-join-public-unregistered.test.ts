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

describe('E2E: SWM after a join on a public, unregistered context graph (#2827)', () => {
  // Separate operational keys give the two nodes distinct default agents.
  const curatorChain = createIndexedEVMAdapter(HARDHAT_KEYS.CORE_OP);
  const memberChain = createIndexedEVMAdapter(HARDHAT_KEYS.EXTRA1);
  let curator: DKGAgent;
  let member: DKGAgent;
  let contextGraphId: string;
  let curatorAgent: string;
  let memberAgent: string;
  let memberDataDir: string;
  let curatorAddr: string;
  const tempDirs: string[] = [];
  const memberPersistedSubscriptions = new Map<string, ContextGraphSubscriptionRecord>();

  function createMember(chainAdapter: EVMChainAdapter): Promise<DKGAgent> {
    return DKGAgent.create({
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
  }

  afterAll(async () => {
    try { await curator?.stop(); } catch { /* ignore */ }
    try { await member?.stop(); } catch { /* ignore */ }
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('boots two edge agents and connects them over libp2p', async () => {
    expect(curatorChain.contextGraphAuthorityIndexRevisionReader).toBeDefined();
    expect(memberChain.contextGraphAuthorityIndexRevisionReader).toBeDefined();
    const curatorDataDir = await mkdtemp(join(tmpdir(), 'dkg-e2e-2827-curator-'));
    memberDataDir = await mkdtemp(join(tmpdir(), 'dkg-e2e-2827-member-'));
    tempDirs.push(curatorDataDir, memberDataDir);
    curator = await DKGAgent.create({
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
    member = await createMember(memberChain);

    await curator.start();
    await member.start();
    await sleep(800);
    curatorAddr = curator.multiaddrs.find((a) => a.includes('/tcp/') && !a.includes('/p2p-circuit'))!;
    await member.connectTo(curatorAddr);
    await sleep(1_500);

    curatorAgent = curator.getDefaultAgentAddress()!.toLowerCase();
    memberAgent = member.getDefaultAgentAddress()!.toLowerCase();
    contextGraphId = `${curatorAgent}/public-p2p-join-e2e`;
    expect(member.node.libp2p.getPeers().length).toBeGreaterThanOrEqual(1);
    expect(memberAgent).not.toBe(curatorAgent);
  }, 30_000);

  it('the curator creates a PUBLIC graph without registering it on chain', async () => {
    await curator.createContextGraph({
      id: contextGraphId,
      name: 'Public P2P join E2E',
      description: '',
      accessPolicy: 0,
      callerAgentAddress: curatorAgent,
    });
    expect(await curator.isCuratorOf(contextGraphId)).toBe(true);
  }, 30_000);

  it('the member subscribes and accepts the owner-signed public policy', async () => {
    // The daemon's subscribe admission: prove finalized name absence, fetch the
    // owner-signed seed from the connected curator and accept it.
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
    expect(accepted).toBe(true);
  }, 75_000);

  it('the member joins and the curator approves', async () => {
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
    expect(status).toBe('approved');
  }, 60_000);

  it("the member installs the curator's allowlist", async () => {
    const allowed = await pollUntil(
      async () => (await member.getContextGraphAllowedAgents(contextGraphId).catch(() => []))
        .map((address) => address.toLowerCase()),
      (addresses) => addresses.includes(memberAgent) && addresses.includes(curatorAgent),
      60_000,
    );
    expect(allowed).toEqual(expect.arrayContaining([curatorAgent, memberAgent]));
  }, 75_000);

  it('the curator shares after the approval and the member receives it', async () => {
    await curator.assertion.create(contextGraphId, 'curator-after-join');
    await curator.assertion.write(contextGraphId, 'curator-after-join', [
      { subject: CURATOR_ENTITY, predicate: NAME, object: '"Curator after join"' },
    ]);
    await curator.assertion.promote(contextGraphId, 'curator-after-join');

    const names = await pollUntil(
      () => sharedMemoryNames(member, contextGraphId, CURATOR_ENTITY),
      (values) => values.length > 0,
      150_000,
      2_000,
    );
    expect(names.some((name) => name.includes('Curator after join'))).toBe(true);
  }, 180_000);

  // The member restarts before it has authored anything here. Restarting after
  // it authored a share hits a separate RFC-64 author-catalog projection
  // failure on the member (tracked in its own issue), not the #2827 defects.
  it('after a restart the member keeps its allowlist and shares in both directions', async () => {
    await member.stop();
    member = await createMember(createIndexedEVMAdapter(HARDHAT_KEYS.EXTRA1));
    await member.start();
    await member.connectTo(curatorAddr);

    const allowed = await pollUntil(
      async () => (await member.getContextGraphAllowedAgents(contextGraphId).catch(() => []))
        .map((address) => address.toLowerCase()),
      (addresses) => addresses.includes(memberAgent) && addresses.includes(curatorAgent),
      60_000,
    );
    expect(allowed).toEqual(expect.arrayContaining([curatorAgent, memberAgent]));

    const memberEntity = `${MEMBER_ENTITY}:after-restart`;
    await member.assertion.create(contextGraphId, 'member-after-restart');
    await member.assertion.write(contextGraphId, 'member-after-restart', [
      { subject: memberEntity, predicate: NAME, object: '"Member after restart"' },
    ]);
    await member.assertion.promote(contextGraphId, 'member-after-restart');
    const onCurator = await pollUntil(
      () => sharedMemoryNames(curator, contextGraphId, memberEntity),
      (values) => values.length > 0,
      150_000,
      2_000,
    );
    expect(onCurator.length).toBeGreaterThan(0);

    const curatorEntity = `${CURATOR_ENTITY}:after-restart`;
    await curator.assertion.create(contextGraphId, 'curator-after-restart');
    await curator.assertion.write(contextGraphId, 'curator-after-restart', [
      { subject: curatorEntity, predicate: NAME, object: '"Curator after member restart"' },
    ]);
    await curator.assertion.promote(contextGraphId, 'curator-after-restart');
    const onMember = await pollUntil(
      () => sharedMemoryNames(member, contextGraphId, curatorEntity),
      (values) => values.length > 0,
      150_000,
      2_000,
    );
    expect(onMember.length).toBeGreaterThan(0);
  }, 420_000);
});
