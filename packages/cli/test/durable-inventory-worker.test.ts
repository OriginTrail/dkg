import { inventoryPersistenceFailure } from '../../agent/src/rfc64/inventory-persistence-failure.js';
import { Wallet, getBytes } from 'ethers';
import { describe, expect, it, vi } from 'vitest';
import { createOperationContext, canonicalGraphScopedAuthorSealFromAssertionSealV1, computeCanonicalGraphScopedAuthorSealDigestV1 } from '@origintrail-official/dkg-core';
import { TripleStoreAsyncPromoteQueue } from '@origintrail-official/dkg-publisher';
import { commitDurableShareInventory } from '../../agent/src/internal/promote/durable-share-inventory.js';
import { AUTHOR, AUTHOR_WALLET, CONTEXT_GRAPH_ID, NETWORK_ID, seedDurableWorkspaceAssetV1, startRepairAgentV1 } from '../../agent/test/support/rfc64-local-catalog-repair-fixture.js';
import { rfc64SwmInventoryShadowRuntimeV1 } from '../../agent/src/rfc64/swm-inventory-shadow-runtime-v1.js';
import { runPromoteJob, createPromoteWorkerSupervisor } from '../src/daemon/worker/async-promote-worker.js';

describe('bound worker owns the real inventory CAS', () => {
  it.each(['before-write', 'lost-acknowledgement', 'policy-not-accepted'])('recovers %s with one original inventory row', async fault => {
    const agent = await startRepairAgentV1({ name: `bound-inventory-${fault}` });
    vi.spyOn(agent, 'getCustodialAgentPrivateKey').mockReturnValue(AUTHOR_WALLET.privateKey);
    agent.acceptOpenContextGraphPolicyV1({ networkId: NETWORK_ID, contextGraphId: CONTEXT_GRAPH_ID, ownerAddress: AUTHOR });
    await agent.whenRfc64CatalogResponsibilitiesIdleV1();
    await agent.whenRfc64CatalogSupervisorsIdleV1();
    const seeded = await seedDurableWorkspaceAssetV1(agent, fault, 91n);
    const params = { contextGraphId: CONTEXT_GRAPH_ID, assertionCoordinate: seeded.assertionCoordinate,
      lifecycleAgentAddress: AUTHOR, shareOperationId: seeded.shareOperationId, ctx: createOperationContext('share') };
    const queue = new TripleStoreAsyncPromoteQueue(agent.store, { backoff: () => 0, maxRetries: 1 });
    const binding = { version: 1 as const, inventoryRequired: true,
      sealDigest: computeCanonicalGraphScopedAuthorSealDigestV1(canonicalGraphScopedAuthorSealFromAssertionSealV1(seeded.seal)),
      intent: { version: 1 as const, operationId: seeded.shareOperationId, timestampMs: Date.parse('2026-07-19T12:35:00.000Z'),
        confirmationRequired: false, accessPolicy: 'public' as const, allowedPeers: [] } };
    const job = await queue.enqueueAndClaim({ contextGraphId: CONTEXT_GRAPH_ID, assertionName: seeded.assertionCoordinate,
      entities: 'all', agentAddress: AUTHOR, recoveryBinding: binding }, 'first');
    const persistence = agent.rfc64PersistenceV1!;
    const inventory = persistence.swmAuthorInventory;
    const commit = inventory.compareAndSwapSwmAuthorInventoryV1.bind(inventory);
    const policy = fault === 'policy-not-accepted'
      ? vi.spyOn(agent.rfc64PublicCatalogServiceV1!, 'acceptedPolicySnapshot').mockReturnValue(null) : undefined;
    if (!policy) (agent as any).rfc64PersistenceV1 = { ...persistence, swmAuthorInventory: { ...inventory,
      compareAndSwapSwmAuthorInventoryV1: (input: Parameters<typeof commit>[0]) => {
        if (fault === 'lost-acknowledgement') commit(input);
        throw inventoryPersistenceFailure(new Error('inventory CAS interruption'));
      },
    } };
    const run = (claimed: typeof job, workerId: string) => runPromoteJob({ job: claimed, queue, workerId,
      now: Date.now, heartbeatIntervalMs: 60_000, log: () => undefined,
      runPromote: async (_request, markStarted) => { await markStarted(); await commitDurableShareInventory(agent, { ...params, recoveryBinding: binding }); return { promotedCount: 0 }; },
    });
    expect((await run(job, 'first')).outcome).toBe('failed_retrying');
    expect((await queue.getStatus(job.jobId))?.attempt.lastError).toMatchObject({ diagnosticCode: policy ? 'PROMOTE_RETRYABLE_FAILURE' : 'PROMOTE_POST_COMMIT_FAILURE', retryable: true });
    const interrupted = agent.readRfc64SwmAuthorInventorySnapshotV1({ inventoryScopeDigest: seeded.scopeDigest, authorAddress: AUTHOR });
    expect(interrupted?.rows.length ?? 0).toBe(fault === 'lost-acknowledgement' ? 1 : 0);
    policy?.mockRestore();
    (agent as any).rfc64PersistenceV1 = persistence;
    vi.spyOn(agent, 'promoteQueue', 'get').mockReturnValue(queue);
    const assertion = agent.assertion;
    vi.spyOn(agent, 'assertion', 'get').mockReturnValue({ ...assertion, promote: async (_cg, _name, options) => {
      expect(options?.recoveryBinding).toEqual(binding);
      await commitDurableShareInventory(agent, { ...params, recoveryBinding: binding });
      return { promotedCount: 0, sealed: true, publishReady: true, shareOperationId: seeded.shareOperationId };
    } });
    const supervisor = createPromoteWorkerSupervisor({ agent, workerConcurrency: 1, pollIntervalMs: 10, log: () => undefined });
    try {
      await supervisor.start();
      await vi.waitFor(async () => expect((await queue.getStatus(job.jobId))?.state).toBe('succeeded'));
    } finally { await supervisor.stop(); }
    const completed = await queue.getStatus(job.jobId);
    expect(completed?.request.recoveryBinding).toEqual(binding);
    expect(completed?.attempt.count).toBe(2);
    const snapshot = agent.readRfc64SwmAuthorInventorySnapshotV1({ inventoryScopeDigest: seeded.scopeDigest, authorAddress: AUTHOR });
    expect(snapshot?.rows).toHaveLength(1);
    expect(snapshot?.rows[0]).toMatchObject({ kaUal: seeded.seal.kaUal, assertionCoordinate: seeded.assertionCoordinate });
  });

  it('holds a real invalid predecessor signature for inspection before any inventory CAS', async () => {
    const agent = await startRepairAgentV1({ name: 'bound-inventory-invalid-signature' });
    vi.spyOn(agent, 'getCustodialAgentPrivateKey').mockReturnValue(AUTHOR_WALLET.privateKey);
    agent.acceptOpenContextGraphPolicyV1({ networkId: NETWORK_ID, contextGraphId: CONTEXT_GRAPH_ID, ownerAddress: AUTHOR });
    await agent.whenRfc64CatalogResponsibilitiesIdleV1();
    const first = await seedDurableWorkspaceAssetV1(agent, 'predecessor', 94n);
    await agent.commitRfc64SwmAuthorInventoryV1({ contextGraphId: CONTEXT_GRAPH_ID,
      assertionCoordinate: first.assertionCoordinate, lifecycleAgentAddress: AUTHOR, shareOperationId: first.shareOperationId });
    const next = await seedDurableWorkspaceAssetV1(agent, 'successor', 95n);
    const persistence = agent.rfc64PersistenceV1!;
    const inventory = persistence.swmAuthorInventory;
    const snapshot = inventory.readSwmAuthorInventorySnapshotV1(first.scopeDigest, AUTHOR)!;
    const wrongSignature = await new Wallet(`0x${'22'.repeat(32)}`).signMessage(getBytes(snapshot.head.objectDigest));
    const compare = vi.fn(inventory.compareAndSwapSwmAuthorInventoryV1.bind(inventory));
    (agent as any).rfc64PersistenceV1 = { ...persistence, swmAuthorInventory: { ...inventory,
      readSwmAuthorInventorySnapshotV1: () => ({ ...snapshot, head: { ...snapshot.head, signature: wrongSignature } }),
      compareAndSwapSwmAuthorInventoryV1: compare } };
    const binding = { version: 1 as const, inventoryRequired: true,
      sealDigest: computeCanonicalGraphScopedAuthorSealDigestV1(canonicalGraphScopedAuthorSealFromAssertionSealV1(next.seal)),
      intent: { version: 1 as const, operationId: next.shareOperationId, timestampMs: Date.now(),
        confirmationRequired: false, accessPolicy: 'public' as const, allowedPeers: [] } };
    const queue = new TripleStoreAsyncPromoteQueue(agent.store, { backoff: () => 0 });
    const job = await queue.enqueueAndClaim({ contextGraphId: CONTEXT_GRAPH_ID, assertionName: next.assertionCoordinate,
      entities: 'all', agentAddress: AUTHOR, recoveryBinding: binding }, 'original');
    try {
      const result = await runPromoteJob({ job, queue, workerId: 'original', now: Date.now, heartbeatIntervalMs: 60_000, log: () => undefined,
        runPromote: async (_request, started) => { await started(); await commitDurableShareInventory(agent, {
          contextGraphId: CONTEXT_GRAPH_ID, assertionCoordinate: next.assertionCoordinate,
          lifecycleAgentAddress: AUTHOR, recoveryBinding: binding, ctx: createOperationContext('share'),
        }); return { promotedCount: 0 }; } });
      expect(result).toMatchObject({ outcome: 'failed_terminal', cause: { code: 'swm-inventory-producer-history' } });
      expect((await queue.getStatus(job.jobId))?.state).toBe('failed');
      expect(await queue.claimNext('automatic')).toBeNull();
      expect(compare).not.toHaveBeenCalled();
    } finally { (agent as any).rfc64PersistenceV1 = persistence; }
  });

  it('serializes a prepared bound handoff before public VM inventory removal', async () => {
    const agent = await startRepairAgentV1({ name: 'bound-confirmation-race' });
    vi.spyOn(agent, 'getCustodialAgentPrivateKey').mockReturnValue(AUTHOR_WALLET.privateKey);
    agent.acceptOpenContextGraphPolicyV1({ networkId: NETWORK_ID, contextGraphId: CONTEXT_GRAPH_ID, ownerAddress: AUTHOR });
    await agent.whenRfc64CatalogResponsibilitiesIdleV1();
    await agent.whenRfc64CatalogSupervisorsIdleV1();
    const seeded = await seedDurableWorkspaceAssetV1(agent, 'confirmation-race', 92n);
    let resume!: () => void, prepared!: () => void;
    const paused = new Promise<void>(resolve => { prepared = resolve; });
    const release = new Promise<void>(resolve => { resume = resolve; });
    const original = (agent as any).prepareRfc64SwmAuthorInventoryRowV1.bind(agent);
    vi.spyOn(agent as any, 'prepareRfc64SwmAuthorInventoryRowV1').mockImplementationOnce(async (...args) => {
      const row = await original(...args); prepared(); await release; return row;
    });
    const params = { contextGraphId: CONTEXT_GRAPH_ID, assertionCoordinate: seeded.assertionCoordinate,
      lifecycleAgentAddress: AUTHOR, shareOperationId: seeded.shareOperationId, ctx: createOperationContext('share') };
    const binding = { version: 1 as const, inventoryRequired: true,
      sealDigest: computeCanonicalGraphScopedAuthorSealDigestV1(canonicalGraphScopedAuthorSealFromAssertionSealV1(seeded.seal)),
      intent: { version: 1 as const, operationId: seeded.shareOperationId, timestampMs: 1,
        confirmationRequired: false, accessPolicy: 'public' as const, allowedPeers: [] } };
    const handoff = commitDurableShareInventory(agent, { ...params, recoveryBinding: binding });
    await paused;
    const runtime = rfc64SwmInventoryShadowRuntimeV1(agent);
    const handoffTracked = runtime.hasInventoryWrites({ contextGraphId: CONTEXT_GRAPH_ID, authorAddress: AUTHOR });
    let removed = false;
    const confirmation = agent.observeRfc64ConfirmedVmV1({ contextGraphId: CONTEXT_GRAPH_ID,
      assertionCoordinate: seeded.assertionCoordinate, shareOperationId: seeded.shareOperationId,
      seal: seeded.seal, assertionUri: 'urn:confirmed:race',
      ctx: createOperationContext('publish'), publicationLabel: 'queued publish' }).then(result => { removed = true; return result; });
    try {
      expect(handoffTracked).toBe(true);
      await new Promise(resolve => setImmediate(resolve));
      expect(removed).toBe(false);
    } finally {
      resume();
    }
    await handoff;
    expect(await confirmation).toBe(true);
    expect(agent.readRfc64SwmAuthorInventorySnapshotV1({ inventoryScopeDigest: seeded.scopeDigest, authorAddress: AUTHOR })?.rows ?? []).toHaveLength(0);
    expect(runtime.hasInventoryWrites({ contextGraphId: CONTEXT_GRAPH_ID, authorAddress: AUTHOR })).toBe(false);
  });

});
