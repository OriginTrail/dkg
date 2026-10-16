import { describe, expect, it, vi } from 'vitest';
import { createOperationContext } from '@origintrail-official/dkg-core';
import { commitDurableShareInventory, finishDurableShare } from '../src/internal/promote/durable-share-inventory.js';

const params = { contextGraphId: 'cg', assertionCoordinate: 'asset', lifecycleAgentAddress: `0x${'11'.repeat(20)}`,
  shareOperationId: 'original-operation', durableInventory: true, ctx: createOperationContext('share') };

describe('durable inventory handoff', () => {
  it.each(['inactive-lane', 'authority-transition'])('retains the obligation while %s', async dormantReason => {
    const agent = { commitRfc64SwmAuthorInventoryV1: vi.fn(async () => ({ status: 'dormant', dormantReason })),
      requestRfc64SwmCatalogProjectionV1: vi.fn() };
    await expect(commitDurableShareInventory(agent as any, params)).rejects.toMatchObject({ code: 'PROMOTE_RETRYABLE_FAILURE' });
    expect(agent.requestRfc64SwmCatalogProjectionV1).not.toHaveBeenCalled();
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
