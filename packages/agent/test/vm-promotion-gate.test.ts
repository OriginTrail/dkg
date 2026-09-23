/**
 * Core VM-promotion guarantees:
 *
 *   1. Chain-driven VM reconcile has its own switch: the periodic peer-sync
 *      switch no longer turns Phase D core-hosted recording off.
 *   2. The StorageACK finality gate answers `ok` only after the graph is
 *      durably recorded core-hosted, and declines otherwise.
 *   3. The ACK promotion audit backfills graphs ACKed while VM reconcile was
 *      off (public only, idempotently) and watches ACKed KAs that do not
 *      reach VM.
 *   4. The SWM TTL cleanup keeps StorageACK copies that are not in VM yet.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import {
  DKG_ONTOLOGY,
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
  generateKnowledgeAssetShareMetadata,
  storeKnowledgeAssetWorkspaceHead,
} from '@origintrail-official/dkg-publisher';
import { GraphManager, type TripleStore } from '@origintrail-official/dkg-storage';
import { DKGAgent } from '../src/index.js';
import type { ContextGraphSubscriptionRecord } from '../src/dkg-agent-types.js';
import { STORAGE_ACK_UNREGISTERED_AT_PREDICATE } from '../src/storage-ack-retention.js';

const AUTHOR = '0x1111111111111111111111111111111111111111';
const DKG = 'http://dkg.io/ontology/';
const HOUR = 60 * 60_000;

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
};

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
  runVmPromotionAudit(): Promise<Record<string, number | string | null>>;
  vmPromotionAuditStatus: Record<string, number | string | null>;
  vmReconcileEnabled(): boolean;
  cleanupExpiredSharedMemory(): Promise<number>;
}

describe('core VM-promotion guarantees', () => {
  let agent: DKGAgent | null = null;
  const saved: ContextGraphSubscriptionRecord[] = [];
  let failSaves = false;

  afterEach(async () => {
    if (agent) {
      await agent.stop().catch(() => undefined);
      agent = null;
    }
    saved.length = 0;
    failSaves = false;
  });

  async function boot(config: Record<string, unknown> = {}): Promise<Internals> {
    const chain = new MockChainAdapter();
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
    return internals;
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

    it('declines transiently while the access policy cannot be read', async () => {
      const internals = await boot();
      internals.chain.isContextGraphActiveOnChain = async () => false;

      await expect(internals.ensureStorageAckVmPromotion({ contextGraphId: '44', operation: 'publish' }))
        .resolves.toMatchObject({ ok: false, code: STORAGE_ACK_DECLINE_CODES.CORE_VM_PROMOTION_UNAVAILABLE });
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
  });

  describe('ACK promotion audit', () => {
    async function seedStorageAckCopy(
      store: TripleStore,
      input: { contextGraphId: string; n: number; ageMs: number; confirmed?: boolean },
    ): Promise<{ op: string; metaGraph: string; assertionGraph: string; head: string }> {
      const metaGraph = contextGraphSharedMemoryMetaUri(input.contextGraphId);
      const shareOperationId = `storage-ack-${input.contextGraphId}-${input.n}`;
      const metadata = generateKnowledgeAssetShareMetadata({
        shareOperationId,
        contextGraphId: input.contextGraphId,
        kaUal: ual(input.n),
        assertionVersion: 1,
        publicTripleCount: 1,
        privateTripleCount: 0,
        publisherPeerId: 'publisher-peer',
        accessPolicy: 'public',
        allowedPeers: [],
        timestamp: new Date(Date.now() - input.ageMs),
      }, metaGraph);
      await store.insert(metadata);
      await storeKnowledgeAssetWorkspaceHead({
        store,
        graphManager: new GraphManager(store),
        contextGraphId: input.contextGraphId,
        kaUal: ual(input.n),
        assertionVersion: 1,
        shareOperationId,
      });
      const assertionGraph = knowledgeAssetLayerGraphUri(
        input.contextGraphId,
        MemoryLayer.SharedWorkingMemory,
        createGraphKnowledgeAssetScope(ual(input.n), 1),
      );
      await store.insert([{
        subject: `urn:entity:${input.n}`,
        predicate: 'http://schema.org/name',
        object: `"ka ${input.n}"`,
        graph: assertionGraph,
      }]);
      if (input.confirmed) {
        await store.insert([{
          subject: ual(input.n),
          predicate: `${DKG}status`,
          object: '"confirmed"',
          graph: contextGraphMetaUri(input.contextGraphId),
        }]);
      }
      return {
        op: metadata[0]!.subject,
        metaGraph,
        assertionGraph,
        head: `${ual(input.n)}#dkg-swm-head`,
      };
    }

    async function count(store: TripleStore, graph: string, subject?: string): Promise<number> {
      const pattern = subject ? `<${subject}> ?p ?o` : '?s ?p ?o';
      const result = await store.query(`SELECT * WHERE { GRAPH <${graph}> { ${pattern} } }`);
      return result.type === 'bindings' ? result.bindings.length : 0;
    }

    it('backfills public graphs holding ACK copies, skips curated ones, and is idempotent', async () => {
      const internals = await boot();
      const policy = recorder(async (id: bigint) => (id === 56n ? 1 : 0));
      internals.chain.getContextGraphAccessPolicy = policy;
      internals.chain.getKAContextGraphId = async () => 0n;
      // A cleartext graph resolves through the ontology on adapters without a
      // finalized authority index; numeric SWM namespaces are their own id.
      await internals.store.insert([{
        subject: 'did:dkg:context-graph:named-public',
        predicate: `${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}OnChainId`,
        object: '"57"',
        graph: contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY),
      }]);
      await seedStorageAckCopy(internals.store, { contextGraphId: '55', n: 1, ageMs: 0 });
      await seedStorageAckCopy(internals.store, { contextGraphId: '56', n: 2, ageMs: 0 });
      await seedStorageAckCopy(internals.store, { contextGraphId: 'named-public', n: 3, ageMs: 0 });

      const first = await internals.runVmPromotionAudit();

      expect(first).toMatchObject({ graphsWithAckCopies: 3, backfilledGraphs: 2, unresolvedGraphs: 0 });
      expect(internals.subscribedContextGraphs.get('55')).toMatchObject({ coreHosted: true, onChainId: '55' });
      expect(internals.subscribedContextGraphs.get('named-public')).toMatchObject({
        coreHosted: true,
        onChainId: '57',
      });
      expect(internals.subscribedContextGraphs.has('56')).toBe(false);
      expect([...new Set(saved.map((record) => record.id))].sort()).toEqual(['55', 'named-public']);

      const policyReads = policy.calls.length;
      const writes = saved.length;
      const second = await internals.runVmPromotionAudit();

      expect(second).toMatchObject({ backfilledGraphs: 2 });
      expect(policy.calls).toHaveLength(policyReads);
      expect(saved).toHaveLength(writes);
    });

    it('reports ACKed KAs stalled on chain and stamps copies the chain never registered', async () => {
      const internals = await boot({ sharedMemoryTtlMs: 24 * HOUR });
      const triggered: string[] = [];
      internals.vmReconcileScheduling = {
        triggerPeriodic: (cg: string) => { triggered.push(cg); },
        triggerLive: () => undefined,
        releaseLiveHold: () => undefined,
      };
      internals.chain.getKAContextGraphId = async (id: bigint) => (id === kaId(10) ? 55n : 0n);
      await internals.recordCoreHostedPublicCg('55');
      const stalled = await seedStorageAckCopy(internals.store, { contextGraphId: '55', n: 10, ageMs: 2 * HOUR });
      const unregistered = await seedStorageAckCopy(internals.store, { contextGraphId: '55', n: 11, ageMs: 48 * HOUR });
      const recentUnregistered = await seedStorageAckCopy(internals.store, { contextGraphId: '55', n: 12, ageMs: 2 * HOUR });
      await seedStorageAckCopy(internals.store, { contextGraphId: '55', n: 13, ageMs: 2 * HOUR, confirmed: true });
      await seedStorageAckCopy(internals.store, { contextGraphId: '55', n: 14, ageMs: 60_000 });

      const status = await internals.runVmPromotionAudit();

      // n=13 is in VM and n=14 is younger than the stall threshold.
      expect(status).toMatchObject({
        staleUnpromotedCopies: 3,
        stalledOnChain: 1,
        notRegisteredOnChain: 2,
        expiredUnregisteredCopies: 1,
        retriesTriggered: 1,
      });
      expect(triggered).toEqual(['55']);
      expect(await count(internals.store, unregistered.metaGraph, unregistered.op)).toBeGreaterThan(0);
      const stamped = await internals.store.query(
        `ASK { GRAPH <${unregistered.metaGraph}> { <${unregistered.op}> <${STORAGE_ACK_UNREGISTERED_AT_PREDICATE}> ?at } }`,
      );
      expect(stamped).toMatchObject({ value: true });
      // A copy younger than the TTL may still belong to a publish in flight.
      const notStamped = await internals.store.query(
        `ASK { GRAPH <${recentUnregistered.metaGraph}> { <${recentUnregistered.op}> <${STORAGE_ACK_UNREGISTERED_AT_PREDICATE}> ?at } }`,
      );
      expect(notStamped).toMatchObject({ value: false });
      expect(await count(internals.store, stalled.assertionGraph)).toBe(1);
    });

    it('keeps unpromoted ACK copies past the SWM TTL and expires promoted or unregistered ones', async () => {
      const internals = await boot({ sharedMemoryTtlMs: 60_000 });
      const cg = 'ttl-ack-cg';
      const retained = await seedStorageAckCopy(internals.store, { contextGraphId: cg, n: 20, ageMs: HOUR });
      const promoted = await seedStorageAckCopy(internals.store, { contextGraphId: cg, n: 21, ageMs: HOUR, confirmed: true });
      const unregistered = await seedStorageAckCopy(internals.store, { contextGraphId: cg, n: 22, ageMs: HOUR });
      await internals.store.insert([{
        subject: unregistered.op,
        predicate: STORAGE_ACK_UNREGISTERED_AT_PREDICATE,
        object: `"${new Date().toISOString()}"^^<http://www.w3.org/2001/XMLSchema#dateTime>`,
        graph: unregistered.metaGraph,
      }]);
      const pastCeiling = await seedStorageAckCopy(internals.store, {
        contextGraphId: cg,
        n: 23,
        ageMs: 100 * 24 * HOUR,
      });

      await internals.cleanupExpiredSharedMemory();

      expect(await count(internals.store, retained.metaGraph, retained.op)).toBeGreaterThan(0);
      expect(await count(internals.store, retained.metaGraph, retained.head)).toBeGreaterThan(0);
      expect(await count(internals.store, retained.assertionGraph)).toBe(1);
      for (const expired of [promoted, unregistered, pastCeiling]) {
        expect(await count(internals.store, expired.metaGraph, expired.op)).toBe(0);
        expect(await count(internals.store, expired.metaGraph, expired.head)).toBe(0);
        expect(await count(internals.store, expired.assertionGraph)).toBe(0);
      }
    });

    it('keeps a head shared with a retained ACK copy when an older alias operation expires', async () => {
      const internals = await boot({ sharedMemoryTtlMs: 60_000 });
      const cg = 'ttl-alias-cg';
      const retained = await seedStorageAckCopy(internals.store, { contextGraphId: cg, n: 30, ageMs: HOUR });
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
  });
});
