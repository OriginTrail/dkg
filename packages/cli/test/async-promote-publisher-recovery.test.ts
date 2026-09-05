import { describe, expect, it, vi } from 'vitest';
vi.mock('@origintrail-official/dkg-publisher', () => import('../../publisher/src/index.js'));
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import {
  TypedEventBus,
  MemoryLayer,
  assertionLifecycleUri,
  contextGraphMetaUri,
  createGraphKnowledgeAssetScope,
  generateEd25519Keypair,
  knowledgeAssetLayerGraphUri,
  assertionScopedGraphUri,
} from '@origintrail-official/dkg-core';
import { DKGPublisher, resolveKnowledgeAssetWorkspaceHead } from '@origintrail-official/dkg-publisher';
import { GraphManager, StoreOperationTimeoutError } from '@origintrail-official/dkg-storage';
import { DKGAgent } from '../../agent/src/dkg-agent.js';
import { finalizeRootlessAssertionForTest } from '../../publisher/test/_helpers/rootless-lifecycle.js';
import { runPromoteJob } from '../src/daemon/worker/async-promote-worker.js';
import { createAsyncPromoteWorkerFixture } from './_helpers/async-promote-worker-fixture.js';

describe('async promote repairs the publisher durable tail', () => {
  it.each([
    ['snapshot', undefined], ['wm-cleanup', undefined], ['completion-marker', undefined],
    ['wm-cleanup', 'succeeded'], ['wm-cleanup', 'not_started'], ['wm-cleanup', 'indeterminate'],
  ] as const)(
    'recovers non-started %s without duplicate publication (legacy VM cleanup: %s)',
    async (failureSite, legacyVmCleanup) => {
      const { store, queue, clock } = createAsyncPromoteWorkerFixture();
      const contextGraphId = 'repair-cg';
      const name = 'repair-asset';
      const agentAddress = `0x${'11'.repeat(20)}`;
      const publisher = new DKGPublisher({
        store,
        chain: new MockChainAdapter(),
        eventBus: new TypedEventBus(),
        keypair: await generateEd25519Keypair(),
      });
      await publisher.assertionCreate(contextGraphId, name, agentAddress);
      await publisher.assertionWrite(contextGraphId, name, agentAddress, [{
        subject: 'urn:test:repair', predicate: 'http://schema.org/name', object: '"Repair"',
      }]);
      const finalized = await finalizeRootlessAssertionForTest({
        publisher, store, contextGraphId, name, agentAddress,
      });

      // Use the real facade after preparing the valid sealed test asset. No
      // network or signing service is needed for this public promotion.
      const agent = Object.create(DKGAgent.prototype) as any;
      agent.defaultAgentAddress = agentAddress;
      agent.node = { peerId: { toString: () => '12D3KooWRecovery' } };
      agent.publisher = publisher;
      agent.prepareAtomicAssertionShare = async () => undefined;
      agent.resolveWorkspaceGossipSigningAgent = async () => undefined;
      agent.resolveWorkspaceRecipientsGated = async () => ({ requiresEncryption: false, recipients: [] });
      agent.buildCuratorAckConfirmer = async () => undefined;
      agent.getContextGraphOnChainPolicy = async () => ({ accessPolicy: 0 });
      agent.afterDurableSwmPromotionV1 = vi.fn(async () => undefined);
      const gossip = vi.fn(async (..._args: unknown[]) => undefined);
      agent.publishWorkspaceGossip = gossip;

      const jobId = await queue.enqueue({
        contextGraphId, assertionName: name, agentAddress, entities: 'all',
      });
      const runAttempt = async () => {
        const job = await queue.claimNext('recovery-worker');
        if (!job) throw new Error('Expected a claimable promotion');
        return runPromoteJob({
          job, queue, workerId: 'recovery-worker', now: clock.now, heartbeatIntervalMs: 0,
          log: () => {},
          runPromote: async (_request, markPromoteStarted) => {
            await markPromoteStarted();
            return agent.assertion.promote(contextGraphId, name);
          },
        });
      };
      const storageFailure = new StoreOperationTimeoutError({
        backend: 'managed-oxigraph',
        operation: failureSite === 'wm-cleanup' ? 'dropGraph' : 'insert',
        outcome: 'not_started',
      });
      const insert = store.insert.bind(store);
      const dropGraph = store.dropGraph.bind(store);
      const wmGraph = await publisher.wmGraphUri(contextGraphId, agentAddress, name);
      let injected = false;
      const insertSpy = vi.spyOn(store, 'insert').mockImplementation(async (quads) => {
        const matchesSite = failureSite === 'snapshot'
          ? quads.some((quad) => quad.graph.includes('/_shared_memory_snapshots/') && quad.graph.endsWith('/ka'))
          : failureSite === 'completion-marker'
            && quads.some((quad) => quad.predicate === 'http://dkg.io/ontology/swmShareComplete');
        if (!injected && matchesSite) {
          injected = true;
          expect(await store.countQuads(finalized.sharedGraphUri)).toBe(1);
          if (failureSite === 'completion-marker') expect(await store.countQuads(wmGraph)).toBe(0);
          throw storageFailure;
        }
        return insert(quads);
      });
      const dropSpy = vi.spyOn(store, 'dropGraph').mockImplementation(async (graph) => {
        if (!injected && failureSite === 'wm-cleanup' && graph === wmGraph) {
          injected = true;
          expect(await publisher.hasSwmShareComplete(contextGraphId, name, agentAddress)).toBe(false);
          throw storageFailure;
        }
        return dropGraph(graph);
      });
      try {
        expect(await runAttempt()).toMatchObject({
          outcome: 'failed_retrying', error: { classification: 'transient', retryable: true },
        });
      } finally {
        insertSpy.mockRestore();
        dropSpy.mockRestore();
      }
      expect(injected).toBe(true);
      expect(gossip).not.toHaveBeenCalled();
      expect((await queue.getStatus(jobId))?.commitMarker?.swmInserted).toBe(false);
      expect((await publisher.assertionQuery(contextGraphId, name, agentAddress)).length)
        .toBe(failureSite === 'completion-marker' ? 0 : 1);
      expect(await publisher.hasSwmShareComplete(contextGraphId, name, agentAddress)).toBe(false);
      const lifecycle = assertionLifecycleUri(contextGraphId, agentAddress, name);
      const operation = await store.query(
        `SELECT ?id WHERE { GRAPH <${contextGraphMetaUri(contextGraphId)}> { ` +
        `<${lifecycle}> <http://dkg.io/ontology/shareOperationId> ?id } }`,
      );
      const rawId = operation.type === 'bindings' ? operation.bindings[0]?.['id'] : undefined;
      const operationId = rawId?.match(/^"(.*)"$/)?.[1] ?? rawId;
      expect(operationId).toBeTruthy();

      if (legacyVmCleanup !== undefined) {
        // Model the durable state left by the old marker-before-cleanup ordering:
        // a confirmed publish moved SWM to VM while an already queued retry and
        // the stale WM copy survived. Exercise the actual worker/facade/publisher
        // retry against that persisted state, without broadcasting an EVM transaction.
        const vmGraph = knowledgeAssetLayerGraphUri(contextGraphId, MemoryLayer.VerifiableMemory,
          createGraphKnowledgeAssetScope(finalized.kaUal, finalized.assertionVersion));
        await store.insert(finalized.publicQuads.map((quad) => ({ ...quad, graph: vmGraph })));
        await store.dropGraph(finalized.sharedGraphUri);
        const memoryLayer = 'http://dkg.io/ontology/memoryLayer';
        await store.deleteByPattern({
          graph: contextGraphMetaUri(contextGraphId), subject: lifecycle, predicate: memoryLayer,
        });
        await store.insert([{
          graph: contextGraphMetaUri(contextGraphId), subject: lifecycle,
          predicate: memoryLayer, object: `"${MemoryLayer.VerifiableMemory}"`,
        }]);
        const staleChild = assertionScopedGraphUri(wmGraph, 'urn:legacy:named-graph');
        const unrelatedGraph = `${wmGraph}-another-asset`;
        await store.insert([
          { ...finalized.publicQuads[0]!, graph: staleChild },
          { ...finalized.publicQuads[0]!, graph: unrelatedGraph },
        ]);
        if (legacyVmCleanup !== 'succeeded') {
          const cleanupFailure = new StoreOperationTimeoutError({
            backend: 'managed-oxigraph', operation: 'dropGraph', outcome: legacyVmCleanup,
          });
          const cleanupSpy = vi.spyOn(store, 'dropGraph').mockImplementation(async (graph) => {
            if (graph === wmGraph) throw cleanupFailure;
            return dropGraph(graph);
          });
          try {
            clock.advance(60_001);
            expect(await runAttempt()).toMatchObject({
              outcome: legacyVmCleanup === 'not_started' ? 'failed_retrying' : 'failed_terminal',
              error: { retryable: legacyVmCleanup === 'not_started' },
            });
          } finally {
            cleanupSpy.mockRestore();
          }
          expect(await store.countQuads(vmGraph)).toBe(1);
          expect(await store.hasGraph(finalized.sharedGraphUri)).toBe(false);
          expect(await store.countQuads(wmGraph)).toBe(1);
          expect(gossip).not.toHaveBeenCalled();
          expect(agent.afterDurableSwmPromotionV1).not.toHaveBeenCalled();
          if (legacyVmCleanup === 'indeterminate') {
            expect(await queue.getStatus(jobId)).toMatchObject({ state: 'failed' });
            return;
          }
        }
        clock.advance(60_001);
        expect(await runAttempt()).toMatchObject({ outcome: 'succeeded' });
        expect(await queue.getStatus(jobId)).toMatchObject({
          state: 'succeeded', attempt: { count: legacyVmCleanup === 'not_started' ? 3 : 2 },
        });
        expect(gossip).not.toHaveBeenCalled();
        expect(agent.afterDurableSwmPromotionV1).not.toHaveBeenCalled();
        expect(await store.hasGraph(finalized.sharedGraphUri)).toBe(false);
        expect(await store.countQuads(vmGraph)).toBe(1);
        expect(await publisher.assertionQuery(contextGraphId, name, agentAddress)).toEqual([]);
        expect(await store.hasGraph(wmGraph)).toBe(false);
        expect(await store.hasGraph(staleChild)).toBe(false);
        expect(await store.countQuads(unrelatedGraph)).toBe(1);
        expect(await publisher.hasSwmShareComplete(contextGraphId, name, agentAddress)).toBe(false);
        expect(await store.query(`ASK { GRAPH <${contextGraphMetaUri(contextGraphId)}> {
          <${lifecycle}> <${memoryLayer}> "${MemoryLayer.VerifiableMemory}"
        } }`)).toMatchObject({ type: 'boolean', value: true });
        await expect(publisher.assertionPullFrom(contextGraphId, name, agentAddress, 'vm'))
          .resolves.toMatchObject({ seeded: 1, fromLayer: 'vm' });
        expect(await publisher.assertionQuery(contextGraphId, name, agentAddress)).toHaveLength(1);
        expect(await store.countQuads(vmGraph)).toBe(1);
        return;
      }

      clock.advance(60_001);
      expect(await runAttempt()).toMatchObject({ outcome: 'succeeded' });
      expect(await queue.getStatus(jobId)).toMatchObject({
        state: 'succeeded', commitMarker: { swmInserted: true }, attempt: { count: 2 },
      });
      expect(gossip).toHaveBeenCalledTimes(1);
      expect(gossip.mock.calls[0]?.[4]).toBe(operationId);
      expect(agent.afterDurableSwmPromotionV1).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ shareOperationId: operationId }),
      );
      expect(await resolveKnowledgeAssetWorkspaceHead({
        store, graphManager: new GraphManager(store), contextGraphId, kaUal: finalized.kaUal,
      })).toMatchObject({ shareOperationId: operationId });
      expect(await store.countQuads(finalized.sharedGraphUri)).toBe(1);
      expect((await publisher.assertionQuery(contextGraphId, name, agentAddress)).length).toBe(0);
    },
  );
});
