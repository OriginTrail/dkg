import { describe, expect, it, vi } from 'vitest';
import { createOperationContext, canonicalGraphScopedAuthorSealFromAssertionSealV1, computeCanonicalGraphScopedAuthorSealDigestV1 } from '@origintrail-official/dkg-core';
import { TripleStoreAsyncPromoteQueue } from '@origintrail-official/dkg-publisher';
import { commitDurableShareInventory } from '../../agent/src/internal/promote/durable-share-inventory.js';
import { AUTHOR, AUTHOR_WALLET, CONTEXT_GRAPH_ID, NETWORK_ID, seedDurableWorkspaceAssetV1, startRepairAgentV1 } from '../../agent/test/support/rfc64-local-catalog-repair-fixture.js';
import { runPromoteJob } from '../src/daemon/worker/async-promote-worker.js';

describe('bound worker owns the real inventory CAS', () => {
  it.each(['before-write', 'lost-acknowledgement'])('recovers %s with one original inventory row', async fault => {
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
    (agent as any).rfc64PersistenceV1 = { ...persistence, swmAuthorInventory: { ...inventory,
      compareAndSwapSwmAuthorInventoryV1: (input: Parameters<typeof commit>[0]) => {
        if (fault === 'lost-acknowledgement') commit(input);
        throw new Error('inventory CAS interruption');
      },
    } };
    const run = (claimed: typeof job, workerId: string) => runPromoteJob({ job: claimed, queue, workerId,
      now: Date.now, heartbeatIntervalMs: 60_000, log: () => undefined,
      runPromote: async (_request, markStarted) => { await markStarted(); await commitDurableShareInventory(agent, params); return { promotedCount: 0 }; },
    });
    expect((await run(job, 'first')).outcome).toBe('failed_retrying');
    expect((await queue.getStatus(job.jobId))?.attempt.lastError).toMatchObject({ diagnosticCode: 'PROMOTE_POST_COMMIT_FAILURE', retryable: true });
    const interrupted = agent.readRfc64SwmAuthorInventorySnapshotV1({ inventoryScopeDigest: seeded.scopeDigest, authorAddress: AUTHOR });
    expect(interrupted?.rows.length ?? 0).toBe(fault === 'lost-acknowledgement' ? 1 : 0);
    (agent as any).rfc64PersistenceV1 = persistence;
    const retry = await queue.claimNext('retry');
    expect(retry?.jobId).toBe(job.jobId);
    expect((await run(retry!, 'retry')).outcome).toBe('succeeded');
    const completed = await queue.getStatus(job.jobId);
    expect(completed?.request.recoveryBinding).toEqual(binding);
    expect(completed?.attempt.count).toBe(2);
    const snapshot = agent.readRfc64SwmAuthorInventorySnapshotV1({ inventoryScopeDigest: seeded.scopeDigest, authorAddress: AUTHOR });
    expect(snapshot?.rows).toHaveLength(1);
    expect(snapshot?.rows[0]).toMatchObject({ kaUal: seeded.seal.kaUal, assertionCoordinate: seeded.assertionCoordinate });
  });
});
