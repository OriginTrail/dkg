import { Rfc64SwmAuthorInventoryProducerErrorV1 } from '../src/rfc64/swm-author-inventory-producer-v1.js';
import { InventoryV1CandidateError } from '../src/rfc64/inventory-v1/index.js';
import { SwmCatalogAuthorityNotReady, SwmInventoryWriteFailure } from '../src/internal/swm-inventory-write.js';
import { describe, expect, it, vi } from 'vitest';
import { createOperationContext } from '@origintrail-official/dkg-core';
import { commitDurableShareInventory, finishDurableShare } from '../src/internal/promote/durable-share-inventory.js';

const params = { contextGraphId: 'cg', assertionCoordinate: 'asset', lifecycleAgentAddress: `0x${'11'.repeat(20)}`,
  shareOperationId: 'original-operation', durableInventory: true, ctx: createOperationContext('share') };

describe('durable inventory handoff', () => {
  it.each(['swm-inventory-producer-input', 'swm-inventory-producer-history', 'swm-inventory-producer-signer'] as const)('preserves typed permanent %s from the inventory phase', async code => {
    const cause = new Rfc64SwmAuthorInventoryProducerErrorV1(code, 'invalid signed inventory');
    const agent = { commitRfc64SwmAuthorInventoryV1: vi.fn(async () => { throw new SwmInventoryWriteFailure('inventory-commit', null, cause); }) };
    await expect(commitDurableShareInventory(agent as any, params)).rejects.toBe(cause);
  });
  it('preserves a typed corrupt inventory database for inspection', async () => {
    const cause = new InventoryV1CandidateError('applied-head-database-corrupt', 'invalid stored head');
    const agent = { commitRfc64SwmAuthorInventoryV1: vi.fn(async () => { throw new SwmInventoryWriteFailure('inventory-commit', null, cause); }) };
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
