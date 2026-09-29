/**
 * The VM exact-recovery holder tier, wired through a real `DKGAgent`:
 * `recoverVmReconcileBatch` -> `refreshVmReconcileHolderTier` -> the roster
 * read by `vmReconcileObservedCandidatePeerIds`.
 *
 * Real: the agent, its phonebook store + `DiscoveryClient`, the chain mock's
 * identities, `FinalizationHandler` and the on-chain root check. Stubbed:
 * only the network edges (`ensurePeerConnected`, sync-protocol readiness and
 * the exact-fetch transport), exactly as `core-fills-gap.test.ts` does.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import { MockChainAdapter, buildKnowledgeAssetUal } from '@origintrail-official/dkg-chain';
import { computeFlatKCRootV10 } from '@origintrail-official/dkg-publisher';
import {
  contextGraphWorkspaceGraphUri,
  contextGraphWorkspaceMetaGraphUri,
  createOperationContext,
} from '@origintrail-official/dkg-core';
import type { Quad } from '@origintrail-official/dkg-storage';
import { DKGAgent } from '../src/index.js';
import { DKGAgentBase } from '../src/dkg-agent-base.js';
import { AGENT_REGISTRY_GRAPH, buildAgentProfile } from '../src/profile.js';
import { FinalizationHandler } from '../src/finalization-handler.js';
import type { OrdinalOutcome, OrdinalRecoveryTarget } from '../src/chain-reconciler.js';
import {
  VM_HOLDER_TIER_FAILURE_RETRY_MS,
  VM_HOLDER_TIER_RESOLUTION_TTL_MS,
} from '../src/vm-reconcile-holder-tier.js';

const DKG = 'https://dkg.network/ontology#';
const CG = '0x0000000000000000000000000000000000000001/holder-tier';
const OTHER_CG = '0x0000000000000000000000000000000000000001/holder-tier-other';
const SELF = '12D3KooWHolderTierLocalPeer';
const CONNECTED = '12D3KooWHolderTierConnectedEdge';
const HOLDER_A = '12D3KooWHolderTierCoreAAAA';
const HOLDER_B = '12D3KooWHolderTierCoreBBBB';

const wallet = (n: number): string => `0x${n.toString(16).padStart(40, '0')}`;

interface Profile {
  peerId: string;
  agentAddress?: string;
  nodeRole?: 'core' | 'edge';
  lastSeen?: string;
}

type Internals = {
  node: unknown;
  store: DKGAgent['store'];
  chain: MockChainAdapter;
  discovery: { findCoreAgentPeerHints: (...args: unknown[]) => Promise<unknown> };
  vmReconcileHolderTierByCg: Map<string, { peerIds: readonly string[]; resolvedAt: number; nextCheckAt: number }>;
  vmReconcileHolderHints: { invalidate(): void } | undefined;
  vmReconcileFetchCooldowns: Map<string, unknown>;
  vmReconcileRotationNow: () => number;
  vmReconcileCuratorPeersByCg: Map<string, string[]>;
  vmReconcileObservedCandidatePeerIds(cg: string): string[];
  refreshVmReconcileHolderTier(cg: string, options: { signal?: AbortSignal; isCurrent: () => boolean }): Promise<void>;
  recoverVmReconcileBatch(
    localCgId: string,
    onChainCgId: bigint,
    targets: readonly OrdinalRecoveryTarget[],
    headBlock: number | undefined,
    isTargetCurrent: () => boolean,
    signal?: AbortSignal,
  ): Promise<{ outcomes: Map<number, OrdinalOutcome> }>;
  scheduleVmRecoveryForResolvedCurators(cgs: readonly string[]): void;
  clearVmReconcileStateForContextGraph?(cg: string): void;
  closeVmReconcileRotationState(): void;
  subscribedContextGraphs: Map<string, unknown>;
};

const agents: DKGAgent[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  delete process.env.DKG_VM_RECONCILE_HOLDER_TIER;
  for (const agent of agents.splice(0)) await agent.stop().catch(() => undefined);
});

function target(ordinal = 0, kaId = String(ordinal + 100)): OrdinalRecoveryTarget {
  return {
    localCgId: CG,
    onChainCgId: '1',
    ordinal,
    ual: `did:dkg:base:84532/0x0000000000000000000000000000000000000001/${kaId}`,
    merkleRoot: `root-${kaId}`,
    kaId,
    reason: 'no-swm',
  };
}

async function seedProfiles(internals: Internals, profiles: readonly Profile[]): Promise<void> {
  const quads: Quad[] = [];
  for (const profile of profiles) {
    quads.push(...buildAgentProfile({
      peerId: profile.peerId,
      name: `node-${profile.peerId.slice(-4)}`,
      skills: [],
      nodeRole: profile.nodeRole ?? 'core',
      ...(profile.agentAddress === undefined ? {} : { agentAddress: profile.agentAddress }),
      lastSeen: profile.lastSeen ?? new Date().toISOString(),
    }).quads);
  }
  await internals.store.insert(quads);
}

interface Harness {
  agent: DKGAgent;
  internals: Internals;
  chain: MockChainAdapter;
  connected: Map<string, { toString(): string }>;
  dialed: string[];
  fetched: string[];
  /** Per-peer exact-fetch behaviour; defaults to a clean absence. */
  onFetch: Map<string, () => Promise<'found' | 'clean-absent'> | 'found' | 'clean-absent'>;
}

/**
 * An agent whose ShardingTable is `table`, whose chain knows `wallets`, and
 * whose local phonebook holds `profiles`. `connected` peers are already dialed.
 */
async function harness(options: {
  table?: bigint[];
  wallets?: Record<string, bigint>;
  profiles?: Profile[];
  connected?: string[];
  policy?: 'public' | 'not-public' | 'unknown';
  curators?: string[];
}): Promise<Harness> {
  const chain = new MockChainAdapter();
  for (const [address, identityId] of Object.entries(options.wallets ?? {})) {
    chain.seedIdentity(address, identityId);
  }
  chain.listDesignatableNodes = async () => (options.table ?? []).map((identityId) => ({
    nodeId: `0x${identityId.toString(16)}`,
    identityId,
    ask: 1n,
    stake: 1n,
  }));
  const agent = await DKGAgent.create({ name: 'HolderTierAgent', chainAdapter: chain });
  agents.push(agent);
  const internals = agent as unknown as Internals;
  await seedProfiles(internals, options.profiles ?? []);

  const connected = new Map<string, { toString(): string }>(
    (options.connected ?? []).map((peerId) => [peerId, { toString: () => peerId }]),
  );
  internals.node = {
    peerId: SELF,
    libp2p: { getConnections: () => [...connected.values()].map((remotePeer) => ({ remotePeer })) },
  };
  const h: Harness = { agent, internals, chain, connected, dialed: [], fetched: [], onFetch: new Map() };
  const stubs = internals as unknown as Record<string, unknown>;
  stubs.readAgentsPhonebookAccessPolicy = async () => options.policy ?? 'public';
  stubs.resolveCuratorPeerIdsForCg = async () => ({
    peerIds: options.curators ?? [],
    curatorIsLocal: false,
    legacyTripleResolved: false,
  });
  stubs.resolvePreferredSyncPeerId = async () => undefined;
  stubs.requestOnDemandAgentsPhonebook = () => undefined;
  stubs.selectCatchupPeers = (peers: Array<{ toString(): string }>) => peers;
  stubs.waitForSyncProtocol = async () => true;
  stubs.ensurePeerAdmittedForRecovery = async () => true;
  stubs.ensurePeerConnected = async (peerId: string) => {
    h.dialed.push(peerId);
    connected.set(peerId, { toString: () => peerId });
  };
  stubs.syncExactKnowledgeAssetsFromPeerDetailed = async (peerId: string) => {
    h.fetched.push(peerId);
    const disposition = await (h.onFetch.get(peerId)?.() ?? 'clean-absent');
    const found = disposition === 'found';
    return {
      result: {
        fetchedDataTriples: found ? 1 : 0,
        fetchedMetaTriples: found ? 8 : 0,
        insertedTriples: found ? 9 : 0,
        failedPeers: 0,
        failedPhases: 0,
        deferredBackpressure: 0,
      },
      disposition,
    };
  };
  return h;
}

/** `reconcileChainOrdinal` for a fixture where `holder` is the only peer with the asset. */
function reconcilesOnceFetchedFrom(h: Harness, holder: string, recovery: OrdinalRecoveryTarget): void {
  (h.internals as unknown as Record<string, unknown>).reconcileChainOrdinal = async () => (
    h.fetched.includes(holder)
      ? { status: 'reconciled', blockNumber: 100 } satisfies OrdinalOutcome
      : { status: 'pending', recovery } satisfies OrdinalOutcome
  );
}

async function pass(h: Harness, recovery = target()): Promise<OrdinalOutcome | undefined> {
  const result = await h.internals.recoverVmReconcileBatch(CG, 1n, [recovery], 100, () => true);
  // The per-graph fetch cooldown is a separate, already-tested damper.
  h.internals.vmReconcileFetchCooldowns.delete(CG);
  return result.outcomes.get(recovery.ordinal);
}

describe('VM exact-recovery holder tier (agent wiring)', () => {
  it('dials and fetches from a ShardingTable holder known only through a bound phonebook hint', async () => {
    const h = await harness({
      table: [7n],
      wallets: { [wallet(0xa1)]: 7n },
      profiles: [{ peerId: HOLDER_A, agentAddress: wallet(0xa1) }],
      connected: [CONNECTED],
    });
    const recovery = target();
    h.onFetch.set(HOLDER_A, () => 'found');
    reconcilesOnceFetchedFrom(h, HOLDER_A, recovery);

    // The connected edge answers cleanly first; the unconnected holder is next.
    expect(await pass(h)).toMatchObject({ status: 'pending' });
    expect(h.fetched).toEqual([CONNECTED]);
    expect(h.dialed).toEqual([]);
    expect(h.internals.vmReconcileObservedCandidatePeerIds(CG)).toEqual([CONNECTED, HOLDER_A]);

    expect(await pass(h)).toEqual({ status: 'reconciled', blockNumber: 100 });
    expect(h.dialed).toEqual([HOLDER_A]);
    expect(h.fetched).toEqual([CONNECTED, HOLDER_A]);
  });

  it('never dials a profile without a bound operational wallet, or one outside the ShardingTable', async () => {
    const h = await harness({
      table: [7n],
      wallets: {
        [wallet(0xa1)]: 7n, // bound and staked: the only real holder
        [wallet(0xb2)]: 99n, // bound, but staked outside this ShardingTable
        [wallet(0xd4)]: 7n, // staked, but its profile claims the edge role
      },
      profiles: [
        { peerId: HOLDER_A, agentAddress: wallet(0xa1) },
        { peerId: '12D3KooWNoWalletAAAAAAAA' },
        { peerId: '12D3KooWOutsideTableBBBB', agentAddress: wallet(0xb2) },
        { peerId: '12D3KooWUnregisteredCCCC', agentAddress: wallet(0xc3) },
        { peerId: '12D3KooWEdgeRoleDDDDDDDD', agentAddress: wallet(0xd4), nodeRole: 'edge' },
      ],
      connected: [CONNECTED],
    });
    // Profiles that name nothing verifiable, however they are spelled.
    await h.internals.store.insert([
      { subject: 'did:dkg:agent:empty', predicate: `${DKG}peerId`, object: '"12D3KooWEmptyAddressEEEE"', graph: AGENT_REGISTRY_GRAPH },
      { subject: 'did:dkg:agent:empty', predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: `${DKG}Agent`, graph: AGENT_REGISTRY_GRAPH },
      { subject: 'did:dkg:agent:empty', predicate: `${DKG}nodeRole`, object: '"core"', graph: AGENT_REGISTRY_GRAPH },
      { subject: 'did:dkg:agent:empty', predicate: `${DKG}agentAddress`, object: '""', graph: AGENT_REGISTRY_GRAPH },
      { subject: 'did:dkg:agent:junk', predicate: `${DKG}peerId`, object: '"12D3KooWJunkAddressFFFFF"', graph: AGENT_REGISTRY_GRAPH },
      { subject: 'did:dkg:agent:junk', predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: `${DKG}Agent`, graph: AGENT_REGISTRY_GRAPH },
      { subject: 'did:dkg:agent:junk', predicate: `${DKG}nodeRole`, object: '"core"', graph: AGENT_REGISTRY_GRAPH },
      { subject: 'did:dkg:agent:junk', predicate: `${DKG}agentAddress`, object: '"not-a-wallet"', graph: AGENT_REGISTRY_GRAPH },
    ]);
    const recovery = target();
    h.onFetch.set(HOLDER_A, () => 'found');
    reconcilesOnceFetchedFrom(h, HOLDER_A, recovery);

    await pass(h);
    await pass(h);

    // Bound to a ShardingTable identity: reached and fetched from.
    expect(h.dialed).toEqual([HOLDER_A]);
    expect(h.fetched).toEqual([CONNECTED, HOLDER_A]);
    // Every unverifiable profile stayed out of the roster altogether.
    expect(h.internals.vmReconcileObservedCandidatePeerIds(CG)).toEqual([CONNECTED, HOLDER_A]);
  });

  describe('falls back to the curator and connected-peer tiers when a fact is unavailable', () => {
    const base = {
      table: [7n],
      wallets: { [wallet(0xa1)]: 7n },
      profiles: [{ peerId: HOLDER_A, agentAddress: wallet(0xa1) }],
      connected: [CONNECTED],
    };
    // Preservation tests: driven only through the recovery pass, so they pass on
    // the code before the holder tier by design. Test 1 above is the positive
    // control (same fixture, nothing sabotaged: the holder IS reached).
    it.each([
      ['the chain has no ShardingTable read', async (h: Harness) => {
        Object.defineProperty(h.chain, 'listDesignatableNodes', { value: undefined, configurable: true });
      }],
      ['the ShardingTable read fails', async (h: Harness) => {
        h.chain.listDesignatableNodes = async () => { throw new Error('rpc down'); };
      }],
      ['the chain cannot resolve a wallet to an identity', async (h: Harness) => {
        Object.defineProperty(h.chain, 'getIdentityIdForAddress', { value: undefined, configurable: true });
      }],
      ['the wallet-to-identity read fails', async (h: Harness) => {
        h.chain.getIdentityIdForAddress = async () => { throw new Error('rpc down'); };
      }],
      ['the phonebook read fails', async (h: Harness) => {
        h.internals.discovery.findCoreAgentPeerHints = async () => { throw new Error('store down'); };
      }],
      ['the graph policy cannot be read', async (h: Harness) => {
        (h.internals as unknown as Record<string, unknown>).readAgentsPhonebookAccessPolicy = async () => 'unknown';
      }],
      ['the graph is not public', async (h: Harness) => {
        (h.internals as unknown as Record<string, unknown>).readAgentsPhonebookAccessPolicy = async () => 'not-public';
      }],
      ['the policy read throws', async (h: Harness) => {
        (h.internals as unknown as Record<string, unknown>).readAgentsPhonebookAccessPolicy = async () => { throw new Error('boom'); };
      }],
      ['the operator disabled the tier', async () => { process.env.DKG_VM_RECONCILE_HOLDER_TIER = '0'; }],
    ] as const)('when %s', async (_label, sabotage) => {
      const h = await harness(base);
      await sabotage(h);
      const recovery = target();
      reconcilesOnceFetchedFrom(h, HOLDER_A, recovery);

      // Passes still run over the connected peers alone, dialing nothing new.
      await pass(h);
      await pass(h);
      expect(h.internals.vmReconcileObservedCandidatePeerIds(CG)).toEqual([CONNECTED]);
      expect(h.dialed).toEqual([]);
      expect(h.fetched).toEqual([CONNECTED]);
    });

    it('keeps the roster byte-identical to the two existing tiers when there is no hint at all', async () => {
      const h = await harness({ ...base, profiles: [], curators: ['12D3KooWCuratorOne', '12D3KooWCuratorTwo'] });
      h.internals.vmReconcileCuratorPeersByCg.set(CG, ['12D3KooWCuratorTwo', '12D3KooWCuratorOne']);
      const before = h.internals.vmReconcileObservedCandidatePeerIds(CG);
      await pass(h);
      // The pass re-resolves curators (sorted); the connected tier follows them.
      expect(h.internals.vmReconcileObservedCandidatePeerIds(CG)).toEqual([
        '12D3KooWCuratorOne', '12D3KooWCuratorTwo', CONNECTED,
      ]);
      expect(before).toEqual(['12D3KooWCuratorTwo', '12D3KooWCuratorOne', CONNECTED]);
    });
  });

  it('appends holders behind the curator and connected tiers and never displaces either', async () => {
    const roster = 5;
    const descriptor = Object.getOwnPropertyDescriptor(DKGAgentBase, 'VM_RECONCILE_EXACT_ROSTER_MAX')!;
    Object.defineProperty(DKGAgentBase, 'VM_RECONCILE_EXACT_ROSTER_MAX', { ...descriptor, value: roster });
    try {
      const h = await harness({
        table: [7n, 8n],
        wallets: { [wallet(0xa1)]: 7n, [wallet(0xb2)]: 8n },
        profiles: [
          { peerId: HOLDER_A, agentAddress: wallet(0xa1) },
          { peerId: HOLDER_B, agentAddress: wallet(0xb2) },
        ],
        connected: ['12D3KooWConnected1', '12D3KooWConnected2'],
      });
      h.internals.vmReconcileCuratorPeersByCg.set(CG, ['12D3KooWCurator1', '12D3KooWCurator2']);
      const existing = h.internals.vmReconcileObservedCandidatePeerIds(CG);
      expect(existing).toEqual([
        '12D3KooWCurator1', '12D3KooWCurator2', '12D3KooWConnected1', '12D3KooWConnected2',
      ]);

      await h.internals.refreshVmReconcileHolderTier(CG, { isCurrent: () => true });
      // One free slot: the existing four keep their place and order.
      expect(h.internals.vmReconcileObservedCandidatePeerIds(CG)).toEqual([...existing, HOLDER_A]);

      // A full roster gains nothing and loses nothing.
      h.internals.vmReconcileCuratorPeersByCg.set(CG, [
        '12D3KooWCurator1', '12D3KooWCurator2', '12D3KooWCurator3',
      ]);
      expect(h.internals.vmReconcileObservedCandidatePeerIds(CG)).toEqual([
        '12D3KooWCurator1', '12D3KooWCurator2', '12D3KooWCurator3',
        '12D3KooWConnected1', '12D3KooWConnected2',
      ]);
    } finally {
      Object.defineProperty(DKGAgentBase, 'VM_RECONCILE_EXACT_ROSTER_MAX', descriptor);
    }
  });

  it('adds hinted holders when the node has no libp2p connection view at all', async () => {
    const h = await harness({
      table: [7n],
      wallets: { [wallet(0xa1)]: 7n },
      profiles: [{ peerId: HOLDER_A, agentAddress: wallet(0xa1) }],
    });
    h.internals.node = { peerId: SELF };
    h.internals.vmReconcileCuratorPeersByCg.set(CG, ['12D3KooWCurator1']);
    await h.internals.refreshVmReconcileHolderTier(CG, { isCurrent: () => true });
    expect(h.internals.vmReconcileObservedCandidatePeerIds(CG)).toEqual(['12D3KooWCurator1', HOLDER_A]);
  });

  it('answers a hinted holder that is already connected from the connected tier, not twice', async () => {
    const h = await harness({
      table: [7n],
      wallets: { [wallet(0xa1)]: 7n },
      profiles: [{ peerId: HOLDER_A, agentAddress: wallet(0xa1) }],
      connected: [HOLDER_A, CONNECTED],
    });
    await h.internals.refreshVmReconcileHolderTier(CG, { isCurrent: () => true });
    expect(h.internals.vmReconcileObservedCandidatePeerIds(CG)).toEqual([CONNECTED, HOLDER_A]);
  });

  it('shares one chain read across graphs but keeps each graph\'s tier its own', async () => {
    const h = await harness({
      table: [7n],
      wallets: { [wallet(0xa1)]: 7n },
      profiles: [{ peerId: HOLDER_A, agentAddress: wallet(0xa1) }],
      connected: [CONNECTED],
    });
    const listTable = vi.spyOn(h.chain, 'listDesignatableNodes');
    await h.internals.refreshVmReconcileHolderTier(CG, { isCurrent: () => true });
    await h.internals.refreshVmReconcileHolderTier(OTHER_CG, { isCurrent: () => true });
    expect(listTable).toHaveBeenCalledTimes(1);
    expect(h.internals.vmReconcileObservedCandidatePeerIds(OTHER_CG)).toEqual([CONNECTED, HOLDER_A]);

    // A private graph gets nothing, without disturbing the public one.
    (h.internals as unknown as Record<string, unknown>).readAgentsPhonebookAccessPolicy = async (cg: string) => (
      cg === OTHER_CG ? 'not-public' : 'public'
    );
    h.internals.vmReconcileHolderTierByCg.delete(OTHER_CG);
    await h.internals.refreshVmReconcileHolderTier(OTHER_CG, { isCurrent: () => true });
    expect(h.internals.vmReconcileObservedCandidatePeerIds(OTHER_CG)).toEqual([CONNECTED]);
    expect(h.internals.vmReconcileObservedCandidatePeerIds(CG)).toEqual([CONNECTED, HOLDER_A]);
  });

  it('re-reads only after the entry\'s cadence, and sooner after an unavailable read', async () => {
    const h = await harness({
      table: [7n],
      wallets: { [wallet(0xa1)]: 7n },
      profiles: [{ peerId: HOLDER_A, agentAddress: wallet(0xa1) }],
      connected: [CONNECTED],
    });
    let now = 1_000;
    h.internals.vmReconcileRotationNow = () => now;
    const policy = vi.fn(async () => 'public' as const);
    (h.internals as unknown as Record<string, unknown>).readAgentsPhonebookAccessPolicy = policy;
    const refresh = () => h.internals.refreshVmReconcileHolderTier(CG, { isCurrent: () => true });

    await refresh();
    now += VM_HOLDER_TIER_RESOLUTION_TTL_MS - 1;
    await refresh();
    expect(policy).toHaveBeenCalledTimes(1);

    // The chain drops out: the previous set survives a short outage, on the shorter retry spacing.
    now += 1;
    h.chain.listDesignatableNodes = async () => { throw new Error('rpc down'); };
    h.internals.vmReconcileHolderHints!.invalidate();
    await refresh();
    expect(policy).toHaveBeenCalledTimes(2);
    expect(h.internals.vmReconcileObservedCandidatePeerIds(CG)).toEqual([CONNECTED, HOLDER_A]);
    now += VM_HOLDER_TIER_FAILURE_RETRY_MS - 1;
    await refresh();
    expect(policy).toHaveBeenCalledTimes(2);
    now += 1;
    await refresh();
    expect(policy).toHaveBeenCalledTimes(3);
  });

  it('writes nothing for a lifecycle that ended while the read was pending', async () => {
    const h = await harness({
      table: [7n],
      wallets: { [wallet(0xa1)]: 7n },
      profiles: [{ peerId: HOLDER_A, agentAddress: wallet(0xa1) }],
      connected: [CONNECTED],
    });
    await h.internals.refreshVmReconcileHolderTier(CG, { isCurrent: () => false });
    expect(h.internals.vmReconcileHolderTierByCg.has(CG)).toBe(false);
    expect(h.internals.vmReconcileObservedCandidatePeerIds(CG)).toEqual([CONNECTED]);

    const controller = new AbortController();
    (h.internals as unknown as Record<string, unknown>).readAgentsPhonebookAccessPolicy = async () => {
      controller.abort(new Error('stopped'));
      return 'public';
    };
    await h.internals.refreshVmReconcileHolderTier(CG, {
      signal: controller.signal,
      isCurrent: () => !controller.signal.aborted,
    });
    expect(h.internals.vmReconcileHolderTierByCg.has(CG)).toBe(false);
  });

  it('forgets a graph\'s tier with the rest of its recovery state and on close', async () => {
    const h = await harness({
      table: [7n],
      wallets: { [wallet(0xa1)]: 7n },
      profiles: [{ peerId: HOLDER_A, agentAddress: wallet(0xa1) }],
      connected: [CONNECTED],
    });
    h.internals.subscribedContextGraphs.set(CG, { subscribed: true });
    await h.internals.refreshVmReconcileHolderTier(CG, { isCurrent: () => true });
    expect(h.internals.vmReconcileHolderTierByCg.get(CG)?.peerIds).toEqual([HOLDER_A]);

    // A phonebook arrival makes a cached answer stale: the graph re-reads.
    h.internals.scheduleVmRecoveryForResolvedCurators([CG]);
    expect(h.internals.vmReconcileHolderTierByCg.has(CG)).toBe(false);
    await h.internals.refreshVmReconcileHolderTier(CG, { isCurrent: () => true });
    expect(h.internals.vmReconcileHolderTierByCg.get(CG)?.peerIds).toEqual([HOLDER_A]);

    h.internals.closeVmReconcileRotationState();
    expect(h.internals.vmReconcileHolderTierByCg.size).toBe(0);
  });

  it('bounds the per-graph tiers it remembers with the other per-graph recovery state', async () => {
    const h = await harness({ table: [], connected: [CONNECTED] });
    const limit = DKGAgentBase.VM_RECONCILE_CG_STATE_MAX_ENTRIES;
    for (let i = 0; i < limit + 3; i += 1) {
      h.internals.vmReconcileHolderTierByCg.set(`cg-${i}`, { peerIds: [], resolvedAt: 0, nextCheckAt: 0 });
    }
    (h.agent as unknown as { pruneVmReconcileState(): void }).pruneVmReconcileState();
    expect(h.internals.vmReconcileHolderTierByCg.size).toBe(limit);
    expect(h.internals.vmReconcileHolderTierByCg.has('cg-0')).toBe(false);
    expect(h.internals.vmReconcileHolderTierByCg.has(`cg-${limit + 2}`)).toBe(true);
  });

  describe('data from a hinted holder is verified against the on-chain root like any other', () => {
    const LOCAL_CG = CG;
    const ON_CHAIN_CG = 1n;
    const ENTITY = 'urn:fact:holder-tier-octopus';
    const KA_ID = 701n;

    const quadFor = (value: string) => ({
      subject: ENTITY, predicate: 'http://schema.org/name', object: `"${value}"`, graph: '',
    });

    /** What a holder's exact fetch leaves in the local shared-memory snapshot. */
    async function deliverSnapshot(store: DKGAgent['store'], value: string): Promise<void> {
      await store.insert([
        { subject: ENTITY, predicate: 'http://schema.org/name', object: `"${value}"`, graph: contextGraphWorkspaceGraphUri(LOCAL_CG) },
        {
          subject: `urn:dkg:share:${ENTITY}`,
          predicate: 'http://dkg.io/ontology/rootEntity',
          object: ENTITY,
          graph: contextGraphWorkspaceMetaGraphUri(LOCAL_CG),
        },
      ]);
    }

    async function inVm(store: DKGAgent['store'], value: string): Promise<boolean> {
      const result = await store.query(
        `ASK { GRAPH <did:dkg:context-graph:${LOCAL_CG}/context/${ON_CHAIN_CG}> `
        + `{ <${ENTITY}> <http://schema.org/name> "${value}" } }`,
      );
      return result.type === 'boolean' && result.value;
    }

    /**
     * A fixture where the only peer the edge can reach is the hinted one. Its
     * transport hands over `delivered`; everything after that (chain root,
     * publisher, `FinalizationHandler`) is the real thing.
     */
    async function rootChecked(delivered: string) {
      const h = await harness({
        table: [7n],
        wallets: { [wallet(0xa1)]: 7n },
        profiles: [{ peerId: HOLDER_A, agentAddress: wallet(0xa1) }],
      });
      const chainRoot = computeFlatKCRootV10([quadFor('Octopuses have three hearts')], []);
      h.chain.__registerKC({
        kaId: KA_ID, contextGraphId: ON_CHAIN_CG, merkleRootHex: ethers.hexlify(chainRoot), chunks: [],
      });
      const handler = new FinalizationHandler(h.internals.store, h.chain);
      const storageAddress = await h.chain.getDKGKnowledgeAssetsAddress();
      const recovery: OrdinalRecoveryTarget = {
        ...target(0, KA_ID.toString()),
        ual: buildKnowledgeAssetUal(h.chain.chainId, storageAddress, KA_ID),
      };
      h.onFetch.set(HOLDER_A, async () => {
        await deliverSnapshot(h.internals.store, delivered);
        return 'found';
      });
      // The real `reconcileChainOrdinal` reads the chain root and hands the
      // local snapshot to this handler; mirrored here as `chain-reconcile-e2e` does.
      (h.internals as unknown as Record<string, unknown>).reconcileChainOrdinal = async (): Promise<OrdinalOutcome> => {
        const outcome = await handler.handleChainReconciledKC({
          contextGraphId: LOCAL_CG,
          onChainCgId: ON_CHAIN_CG.toString(),
          ual: recovery.ual,
          merkleRoot: await h.chain.getLatestMerkleRoot(KA_ID),
          publisherAddress: await h.chain.getLatestMerkleRootPublisher(KA_ID),
          kaId: KA_ID,
          versionBlock: 100,
        }, createOperationContext('system'));
        return outcome === 'promoted' || outcome === 'already-confirmed'
          ? { status: 'reconciled', blockNumber: 100 }
          : { status: 'pending', recovery };
      };
      return { h, recovery };
    }

    it('rejects content a hinted holder serves that fails the on-chain root check', async () => {
      const { h, recovery } = await rootChecked('Octopuses have two hearts');
      const outcome = await pass(h, recovery);
      // The hinted peer really was dialed and asked, and claimed to have it...
      expect(h.dialed).toEqual([HOLDER_A]);
      expect(h.fetched).toEqual([HOLDER_A]);
      // ...but nothing it served reached Verifiable Memory.
      expect(outcome).toMatchObject({ status: 'pending' });
      expect(await inVm(h.internals.store, 'Octopuses have two hearts')).toBe(false);
      expect(await inVm(h.internals.store, 'Octopuses have three hearts')).toBe(false);
    });

    it('promotes the same hinted holder\'s content once it matches the on-chain root', async () => {
      const { h, recovery } = await rootChecked('Octopuses have three hearts');
      expect(await pass(h, recovery)).toEqual({ status: 'reconciled', blockNumber: 100 });
      expect(h.dialed).toEqual([HOLDER_A]);
      expect(await inVm(h.internals.store, 'Octopuses have three hearts')).toBe(true);
    });
  });
});
