import { AUTHOR, AUTHOR_WALLET, CONTEXT_GRAPH_ID, NETWORK_ID, seedDurableWorkspaceAssetV1, startRepairAgentV1 } from './support/rfc64-local-catalog-repair-fixture.js';
import { Rfc64SwmAuthorInventoryProducerErrorV1 } from '../src/rfc64/swm-author-inventory-producer-v1.js';
import { InventoryV1CandidateError } from '../src/rfc64/inventory-v1/index.js';
import { SwmCatalogAuthorityNotReady, SwmInventoryWriteFailure } from '../src/internal/swm-inventory-write.js';
import { describe, expect, it, vi } from 'vitest';
import { createOperationContext } from '@origintrail-official/dkg-core';
import { commitDurableShareInventory, finishDurableShare } from '../src/internal/promote/durable-share-inventory.js';

const params = { contextGraphId: 'cg', assertionCoordinate: 'asset', lifecycleAgentAddress: `0x${'11'.repeat(20)}`,
  recoveryBinding: { version: 1 as const, sealDigest: `0x${'11'.repeat(32)}`, inventoryRequired: true,
    intent: { version: 1 as const, operationId: 'original-operation', timestampMs: 1, confirmationRequired: false, accessPolicy: 'public' as const, allowedPeers: [] } }, ctx: createOperationContext('share') };

describe('durable inventory handoff', () => {
  it.each(['swm-inventory-producer-input', 'swm-inventory-producer-history', 'swm-inventory-producer-signer'] as const)('preserves typed permanent %s from the inventory phase', async code => {
    const cause = new Rfc64SwmAuthorInventoryProducerErrorV1(code, 'invalid signed inventory');
    const agent = { commitRfc64SwmAuthorInventoryV1: vi.fn(async () => { throw new SwmInventoryWriteFailure('inventory-maintenance', null, cause); }) };
    await expect(commitDurableShareInventory(agent as any, params)).rejects.toBe(cause);
  });
  it('does not infer retry safety from an unmarked persistence-like error code', async () => {
    const cause = new InventoryV1CandidateError('candidate-database-error', 'unproven origin');
    const agent = { commitRfc64SwmAuthorInventoryV1: vi.fn(async () => { throw new SwmInventoryWriteFailure('inventory-maintenance', null, cause); }) };
    await expect(commitDurableShareInventory(agent as any, params)).rejects.toBe(cause);
  });
  it('preserves a typed corrupt inventory database for inspection', async () => {
    const cause = new InventoryV1CandidateError('applied-head-database-corrupt', 'invalid stored head');
    const agent = { commitRfc64SwmAuthorInventoryV1: vi.fn(async () => { throw new SwmInventoryWriteFailure('inventory-maintenance', null, cause); }) };
    await expect(commitDurableShareInventory(agent as any, params)).rejects.toBe(cause);
  });

  it.each(['inactive-lane', 'authority-transition'])('retains the obligation while %s', async dormantReason => {
    const agent = { commitRfc64SwmAuthorInventoryV1: vi.fn(async () => ({ status: 'dormant', dormantReason })),
      requestRfc64SwmCatalogProjectionV1: vi.fn() };
    await expect(commitDurableShareInventory(agent as any, params)).rejects.toMatchObject({ code: 'PROMOTE_RETRYABLE_FAILURE' });
    expect(agent.requestRfc64SwmCatalogProjectionV1).not.toHaveBeenCalled();
  });
  it.each(['service-unavailable', 'policy-not-accepted'] as const)('retries typed readiness %s only', async reason => {
    const cause = new SwmCatalogAuthorityNotReady(reason);
    const agent = { commitRfc64SwmAuthorInventoryV1: vi.fn(async () => { throw new SwmInventoryWriteFailure('authority', null, cause); }) };
    await expect(commitDurableShareInventory(agent as any, params)).rejects.toMatchObject({ code: 'PROMOTE_RETRYABLE_FAILURE', cause });
    const denied = new Error('catalog policy authority invalid');
    agent.commitRfc64SwmAuthorInventoryV1.mockImplementation(async () => { throw new SwmInventoryWriteFailure('authority', null, denied); });
    await expect(commitDurableShareInventory(agent as any, params)).rejects.toBe(denied);
  });
  it('refuses policy mismatch and never substitutes a detached observer for durable admission', async () => {
    const agent = { commitRfc64SwmAuthorInventoryV1: vi.fn(async () => ({ status: 'dormant', dormantReason: 'policy-mismatch' })) };
    const detached = vi.fn();
    await expect(finishDurableShare(agent as any, params, async () => undefined, detached))
      .rejects.toMatchObject({ code: 'KA_PROMOTE_RECOVERY_BINDING_CONFLICT' });
    expect(detached).not.toHaveBeenCalled();
  });
  it('waits for the durable CAS and requests projection only after acknowledgement', async () => {
    let finish!: (value: any) => void;
    const agent = { commitRfc64SwmAuthorInventoryV1: vi.fn(() => new Promise(resolve => { finish = resolve; })),
      requestRfc64SwmCatalogProjectionV1: vi.fn(() => false) };
    const pending = commitDurableShareInventory(agent as any, params);
    expect(agent.requestRfc64SwmCatalogProjectionV1).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(finish).toEqual(expect.any(Function)));
    finish({ status: 'existing' }); await pending;
    expect(agent.commitRfc64SwmAuthorInventoryV1).toHaveBeenCalledWith(expect.objectContaining({
      shareOperationId: 'original-operation', lifecycleAgentAddress: params.lifecycleAgentAddress,
    }));
    expect(agent.requestRfc64SwmCatalogProjectionV1).toHaveBeenCalledOnce();
  });
  it('retains pointer failure ownership and does not run the catalog mutation', async () => {
    const agent = { commitRfc64SwmAuthorInventoryV1: vi.fn() };
    const detached = vi.fn();
    await expect(finishDurableShare(agent as any, params, async () => { throw new Error('pointer write interrupted'); }, detached))
      .rejects.toMatchObject({ code: 'PROMOTE_POST_COMMIT_FAILURE' });
    expect(agent.commitRfc64SwmAuthorInventoryV1).not.toHaveBeenCalled();
    expect(detached).not.toHaveBeenCalled();
  });
});


describe('throwing confirmed inventory removal and observation', () => {
  it('keeps domain outcomes independent of observer bookkeeping', async () => {
    const agent = await startRepairAgentV1({ name: 'removal-domain-outcome' });
    vi.spyOn(agent, 'getCustodialAgentPrivateKey').mockReturnValue(AUTHOR_WALLET.privateKey);
    agent.acceptOpenContextGraphPolicyV1({ networkId: NETWORK_ID, contextGraphId: CONTEXT_GRAPH_ID, ownerAddress: AUTHOR });
    await agent.whenRfc64CatalogResponsibilitiesIdleV1();
    const seeded = await seedDurableWorkspaceAssetV1(agent, 'removal-domain', 98n);
    await agent.commitRfc64SwmAuthorInventoryV1({ contextGraphId: CONTEXT_GRAPH_ID,
      assertionCoordinate: seeded.assertionCoordinate, lifecycleAgentAddress: AUTHOR, shareOperationId: seeded.shareOperationId });
    const stats = agent.rfc64SwmAuthorInventoryShadowStatusV1();
    const request = { contextGraphId: CONTEXT_GRAPH_ID, seal: seeded.seal };
    expect(await agent.commitRfc64ConfirmedInventoryRemovalV1(request)).toMatchObject({ status: 'applied' });
    expect(agent.rfc64SwmAuthorInventoryShadowStatusV1()).toEqual(stats);
    const confirmed = { ...request, assertionCoordinate: seeded.assertionCoordinate,
      shareOperationId: seeded.shareOperationId, assertionUri: 'urn:confirmed', ctx: createOperationContext('publish'), publicationLabel: 'queued publish' as const };
    expect(await agent.observeRfc64ConfirmedVmV1(confirmed)).toBe(true);
    expect(agent.rfc64SwmAuthorInventoryShadowStatusV1()).toMatchObject({ attemptedRemovals: stats.attemptedRemovals + 1, absentRemovals: stats.absentRemovals + 1 });
    vi.spyOn(agent as any, 'recordRfc64SwmAuthorInventoryShadowStatsV1').mockImplementation(() => { throw new Error('observer accounting unavailable'); });
    expect(await agent.transferRfc64ConfirmedVmV1(confirmed)).toBe('owned');
  });

  it('preserves a throwing removal cause while the observer records its failure', async () => {
    const agent = await startRepairAgentV1({ name: 'removal-domain-failure' });
    agent.acceptOpenContextGraphPolicyV1({ networkId: NETWORK_ID, contextGraphId: CONTEXT_GRAPH_ID, ownerAddress: AUTHOR });
    await agent.whenRfc64CatalogResponsibilitiesIdleV1();
    const seeded = await seedDurableWorkspaceAssetV1(agent, 'removal-failure', 99n);
    const cause = new Error('inventory write unavailable');
    vi.spyOn(agent, 'removeRfc64SwmAuthorInventoryConfirmedRowV1').mockRejectedValue(cause);
    const request = { contextGraphId: CONTEXT_GRAPH_ID, seal: seeded.seal };
    await expect(agent.commitRfc64ConfirmedInventoryRemovalV1(request)).rejects.toMatchObject({ phase: 'inventory-maintenance', cause });
    expect(agent.rfc64SwmAuthorInventoryShadowStatusV1().failed).toBe(0);
    expect(await agent.observeRfc64ConfirmedVmV1({ ...request, assertionCoordinate: seeded.assertionCoordinate,
      assertionUri: 'urn:confirmed', ctx: createOperationContext('publish'), publicationLabel: 'queued publish' })).toBe(false);
    expect(agent.rfc64SwmAuthorInventoryShadowStatusV1()).toMatchObject({ attemptedRemovals: 1, failed: 1 });
  });
});
