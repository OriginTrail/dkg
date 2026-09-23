/**
 * Core VM-promotion guarantees:
 *
 *   1. Chain-driven VM reconcile has its own switch: the periodic peer-sync
 *      switch no longer turns Phase D core-hosted recording off.
 *   2. The StorageACK finality gate answers `ok` only after the namespace is
 *      durably recorded core-hosted, and declines otherwise.
 *   3. Retention keys on the node-local signed-ACK ledger: ledgered copies
 *      outlive the SWM TTL until promoted at their version; unledgered ones
 *      (declined, synced, gossip-chosen ids) do not.
 *   4. The ACK promotion audit backfills namespaces ACKed while VM reconcile
 *      was off (public only, idempotently, without starving on unresolvable
 *      graphs) and watches ledgered copies that do not reach VM.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import { MockChainAdapter, activeRpcRequestContext } from '@origintrail-official/dkg-chain';
import {
  DKG_ONTOLOGY,
  GRAPH_KA_CONTENT_SCOPE_VERSION,
  PROTOCOL_STORAGE_ACK_V2,
  PROTOCOL_STORAGE_UPDATE_ACK_V2,
  TypedEventBus,
  decodeStorageACK,
  encodePublishIntent,
  encodeUpdateIntent,
  isStorageACKDecline,
  MemoryLayer,
  STORAGE_ACK_DECLINE_CODES,
  SYSTEM_CONTEXT_GRAPHS,
  contextGraphDataGraphUri,
  contextGraphMetaUri,
  contextGraphSharedMemoryMetaUri,
  createGraphKnowledgeAssetScope,
  knowledgeAssetLayerGraphUri,
} from '@origintrail-official/dkg-core';
import {
  STORAGE_ACK_LEDGER_GRAPH,
  STORAGE_ACK_LEDGER_PREDICATES as LEDGER,
  StorageACKHandler,
  computeFlatKCMerkleLeafCountV10,
  computeFlatKCRootV10,
  storageAckLedgerMarkUpdate,
  swmKaWriteLockKey,
  withKeyedLocks,
  generateKnowledgeAssetShareMetadata,
  storageAckLedgerEntryQuads,
  storeKnowledgeAssetWorkspaceHead,
  xsdDateTimeLiteral,
} from '@origintrail-official/dkg-publisher';
import {
  GraphManager,
  activeDefaultStoreWorkPriority,
  type Quad,
  type TripleStore,
} from '@origintrail-official/dkg-storage';
import { DKGAgent } from '../src/index.js';
import { DKGAgentBase } from '../src/dkg-agent-base.js';
import type { ContextGraphSubscriptionRecord } from '../src/dkg-agent-types.js';

const AUTHOR = '0x1111111111111111111111111111111111111111';
const DKG = 'http://dkg.io/ontology/';
const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

function ual(n: number): string {
  return `did:dkg:otp:20430/${AUTHOR}/${n}`;
}

function kaId(n: number): bigint {
  return (BigInt(AUTHOR) << 96n) | BigInt(n);
}

function recorder<A extends unknown[], R>(impl: (...args: A) => R) {
  const calls: A[] = [];
  const fn = (...args: A): R => {
    calls.push(args);
    return impl(...args);
  };
  return Object.assign(fn, { calls });
}

type Chain = MockChainAdapter & {
  getContextGraphAccessPolicy: (id: bigint) => Promise<number>;
  isContextGraphActiveOnChain: (id: bigint) => Promise<boolean>;
  getKAContextGraphId: (kaId: bigint) => Promise<bigint>;
  getMerkleRootCount: (kaId: bigint) => Promise<bigint>;
  getContextGraphNameHash: (id: bigint) => Promise<string | null>;
};

/**
 * On-chain names the tests' graphs committed (id -> name): the gate only
 * binds an ACK namespace that is its graph's committed name.
 */
const COMMITTED_NAMES = new Map<bigint, string>([
  [42n, 'public-cg'],
  [43n, 'curated-cg'],
  [45n, 'flaky-store-cg'],
  [46n, 'dormant-cg'],
  [48n, 'burst-cg'],
  [55n, 'update-e2e-cg'],
  [56n, 'sub-e2e-cg'],
]);

function nameHash(name: string): string {
  return ethers.keccak256(ethers.toUtf8Bytes(name)).toLowerCase();
}

type AuditStatus = Record<string, number | string | boolean | null>;

interface Internals {
  store: TripleStore;
  chain: Chain;
  started: boolean;
  vmReconcileRuntimeReady: boolean;
  subscribedContextGraphs: Map<string, {
    subscribed: boolean;
    coreHosted?: boolean;
    onChainId?: string;
  }>;
  vmReconcileScheduling: unknown;
  recordCoreHostedPublicCg(cgId: string, swmGraphId?: string, options?: { durable?: boolean }): Promise<string>;
  ensureStorageAckVmPromotion(request: {
    contextGraphId: string;
    swmGraphId?: string;
    operation: 'publish' | 'update';
  }): Promise<{ ok: boolean; code?: string; message?: string }>;
  ensureStorageAckLedgerReady(): Promise<boolean>;
  runVmPromotionAudit(): Promise<AuditStatus>;
  vmReconcileEnabled(): boolean;
  cleanupExpiredSharedMemory(): Promise<number>;
  recordStorageAckDecline(code: string, now?: number): void;
  storageAckDeclinesLastHour(now?: number): Record<string, number>;
  reconcileStorageAckCopy(candidate: unknown, onChainId: string): Promise<boolean>;
  promotePendingStorageAckUpdates(now?: number): Promise<{ checked: number; promoted: number }>;
  promoteStorageAckPriorVersion(request: {
    contextGraphId: string;
    swmGraphId: string;
    kaUal: string;
    assertionVersion: string;
  }): void;
  storageAckPriorVersionFlights: Map<string, Promise<unknown>>;
  storageAckLedgerReady: boolean;
  storageAckDormantSince: Map<string, number>;
  contextGraphSubscriptionDormancyById: Map<string, string>;
  writeLocks: Map<string, Promise<void>>;
  readStorageAckKnowledgeAssetRootCount(kaUal: string, signal?: AbortSignal): Promise<bigint>;
  reconcileChainOrdinal(
    localCgId: string,
    onChainCgId: bigint,
    ordinal: number,
    headBlock: number | undefined,
  ): Promise<{ status: string }>;
}

interface SeededCopy {
  op: string;
  metaGraph: string;
  assertionGraph: string;
  head: string;
}

describe('core VM-promotion guarantees', () => {
  let agent: DKGAgent | null = null;
  const saved: ContextGraphSubscriptionRecord[] = [];
  let failSaves = false;
  const restoreStatics: Array<() => void> = [];

  afterEach(async () => {
    if (agent) {
      await agent.stop().catch(() => undefined);
      agent = null;
    }
    saved.length = 0;
    failSaves = false;
    for (const restore of restoreStatics.splice(0)) restore();
  });

  function setStatic(name: string, value: number): void {
    const statics = DKGAgentBase as unknown as Record<string, number>;
    const previous = statics[name];
    statics[name] = value;
    restoreStatics.push(() => { statics[name] = previous!; });
  }

  async function boot(config: Record<string, unknown> = {}): Promise<Internals> {
    const chain = new MockChainAdapter('otp:20430');
    agent = await DKGAgent.create({
      name: 'VmPromotionGate',
      chainAdapter: chain,
      nodeRole: 'core',
      contextGraphSubscriptionStore: {
        loadAll: async () => [],
        save: async (record) => {
          if (failSaves) throw new Error('subscription store unavailable');
          saved.push(record);
        },
        delete: async () => undefined,
      },
      ...config,
    });
    (agent as unknown as { node: unknown }).node = {
      peerId: '12D3KooWVmPromotionGate',
      libp2p: { getPeers: () => [] },
    };
    const internals = agent as unknown as Internals;
    internals.chain.isContextGraphActiveOnChain = async () => true;
    internals.chain.getContextGraphAccessPolicy = async () => 0;
    internals.chain.getContextGraphNameHash = async (id) => {
      const name = COMMITTED_NAMES.get(id);
      return name === undefined ? null : nameHash(name);
    };
    return internals;
  }

  async function seedCopy(
    store: TripleStore,
    input: {
      namespace: string;
      n: number;
      ageMs: number;
      version?: number;
      confirmedVersion?: number;
      ledger?: 'signed' | 'none';
      target?: string;
      registered?: boolean;
    },
  ): Promise<SeededCopy> {
    const version = input.version ?? 1;
    const metaGraph = contextGraphSharedMemoryMetaUri(input.namespace);
    const shareOperationId = `storage-ack-${input.namespace}-${input.n}-${version}`;
    const publishedAt = new Date(Date.now() - input.ageMs);
    const metadata = generateKnowledgeAssetShareMetadata({
      shareOperationId,
      contextGraphId: input.namespace,
      kaUal: ual(input.n),
      assertionVersion: version,
      publicTripleCount: 1,
      privateTripleCount: 0,
      publisherPeerId: 'publisher-peer',
      accessPolicy: 'public',
      allowedPeers: [],
      timestamp: publishedAt,
    }, metaGraph);
    await store.insert(metadata);
    await storeKnowledgeAssetWorkspaceHead({
      store,
      graphManager: new GraphManager(store),
      contextGraphId: input.namespace,
      kaUal: ual(input.n),
      assertionVersion: version,
      shareOperationId,
    });
    const assertionGraph = knowledgeAssetLayerGraphUri(
      input.namespace,
      MemoryLayer.SharedWorkingMemory,
      createGraphKnowledgeAssetScope(ual(input.n), version),
    );
    await store.insert([{
      subject: `urn:entity:${input.n}`,
      predicate: 'http://schema.org/name',
      object: `"ka ${input.n} v${version}"`,
      graph: assertionGraph,
    }]);
    const op = metadata[0]!.subject;
    if ((input.ledger ?? 'signed') === 'signed') {
      await store.insert(storageAckLedgerEntryQuads({
        operationSubject: op,
        namespace: input.namespace,
        metaGraph,
        contextGraphId: input.target ?? '55',
        kaUal: ual(input.n),
        assertionVersion: version,
        operation: version > 1 ? 'update' : 'publish',
        signedAt: publishedAt,
      }));
      if (input.registered) {
        await store.insert([{
          subject: op,
          predicate: LEDGER.registeredAt,
          object: xsdDateTimeLiteral(new Date()),
          graph: STORAGE_ACK_LEDGER_GRAPH,
        }]);
      }
    }
    if (input.confirmedVersion !== undefined) {
      await store.insert([
        { subject: ual(input.n), predicate: `${DKG}status`, object: '"confirmed"', graph: contextGraphMetaUri(input.namespace) },
        {
          subject: ual(input.n),
          predicate: `${DKG}assertionVersion`,
          object: `"${input.confirmedVersion}"^^<http://www.w3.org/2001/XMLSchema#integer>`,
          graph: contextGraphMetaUri(input.namespace),
        },
      ]);
    }
    return { op, metaGraph, assertionGraph, head: `${ual(input.n)}#dkg-swm-head` };
  }

  async function count(store: TripleStore, graph: string, subject?: string): Promise<number> {
    const pattern = subject ? `<${subject}> ?p ?o` : '?s ?p ?o';
    const result = await store.query(`SELECT * WHERE { GRAPH <${graph}> { ${pattern} } }`);
    return result.type === 'bindings' ? result.bindings.length : 0;
  }

  async function ledgerHas(store: TripleStore, op: string, predicate: string): Promise<boolean> {
    const result = await store.query(
      `ASK { GRAPH <${STORAGE_ACK_LEDGER_GRAPH}> { <${op}> <${predicate}> ?value } }`,
    );
    return result.type === 'boolean' && result.value;
  }

  describe('switch decoupling', () => {
    it('records a public graph core-hosted while only the peer-sync reconciler is off', async () => {
      const internals = await boot({ syncReconcilerEnabled: false });

      expect(internals.vmReconcileEnabled()).toBe(true);
      await expect(internals.recordCoreHostedPublicCg('42', 'public-cg')).resolves.toBe('recorded');

      expect(internals.subscribedContextGraphs.get('public-cg')).toMatchObject({
        coreHosted: true,
        subscribed: false,
        onChainId: '42',
      });
      expect(saved.find((record) => record.id === 'public-cg')?.coreHosted).toBe(true);
    });

    it('records nothing once chain-driven VM reconcile itself is switched off', async () => {
      const internals = await boot({ vmReconcilerEnabled: false });

      await expect(internals.recordCoreHostedPublicCg('42', 'public-cg'))
        .resolves.toBe('vm-reconcile-disabled');
      expect(internals.subscribedContextGraphs.has('public-cg')).toBe(false);
    });
  });

  describe('StorageACK finality gate', () => {
    it('commits only after the core-hosted row is durably written, once per graph', async () => {
      const internals = await boot();
      const policy = recorder(async () => 0);
      internals.chain.getContextGraphAccessPolicy = policy;

      await expect(internals.ensureStorageAckVmPromotion({
        contextGraphId: '42',
        swmGraphId: 'public-cg',
        operation: 'publish',
      })).resolves.toEqual({ ok: true });
      const writesAfterFirst = saved.filter((record) => record.id === 'public-cg').length;
      expect(writesAfterFirst).toBeGreaterThan(0);
      expect(saved.at(-1)).toMatchObject({ id: 'public-cg', coreHosted: true, onChainId: '42' });

      await expect(internals.ensureStorageAckVmPromotion({
        contextGraphId: '42',
        swmGraphId: 'public-cg',
        operation: 'update',
      })).resolves.toEqual({ ok: true });
      // The steady state costs neither chain reads nor store writes per ACK.
      expect(policy.calls).toHaveLength(1);
      expect(saved.filter((record) => record.id === 'public-cg')).toHaveLength(writesAfterFirst);
    });

    it('records the row under the ACK copy namespace: the numeric id for a direct publish', async () => {
      const internals = await boot();
      internals.subscribedContextGraphs.set('member-name', { subscribed: true, onChainId: '42' });

      await expect(internals.ensureStorageAckVmPromotion({ contextGraphId: '42', operation: 'publish' }))
        .resolves.toEqual({ ok: true });

      expect(internals.subscribedContextGraphs.get('42')).toMatchObject({ coreHosted: true, onChainId: '42' });
      expect(internals.subscribedContextGraphs.get('member-name')?.coreHosted).toBeUndefined();
    });

    it('shares one policy read and store write across a burst of first ACKs for a graph', async () => {
      const internals = await boot();
      let releasePolicy!: () => void;
      const policyGate = new Promise<void>((resolve) => { releasePolicy = resolve; });
      const policy = recorder(async () => {
        await policyGate;
        return 0;
      });
      internals.chain.getContextGraphAccessPolicy = policy;

      const burst = Array.from({ length: 5 }, () => internals.ensureStorageAckVmPromotion({
        contextGraphId: '48',
        swmGraphId: 'burst-cg',
        operation: 'publish',
      }));
      releasePolicy();

      await expect(Promise.all(burst)).resolves.toEqual(Array.from({ length: 5 }, () => ({ ok: true })));
      expect(policy.calls).toHaveLength(1);
    });

    it('declines permanently when VM reconcile is switched off', async () => {
      const internals = await boot({ vmReconcilerEnabled: false });

      await expect(internals.ensureStorageAckVmPromotion({ contextGraphId: '42', operation: 'publish' }))
        .resolves.toMatchObject({ ok: false, code: STORAGE_ACK_DECLINE_CODES.CORE_VM_PROMOTION_DISABLED });
    });

    it('declines permanently for a curated graph and records nothing', async () => {
      const internals = await boot();
      internals.chain.getContextGraphAccessPolicy = async () => 1;

      await expect(internals.ensureStorageAckVmPromotion({
        contextGraphId: '43',
        swmGraphId: 'curated-cg',
        operation: 'publish',
      })).resolves.toMatchObject({ ok: false, code: STORAGE_ACK_DECLINE_CODES.CORE_VM_PROMOTION_DISABLED });
      expect(internals.subscribedContextGraphs.has('curated-cg')).toBe(false);
    });

    it('declines permanently when the namespace reconciles another live graph', async () => {
      const internals = await boot();
      internals.subscribedContextGraphs.set('shared-name', { subscribed: true, onChainId: '7' });

      await expect(internals.ensureStorageAckVmPromotion({
        contextGraphId: '42',
        swmGraphId: 'shared-name',
        operation: 'publish',
      })).resolves.toMatchObject({ ok: false, code: STORAGE_ACK_DECLINE_CODES.CORE_VM_PROMOTION_DISABLED });
      expect(internals.subscribedContextGraphs.get('shared-name')).toEqual({ subscribed: true, onChainId: '7' });
    });

    it('declines transiently while the graph is not live on chain', async () => {
      const internals = await boot();
      internals.chain.isContextGraphActiveOnChain = async () => false;

      await expect(internals.ensureStorageAckVmPromotion({ contextGraphId: '44', operation: 'publish' }))
        .resolves.toMatchObject({ ok: false, code: STORAGE_ACK_DECLINE_CODES.CORE_VM_PROMOTION_UNAVAILABLE });
    });

    it('declines transiently while the namespace row is dormant, without touching it', async () => {
      const internals = await boot();
      (internals as any).contextGraphSubscriptionDormancyById.set('dormant-cg', 'authorityUnavailable');

      await expect(internals.ensureStorageAckVmPromotion({
        contextGraphId: '46',
        swmGraphId: 'dormant-cg',
        operation: 'publish',
      })).resolves.toMatchObject({ ok: false, code: STORAGE_ACK_DECLINE_CODES.CORE_VM_PROMOTION_UNAVAILABLE });
      expect(internals.subscribedContextGraphs.has('dormant-cg')).toBe(false);
      expect(saved).toHaveLength(0);
    });

    it('declines transiently when the core-hosted row cannot be persisted, then recovers', async () => {
      const internals = await boot();
      failSaves = true;

      await expect(internals.ensureStorageAckVmPromotion({
        contextGraphId: '45',
        swmGraphId: 'flaky-store-cg',
        operation: 'publish',
      })).resolves.toMatchObject({ ok: false, code: STORAGE_ACK_DECLINE_CODES.CORE_VM_PROMOTION_UNAVAILABLE });

      failSaves = false;
      await expect(internals.ensureStorageAckVmPromotion({
        contextGraphId: '45',
        swmGraphId: 'flaky-store-cg',
        operation: 'publish',
      })).resolves.toEqual({ ok: true });
      expect(saved.at(-1)).toMatchObject({ id: 'flaky-store-cg', coreHosted: true });
    });

    it('declines transiently while a started agent has not armed VM reconcile yet', async () => {
      const internals = await boot();
      internals.started = true;
      internals.vmReconcileRuntimeReady = false;

      await expect(internals.ensureStorageAckVmPromotion({ contextGraphId: '42', operation: 'publish' }))
        .resolves.toMatchObject({ ok: false, code: STORAGE_ACK_DECLINE_CODES.CORE_VM_PROMOTION_UNAVAILABLE });
      internals.started = false;
    });

    it('counts StorageACK declines per code over the last hour', async () => {
      const internals = await boot();
      const now = Date.now();
      internals.recordStorageAckDecline('CORE_VM_PROMOTION_UNAVAILABLE', now - 2 * HOUR);
      internals.recordStorageAckDecline('CORE_VM_PROMOTION_UNAVAILABLE', now - 30 * 60_000);
      internals.recordStorageAckDecline('CORE_VM_PROMOTION_UNAVAILABLE', now);
      internals.recordStorageAckDecline('BYTESIZE_UNDERCLAIM', now);

      expect(internals.storageAckDeclinesLastHour(now)).toEqual({
        CORE_VM_PROMOTION_UNAVAILABLE: 2,
        BYTESIZE_UNDERCLAIM: 1,
      });
    });
  });

  describe('retention of StorageACK copies', () => {
    it('keeps ledgered unpromoted copies past the TTL and expires promoted, stamped and unledgered ones', async () => {
      const internals = await boot({ sharedMemoryTtlMs: 60_000 });
      await internals.ensureStorageAckLedgerReady();
      const cg = 'ttl-ack-cg';
      const retained = await seedCopy(internals.store, { namespace: cg, n: 20, ageMs: HOUR });
      const promoted = await seedCopy(internals.store, { namespace: cg, n: 21, ageMs: HOUR, confirmedVersion: 1 });
      const stamped = await seedCopy(internals.store, { namespace: cg, n: 22, ageMs: HOUR });
      await internals.store.insert([{
        subject: stamped.op,
        predicate: LEDGER.unregisteredAt,
        object: xsdDateTimeLiteral(new Date()),
        graph: STORAGE_ACK_LEDGER_GRAPH,
      }]);
      // A declined request, a gossip-chosen id or an SWM-synced copy: no ledger row.
      const unsigned = await seedCopy(internals.store, { namespace: cg, n: 23, ageMs: HOUR, ledger: 'none' });

      await internals.cleanupExpiredSharedMemory();

      expect(await count(internals.store, retained.metaGraph, retained.op)).toBeGreaterThan(0);
      expect(await count(internals.store, retained.metaGraph, retained.head)).toBeGreaterThan(0);
      expect(await count(internals.store, retained.assertionGraph)).toBe(1);
      for (const expired of [promoted, stamped, unsigned]) {
        expect(await count(internals.store, expired.metaGraph, expired.op)).toBe(0);
        expect(await count(internals.store, expired.metaGraph, expired.head)).toBe(0);
        expect(await count(internals.store, expired.assertionGraph)).toBe(0);
      }
      // The ledger row goes with the copy.
      expect(await count(internals.store, STORAGE_ACK_LEDGER_GRAPH, stamped.op)).toBe(0);
    });

    it('releases an update copy only once VM holds its version, not an older one', async () => {
      const internals = await boot({ sharedMemoryTtlMs: 60_000 });
      await internals.ensureStorageAckLedgerReady();
      const cg = 'ttl-update-cg';
      const update = await seedCopy(internals.store, {
        namespace: cg, n: 24, ageMs: HOUR, version: 2, confirmedVersion: 1,
      });

      await internals.cleanupExpiredSharedMemory();
      expect(await count(internals.store, update.metaGraph, update.op)).toBeGreaterThan(0);

      await internals.store.deleteByPattern({ graph: contextGraphMetaUri(cg), subject: ual(24) });
      await internals.store.insert([
        { subject: ual(24), predicate: `${DKG}status`, object: '"confirmed"', graph: contextGraphMetaUri(cg) },
        {
          subject: ual(24),
          predicate: `${DKG}assertionVersion`,
          object: '"2"^^<http://www.w3.org/2001/XMLSchema#integer>',
          graph: contextGraphMetaUri(cg),
        },
      ]);
      await internals.cleanupExpiredSharedMemory();
      expect(await count(internals.store, update.metaGraph, update.op)).toBe(0);
    });

    it('applies the ceiling only to copies never seen registered on chain', async () => {
      const internals = await boot({ sharedMemoryTtlMs: 60_000 });
      await internals.ensureStorageAckLedgerReady();
      const cg = 'ttl-ceiling-cg';
      const unproven = await seedCopy(internals.store, { namespace: cg, n: 25, ageMs: 100 * DAY });
      const registered = await seedCopy(internals.store, {
        namespace: cg, n: 26, ageMs: 100 * DAY, registered: true,
      });

      await internals.cleanupExpiredSharedMemory();

      expect(await count(internals.store, unproven.metaGraph, unproven.op)).toBe(0);
      expect(await count(internals.store, registered.metaGraph, registered.op)).toBeGreaterThan(0);
      expect(await count(internals.store, registered.assertionGraph)).toBe(1);
    });

    it('keeps a head shared with a retained ACK copy when an older alias operation expires', async () => {
      const internals = await boot({ sharedMemoryTtlMs: 60_000 });
      await internals.ensureStorageAckLedgerReady();
      const cg = 'ttl-alias-cg';
      const retained = await seedCopy(internals.store, { namespace: cg, n: 30, ageMs: HOUR });
      const originatorOp = `urn:dkg:share:${cg}:originator-30`;
      await internals.store.insert([
        { subject: originatorOp, predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: `${DKG}WorkspaceOperation`, graph: retained.metaGraph },
        { subject: originatorOp, predicate: `${DKG}shareOperationId`, object: '"originator-30"', graph: retained.metaGraph },
        { subject: originatorOp, predicate: `${DKG}publishedAt`, object: `"${new Date(Date.now() - 2 * HOUR).toISOString()}"^^<http://www.w3.org/2001/XMLSchema#dateTime>`, graph: retained.metaGraph },
        { subject: originatorOp, predicate: `${DKG}contentScopeVersion`, object: '"2"^^<http://www.w3.org/2001/XMLSchema#integer>', graph: retained.metaGraph },
        { subject: originatorOp, predicate: `${DKG}kaUal`, object: ual(30), graph: retained.metaGraph },
        // The head carries both operation ids as aliases.
        { subject: retained.head, predicate: `${DKG}shareOperationId`, object: '"originator-30"', graph: retained.metaGraph },
      ]);

      await internals.cleanupExpiredSharedMemory();

      expect(await count(internals.store, retained.metaGraph, originatorOp)).toBe(0);
      expect(await count(internals.store, retained.metaGraph, retained.op)).toBeGreaterThan(0);
      expect(await count(internals.store, retained.metaGraph, retained.head)).toBeGreaterThan(0);
      expect(await count(internals.store, retained.assertionGraph)).toBe(1);
    });

    it('grandfathers pre-ledger copies once, and never copies stored after the ledger started', async () => {
      const internals = await boot({ sharedMemoryTtlMs: 60_000 });
      const historical = await seedCopy(internals.store, { namespace: 'legacy-cg', n: 31, ageMs: HOUR, ledger: 'none' });

      await expect(internals.ensureStorageAckLedgerReady()).resolves.toBe(true);
      expect(await ledgerHas(internals.store, historical.op, LEDGER.grandfathered)).toBe(true);
      const later = await seedCopy(internals.store, { namespace: 'legacy-cg', n: 32, ageMs: HOUR, ledger: 'none' });
      await internals.cleanupExpiredSharedMemory();

      expect(await count(internals.store, historical.metaGraph, historical.op)).toBeGreaterThan(0);
      expect(await count(internals.store, later.metaGraph, later.op)).toBe(0);
    });

    it('visits an undeclared slash-named namespace it holds ledgered copies for', async () => {
      // `<curator>/<name>` SWM ids are listed as context graphs only with a
      // declaration; the ledger makes cleanup visit them regardless.
      const internals = await boot({ sharedMemoryTtlMs: 60_000 });
      await internals.ensureStorageAckLedgerReady();
      const namespace = `${AUTHOR}/remapped-project`;
      const promoted = await seedCopy(internals.store, { namespace, n: 34, ageMs: HOUR, confirmedVersion: 1 });
      const owed = await seedCopy(internals.store, { namespace, n: 35, ageMs: HOUR });

      await internals.cleanupExpiredSharedMemory();

      expect(await count(internals.store, promoted.metaGraph, promoted.op)).toBe(0);
      expect(await count(internals.store, owed.metaGraph, owed.op)).toBeGreaterThan(0);
    });

    it('does not retain copies on a node that never signed them', async () => {
      const internals = await boot({ sharedMemoryTtlMs: 60_000, nodeRole: 'edge' });
      const synced = await seedCopy(internals.store, { namespace: 'edge-cg', n: 33, ageMs: HOUR, ledger: 'none' });

      await internals.cleanupExpiredSharedMemory();

      expect(await count(internals.store, synced.metaGraph, synced.op)).toBe(0);
    });
  });

  describe('ACK promotion audit', () => {
    it('backfills public namespaces holding ACK copies, skips curated ones, and is idempotent', async () => {
      const internals = await boot();
      const policy = recorder(async (id: bigint) => (id === 56n ? 1 : 0));
      internals.chain.getContextGraphAccessPolicy = policy;
      internals.chain.getKAContextGraphId = async () => 0n;
      // A grandfathered cleartext namespace (no signed target) resolves through
      // the ontology on adapters without a finalized authority index.
      await internals.store.insert([{
        subject: 'did:dkg:context-graph:named-public',
        predicate: `${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}OnChainId`,
        object: '"57"',
        graph: contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY),
      }]);
      await seedCopy(internals.store, { namespace: 'named-public', n: 3, ageMs: 60_000, ledger: 'none' });
      await internals.ensureStorageAckLedgerReady();
      await seedCopy(internals.store, { namespace: 'signed-public', n: 1, ageMs: 0, target: '55' });
      await seedCopy(internals.store, { namespace: 'signed-curated', n: 2, ageMs: 0, target: '56' });

      const first = await internals.runVmPromotionAudit();

      expect(first).toMatchObject({ namespacesWithAckCopies: 3, backfilledGraphs: 2, unresolvedGraphs: 0 });
      expect(internals.subscribedContextGraphs.get('signed-public')).toMatchObject({ coreHosted: true, onChainId: '55' });
      expect(internals.subscribedContextGraphs.get('named-public')).toMatchObject({ coreHosted: true, onChainId: '57' });
      expect(internals.subscribedContextGraphs.has('signed-curated')).toBe(false);
      expect([...new Set(saved.map((record) => record.id))].sort()).toEqual(['named-public', 'signed-public']);

      const policyReads = policy.calls.length;
      const writes = saved.length;
      const second = await internals.runVmPromotionAudit();

      expect(second).toMatchObject({ backfilledGraphs: 2 });
      expect(policy.calls).toHaveLength(policyReads);
      expect(saved).toHaveLength(writes);
    });

    it('prunes ledger rows whose copy is gone and keeps the rows of live copies', async () => {
      const internals = await boot();
      await internals.ensureStorageAckLedgerReady();
      const live = await seedCopy(internals.store, { namespace: 'prune-cg', n: 40, ageMs: 0 });
      const gone = await seedCopy(internals.store, { namespace: 'prune-cg', n: 41, ageMs: 0 });
      await internals.store.deleteByPattern({ graph: gone.metaGraph, subject: gone.op });

      await internals.runVmPromotionAudit();

      expect(await ledgerHas(internals.store, live.op, LEDGER.signedAt)).toBe(true);
      expect(await count(internals.store, STORAGE_ACK_LEDGER_GRAPH, gone.op)).toBe(0);
    });

    it('pages past namespaces it cannot resolve instead of retrying them every pass', async () => {
      setStatic('VM_PROMOTION_BACKFILL_PAGE_SIZE', 4);
      setStatic('VM_PROMOTION_AUDIT_MAX_RECORDS', 2);
      const internals = await boot();
      internals.chain.getKAContextGraphId = async () => 0n;
      await internals.ensureStorageAckLedgerReady();
      // Six namespaces the chain says are not live, sorting ahead of one that is.
      for (let index = 0; index < 6; index += 1) {
        await seedCopy(internals.store, { namespace: `a-dead-${index}`, n: 100 + index, ageMs: 0, target: `${900 + index}` });
      }
      await seedCopy(internals.store, { namespace: 'z-live', n: 200, ageMs: 0, target: '77' });
      internals.chain.isContextGraphActiveOnChain = async (id) => id === 77n;

      for (let pass = 0; pass < 5 && !internals.subscribedContextGraphs.has('z-live'); pass += 1) {
        await internals.runVmPromotionAudit();
      }

      expect(internals.subscribedContextGraphs.get('z-live')).toMatchObject({ coreHosted: true, onChainId: '77' });
    });

    it('marks ACKed copies registered on chain, promotes them per asset, and never lets them expire', async () => {
      const internals = await boot({ sharedMemoryTtlMs: DAY });
      await internals.ensureStorageAckLedgerReady();
      await internals.recordCoreHostedPublicCg('55', 'watched-cg');
      internals.chain.getKAContextGraphId = async (id) => (id === kaId(10) ? 55n : 0n);
      internals.chain.getMerkleRootCount = async (id) => (id === kaId(10) ? 1n : 0n);
      const reconciled: string[] = [];
      (internals as any).reconcileStorageAckCopy = async (candidate: { kaUal: string }) => {
        reconciled.push(candidate.kaUal);
        return false;
      };
      const stalled = await seedCopy(internals.store, { namespace: 'watched-cg', n: 10, ageMs: 2 * HOUR });

      const status = await internals.runVmPromotionAudit();

      expect(status).toMatchObject({ staleUnpromotedCopies: 1, stalledOnChain: 1, retriesTriggered: 1 });
      expect(reconciled).toEqual([ual(10)]);
      expect(await ledgerHas(internals.store, stalled.op, LEDGER.registeredAt)).toBe(true);
    });

    it('stamps a copy chain-absent only on a second observation, past the TTL', async () => {
      setStatic('VM_PROMOTION_AUDIT_INTERVAL_MS', 1);
      const internals = await boot({ sharedMemoryTtlMs: DAY });
      await internals.ensureStorageAckLedgerReady();
      await internals.recordCoreHostedPublicCg('55', 'absent-cg');
      internals.chain.getKAContextGraphId = async () => 0n;
      internals.chain.getMerkleRootCount = async () => 0n;
      const old = await seedCopy(internals.store, { namespace: 'absent-cg', n: 11, ageMs: 2 * DAY });
      const young = await seedCopy(internals.store, { namespace: 'absent-cg', n: 12, ageMs: 2 * HOUR });

      await internals.runVmPromotionAudit();
      expect(await ledgerHas(internals.store, old.op, LEDGER.absentSeenAt)).toBe(true);
      expect(await ledgerHas(internals.store, old.op, LEDGER.unregisteredAt)).toBe(false);

      await new Promise((resolve) => setTimeout(resolve, 5));
      const status = await internals.runVmPromotionAudit();

      expect(status).toMatchObject({ notRegisteredOnChain: 2, expiredUnregisteredCopies: 1 });
      expect(await ledgerHas(internals.store, old.op, LEDGER.unregisteredAt)).toBe(true);
      // A younger copy may belong to a publish still in flight.
      expect(await ledgerHas(internals.store, young.op, LEDGER.absentSeenAt)).toBe(false);
      expect(await ledgerHas(internals.store, young.op, LEDGER.unregisteredAt)).toBe(false);
    });

    it('never stamps on an ambiguous chain answer', async () => {
      setStatic('VM_PROMOTION_AUDIT_INTERVAL_MS', 1);
      const internals = await boot({ sharedMemoryTtlMs: DAY });
      await internals.ensureStorageAckLedgerReady();
      await internals.recordCoreHostedPublicCg('55', 'ambiguous-cg');
      internals.chain.getKAContextGraphId = async () => 0n;
      // Registered nowhere, yet the asset has a root: not proof of absence.
      internals.chain.getMerkleRootCount = async () => 1n;
      const copy = await seedCopy(internals.store, { namespace: 'ambiguous-cg', n: 13, ageMs: 2 * DAY });

      await internals.runVmPromotionAudit();
      await new Promise((resolve) => setTimeout(resolve, 5));
      await internals.runVmPromotionAudit();

      expect(await ledgerHas(internals.store, copy.op, LEDGER.absentSeenAt)).toBe(false);
      expect(await ledgerHas(internals.store, copy.op, LEDGER.unregisteredAt)).toBe(false);
    });

    it('rotates the watchdog through every copy within its chain-read budget', async () => {
      setStatic('VM_PROMOTION_AUDIT_PAGE_SIZE', 5);
      setStatic('VM_PROMOTION_AUDIT_MAX_CHAIN_CHECKS', 2);
      const internals = await boot({ sharedMemoryTtlMs: DAY });
      await internals.ensureStorageAckLedgerReady();
      await internals.recordCoreHostedPublicCg('55', 'busy-cg');
      const reads = recorder(async () => 0n);
      internals.chain.getKAContextGraphId = reads;
      internals.chain.getMerkleRootCount = async () => 0n;
      const copies: SeededCopy[] = [];
      for (let index = 0; index < 12; index += 1) {
        copies.push(await seedCopy(internals.store, { namespace: 'busy-cg', n: 300 + index, ageMs: 2 * HOUR + index * 60_000 }));
      }

      await internals.runVmPromotionAudit();
      expect(reads.calls).toHaveLength(2);

      for (let pass = 0; pass < 12; pass += 1) await internals.runVmPromotionAudit();
      const examined = new Set(reads.calls.map(([id]) => id));
      // Every copy, old or new, got a chain read within a bounded number of passes.
      for (let index = 0; index < 12; index += 1) {
        expect(examined.has(kaId(300 + index))).toBe(true);
      }
    });
  });

  describe('durable update path', () => {
    const NAMESPACE = 'update-e2e-cg';
    const TARGET = '55';
    const N = 77;
    const PEER = { toString: () => 'publisher-peer' };

    function wire(quads: readonly Quad[]): Uint8Array {
      return new TextEncoder().encode(quads.map((quad) =>
        `<${quad.subject}> <${quad.predicate}> ${quad.object} <${quad.graph}> .`).join('\n'));
    }

    function content(value: string, layer: MemoryLayer, version: number): Quad[] {
      return [{
        subject: 'urn:entity:e2e',
        predicate: 'http://schema.org/name',
        object: `"${value}"`,
        graph: knowledgeAssetLayerGraphUri(NAMESPACE, layer, createGraphKnowledgeAssetScope(ual(N), version)),
      }];
    }

    function realHandler(internals: Internals): StorageACKHandler {
      return new StorageACKHandler(internals.store, {
        nodeRole: 'core',
        nodeIdentityId: 17n,
        signerWallet: ethers.Wallet.createRandom(),
        contextGraphSharedMemoryUri: (cgId: string) => `did:dkg:context-graph:${cgId}/_shared_memory`,
        chainId: 31337n,
        kav10Address: '0x000000000000000000000000000000000000c10a',
        isCgCurated: async () => false,
        ensureVmPromotion: (request) => internals.ensureStorageAckVmPromotion(request),
        onPriorVersionAwaitingPromotion: (request) => internals.promoteStorageAckPriorVersion(request),
        readKnowledgeAssetRootCount: (kaUal, signal) =>
          internals.readStorageAckKnowledgeAssetRootCount(kaUal, signal),
      }, new TypedEventBus());
    }

    async function ack(handler: StorageACKHandler, value: string, version: number) {
      if (version === 1) {
        const quads = content(value, MemoryLayer.SharedWorkingMemory, 1);
        return decodeStorageACK(await handler.handler(encodePublishIntent({
          merkleRoot: computeFlatKCRootV10(quads, []),
          contextGraphId: TARGET,
          swmGraphId: NAMESPACE,
          publisherPeerId: 'publisher-peer',
          publicByteSize: wire(quads).length,
          isPrivate: false,
          kaCount: 1,
          rootEntities: [],
          stagingQuads: wire(quads),
          merkleLeafCount: computeFlatKCMerkleLeafCountV10(quads, []),
          contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
          kaUal: ual(N),
          assertionVersion: '1',
          publicTripleCount: 1,
          privateTripleCount: 0,
          accessPolicy: 'public',
          allowedPeers: [],
        }), PEER));
      }
      // The default public update ships its payload inline from the publisher's VM graph.
      const quads = content(value, MemoryLayer.VerifiableMemory, version);
      return decodeStorageACK(await handler.updateHandler(encodeUpdateIntent({
        kaId: kaId(N).toString(),
        contextGraphId: TARGET,
        swmGraphId: NAMESPACE,
        preUpdateMerkleRootCount: version - 1,
        newMerkleRoot: computeFlatKCRootV10(quads, []),
        newByteSize: wire(quads).length,
        newTokenAmount: '1000',
        mintAmount: 0,
        burnTokenIds: [],
        newMerkleLeafCount: computeFlatKCMerkleLeafCountV10(quads, []),
        publisherPeerId: 'publisher-peer',
        stagingQuads: wire(quads),
        contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
        kaUal: ual(N),
        assertionVersion: String(version),
        publicTripleCount: 1,
        privateTripleCount: 0,
      }), PEER));
    }

    function landOnChain(internals: Internals, value: string, version: number): void {
      const root = computeFlatKCRootV10(content(value, MemoryLayer.SharedWorkingMemory, version), []);
      const chain = internals.chain as unknown as {
        __registerKC(input: { kaId: bigint; contextGraphId: bigint; merkleRootHex: string; chunks: [] }): void;
        collections: Map<bigint, { merkleRoot: Uint8Array; updateContext: { merkleRootsCount: bigint } }>;
      };
      if (version === 1) {
        chain.__registerKC({
          kaId: kaId(N),
          contextGraphId: BigInt(TARGET),
          merkleRootHex: ethers.hexlify(root),
          chunks: [],
        });
        return;
      }
      const entry = chain.collections.get(kaId(N))!;
      entry.merkleRoot = root;
      entry.updateContext = { ...entry.updateContext, merkleRootsCount: BigInt(version) };
    }

    async function vmState(store: TripleStore): Promise<{ version: string | undefined; values: string[] }> {
      const meta = await store.query(`SELECT ?version WHERE { GRAPH <${contextGraphMetaUri(NAMESPACE)}> {
        <${ual(N)}> <${DKG}status> "confirmed" ; <${DKG}assertionVersion> ?version .
      } }`);
      const version = meta.type === 'bindings' ? meta.bindings[0]?.['version'] : undefined;
      // The per-KA VM graph is not versioned: an update replaces its content.
      const data = await store.query(
        `SELECT ?o WHERE { GRAPH <${knowledgeAssetLayerGraphUri(
          NAMESPACE,
          MemoryLayer.VerifiableMemory,
          createGraphKnowledgeAssetScope(ual(N), 1),
        )}> { ?s ?p ?o } }`,
      );
      const values = data.type === 'bindings' ? data.bindings.map((row) => row['o']!) : [];
      return { version, values };
    }

    it('carries an ACKed update into VM once it lands on chain, through the real handler and finalization', async () => {
      const internals = await boot({ sharedMemoryTtlMs: 60_000 });
      await internals.ensureStorageAckLedgerReady();
      const handler = realHandler(internals);

      // v1: ACKed, registered, promoted per asset.
      expect(isStorageACKDecline(await ack(handler, 'first', 1))).toBe(false);
      landOnChain(internals, 'first', 1);
      await internals.runVmPromotionAudit();
      expect(await internals.reconcileStorageAckCopy({
        operationSubject: 'unused', namespace: NAMESPACE, kaUal: ual(N), assertionVersion: 1n,
        signedAtMs: 0, contextGraphId: TARGET, registered: true,
      }, TARGET)).toBe(true);
      expect((await vmState(internals.store)).values).toEqual(['"first"']);

      // v2: ACKed as a durable copy; nothing lands yet, so nothing moves.
      expect(isStorageACKDecline(await ack(handler, 'second', 2))).toBe(false);
      const later = Date.now() + 2 * 60_000;
      await expect(internals.promotePendingStorageAckUpdates(later)).resolves.toMatchObject({ promoted: 0 });
      expect((await vmState(internals.store)).values).toEqual(['"first"']);

      // The update lands on chain: the pending-update lane promotes it.
      landOnChain(internals, 'second', 2);
      await expect(internals.promotePendingStorageAckUpdates(later + DAY)).resolves.toMatchObject({ promoted: 1 });

      const vm = await vmState(internals.store);
      expect(vm.version).toBe('"2"^^<http://www.w3.org/2001/XMLSchema#integer>');
      expect(vm.values).toContain('"second"');
      expect(vm.values).not.toContain('"first"');
    });

    it('releases an update copy the chain moved past, and then accepts the next update', async () => {
      const internals = await boot();
      await internals.ensureStorageAckLedgerReady();
      const handler = realHandler(internals);
      expect(isStorageACKDecline(await ack(handler, 'first', 1))).toBe(false);
      landOnChain(internals, 'first', 1);
      expect(await internals.reconcileStorageAckCopy({
        operationSubject: 'unused', namespace: NAMESPACE, kaUal: ual(N), assertionVersion: 1n,
        signedAtMs: 0, contextGraphId: TARGET, registered: true,
      }, TARGET)).toBe(true);
      expect(isStorageACKDecline(await ack(handler, 'second', 2))).toBe(false);
      // v2 lands, then v3 lands through other cores before this one promotes v2.
      landOnChain(internals, 'second', 2);
      landOnChain(internals, 'third', 3);

      const lane = await internals.promotePendingStorageAckUpdates(Date.now() + 2 * 60_000);

      expect(lane).toMatchObject({ superseded: 1, promoted: 0 });
      const released = await internals.store.query(`ASK { GRAPH <${STORAGE_ACK_LEDGER_GRAPH}> {
        ?op <${LEDGER.supersededAt}> ?at ; <${LEDGER.assertionVersion}> ?v . FILTER(?v = 2)
      } }`);
      expect(released).toMatchObject({ type: 'boolean', value: true });
      // The copy no longer holds the head: v4 is signed straight away.
      expect(isStorageACKDecline(await ack(handler, 'fourth', 4))).toBe(false);
    });

    it('releases a same-version copy that never landed when the publisher retries with new content', async () => {
      const internals = await boot();
      await internals.ensureStorageAckLedgerReady();
      const handler = realHandler(internals);
      expect(isStorageACKDecline(await ack(handler, 'first-attempt', 1))).toBe(false);

      // While the first copy's transaction may still be pending, the retry waits.
      const early = await ack(handler, 'edited-retry', 1);
      expect(early.declineCode).toBe(STORAGE_ACK_DECLINE_CODES.CORE_TEMPORARILY_UNAVAILABLE);
      // Past the pending-transaction window it replaces the held copy.
      const held = await internals.store.query(`SELECT ?op WHERE { GRAPH <${STORAGE_ACK_LEDGER_GRAPH}> {
        ?op <${LEDGER.kaUal}> <${ual(N)}>
      } }`);
      const heldOp = held.type === 'bindings' ? held.bindings[0]?.['op'] : undefined;
      await internals.store.update!(storageAckLedgerMarkUpdate(heldOp!, LEDGER.signedAt, new Date(Date.now() - 6 * 60_000)));
      expect(isStorageACKDecline(await ack(handler, 'edited-retry', 1))).toBe(false);

      // Once that version landed with some content, different content is refused.
      landOnChain(internals, 'edited-retry', 1);
      const late = await ack(handler, 'third-try', 1);
      expect(late.declineCode).toBe(STORAGE_ACK_DECLINE_CODES.CONFLICTING_KA_ASSERTION);
    });

    it('releases a copy whose version landed with different content', async () => {
      const internals = await boot();
      await internals.ensureStorageAckLedgerReady();
      const handler = realHandler(internals);
      expect(isStorageACKDecline(await ack(handler, 'first', 1))).toBe(false);
      landOnChain(internals, 'first', 1);
      expect(await internals.reconcileStorageAckCopy({
        operationSubject: 'unused', namespace: NAMESPACE, kaUal: ual(N), assertionVersion: 1n,
        signedAtMs: 0, contextGraphId: TARGET, registered: true,
      }, TARGET)).toBe(true);
      expect(isStorageACKDecline(await ack(handler, 'second', 2))).toBe(false);
      // Version 2 lands through other cores with content this core never held.
      landOnChain(internals, 'rival', 2);

      const lane = await internals.promotePendingStorageAckUpdates(Date.now() + 2 * 60_000);

      expect(lane).toMatchObject({ superseded: 1, promoted: 0 });
      // The held copy no longer blocks the next update.
      expect(isStorageACKDecline(await ack(handler, 'third', 3))).toBe(false);
    });

    it('promotes the version an update waits on, so the publisher retry is signed', async () => {
      const internals = await boot();
      await internals.ensureStorageAckLedgerReady();
      const handler = realHandler(internals);
      expect(isStorageACKDecline(await ack(handler, 'first', 1))).toBe(false);
      // v1 is on chain (an update requires it) but this core has not promoted it yet.
      landOnChain(internals, 'first', 1);

      // The promotion a waiting publisher depends on runs ahead of the
      // background catch-up: foreground RPC class at authority priority,
      // normal store lane.
      const lanes: Array<{ requestClass: string; admissionPriority?: string; store?: string }> = [];
      const readRoot = internals.chain.getLatestMerkleRoot.bind(internals.chain);
      internals.chain.getLatestMerkleRoot = async (id: bigint) => {
        const rpc = activeRpcRequestContext();
        lanes.push({
          requestClass: rpc.requestClass,
          ...(rpc.admissionPriority ? { admissionPriority: rpc.admissionPriority } : {}),
          ...(activeDefaultStoreWorkPriority() ? { store: activeDefaultStoreWorkPriority() } : {}),
        });
        return readRoot(id);
      };

      const declined = await ack(handler, 'second', 2);
      expect(declined.declineCode).toBe(STORAGE_ACK_DECLINE_CODES.CORE_TEMPORARILY_UNAVAILABLE);
      await Promise.all(internals.storageAckPriorVersionFlights.values());
      expect(lanes.length).toBeGreaterThan(0);
      for (const lane of lanes) {
        expect(lane).toEqual({ requestClass: 'foreground', admissionPriority: 'authority', store: 'normal' });
      }

      expect((await vmState(internals.store)).values).toEqual(['"first"']);
      expect(isStorageACKDecline(await ack(handler, 'second', 2))).toBe(false);
    });
  });

  it('runs the update path through a started core\'s own StorageACK handler', async () => {
    const primary = ethers.Wallet.createRandom();
    const chain = new MockChainAdapter('otp:20430', primary.address);
    chain.seedIdentity(primary.address, 42n);
    const chainStubs = chain as unknown as Chain;
    chainStubs.isContextGraphActiveOnChain = async () => true;
    chainStubs.getContextGraphAccessPolicy = async () => 0;
    chainStubs.getContextGraphNameHash = async (id) => (id === 55n ? nameHash('update-e2e-cg') : null);
    agent = await DKGAgent.create({
      name: 'StartedCoreUpdatePath',
      listenHost: '127.0.0.1',
      listenPort: 0,
      chainAdapter: chain,
      nodeRole: 'core',
      ackSignerKey: ethers.Wallet.createRandom().privateKey,
    });
    await agent.start();
    const internals = agent as unknown as Internals;
    const handlers = (agent as unknown as {
      messenger: { handlers: Map<string, (payload: Uint8Array, peerId: string) => Promise<Uint8Array>> };
    }).messenger.handlers;
    const publishAck = handlers.get(PROTOCOL_STORAGE_ACK_V2)!;
    const updateAck = handlers.get(PROTOCOL_STORAGE_UPDATE_ACK_V2)!;
    expect(publishAck).toBeTypeOf('function');
    expect(updateAck).toBeTypeOf('function');
    const n = 88;
    const graphFor = (layer: MemoryLayer, version: number) => knowledgeAssetLayerGraphUri(
      'update-e2e-cg', layer, createGraphKnowledgeAssetScope(ual(n), version),
    );
    const quadsFor = (value: string, layer: MemoryLayer, version: number): Quad[] => [{
      subject: 'urn:entity:started', predicate: 'http://schema.org/name', object: `"${value}"`, graph: graphFor(layer, version),
    }];
    const wire = (quads: readonly Quad[]) => new TextEncoder().encode(
      quads.map((q) => `<${q.subject}> <${q.predicate}> ${q.object} <${q.graph}> .`).join('\n'),
    );
    const v1 = quadsFor('first', MemoryLayer.SharedWorkingMemory, 1);
    const published = decodeStorageACK(await publishAck(encodePublishIntent({
      merkleRoot: computeFlatKCRootV10(v1, []),
      contextGraphId: '55',
      swmGraphId: 'update-e2e-cg',
      publisherPeerId: 'publisher-peer',
      publicByteSize: wire(v1).length,
      isPrivate: false,
      kaCount: 1,
      rootEntities: [],
      stagingQuads: wire(v1),
      merkleLeafCount: computeFlatKCMerkleLeafCountV10(v1, []),
      contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
      kaUal: ual(n),
      assertionVersion: '1',
      publicTripleCount: 1,
      privateTripleCount: 0,
      accessPolicy: 'public',
      allowedPeers: [],
    }), 'publisher-peer'));
    expect(published.declineMessage).toBeFalsy();
    expect(isStorageACKDecline(published)).toBe(false);
    (chain as unknown as {
      __registerKC(input: { kaId: bigint; contextGraphId: bigint; merkleRootHex: string; chunks: [] }): void;
    }).__registerKC({ kaId: kaId(n), contextGraphId: 55n, merkleRootHex: ethers.hexlify(computeFlatKCRootV10(v1, [])), chunks: [] });
    const v2 = quadsFor('second', MemoryLayer.VerifiableMemory, 2);
    const updateIntent = encodeUpdateIntent({
      kaId: kaId(n).toString(),
      contextGraphId: '55',
      swmGraphId: 'update-e2e-cg',
      preUpdateMerkleRootCount: 1,
      newMerkleRoot: computeFlatKCRootV10(v2, []),
      newByteSize: wire(v2).length,
      newTokenAmount: '1000',
      mintAmount: 0,
      burnTokenIds: [],
      newMerkleLeafCount: computeFlatKCMerkleLeafCountV10(v2, []),
      publisherPeerId: 'publisher-peer',
      stagingQuads: wire(v2),
      contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
      kaUal: ual(n),
      assertionVersion: '2',
      publicTripleCount: 1,
      privateTripleCount: 0,
    });

    const first = decodeStorageACK(await updateAck(updateIntent, 'publisher-peer'));
    expect(first.declineCode).toBe(STORAGE_ACK_DECLINE_CODES.CORE_TEMPORARILY_UNAVAILABLE);
    await Promise.all(internals.storageAckPriorVersionFlights.values());
    const retried = decodeStorageACK(await updateAck(updateIntent, 'publisher-peer'));

    expect(retried.declineMessage).toBeFalsy();
    expect(isStorageACKDecline(retried)).toBe(false);
    const ledgered = await internals.store.query(`ASK { GRAPH <${STORAGE_ACK_LEDGER_GRAPH}> {
      ?op <${LEDGER.operation}> "update" ; <${LEDGER.kaUal}> <${ual(n)}>
    } }`);
    expect(ledgered).toMatchObject({ type: 'boolean', value: true });
  });

  describe('sub-graph copies', () => {
    const NAMESPACE = 'sub-e2e-cg';
    const TARGET = '56';
    const SUB = 'research';
    const PEER = { toString: () => 'publisher-peer' };

    function content(n: number, value: string, layer: MemoryLayer, version: number): Quad[] {
      return [{
        subject: `urn:entity:sub-${n}`,
        predicate: 'http://schema.org/name',
        object: `"${value}"`,
        graph: knowledgeAssetLayerGraphUri(NAMESPACE, layer, createGraphKnowledgeAssetScope(ual(n), version), SUB),
      }];
    }

    function wire(quads: readonly Quad[]): Uint8Array {
      return new TextEncoder().encode(quads.map((quad) =>
        `<${quad.subject}> <${quad.predicate}> ${quad.object} <${quad.graph}> .`).join('\n'));
    }

    function handlerFor(internals: Internals): StorageACKHandler {
      return new StorageACKHandler(internals.store, {
        nodeRole: 'core',
        nodeIdentityId: 17n,
        signerWallet: ethers.Wallet.createRandom(),
        contextGraphSharedMemoryUri: (cgId: string) => `did:dkg:context-graph:${cgId}/_shared_memory`,
        chainId: 31337n,
        kav10Address: '0x000000000000000000000000000000000000c10a',
        isCgCurated: async () => false,
        ensureVmPromotion: (request) => internals.ensureStorageAckVmPromotion(request),
        onPriorVersionAwaitingPromotion: (request) => internals.promoteStorageAckPriorVersion(request),
        readKnowledgeAssetRootCount: (kaUal, signal) =>
          internals.readStorageAckKnowledgeAssetRootCount(kaUal, signal),
      }, new TypedEventBus());
    }

    async function ack(handler: StorageACKHandler, n: number, value: string, version: number) {
      if (version === 1) {
        const quads = content(n, value, MemoryLayer.SharedWorkingMemory, 1);
        return decodeStorageACK(await handler.handler(encodePublishIntent({
          merkleRoot: computeFlatKCRootV10(quads, []),
          contextGraphId: TARGET,
          swmGraphId: NAMESPACE,
          subGraphName: SUB,
          publisherPeerId: 'publisher-peer',
          publicByteSize: wire(quads).length,
          isPrivate: false,
          kaCount: 1,
          rootEntities: [],
          stagingQuads: wire(quads),
          merkleLeafCount: computeFlatKCMerkleLeafCountV10(quads, []),
          contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
          kaUal: ual(n),
          assertionVersion: '1',
          publicTripleCount: 1,
          privateTripleCount: 0,
          accessPolicy: 'public',
          allowedPeers: [],
        }), PEER));
      }
      const quads = content(n, value, MemoryLayer.VerifiableMemory, version);
      return decodeStorageACK(await handler.updateHandler(encodeUpdateIntent({
        kaId: kaId(n).toString(),
        contextGraphId: TARGET,
        swmGraphId: NAMESPACE,
        subGraphName: SUB,
        preUpdateMerkleRootCount: version - 1,
        newMerkleRoot: computeFlatKCRootV10(quads, []),
        newByteSize: wire(quads).length,
        newTokenAmount: '1000',
        mintAmount: 0,
        burnTokenIds: [],
        newMerkleLeafCount: computeFlatKCMerkleLeafCountV10(quads, []),
        publisherPeerId: 'publisher-peer',
        stagingQuads: wire(quads),
        contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
        kaUal: ual(n),
        assertionVersion: String(version),
        publicTripleCount: 1,
        privateTripleCount: 0,
      }), PEER));
    }

    function landOnChain(internals: Internals, n: number, value: string, version: number): void {
      const root = computeFlatKCRootV10(content(n, value, MemoryLayer.SharedWorkingMemory, version), []);
      const chain = internals.chain as unknown as {
        __registerKC(input: { kaId: bigint; contextGraphId: bigint; merkleRootHex: string; chunks: [] }): void;
        collections: Map<bigint, { merkleRoot: Uint8Array; updateContext: { merkleRootsCount: bigint } }>;
      };
      if (version === 1) {
        chain.__registerKC({ kaId: kaId(n), contextGraphId: BigInt(TARGET), merkleRootHex: ethers.hexlify(root), chunks: [] });
        return;
      }
      const entry = chain.collections.get(kaId(n))!;
      entry.merkleRoot = root;
      entry.updateContext = { ...entry.updateContext, merkleRootsCount: BigInt(version) };
    }

    async function vmValues(store: TripleStore, n: number): Promise<string[]> {
      const data = await store.query(`SELECT ?o WHERE { GRAPH <${knowledgeAssetLayerGraphUri(
        NAMESPACE,
        MemoryLayer.VerifiableMemory,
        createGraphKnowledgeAssetScope(ual(n), 1),
        SUB,
      )}> { ?s ?p ?o } }`);
      return data.type === 'bindings' ? data.bindings.map((row) => row['o']!) : [];
    }

    it('promotes a hosted-only sub-graph publish through the ordinal walk', async () => {
      const internals = await boot();
      await internals.ensureStorageAckLedgerReady();
      const handler = handlerFor(internals);
      expect(isStorageACKDecline(await ack(handler, 81, 'sub-publish', 1))).toBe(false);
      landOnChain(internals, 81, 'sub-publish', 1);

      await internals.reconcileChainOrdinal(NAMESPACE, BigInt(TARGET), 0, undefined);

      expect(await vmValues(internals.store, 81)).toEqual(['"sub-publish"']);
    });

    it('promotes the prior version of a sub-graph update and then the update itself', async () => {
      const internals = await boot();
      await internals.ensureStorageAckLedgerReady();
      const handler = handlerFor(internals);
      expect(isStorageACKDecline(await ack(handler, 82, 'v1', 1))).toBe(false);
      landOnChain(internals, 82, 'v1', 1);

      const declined = await ack(handler, 82, 'v2', 2);
      expect(declined.declineCode).toBe(STORAGE_ACK_DECLINE_CODES.CORE_TEMPORARILY_UNAVAILABLE);
      await Promise.all(internals.storageAckPriorVersionFlights.values());
      expect(await vmValues(internals.store, 82)).toEqual(['"v1"']);

      expect(isStorageACKDecline(await ack(handler, 82, 'v2', 2))).toBe(false);
      landOnChain(internals, 82, 'v2', 2);
      await expect(internals.promotePendingStorageAckUpdates(Date.now() + 2 * 60_000))
        .resolves.toMatchObject({ promoted: 1 });
      expect(await vmValues(internals.store, 82)).toEqual(['"v2"']);
    });
  });

  describe('ACK namespace binding', () => {
    it('refuses a numeric namespace that is another graph', async () => {
      const internals = await boot();

      await expect(internals.ensureStorageAckVmPromotion({
        contextGraphId: '42', swmGraphId: '57', operation: 'publish',
      })).resolves.toMatchObject({ ok: false, code: STORAGE_ACK_DECLINE_CODES.CORE_VM_PROMOTION_DISABLED });
      expect(internals.subscribedContextGraphs.has('57')).toBe(false);
    });

    it("refuses a name that is not the graph's committed on-chain name", async () => {
      const internals = await boot();

      await expect(internals.ensureStorageAckVmPromotion({
        contextGraphId: '42', swmGraphId: 'burst-cg', operation: 'publish',
      })).resolves.toMatchObject({ ok: false, code: STORAGE_ACK_DECLINE_CODES.CORE_VM_PROMOTION_DISABLED });
      expect(internals.subscribedContextGraphs.has('burst-cg')).toBe(false);
    });

    it('accepts a graph without a committed name only through a local binding', async () => {
      const internals = await boot();
      await internals.store.insert([{
        subject: 'did:dkg:context-graph:locally-bound',
        predicate: `${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}OnChainId`,
        object: '"60"',
        graph: contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY),
      }]);

      await expect(internals.ensureStorageAckVmPromotion({
        contextGraphId: '60', swmGraphId: 'locally-bound', operation: 'publish',
      })).resolves.toEqual({ ok: true });
      // Nothing confirms or contradicts the name yet: retryable.
      await expect(internals.ensureStorageAckVmPromotion({
        contextGraphId: '61', swmGraphId: 'unknown-name', operation: 'publish',
      })).resolves.toMatchObject({ ok: false, code: STORAGE_ACK_DECLINE_CODES.CORE_VM_PROMOTION_UNAVAILABLE });
    });

    it("declines transiently until a brand-new graph's registration is visible, then binds", async () => {
      const internals = await boot();
      let registered = false;
      internals.chain.getContextGraphNameHash = async (id) => (
        id === 62n && registered ? nameHash('brand-new-cg') : null
      );
      const request = { contextGraphId: '62', swmGraphId: 'brand-new-cg', operation: 'publish' as const };

      await expect(internals.ensureStorageAckVmPromotion(request))
        .resolves.toMatchObject({ ok: false, code: STORAGE_ACK_DECLINE_CODES.CORE_VM_PROMOTION_UNAVAILABLE });
      registered = true;
      await expect(internals.ensureStorageAckVmPromotion(request)).resolves.toEqual({ ok: true });
    });

    it('declines transiently when the committed name cannot be read', async () => {
      const internals = await boot();
      internals.chain.getContextGraphNameHash = async () => { throw new Error('rpc down'); };

      await expect(internals.ensureStorageAckVmPromotion({
        contextGraphId: '42', swmGraphId: 'public-cg', operation: 'publish',
      })).resolves.toMatchObject({ ok: false, code: STORAGE_ACK_DECLINE_CODES.CORE_VM_PROMOTION_UNAVAILABLE });
    });
  });

  describe('name-hash placeholders (#2744)', () => {
    /** A Core that saw ContextGraphCreated first holds the graph under its name hash, hosted by an earlier release. */
    async function bootWithHostedPlaceholder(): Promise<Internals & Record<string, any>> {
      const internals = await boot() as Internals & Record<string, any>;
      const hash = nameHash('public-cg');
      expect(internals.stageOnChainContextGraphBindingFromNameHash(hash, '42')).toBe(hash);
      internals.setContextGraphSubscription(hash, {
        ...internals.subscribedContextGraphs.get(hash),
        syncMode: 'always-on',
        coreHosted: true,
      });
      return internals;
    }

    it('adopts the placeholder when the gate records the verified cleartext namespace', async () => {
      const internals = await bootWithHostedPlaceholder();

      await expect(internals.ensureStorageAckVmPromotion({
        contextGraphId: '42', swmGraphId: 'public-cg', operation: 'publish',
      })).resolves.toEqual({ ok: true });

      expect(internals.subscribedContextGraphs.has(nameHash('public-cg'))).toBe(false);
      expect(internals.subscribedContextGraphs.get('public-cg')).toMatchObject({
        coreHosted: true, onChainId: '42', onChainHash: nameHash('public-cg'),
      });
    });

    it('adopts the placeholder when the backfill records a cleartext namespace holding ACK copies', async () => {
      const internals = await bootWithHostedPlaceholder();
      await internals.ensureStorageAckLedgerReady();
      await seedCopy(internals.store, { namespace: 'public-cg', n: 97, ageMs: 0, target: '42' });

      await internals.runVmPromotionAudit();

      expect(internals.subscribedContextGraphs.has(nameHash('public-cg'))).toBe(false);
      expect(internals.subscribedContextGraphs.get('public-cg')).toMatchObject({ coreHosted: true, onChainId: '42' });
    });
  });

  describe('dormant subscription rows', () => {
    it('declines finally when rehydration is disabled', async () => {
      const internals = await boot();
      internals.contextGraphSubscriptionDormancyById.set('dormant-cg', 'rehydrationDisabled');

      const verdict = await internals.ensureStorageAckVmPromotion({
        contextGraphId: '46', swmGraphId: 'dormant-cg', operation: 'publish',
      });

      expect(verdict).toMatchObject({ ok: false, code: STORAGE_ACK_DECLINE_CODES.CORE_VM_PROMOTION_DISABLED });
      expect(verdict.message).toContain('rehydrationDisabled');
    });

    it('declines transiently for a while, then finally, when dormancy does not clear', async () => {
      const internals = await boot();
      internals.contextGraphSubscriptionDormancyById.set('dormant-cg', 'authorityUnavailable');
      const request = { contextGraphId: '46', swmGraphId: 'dormant-cg', operation: 'publish' as const };

      await expect(internals.ensureStorageAckVmPromotion(request))
        .resolves.toMatchObject({ ok: false, code: STORAGE_ACK_DECLINE_CODES.CORE_VM_PROMOTION_UNAVAILABLE });
      internals.storageAckDormantSince.set('dormant-cg', Date.now() - 11 * 60_000);
      await expect(internals.ensureStorageAckVmPromotion(request))
        .resolves.toMatchObject({ ok: false, code: STORAGE_ACK_DECLINE_CODES.CORE_VM_PROMOTION_DISABLED });
    });
  });

  describe('pending-update lane and ledger readiness', () => {
    it('pages past promoted rows so a new update is reached within a few runs', async () => {
      setStatic('VM_PROMOTION_UPDATE_PAGE_SIZE', 2);
      setStatic('VM_PROMOTION_UPDATE_MAX_CHECKS', 1);
      const internals = await boot();
      for (let n = 60; n < 66; n += 1) {
        await seedCopy(internals.store, {
          namespace: 'lane-cg', n, ageMs: 5 * 60_000, version: 2, confirmedVersion: 2, target: '55',
        });
      }
      await seedCopy(internals.store, { namespace: 'lane-cg', n: 90, ageMs: 5 * 60_000, version: 2, target: '55' });
      internals.chain.getMerkleRootCount = async () => 2n;
      const reconciled: string[] = [];
      (internals as any).reconcileStorageAckCopy = async (candidate: { kaUal: string }) => {
        reconciled.push(candidate.kaUal);
        return true;
      };

      for (let run = 0; run < 6 && reconciled.length === 0; run += 1) {
        await internals.promotePendingStorageAckUpdates();
      }

      expect(reconciled).toEqual([ual(90)]);
    });

    it('promotes updates while pre-ledger copies are not grandfathered yet', async () => {
      const internals = await boot();
      internals.storageAckLedgerReady = false;
      await seedCopy(internals.store, { namespace: 'lane-cg', n: 91, ageMs: 5 * 60_000, version: 2, target: '55' });
      internals.chain.getMerkleRootCount = async () => 2n;
      const reconciled: string[] = [];
      (internals as any).reconcileStorageAckCopy = async (candidate: { kaUal: string }) => {
        reconciled.push(candidate.kaUal);
        return true;
      };

      await internals.promotePendingStorageAckUpdates();

      expect(reconciled).toEqual([ual(91)]);
    });

    it('grandfathers once per store, and again only for a window another version may have run', async () => {
      const internals = await boot();
      const grandfatherRuns: string[] = [];
      const update = internals.store.update!.bind(internals.store);
      internals.store.update = (async (sparql: string, options?: unknown) => {
        if (sparql.includes(`<${LEDGER.grandfathered}> true`)) grandfatherRuns.push(sparql);
        return update(sparql, options as never);
      }) as typeof internals.store.update;

      await internals.ensureStorageAckLedgerReady();
      internals.storageAckLedgerReady = false;
      await internals.ensureStorageAckLedgerReady();
      expect(grandfatherRuns).toHaveLength(1);

      // The node last ran with a ledger two hours ago; meanwhile another
      // version stored a copy without one. An older unledgered copy (synced
      // long ago) is not in that window.
      await internals.store.update!(storageAckLedgerMarkUpdate(
        STORAGE_ACK_LEDGER_GRAPH, LEDGER.seenAt, new Date(Date.now() - 2 * HOUR),
      ));
      const duringRollback = await seedCopy(internals.store, { namespace: 'rollback-cg', n: 92, ageMs: HOUR, ledger: 'none' });
      const longAgo = await seedCopy(internals.store, { namespace: 'rollback-cg', n: 93, ageMs: 3 * HOUR, ledger: 'none' });
      internals.storageAckLedgerReady = false;
      await internals.ensureStorageAckLedgerReady();

      expect(grandfatherRuns).toHaveLength(2);
      expect(await ledgerHas(internals.store, duringRollback.op, LEDGER.grandfathered)).toBe(true);
      expect(await ledgerHas(internals.store, longAgo.op, LEDGER.grandfathered)).toBe(false);
    });

    it('releases a registered copy once a later version lands, and stops counting it as stalled', async () => {
      const internals = await boot({ sharedMemoryTtlMs: DAY });
      await internals.ensureStorageAckLedgerReady();
      await internals.recordCoreHostedPublicCg('55', 'released-cg');
      const copy = await seedCopy(internals.store, {
        namespace: 'released-cg', n: 94, ageMs: 2 * HOUR, version: 2, registered: true,
      });
      internals.chain.getMerkleRootCount = async () => 3n;

      const status = await internals.runVmPromotionAudit();

      expect(status).toMatchObject({ stalledOnChain: 0, supersededCopies: 1 });
      expect(await ledgerHas(internals.store, copy.op, LEDGER.supersededAt)).toBe(true);
    });
  });

  it('tears an expired head down only under the per-KA write lock', async () => {
    const internals = await boot({ sharedMemoryTtlMs: 60_000 });
    await internals.ensureStorageAckLedgerReady();
    await seedCopy(internals.store, { namespace: 'lock-cg', n: 95, ageMs: HOUR, ledger: 'none' });
    const sources: string[] = [];
    const query = internals.store.query.bind(internals.store);
    internals.store.query = (async (sparql: string, options?: { source?: string }) => {
      if (options?.source) sources.push(options.source);
      return query(sparql, options as never);
    }) as typeof internals.store.query;
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const holder = withKeyedLocks(internals.writeLocks, [swmKaWriteLockKey('lock-cg', undefined, ual(95))], () => held);

    const cleanup = internals.cleanupExpiredSharedMemory();
    for (let i = 0; i < 100 && !sources.includes('agent.swmCleanup.graphScopedMetadata'); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await new Promise((resolve) => setTimeout(resolve, 20));

    // A writer holding the lock (an ACK or share) is never interleaved with.
    expect(sources).toContain('agent.swmCleanup.graphScopedMetadata');
    expect(sources).not.toContain('agent.swmCleanup.currentHeadOwner');
    release();
    await holder;
    await cleanup;
    expect(sources).toContain('agent.swmCleanup.currentHeadOwner');
  });
});
