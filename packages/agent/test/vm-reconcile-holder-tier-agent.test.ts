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
  createGraphKnowledgeAssetScope,
  createOperationContext,
} from '@origintrail-official/dkg-core';
import type { Quad } from '@origintrail-official/dkg-storage';
import { DKGAgent } from '../src/index.js';
import { DKGAgentBase } from '../src/dkg-agent-base.js';
import { AGENT_REGISTRY_GRAPH, buildAgentProfile } from '../src/profile.js';
import { FinalizationHandler } from '../src/finalization-handler.js';
import { buildReconciledKnowledgeAssetUal, packKnowledgeAssetIdFromIdentity } from '../src/ka-identity.js';
import {
  graphHoldsTriple,
  knowledgeAssetVerifiedMemoryGraph,
  stageKnowledgeAssetInSharedMemory,
} from './_helpers/staged-knowledge-asset.js';
import type { OrdinalOutcome, OrdinalRecoveryTarget } from '../src/chain-reconciler.js';
import {
  VM_HOLDER_TIER_FAILURE_RETRY_MS,
  VM_HOLDER_TIER_MAX_IDENTITY_LOOKUPS,
  VM_HOLDER_TIER_POLICY_TIMEOUT_MS,
  VM_HOLDER_TIER_RESOLUTION_TTL_MS,
  VM_HOLDER_TIER_STALE_MAX_MS,
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
  discovery: { findCoreAgentPeerHintPage: (...args: unknown[]) => Promise<unknown> };
  /** The holder-tier controller; undefined until the first refresh creates it. */
  vmReconcileHolderTier: {
    entryFor(cg: string): { peerIds: readonly string[]; resolvedAt: number; nextCheckAt: number } | undefined;
    peerIdsFor(cg: string): readonly string[];
    deleteGraph(cg: string): void;
    invalidateHints(cgs: readonly string[]): void;
    close(): void;
  } | undefined;
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
  vi.useRealTimers();
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
  /** Extra `DKGAgent.create` options, e.g. the typed holder-tier switch. */
  agentConfig?: Partial<Parameters<typeof DKGAgent.create>[0]>;
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
  const agent = await DKGAgent.create({
    name: 'HolderTierAgent',
    chainAdapter: chain,
    ...options.agentConfig,
  });
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
  // The recovery executor counts a fetch only once the transport reports that
  // work started (`onWorkStarted`, argument four) and the result says it was admitted.
  stubs.syncExactKnowledgeAssetsFromPeerDetailed = async (
    peerId: string,
    _cg: string,
    _uals: unknown,
    options?: { onWorkStarted?: () => void },
  ) => {
    options?.onWorkStarted?.();
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
      admission: 'work-started' as const,
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
    const info = vi.spyOn((h.agent as unknown as { log: { info: (...args: unknown[]) => void } }).log, 'info');
    const logged = () => info.mock.calls.map((call) => String(call[1]));

    // The connected edge answers cleanly first; the unconnected holder is next.
    expect(await pass(h)).toMatchObject({ status: 'pending' });
    expect(h.fetched).toEqual([CONNECTED]);
    expect(h.dialed).toEqual([]);
    expect(h.internals.vmReconcileObservedCandidatePeerIds(CG)).toEqual([CONNECTED, HOLDER_A]);
    // The resolution names the hinted peers (short ids), so a log reader can follow them.
    expect(logged().filter((line) => line.includes('VM exact fetch holder tier'))).toEqual([
      expect.stringContaining(`1 hinted ShardingTable holder(s) [peers=${HOLDER_A.slice(-8)}] across 1 identity`),
    ]);
    expect(logged().some((line) => line.includes('dialing hinted ShardingTable holder'))).toBe(false);

    expect(await pass(h)).toEqual({ status: 'reconciled', blockNumber: 100 });
    expect(h.dialed).toEqual([HOLDER_A]);
    expect(h.fetched).toEqual([CONNECTED, HOLDER_A]);
    // The pass says it dialed the unconnected hinted holder itself, and only that one.
    expect(logged().filter((line) => line.includes('dialing hinted ShardingTable holder'))).toEqual([
      `VM exact fetch dialing hinted ShardingTable holder ${HOLDER_A.slice(-8)} for "${CG}": not connected`,
    ]);
  });

  it('does not claim to dial a hinted holder that something else connected after the pass began', async () => {
    const h = await harness({
      table: [7n],
      wallets: { [wallet(0xa1)]: 7n },
      profiles: [{ peerId: HOLDER_A, agentAddress: wallet(0xa1) }],
      connected: [CONNECTED],
    });
    const info = vi.spyOn((h.agent as unknown as { log: { info: (...args: unknown[]) => void } }).log, 'info');
    const dialLines = () => info.mock.calls
      .map((call) => String(call[1]))
      .filter((line) => line.includes('dialing hinted ShardingTable holder'));
    // The connected peer's answer arrives while a priming walk connects the holder.
    h.onFetch.set(CONNECTED, () => {
      h.connected.set(HOLDER_A, { toString: () => HOLDER_A });
      return 'clean-absent';
    });
    // One pass over two missing assets: the second one's turn comes after the first
    // one's fetch, so its candidate is the holder, connected since the pass began.
    const targets = [target(0), target(1)];
    (h.internals as unknown as Record<string, unknown>).reconcileChainOrdinal = async (
      _cg: string,
      _ocg: bigint,
      ordinal: number,
    ) => ({ status: 'pending', recovery: targets[ordinal]! }) satisfies OrdinalOutcome;
    await h.internals.refreshVmReconcileHolderTier(CG, { isCurrent: () => true });

    await h.internals.recoverVmReconcileBatch(CG, 1n, targets, 100, () => true);

    expect(h.fetched).toEqual([CONNECTED, HOLDER_A]);
    // (The stubbed `ensurePeerConnected` records every call; the real one is a no-op for a connected peer.)
    expect(dialLines()).toEqual([]);
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
        h.internals.discovery.findCoreAgentPeerHintPage = async () => { throw new Error('store down'); };
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

  describe('the typed vmReconcileHolderTierEnabled switch', () => {
    const fixture = {
      table: [7n],
      wallets: { [wallet(0xa1)]: 7n },
      profiles: [{ peerId: HOLDER_A, agentAddress: wallet(0xa1) }],
      connected: [CONNECTED],
    };
    const refresh = (h: Harness) => h.internals.refreshVmReconcileHolderTier(CG, { isCurrent: () => true });

    it('is decided per instance: one enabled and one disabled agent in the same process', async () => {
      const enabled = await harness({ ...fixture, agentConfig: { vmReconcileHolderTierEnabled: true } });
      const disabled = await harness({ ...fixture, agentConfig: { vmReconcileHolderTierEnabled: false } });
      const disabledTableRead = vi.spyOn(disabled.chain, 'listDesignatableNodes');
      const byDefault = await harness(fixture);
      expect(enabled.agent.vmReconcileHolderTierEnabled()).toBe(true);
      expect(disabled.agent.vmReconcileHolderTierEnabled()).toBe(false);
      expect(byDefault.agent.vmReconcileHolderTierEnabled()).toBe(true);

      for (const h of [enabled, disabled, byDefault]) await refresh(h);
      expect(enabled.internals.vmReconcileObservedCandidatePeerIds(CG)).toEqual([CONNECTED, HOLDER_A]);
      expect(byDefault.internals.vmReconcileObservedCandidatePeerIds(CG)).toEqual([CONNECTED, HOLDER_A]);
      // The disabled instance neither resolves nor remembers anything for the graph.
      expect(disabled.internals.vmReconcileObservedCandidatePeerIds(CG)).toEqual([CONNECTED]);
      expect(disabled.internals.vmReconcileHolderTier?.entryFor(CG)).toBeUndefined();
      // Nor does it read the chain: the disabled agent's tier never resolves anything.
      expect(disabledTableRead).not.toHaveBeenCalled();
    });

    it('lets DKG_VM_RECONCILE_HOLDER_TIER override the configured value in both directions', async () => {
      const enabled = await harness({ ...fixture, agentConfig: { vmReconcileHolderTierEnabled: true } });
      const disabled = await harness({ ...fixture, agentConfig: { vmReconcileHolderTierEnabled: false } });

      process.env.DKG_VM_RECONCILE_HOLDER_TIER = '0';
      expect(enabled.agent.vmReconcileHolderTierEnabled()).toBe(false);
      await refresh(enabled);
      expect(enabled.internals.vmReconcileObservedCandidatePeerIds(CG)).toEqual([CONNECTED]);

      process.env.DKG_VM_RECONCILE_HOLDER_TIER = '1';
      expect(disabled.agent.vmReconcileHolderTierEnabled()).toBe(true);
      await refresh(disabled);
      expect(disabled.internals.vmReconcileObservedCandidatePeerIds(CG)).toEqual([CONNECTED, HOLDER_A]);

      // An unrecognised value is not a decision: the configured value applies.
      process.env.DKG_VM_RECONCILE_HOLDER_TIER = 'maybe';
      expect(enabled.agent.vmReconcileHolderTierEnabled()).toBe(true);
      expect(disabled.agent.vmReconcileHolderTierEnabled()).toBe(false);
    });

    it('drops a graph\'s tier the moment the switch goes off', async () => {
      const h = await harness(fixture);
      await refresh(h);
      expect(h.internals.vmReconcileHolderTier?.entryFor(CG)?.peerIds).toEqual([HOLDER_A]);
      process.env.DKG_VM_RECONCILE_HOLDER_TIER = '0';
      await refresh(h);
      expect(h.internals.vmReconcileHolderTier?.entryFor(CG)).toBeUndefined();
      expect(h.internals.vmReconcileObservedCandidatePeerIds(CG)).toEqual([CONNECTED]);
    });
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
    h.internals.vmReconcileHolderTier!.deleteGraph(OTHER_CG);
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
    h.internals.vmReconcileHolderTier!.invalidateHints([]);
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

  it('runs a failing policy read through the unavailable transition instead of retaining the entry untouched', async () => {
    const h = await harness({
      table: [7n],
      wallets: { [wallet(0xa1)]: 7n },
      profiles: [{ peerId: HOLDER_A, agentAddress: wallet(0xa1) }],
      connected: [CONNECTED],
    });
    let now = 1_000;
    h.internals.vmReconcileRotationNow = () => now;
    const policy = vi.fn(async (): Promise<'public'> => 'public');
    (h.internals as unknown as Record<string, unknown>).readAgentsPhonebookAccessPolicy = policy;
    const refresh = () => h.internals.refreshVmReconcileHolderTier(CG, { isCurrent: () => true });
    const entry = () => h.internals.vmReconcileHolderTier?.entryFor(CG);

    await refresh();
    const resolved = entry()!;
    expect(resolved.peerIds).toEqual([HOLDER_A]);

    // The set's cadence has elapsed and the policy store starts failing.
    now += VM_HOLDER_TIER_RESOLUTION_TTL_MS;
    policy.mockImplementation(async () => { throw new Error('policy store down'); });
    await refresh();
    expect(policy).toHaveBeenCalledTimes(2);
    // The outage moved the entry: same holders, same age, the shorter failure spacing.
    expect(entry()).toEqual({
      peerIds: [HOLDER_A],
      resolvedAt: resolved.resolvedAt,
      nextCheckAt: now + VM_HOLDER_TIER_FAILURE_RETRY_MS,
    });
    expect(h.internals.vmReconcileObservedCandidatePeerIds(CG)).toEqual([CONNECTED, HOLDER_A]);

    // Retried on the failure spacing, not on every pass.
    now += VM_HOLDER_TIER_FAILURE_RETRY_MS - 1;
    await refresh();
    expect(policy).toHaveBeenCalledTimes(2);
    now += 1;
    await refresh();
    expect(policy).toHaveBeenCalledTimes(3);
    expect(entry()?.peerIds).toEqual([HOLDER_A]);

    // The chain has not confirmed the set within the staleness bound: it goes.
    now = resolved.resolvedAt + VM_HOLDER_TIER_STALE_MAX_MS;
    await refresh();
    expect(entry()).toEqual({
      peerIds: [],
      resolvedAt: now,
      nextCheckAt: now + VM_HOLDER_TIER_FAILURE_RETRY_MS,
    });
    expect(h.internals.vmReconcileObservedCandidatePeerIds(CG)).toEqual([CONNECTED]);
  });

  it('lets a defect surface instead of hiding it as an unavailable read, without stopping exact recovery', async () => {
    const h = await harness({
      table: [7n],
      wallets: { [wallet(0xa1)]: 7n },
      profiles: [{ peerId: HOLDER_A, agentAddress: wallet(0xa1) }],
      connected: [CONNECTED],
    });
    // A programming error inside the resolution, past every dependency boundary:
    // the node cannot say which peer id is its own, once. The resolution is the
    // first thing in a pass that asks.
    const defect = new TypeError('peer id bug');
    const { libp2p } = h.internals.node as { libp2p: unknown };
    let failNext = true;
    h.internals.node = {
      get peerId(): string {
        if (failNext) {
          failNext = false;
          throw defect;
        }
        return SELF;
      },
      libp2p,
    };

    // The tier itself does not swallow it, and records no transition for it.
    await expect(h.internals.refreshVmReconcileHolderTier(CG, { isCurrent: () => true }))
      .rejects.toBe(defect);
    expect(h.internals.vmReconcileHolderTier?.entryFor(CG)).toBeUndefined();

    // The recovery pass reports it loudly and still runs over the existing tiers.
    const logged = vi.spyOn((h.agent as unknown as { log: { error: (...args: unknown[]) => void } }).log, 'error');
    reconcilesOnceFetchedFrom(h, HOLDER_A, target());
    failNext = true;
    expect(await pass(h)).toMatchObject({ status: 'pending' });
    expect(h.fetched).toEqual([CONNECTED]);
    expect(logged).toHaveBeenCalledTimes(1);
    expect(String(logged.mock.calls[0]![1])).toContain('peer id bug');

    // Fixed, the next refresh moves the entry as usual.
    await h.internals.refreshVmReconcileHolderTier(CG, { isCurrent: () => true });
    expect(h.internals.vmReconcileHolderTier?.entryFor(CG)?.peerIds).toEqual([HOLDER_A]);
  });

  it('writes nothing when the caller aborts while the shared read is pending', async () => {
    const h = await harness({
      table: [7n],
      wallets: { [wallet(0xa1)]: 7n },
      profiles: [{ peerId: HOLDER_A, agentAddress: wallet(0xa1) }],
      connected: [CONNECTED],
    });
    const controller = new AbortController();
    const readTable = h.chain.listDesignatableNodes!.bind(h.chain);
    h.chain.listDesignatableNodes = async (...args) => {
      controller.abort(new Error('caller gone'));
      await new Promise((resolve) => setTimeout(resolve, 5));
      return readTable(...args);
    };
    await expect(h.internals.refreshVmReconcileHolderTier(CG, {
      signal: controller.signal,
      isCurrent: () => true,
    })).resolves.toBeUndefined();
    expect(h.internals.vmReconcileHolderTier?.entryFor(CG)).toBeUndefined();
  });

  it('bounds a policy read that ignores its abort signal and treats it as unavailable', async () => {
    const h = await harness({
      table: [7n],
      wallets: { [wallet(0xa1)]: 7n },
      profiles: [{ peerId: HOLDER_A, agentAddress: wallet(0xa1) }],
      connected: [CONNECTED],
    });
    const now = 1_000;
    h.internals.vmReconcileRotationNow = () => now;
    // A policy read that never settles and never looks at its signal.
    (h.internals as unknown as Record<string, unknown>).readAgentsPhonebookAccessPolicy = () => new Promise(() => undefined);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    let done = false;
    const running = h.internals.refreshVmReconcileHolderTier(CG, { isCurrent: () => true })
      .then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(VM_HOLDER_TIER_POLICY_TIMEOUT_MS - 1);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toBe(true);
    await running;
    expect(h.internals.vmReconcileHolderTier?.entryFor(CG)).toEqual({
      peerIds: [],
      resolvedAt: now,
      nextCheckAt: now + VM_HOLDER_TIER_FAILURE_RETRY_MS,
    });
  });

  it('does not remember a holder set that was read before a phonebook arrival invalidated it', async () => {
    const h = await harness({
      table: [7n, 8n],
      wallets: { [wallet(0xa1)]: 7n, [wallet(0xb2)]: 8n },
      profiles: [{ peerId: HOLDER_A, agentAddress: wallet(0xa1) }],
      connected: [CONNECTED],
    });
    h.internals.subscribedContextGraphs.set(CG, { subscribed: true });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const readTable = h.chain.listDesignatableNodes!.bind(h.chain);
    let held = false;
    h.chain.listDesignatableNodes = async (...args) => {
      const nodes = await readTable(...args);
      if (!held) {
        held = true;
        await gate;
      }
      return nodes;
    };
    const refresh = () => h.internals.refreshVmReconcileHolderTier(CG, { isCurrent: () => true });

    // The recovery pass is reading the ShardingTable when holder B's profile arrives...
    const inFlight = refresh();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await seedProfiles(h.internals, [{ peerId: HOLDER_B, agentAddress: wallet(0xb2) }]);
    h.internals.scheduleVmRecoveryForResolvedCurators([CG]);
    release();
    await inFlight;

    // ...so what that read found (holder A alone) is not remembered for a full period.
    expect(h.internals.vmReconcileHolderTier?.entryFor(CG)).toBeUndefined();
    await refresh();
    expect(h.internals.vmReconcileObservedCandidatePeerIds(CG)).toEqual([CONNECTED, HOLDER_A, HOLDER_B]);
  });

  describe('unsigned phonebook rows an attacker publishes cost bounded work, and a genuine holder behind them is still reached', () => {
    const HOLDER_WALLET = wallet(0xf00000);
    const HOLDER_ID = 'peerHolderGenuineCoreAAAA';
    const fresh = () => new Date().toISOString();
    /** A core-role row that binds a well-formed wallet registered to nobody. */
    const junk = (i: number, peerId = `12D3KooWJunk${String(i).padStart(5, '0')}`): Profile => ({
      peerId,
      agentAddress: wallet(0x10000 + i),
      lastSeen: fresh(),
    });
    const rawProfile = (subject: string, peerId: string, address: string) => [
      { subject, predicate: `${DKG}peerId`, object: JSON.stringify(peerId), graph: AGENT_REGISTRY_GRAPH },
      { subject, predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: `${DKG}Agent`, graph: AGENT_REGISTRY_GRAPH },
      { subject, predicate: `${DKG}nodeRole`, object: '"core"', graph: AGENT_REGISTRY_GRAPH },
      { subject, predicate: `${DKG}agentAddress`, object: JSON.stringify(address), graph: AGENT_REGISTRY_GRAPH },
      { subject, predicate: `${DKG}lastSeen`, object: JSON.stringify(fresh()), graph: AGENT_REGISTRY_GRAPH },
    ];

    it('hints the holder behind more fresh junk rows than one page holds, at bounded chain cost', async () => {
      const h = await harness({
        table: [7n],
        wallets: { [HOLDER_WALLET]: 7n },
        // The genuine holder's own claim is the oldest in the phonebook.
        profiles: [{ peerId: HOLDER_ID, agentAddress: HOLDER_WALLET, lastSeen: '2020-01-01T00:00:00.000Z' }],
        connected: [CONNECTED],
      });
      // 300 rows ahead of it: ten wallets each claimed by many peers, and rows that bind no wallet.
      await seedProfiles(h.internals, Array.from({ length: 200 }, (_, i) => junk(i % 10, `12D3KooWCrowd${String(i).padStart(5, '0')}`)));
      await h.internals.store.insert(Array.from({ length: 100 }, (_, i) => (
        rawProfile(`did:dkg:agent:unbound${i}`, `12D3KooWUnbound${String(i).padStart(5, '0')}`, `0xnothex${i}`)
      )).flat());
      const lookups = vi.spyOn(h.chain, 'getIdentityIdForAddress');

      await h.internals.refreshVmReconcileHolderTier(CG, { isCurrent: () => true });

      expect(h.internals.vmReconcileHolderTier?.entryFor(CG)?.peerIds).toEqual([HOLDER_ID]);
      expect(h.internals.vmReconcileObservedCandidatePeerIds(CG)).toEqual([CONNECTED, HOLDER_ID]);
      // One lookup per distinct well-formed wallet: ten junk ones and the holder's.
      expect(lookups).toHaveBeenCalledTimes(11);
    });

    it('walks a phonebook larger than one window across refreshes and reaches the holder behind it', async () => {
      const h = await harness({
        table: [7n],
        wallets: { [HOLDER_WALLET]: 7n },
        profiles: [{ peerId: HOLDER_ID, agentAddress: HOLDER_WALLET, lastSeen: '2020-01-01T00:00:00.000Z' }],
        connected: [CONNECTED],
      });
      // 1,100 fresh rows ahead of the holder: thirty wallets, each claimed by dozens of peers.
      await seedProfiles(h.internals, Array.from({ length: 1_100 }, (_, i) => junk(i % 30, `12D3KooWWide${String(i).padStart(5, '0')}`)));
      let now = 1_000;
      h.internals.vmReconcileRotationNow = () => now;
      const lookups = vi.spyOn(h.chain, 'getIdentityIdForAddress');
      const refresh = () => h.internals.refreshVmReconcileHolderTier(CG, { isCurrent: () => true });

      await refresh();
      // One window of the phonebook is all junk: no holder yet, and the graph is due again soon.
      expect(h.internals.vmReconcileHolderTier?.entryFor(CG)).toEqual({
        peerIds: [],
        resolvedAt: now,
        nextCheckAt: now + VM_HOLDER_TIER_FAILURE_RETRY_MS,
      });
      now += VM_HOLDER_TIER_FAILURE_RETRY_MS;
      await refresh();
      // The next resolution reads the next window, which holds the holder.
      expect(h.internals.vmReconcileHolderTier?.entryFor(CG)?.peerIds).toEqual([HOLDER_ID]);
      expect(h.internals.vmReconcileObservedCandidatePeerIds(CG)).toEqual([CONNECTED, HOLDER_ID]);
      // Thirty junk wallets and the holder's, each resolved on chain once.
      expect(lookups).toHaveBeenCalledTimes(31);
    });

    it('bounds the chain lookups of a distinct-wallet flood and reaches the holder over the next resolutions', async () => {
      const h = await harness({
        table: [7n],
        wallets: { [HOLDER_WALLET]: 7n },
        profiles: [{ peerId: HOLDER_ID, agentAddress: HOLDER_WALLET, lastSeen: '2020-01-01T00:00:00.000Z' }],
        connected: [CONNECTED],
      });
      await seedProfiles(h.internals, Array.from({ length: 300 }, (_, i) => junk(i)));
      let now = 1_000;
      h.internals.vmReconcileRotationNow = () => now;
      const lookups = vi.spyOn(h.chain, 'getIdentityIdForAddress');
      const refresh = () => h.internals.refreshVmReconcileHolderTier(CG, { isCurrent: () => true });

      await refresh();
      // Cut short by the lookup bound: no holder yet, and the entry is due again on the failure spacing.
      expect(lookups.mock.calls.length).toBeLessThanOrEqual(VM_HOLDER_TIER_MAX_IDENTITY_LOOKUPS);
      expect(h.internals.vmReconcileHolderTier?.entryFor(CG)).toEqual({
        peerIds: [],
        resolvedAt: now,
        nextCheckAt: now + VM_HOLDER_TIER_FAILURE_RETRY_MS,
      });
      const afterFirst = lookups.mock.calls.length;

      // The next pass continues past the junk it already rejected.
      now += VM_HOLDER_TIER_FAILURE_RETRY_MS;
      await refresh();
      expect(h.internals.vmReconcileHolderTier?.entryFor(CG)?.peerIds).toEqual([HOLDER_ID]);
      expect(lookups.mock.calls.length - afterFirst).toBeLessThanOrEqual(VM_HOLDER_TIER_MAX_IDENTITY_LOOKUPS);
      // No wallet was resolved on chain twice.
      const wallets = lookups.mock.calls.map(([address]) => String(address).toLowerCase());
      expect(new Set(wallets).size).toBe(wallets.length);
      expect(wallets).toHaveLength(301);
    });
  });

  it('writes nothing for a lifecycle that ended while the read was pending', async () => {
    const h = await harness({
      table: [7n],
      wallets: { [wallet(0xa1)]: 7n },
      profiles: [{ peerId: HOLDER_A, agentAddress: wallet(0xa1) }],
      connected: [CONNECTED],
    });
    await h.internals.refreshVmReconcileHolderTier(CG, { isCurrent: () => false });
    expect(h.internals.vmReconcileHolderTier?.entryFor(CG)).toBeUndefined();
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
    expect(h.internals.vmReconcileHolderTier?.entryFor(CG)).toBeUndefined();
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
    expect(h.internals.vmReconcileHolderTier?.entryFor(CG)?.peerIds).toEqual([HOLDER_A]);

    // A phonebook arrival makes a cached answer stale: the graph re-reads.
    h.internals.scheduleVmRecoveryForResolvedCurators([CG]);
    expect(h.internals.vmReconcileHolderTier?.entryFor(CG)).toBeUndefined();
    await h.internals.refreshVmReconcileHolderTier(CG, { isCurrent: () => true });
    expect(h.internals.vmReconcileHolderTier?.entryFor(CG)?.peerIds).toEqual([HOLDER_A]);

    h.internals.closeVmReconcileRotationState();
    expect(h.internals.vmReconcileHolderTier?.entryFor(CG)).toBeUndefined();
    expect(h.internals.vmReconcileObservedCandidatePeerIds(CG)).toEqual([CONNECTED]);
  });

  it('bounds the per-graph tiers it remembers with the other per-graph recovery state', async () => {
    const h = await harness({ table: [], connected: [CONNECTED], policy: 'not-public' });
    const limit = DKGAgentBase.VM_RECONCILE_CG_STATE_MAX_ENTRIES;
    for (let i = 0; i < limit + 3; i += 1) {
      await h.internals.refreshVmReconcileHolderTier(`cg-${i}`, { isCurrent: () => true });
    }
    const remembered = () => Array.from({ length: limit + 3 }, (_, i) => i)
      .filter((i) => h.internals.vmReconcileHolderTier?.entryFor(`cg-${i}`) !== undefined);
    expect(remembered()).toHaveLength(limit + 3);
    (h.agent as unknown as { pruneVmReconcileState(): void }).pruneVmReconcileState();
    expect(remembered()).toHaveLength(limit);
    expect(h.internals.vmReconcileHolderTier?.entryFor('cg-0')).toBeUndefined();
    expect(h.internals.vmReconcileHolderTier?.entryFor(`cg-${limit + 2}`)).toBeDefined();
  });

  describe('data from a hinted holder is verified against the on-chain root like any other', () => {
    const LOCAL_CG = CG;
    const ENTITY = 'urn:fact:holder-tier-octopus';
    const AUTHOR = '0x9277a1a194fcadbb60d8df0c472e7909ead50e33';
    const KA_NUMBER = 701n;
    const KA_ID = packKnowledgeAssetIdFromIdentity({ agentAddress: AUTHOR, kaNumber: KA_NUMBER });
    const NAME = 'http://schema.org/name';

    const quadFor = (value: string) => ({
      subject: ENTITY, predicate: NAME, object: `"${value}"`, graph: '',
    });

    /** What a holder's exact fetch leaves locally: the KA's own shared-memory graph and its workspace head. */
    async function deliverSnapshot(
      store: DKGAgent['store'],
      scope: ReturnType<typeof createGraphKnowledgeAssetScope>,
      value: string,
    ): Promise<void> {
      await stageKnowledgeAssetInSharedMemory({
        store,
        contextGraphId: LOCAL_CG,
        scope,
        triples: [{ subject: ENTITY, predicate: NAME, object: `"${value}"` }],
        shareOperationId: 'holder-tier-share',
        publisherPeerId: HOLDER_A,
      });
    }

    function inVm(
      store: DKGAgent['store'],
      scope: ReturnType<typeof createGraphKnowledgeAssetScope>,
      value: string,
    ): Promise<boolean> {
      return graphHoldsTriple(
        store,
        knowledgeAssetVerifiedMemoryGraph(LOCAL_CG, scope),
        { subject: ENTITY, predicate: NAME, object: `"${value}"` },
      );
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
      // Promotion needs the live authority of a registered public graph and the KA's author.
      h.chain.getLatestMerkleRootAuthor = async () => AUTHOR;
      const { contextGraphId: onChainCg } = await h.chain.createOnChainContextGraph({
        accessPolicy: 0,
        publishPolicy: 1,
      });
      const chainRoot = computeFlatKCRootV10([quadFor('Octopuses have three hearts')], []);
      h.chain.__registerKC({
        kaId: KA_ID, contextGraphId: onChainCg, merkleRootHex: ethers.hexlify(chainRoot), chunks: [],
      });
      const handler = new FinalizationHandler(h.internals.store, h.chain);
      const storageAddress = await h.chain.getDKGKnowledgeAssetsAddress();
      const scope = createGraphKnowledgeAssetScope(
        buildKnowledgeAssetUal(h.chain.chainId, AUTHOR, KA_NUMBER),
        onChainCg.toString(),
      );
      const recovery: OrdinalRecoveryTarget = {
        ...target(0, KA_ID.toString()),
        onChainCgId: onChainCg.toString(),
        ual: buildReconciledKnowledgeAssetUal(h.chain.chainId, storageAddress, KA_ID),
      };
      h.onFetch.set(HOLDER_A, async () => {
        await deliverSnapshot(h.internals.store, scope, delivered);
        return 'found';
      });
      // The real `reconcileChainOrdinal` reads the chain root and hands the
      // local snapshot to this handler; mirrored here as `chain-reconcile-e2e` does.
      (h.internals as unknown as Record<string, unknown>).reconcileChainOrdinal = async (): Promise<OrdinalOutcome> => {
        const outcome = await handler.handleChainReconciledKC({
          contextGraphId: LOCAL_CG,
          onChainCgId: onChainCg.toString(),
          ual: recovery.ual,
          merkleRoot: await h.chain.getLatestMerkleRoot(KA_ID),
          publisherAddress: await h.chain.getLatestMerkleRootPublisher(KA_ID),
          kaId: KA_ID,
          batchId: KA_ID,
          versionBlock: 100,
        }, createOperationContext('system'));
        return outcome === 'promoted' || outcome === 'already-confirmed'
          ? { status: 'reconciled', blockNumber: 100 }
          : { status: 'pending', recovery };
      };
      return { h, recovery, scope, onChainCg };
    }

    it('rejects content a hinted holder serves that fails the on-chain root check', async () => {
      const { h, recovery, scope } = await rootChecked('Octopuses have two hearts');
      const outcome = await pass(h, recovery);
      // The hinted peer really was dialed and asked, and claimed to have it...
      expect(h.dialed).toEqual([HOLDER_A]);
      expect(h.fetched).toEqual([HOLDER_A]);
      // ...but nothing it served reached Verifiable Memory.
      expect(outcome).toMatchObject({ status: 'pending' });
      expect(await inVm(h.internals.store, scope, 'Octopuses have two hearts')).toBe(false);
      expect(await inVm(h.internals.store, scope, 'Octopuses have three hearts')).toBe(false);
    });

    it('promotes the same hinted holder\'s content once it matches the on-chain root', async () => {
      const { h, recovery, scope } = await rootChecked('Octopuses have three hearts');
      expect(await pass(h, recovery)).toEqual({ status: 'reconciled', blockNumber: 100 });
      expect(h.dialed).toEqual([HOLDER_A]);
      expect(await inVm(h.internals.store, scope, 'Octopuses have three hearts')).toBe(true);
    });
  });
});
