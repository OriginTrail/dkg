import { inventoryPersistenceFailure } from '../../agent/src/rfc64/inventory-persistence-failure.js';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createGraphKnowledgeAssetScope, knowledgeAssetLayerGraphUri, MemoryLayer, createOperationContext, type TimestampMsV1, canonicalGraphScopedAuthorSealFromAssertionSealV1, computeCanonicalGraphScopedAuthorSealDigestV1 } from '@origintrail-official/dkg-core';
import { TripleStoreAsyncPromoteQueue, generateGraphKnowledgeAssetMetadata } from '@origintrail-official/dkg-publisher';
import { commitDurableShareInventory } from '../../agent/src/internal/promote/durable-share-inventory.js';
import { commitConfirmedDurableShareInventory } from '../../agent/src/internal/promote/durable-vm-share-inventory.js';
import { AUTHOR, AUTHOR_WALLET, CONTEXT_GRAPH_ID, NETWORK_ID, PROJECTION_QUADS, agents, tempDirs, catalogScopeDigestV1, startRepairAgentV1, seedDurableWorkspaceAssetV1 } from '../../agent/test/support/rfc64-local-catalog-repair-fixture.js';
import { startPlacementAgentV1, untilV1 } from '../../agent/test/support/rfc64-publication-placement-fixture.js';
import { runPromoteJob, createPromoteWorkerSupervisor } from '../src/daemon/worker/async-promote-worker.js';

// The placement fixture models chain confirmation and finalized-private authority.
// Queue, disk reopen, marker persistence, signed catalog repair and supervisors are real.
// The separate synchronous-share test exercises the publisher's actual VM no-op proof.
describe('bound VM share retains catalog ownership', () => {
  it.each(['authority-inactive', 'policy-unavailable'])('retains public VM recovery after removal when projection is %s', async fault => {
    const agent = await startRepairAgentV1({ name: `bound-vm-projection-${fault}`,
      autoPublish: { peers: [], catalogIssuerDelegationExpiresAt: '1893456000000' as TimestampMsV1 } });
    vi.spyOn(agent, 'getCustodialAgentPrivateKey').mockReturnValue(AUTHOR_WALLET.privateKey);
    agent.acceptOpenContextGraphPolicyV1({ networkId: NETWORK_ID, contextGraphId: CONTEXT_GRAPH_ID, ownerAddress: AUTHOR });
    await agent.whenRfc64CatalogResponsibilitiesIdleV1(); await agent.whenRfc64CatalogSupervisorsIdleV1();
    const remaining = await seedDurableWorkspaceAssetV1(agent, 'vm-projection-remaining', 98n);
    const seeded = await seedDurableWorkspaceAssetV1(agent, 'vm-projection-confirmed', 99n);
    for (const asset of [remaining, seeded]) await agent.commitRfc64SwmAuthorInventoryV1({ contextGraphId: CONTEXT_GRAPH_ID,
      assertionCoordinate: asset.assertionCoordinate, lifecycleAgentAddress: AUTHOR, shareOperationId: asset.shareOperationId });
    expect(agent.requestRfc64SwmCatalogProjectionV1({ contextGraphId: CONTEXT_GRAPH_ID, authorAddress: AUTHOR })).toBe(true);
    await agent.whenRfc64CatalogSupervisorsIdleV1();
    const oldHead = agent.readRfc64AppliedCatalogHeadV1({ catalogScopeDigest: catalogScopeDigestV1(), authorAddress: AUTHOR });
    expect(oldHead).toMatchObject({ inventoryRowCount: '2' });
    expect(agent.readRfc64SwmCatalogProjectionSupervisorStatusV1()?.repairs)
      .toContainEqual(expect.objectContaining({ outcome: 'reconciled', inventoryRowCount: '2' }));
    const seal = seeded.seal;
    const vmGraph = knowledgeAssetLayerGraphUri(CONTEXT_GRAPH_ID, MemoryLayer.VerifiableMemory,
      createGraphKnowledgeAssetScope(seal.kaUal!, seal.assertionVersion!));
    await agent.store.insert([
      ...PROJECTION_QUADS.map(q => ({ ...q, graph: vmGraph })),
      ...generateGraphKnowledgeAssetMetadata({ contextGraphId: CONTEXT_GRAPH_ID, ual: seal.kaUal!,
        merkleRoot: seal.merkleRoot, publisherPeerId: agent.peerId, authorAddress: AUTHOR,
        accessPolicy: 'public', allowedPeers: [], timestamp: new Date(seal.finalizedAtIso),
        assertionVersion: seal.assertionVersion!, publicTripleCount: seal.publicTripleCount!,
        privateTripleCount: seal.privateTripleCount!, assertionGraph: vmGraph },
      { status: 'confirmed', confirmation: { kind: 'finalized-materialization', provenance: {
        batchId: seal.reservedKaId!, materializedVersion: { blockNumber: 1, txIndex: 0 } } } }),
    ]);
    const binding = { version: 1 as const, inventoryRequired: true,
      sealDigest: computeCanonicalGraphScopedAuthorSealDigestV1(canonicalGraphScopedAuthorSealFromAssertionSealV1(seal)),
      intent: { version: 1 as const, operationId: seeded.shareOperationId, timestampMs: 1,
        confirmationRequired: false, accessPolicy: 'public' as const, allowedPeers: [] } };
    const queue = new TripleStoreAsyncPromoteQueue(agent.store, { backoff: () => 0, maxRetries: 1 });
    const job = await queue.enqueueAndClaim({ contextGraphId: CONTEXT_GRAPH_ID, assertionName: seeded.assertionCoordinate,
      entities: 'all', agentAddress: AUTHOR, recoveryBinding: binding }, 'original');
    const params = { contextGraphId: CONTEXT_GRAPH_ID, assertionCoordinate: seeded.assertionCoordinate,
      lifecycleAgentAddress: AUTHOR, recoveryBinding: binding, ctx: createOperationContext('share') };
    const projection = vi.spyOn(agent, 'requestRfc64SwmCatalogProjectionV1');
    const remove = agent.commitRfc64ConfirmedInventoryRemovalV1.bind(agent);
    let restoreAuthority: (() => void) | undefined;
    const acknowledgement = vi.spyOn(agent, 'commitRfc64ConfirmedInventoryRemovalV1').mockImplementationOnce(async input => {
      const result = await remove(input); expect(result.status).toBe('applied');
      if (fault === 'policy-unavailable') {
        const policy = vi.spyOn(agent.rfc64PublicCatalogServiceV1!, 'acceptedPolicySnapshot').mockReturnValue(null);
        restoreAuthority = () => policy.mockRestore();
      } else {
        const resolve = agent.resolveRfc64CatalogReceiverAuthorityV1.bind(agent);
        const authority = vi.spyOn(agent, 'resolveRfc64CatalogReceiverAuthorityV1')
          .mockImplementation(cg => ({ ...resolve(cg), authoringAllowed: false }));
        restoreAuthority = () => authority.mockRestore();
      }
      return result;
    });
    try {
      const result = await runPromoteJob({ job, queue, workerId: 'original', now: Date.now, log: () => undefined,
        runPromote: async () => { await commitConfirmedDurableShareInventory(agent, params); return { promotedCount: 0 }; } });
      expect(result.outcome).toBe('failed_retrying');
      expect((await queue.getStatus(job.jobId))?.attempt.lastError)
        .toMatchObject({ diagnosticCode: 'PROMOTE_RETRYABLE_FAILURE', retryable: true });
      if (fault === 'authority-inactive') expect(projection).toHaveReturnedWith(false);
      expect(agent.readRfc64AppliedCatalogHeadV1({ catalogScopeDigest: catalogScopeDigestV1(), authorAddress: AUTHOR })).toEqual(oldHead);
    } finally { restoreAuthority?.(); acknowledgement.mockRestore(); }
    const before = agent.readRfc64SwmAuthorInventorySnapshotV1({ inventoryScopeDigest: seeded.scopeDigest, authorAddress: AUTHOR })!;
    expect(before.rows).toHaveLength(1); expect(before.rows[0]?.kaUal).toBe(remaining.seal.kaUal);
    vi.spyOn(agent, 'promoteQueue', 'get').mockReturnValue(queue);
    const assertion = agent.assertion;
    vi.spyOn(agent, 'assertion', 'get').mockReturnValue({ ...assertion, promote: async (_cg, _name, options) => {
      expect(options?.recoveryBinding).toEqual(binding); await commitConfirmedDurableShareInventory(agent, params);
      return { promotedCount: 0, sealed: true, publishReady: false };
    } });
    const supervisor = createPromoteWorkerSupervisor({ agent, workerConcurrency: 1, pollIntervalMs: 10, log: () => undefined });
    try {
      await supervisor.start();
      await vi.waitFor(async () => expect((await queue.getStatus(job.jobId))?.state).toBe('succeeded'));
      await vi.waitFor(() => expect(agent.readRfc64AppliedCatalogHeadV1({ catalogScopeDigest: catalogScopeDigestV1(), authorAddress: AUTHOR }))
        .toMatchObject({ catalogVersion: (BigInt(oldHead!.catalogVersion) + 1n).toString(), inventoryRowCount: '1' }), { timeout: 10_000 });
    } finally { await supervisor.stop(); }
    expect((await queue.getStatus(job.jobId))?.attempt.count).toBe(2);
    expect((await queue.getStatus(job.jobId))?.request.recoveryBinding).toEqual(binding);
    expect(agent.readRfc64SwmAuthorInventorySnapshotV1({ inventoryScopeDigest: seeded.scopeDigest, authorAddress: AUTHOR })).toEqual(before);
    const payload = await agent.store.query(`CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${vmGraph}> { ?s ?p ?o } }`);
    expect(payload.type).toBe('quads');
    if (payload.type === 'quads') expect(payload.quads.map(({ subject, predicate, object }) => JSON.stringify([subject, predicate, object])).sort())
      .toEqual(PROJECTION_QUADS.map(({ subject, predicate, object }) => JSON.stringify([subject, predicate, object])).sort());
    expect(agent.readRfc64SwmCatalogProjectionSupervisorStatusV1()?.repairs).toContainEqual(expect.objectContaining({
      outcome: 'reconciled', inventoryHeadObjectDigest: before.head.objectDigest, inventoryRowCount: '1',
    }));
  });

  it('survives failed SWM inventory, failed confirmation marker and restart without a caller replay', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'dkg-bound-vm-'));
    tempDirs.push(dataDir);
    const storePath = join(dataDir, 'store.nq');
    const first = await startPlacementAgentV1({ name: 'bound-vm-first', dataDir, storePath });
    const seeded = await seedDurableWorkspaceAssetV1(first.agent, 'bound-vm', 97n);
    const binding = { version: 1 as const, inventoryRequired: true,
      sealDigest: computeCanonicalGraphScopedAuthorSealDigestV1(canonicalGraphScopedAuthorSealFromAssertionSealV1(seeded.seal)),
      intent: { version: 1 as const, operationId: seeded.shareOperationId, timestampMs: Date.parse('2026-07-19T12:35:00.000Z'),
        confirmationRequired: false, accessPolicy: 'public' as const, allowedPeers: [] } };
    const params = { contextGraphId: CONTEXT_GRAPH_ID, assertionCoordinate: seeded.assertionCoordinate,
      lifecycleAgentAddress: AUTHOR, recoveryBinding: binding, ctx: createOperationContext('share') };
    const queue = new TripleStoreAsyncPromoteQueue(first.agent.store, { backoff: () => 0, maxRetries: 1 });
    const job = await queue.enqueueAndClaim({ contextGraphId: CONTEXT_GRAPH_ID, assertionName: seeded.assertionCoordinate,
      entities: 'all', agentAddress: AUTHOR, recoveryBinding: binding }, 'first');
    const persistence = first.agent.rfc64PersistenceV1!;
    (first.agent as any).rfc64PersistenceV1 = { ...persistence, swmAuthorInventory: { ...persistence.swmAuthorInventory,
      compareAndSwapSwmAuthorInventoryV1: () => { throw inventoryPersistenceFailure(new Error('inventory CAS unavailable')); } } };
    expect((await runPromoteJob({ job, queue, workerId: 'first', now: Date.now, heartbeatIntervalMs: 60_000, log: () => undefined,
      runPromote: async (_request) => {  await commitDurableShareInventory(first.agent, params); return { promotedCount: 0 }; },
    })).outcome).toBe('failed_retrying');
    (first.agent as any).rfc64PersistenceV1 = persistence;
    const seal = seeded.seal;
    const vmGraph = knowledgeAssetLayerGraphUri(CONTEXT_GRAPH_ID, MemoryLayer.VerifiableMemory,
      createGraphKnowledgeAssetScope(seal.kaUal!, seal.assertionVersion!));
    await first.agent.store.insert([
      ...PROJECTION_QUADS.map(q => ({ ...q, graph: vmGraph })),
      ...generateGraphKnowledgeAssetMetadata({ contextGraphId: CONTEXT_GRAPH_ID, ual: seal.kaUal!,
        merkleRoot: seal.merkleRoot, publisherPeerId: first.agent.peerId, authorAddress: AUTHOR,
        accessPolicy: 'public', allowedPeers: [], timestamp: new Date(seal.finalizedAtIso),
        assertionVersion: seal.assertionVersion!, publicTripleCount: seal.publicTripleCount!,
        privateTripleCount: seal.privateTripleCount!, assertionGraph: vmGraph },
      { status: 'confirmed', confirmation: { kind: 'finalized-materialization', provenance: {
        batchId: seal.reservedKaId!, materializedVersion: { blockNumber: 1, txIndex: 0 } } } }),
    ]);
    first.failMarkerWrite = inventoryPersistenceFailure(new Error('confirmation marker unavailable'));
    expect(await first.agent.observeRfc64ConfirmedVmV1({ ...params, shareOperationId: binding.intent.operationId, seal: seeded.seal,
      assertionUri: 'urn:bound-vm', publicationLabel: 'queued publish' })).toBe(false);
    expect(first.markers()).toHaveLength(0);
    expect(first.agent.readRfc64SwmAuthorInventorySnapshotV1({ inventoryScopeDigest: seeded.scopeDigest, authorAddress: AUTHOR })?.rows ?? []).toHaveLength(0);
    // Even the in-process VM fence cannot discharge the unowned placement.
    const secondClaim = await queue.claimNext('second');
    expect((await runPromoteJob({ job: secondClaim!, queue, workerId: 'second', now: Date.now, heartbeatIntervalMs: 60_000, log: () => undefined,
      runPromote: async (_request) => {  await commitDurableShareInventory(first.agent, params); return { promotedCount: 0 }; },
    })).outcome).toBe('failed_retrying');
    expect(first.markers()).toHaveLength(0);
    await first.agent.stop();
    agents.splice(agents.indexOf(first.agent), 1);

    const second = await startPlacementAgentV1({ name: 'bound-vm-restart', dataDir, storePath });
    const reopened = new TripleStoreAsyncPromoteQueue(second.agent.store, { backoff: () => 0, maxRetries: 1 });
    vi.spyOn(second.agent, 'promoteQueue', 'get').mockReturnValue(reopened);
    const assertion = second.agent.assertion;
    const vmNoop = vi.fn(async (_cg, _name, options) => {
      expect(options.recoveryBinding).toEqual(binding);
      await commitConfirmedDurableShareInventory(second.agent, params);
      return { promotedCount: 0, sealed: true, publishReady: false };
    });
    vi.spyOn(second.agent, 'assertion', 'get').mockReturnValue({ ...assertion, promote: vmNoop });
    // Stop placement admission: the share may succeed only after the marker exists.
    await second.agent.closeRfc64SwmCatalogProjectionSupervisorV1();
    const supervisor = createPromoteWorkerSupervisor({ agent: second.agent, workerConcurrency: 1, pollIntervalMs: 10, log: () => undefined });
    try {
      await supervisor.start();
      await untilV1(async () => (await reopened.getStatus(job.jobId))?.state === 'succeeded', 'original share completed');
    } finally { await supervisor.stop(); }
    expect(second.markers()).toHaveLength(1);
    expect((await reopened.getStatus(job.jobId))?.request.recoveryBinding).toEqual(binding);
    expect((await reopened.getStatus(job.jobId))?.attempt.count).toBe(3);
    expect(vmNoop).toHaveBeenCalledTimes(1);
    second.agent.startRfc64SwmCatalogProjectionSupervisorV1(createOperationContext('share'));
    await untilV1(() => second.markers().length === 0, 'catalog marker placed');
    await second.agent.whenRfc64SwmCatalogProjectionSupervisorIdleV1();
    expect(second.catalogRows()).toBe('1');
    expect(await second.agent.store.countQuads(vmGraph)).toBe(PROJECTION_QUADS.length);
    expect(second.counts()).toMatchObject({ successors: 1, announcements: 1 });
  }, 120_000);
});
