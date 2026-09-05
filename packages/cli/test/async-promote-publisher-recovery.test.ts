import { describe, expect, it, vi } from 'vitest';
vi.mock('@origintrail-official/dkg-publisher', () => import('../../publisher/src/index.js'));
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import {
  TypedEventBus,
  assertionLifecycleUri,
  contextGraphMetaUri,
  generateEd25519Keypair,
} from '@origintrail-official/dkg-core';
import { DKGPublisher, resolveKnowledgeAssetWorkspaceHead } from '@origintrail-official/dkg-publisher';
import { GraphManager, StoreOperationTimeoutError } from '@origintrail-official/dkg-storage';
import { DKGAgent } from '../../agent/src/dkg-agent.js';
import { finalizeRootlessAssertionForTest } from '../../publisher/test/_helpers/rootless-lifecycle.js';
import { runPromoteJob } from '../src/daemon/worker/async-promote-worker.js';
import { createAsyncPromoteWorkerFixture } from './_helpers/async-promote-worker-fixture.js';

describe('async promote repairs the publisher durable tail', () => {
  it('retries a non-started snapshot write with the same operation ID and one gossip emission', async () => {
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
      backend: 'managed-oxigraph', operation: 'insert', outcome: 'not_started',
    });
    const insert = store.insert.bind(store);
    let injected = false;
    const insertSpy = vi.spyOn(store, 'insert').mockImplementation(async (quads) => {
      if (!injected && quads.some((quad) =>
        quad.graph.includes('/_shared_memory_snapshots/') && quad.graph.endsWith('/ka'))) {
        injected = true;
        expect(await store.countQuads(finalized.sharedGraphUri)).toBe(1);
        throw storageFailure;
      }
      return insert(quads);
    });
    try {
      expect(await runAttempt()).toMatchObject({
        outcome: 'failed_retrying', error: { classification: 'transient', retryable: true },
      });
    } finally {
      insertSpy.mockRestore();
    }
    expect(injected).toBe(true);
    expect(gossip).not.toHaveBeenCalled();
    expect((await queue.getStatus(jobId))?.commitMarker?.swmInserted).toBe(false);
    expect((await publisher.assertionQuery(contextGraphId, name, agentAddress)).length).toBe(1);
    const lifecycle = assertionLifecycleUri(contextGraphId, agentAddress, name);
    const operation = await store.query(
      `SELECT ?id WHERE { GRAPH <${contextGraphMetaUri(contextGraphId)}> { ` +
      `<${lifecycle}> <http://dkg.io/ontology/shareOperationId> ?id } }`,
    );
    const rawId = operation.type === 'bindings' ? operation.bindings[0]?.['id'] : undefined;
    const operationId = rawId?.match(/^"(.*)"$/)?.[1] ?? rawId;
    expect(operationId).toBeTruthy();

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
  });
});
