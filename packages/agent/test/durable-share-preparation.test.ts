import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertionLifecycleUri, contextGraphMetaUri, createOperationContext } from '@origintrail-official/dkg-core';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { createPromotionAgentForTest } from './_helpers/promotion-agent.js';
import { makeTestKaNumberAllocator } from './_helpers/ka-allocator.js';
import { finalizeRootlessAssertionForTest } from '../../publisher/test/_helpers/rootless-lifecycle.js';
import { commitConfirmedDurableShareInventory } from '../src/internal/promote/durable-vm-share-inventory.js';
import { SwmCatalogAuthorityNotReady } from '../src/internal/swm-inventory-write.js';

const CG = 'agent-bound-share', NAME = 'asset', AUTHOR = `0x${'11'.repeat(20)}`;
const stores: OxigraphStore[] = [];
afterEach(async () => { await Promise.all(stores.splice(0).map(store => store.close())); });
async function setup() {
  const store = new OxigraphStore(); stores.push(store);
  const { agent, publisher } = await createPromotionAgentForTest(store, {
    agentAddress: AUTHOR, peerId: '12D3KooWRecovery', kaAllocator: makeTestKaNumberAllocator(),
  });
  agent.resolveRfc64CatalogReceiverAuthorityV1 = () => ({ mode: 'legacy', killSwitchActive: false });
  await publisher.assertionCreate(CG, NAME, AUTHOR);
  await publisher.assertionWrite(CG, NAME, AUTHOR, [{ subject: 'urn:asset', predicate: 'urn:value', object: '"original"' }]);
  const finalized = await finalizeRootlessAssertionForTest({ publisher, store, contextGraphId: CG, name: NAME, agentAddress: AUTHOR });
  return { agent, store, finalized };
}

describe('agent durable share preparation and replay', () => {
  it('pins the original operation, preserves content on replay and tolerates gossip notification failure', async () => {
    const { agent, store, finalized } = await setup();
    const prepared = await agent.assertion.prepareDurableShare(CG, NAME);
    expect(prepared.agentAddress).toBe(AUTHOR);
    expect(prepared.recoveryBinding.inventoryRequired).toBe(false);
    agent.publishWorkspaceGossip.mockRejectedValueOnce(new Error('notification unavailable'));
    const first = await agent.assertion.promote(CG, NAME, prepared);
    const next = await agent.assertion.prepareDurableShare(CG, NAME);
    expect(next.recoveryBinding).toEqual(prepared.recoveryBinding);
    const repeat = await agent.assertion.promote(CG, NAME, next);
    expect(first.promotedCount).toBe(1);
    expect(repeat).toMatchObject({ promotedCount: 0, shareOperationId: prepared.recoveryBinding.intent.operationId });
    expect(await store.countQuads(finalized.sharedGraphUri)).toBe(1);
    expect(agent.log.warn).toHaveBeenCalled();
  });

  it('admits a prepared owner under the publisher mutation fence', async () => {
    const { agent } = await setup();
    const prepared = await agent.assertion.prepareDurableShare(CG, NAME);
    const job = await agent.assertion.admitDurableShare({ contextGraphId: CG, assertionName: NAME, entities: 'all', ...prepared }, 'inline');
    expect(job.request.recoveryBinding).toEqual(prepared.recoveryBinding);
    expect((await agent.promoteQueue.getStatus(job.jobId)).state).toBe('running');
    await expect(agent.assertion.discard(CG, NAME)).rejects.toMatchObject({ code: 'KA_PROMOTE_RECOVERY_REQUIRED' });
  });

  it('keeps completed legacy content read-only without inventing an operation intent', async () => {
    const { agent, store } = await setup();
    const result = await agent.assertion.promote(CG, NAME);
    await store.deleteByPattern({ graph: contextGraphMetaUri(CG), subject: assertionLifecycleUri(CG, AUTHOR, NAME),
      predicate: 'http://dkg.io/ontology/promoteOperationIntent' });
    const mutation = vi.spyOn(store, 'insert');
    const prepared = await agent.assertion.prepareDurableShare(CG, NAME);
    expect(prepared).toMatchObject({ agentAddress: AUTHOR, recoveryBinding: undefined,
      completedResult: { promotedCount: 0, sealed: true, shareOperationId: result.shareOperationId } });
    expect(mutation).not.toHaveBeenCalled();
  });

  it('refuses stronger acknowledgement and bound subset replay without touching content', async () => {
    const { agent, store, finalized } = await setup();
    const prepared = await agent.assertion.prepareDurableShare(CG, NAME);
    await agent.assertion.promote(CG, NAME, prepared);
    agent.buildCuratorAckConfirmer = async () => async () => undefined;
    await expect(agent.assertion.prepareDurableShare(CG, NAME, { awaitCuratorAck: true }))
      .rejects.toMatchObject({ code: 'KA_PROMOTE_ACK_REQUIREMENT_CONFLICT' });
    await expect(agent.assertion.promote(CG, NAME, { ...prepared, entities: ['urn:asset'] }))
      .rejects.toThrow('sealed, complete');
    await expect(agent.assertion.promote(CG, NAME, { ...prepared, awaitCuratorAck: true }))
      .rejects.toMatchObject({ code: 'KA_PROMOTE_ACK_REQUIREMENT_CONFLICT' });
    expect(await store.countQuads(finalized.sharedGraphUri)).toBe(1);
  });

  it.each(['service-unavailable', 'policy-not-accepted'] as const)('retains typed readiness before admission: %s', async reason => {
    const { agent, store, finalized } = await setup();
    agent.requiresRfc64ShareInventoryV1 = () => { throw new SwmCatalogAuthorityNotReady(reason); };
    await expect(agent.assertion.prepareDurableShare(CG, NAME)).rejects.toMatchObject({ code: 'PROMOTE_RETRYABLE_FAILURE' });
    expect(await store.countQuads(finalized.sharedGraphUri)).toBe(0);
  });

  it.each(['owned', 'inactive', 'pending', 'authority-refused', 'wrong-seal'])('requires exact confirmed handoff ownership: %s', async outcome => {
    const { agent } = await setup();
    const prepared = await agent.assertion.prepareDurableShare(CG, NAME);
    const binding = { ...prepared.recoveryBinding, inventoryRequired: true };
    if (outcome === 'wrong-seal') binding.sealDigest = `0x${'ff'.repeat(32)}`;
    const refusal = new Error('permanent authority refusal');
    agent.transferRfc64ConfirmedVmV1 = vi.fn(async () => {
      if (outcome === 'authority-refused') throw refusal;
      return outcome;
    });
    const transfer = commitConfirmedDurableShareInventory(agent, { contextGraphId: CG, assertionCoordinate: NAME,
      lifecycleAgentAddress: AUTHOR, recoveryBinding: binding, ctx: createOperationContext('share') });
    if (outcome === 'owned') {
      await transfer;
      expect(agent.transferRfc64ConfirmedVmV1).toHaveBeenCalledWith(expect.objectContaining({
        shareOperationId: binding.intent.operationId, expectedWorkspaceAccessPolicy: binding.intent.accessPolicy,
      }));
    } else if (outcome === 'wrong-seal') {
      await expect(transfer).rejects.toMatchObject({ code: 'KA_PROMOTE_RECOVERY_BINDING_CONFLICT' });
      expect(agent.transferRfc64ConfirmedVmV1).not.toHaveBeenCalled();
    } else if (outcome === 'authority-refused') await expect(transfer).rejects.toBe(refusal);
    else await expect(transfer).rejects.toMatchObject({ code: 'PROMOTE_RETRYABLE_FAILURE' });
  });
});
