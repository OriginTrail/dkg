import { TripleStoreAsyncPromoteQueue } from '@origintrail-official/dkg-publisher';
import { canonicalGraphScopedAuthorSealFromAssertionSealV1, computeCanonicalGraphScopedAuthorSealDigestV1 } from '@origintrail-official/dkg-core';
import { startRepairAgentV1, seedDurableWorkspaceAssetV1, AUTHOR as REPAIR_AUTHOR, CONTEXT_GRAPH_ID as REPAIR_CG } from './support/rfc64-local-catalog-repair-fixture.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertionLifecycleUri, contextGraphMetaUri, createOperationContext } from '@origintrail-official/dkg-core';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { createPromotionAgentForTest } from './_helpers/promotion-agent.js';
import { makeTestKaNumberAllocator } from './_helpers/ka-allocator.js';
import { finalizeRootlessAssertionForTest } from '../../publisher/test/_helpers/rootless-lifecycle.js';
import { commitConfirmedDurableShareInventory } from '../src/internal/promote/durable-vm-share-inventory.js';
import { SwmCatalogAuthorityNotReady } from '../src/internal/swm-inventory-write.js';
import { committedSharePendingCatalogHandoff, inventoryHandoffPendingFailure } from '../src/internal/promote/inventory-recovery-failure.js';
import { resolveRfc64CatalogAuthoringPolicyV1 } from '../src/rfc64/public-catalog-activation-config-v1.js';
import { Wallet } from 'ethers';

const CG = 'agent-bound-share', NAME = 'asset', AUTHOR = `0x${'11'.repeat(20)}`;
const stores: OxigraphStore[] = [];
afterEach(async () => { await Promise.all(stores.splice(0).map(store => store.close())); });
async function setup(author = AUTHOR) {
  const store = new OxigraphStore(); stores.push(store);
  const { agent, publisher } = await createPromotionAgentForTest(store, {
    agentAddress: author, peerId: '12D3KooWRecovery', kaAllocator: makeTestKaNumberAllocator(),
  });
  agent.resolveRfc64CatalogReceiverAuthorityV1 = () => ({ mode: 'legacy', killSwitchActive: false });
  await publisher.assertionCreate(CG, NAME, author);
  await publisher.assertionWrite(CG, NAME, author, [{ subject: 'urn:asset', predicate: 'urn:value', object: '"original"' }]);
  const finalized = await finalizeRootlessAssertionForTest({ publisher, store, contextGraphId: CG, name: NAME, agentAddress: author });
  return { agent, store, finalized };
}
const ACTIVE_LANE = { active: true, authoringAllowed: true, reconciliationLane: 'catalog-apply' } as const;
const FENCED_LANE = { active: false, authoringAllowed: false, reconciliationLane: 'disabled' } as const;

describe('agent durable share preparation and replay', () => {
  it('configures custom ownership before lazy queue construction across store wrappers', async () => {
    const agent=await startRepairAgentV1({name:'explicit-custom-ownership'});
    const configuration={graphUri:'urn:custom:explicit-control'};
    agent.configurePromoteQueue(configuration);configuration.graphUri='urn:mutated-after-configuration';
    const seeded=await seedDurableWorkspaceAssetV1(agent,'custom-owned',98n);
    const binding={version:1 as const,inventoryRequired:true,
      sealDigest:computeCanonicalGraphScopedAuthorSealDigestV1(canonicalGraphScopedAuthorSealFromAssertionSealV1(seeded.seal)),
      intent:{version:1 as const,operationId:seeded.shareOperationId,timestampMs:1,confirmationRequired:false,accessPolicy:'public' as const,allowedPeers:[]}};
    const otherWrapper=new Proxy(agent.store,{get(target,key){const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
    const writer=new TripleStoreAsyncPromoteQueue(otherWrapper,{graphUri:'urn:custom:explicit-control'});
    const job=await writer.enqueueAndClaim({contextGraphId:REPAIR_CG,assertionName:seeded.assertionCoordinate,
      agentAddress:REPAIR_AUTHOR,entities:'all',recoveryBinding:binding},'external');
    expect((agent as any)._promoteQueue).toBeUndefined();
    await expect(agent.publisher.assertionPullFrom(REPAIR_CG,seeded.assertionCoordinate,REPAIR_AUTHOR,'swm'))
      .rejects.toMatchObject({code:'KA_PROMOTE_RECOVERY_REQUIRED',recoveryJobId:job.jobId});
    expect((agent as any)._promoteQueue).toBeUndefined();
    expect((await agent.promoteQueue.getStatus(job.jobId))?.request.recoveryBinding).toEqual(binding);
  });


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
    delete agent.prepareAtomicAssertionShare;
    const finalize = vi.spyOn(agent.publisher, 'materializeCanonicalWorkingMemory');
    expect((await agent.assertion.prepareDurableShare(CG, NAME)).recoveryBinding.sealDigest).toBe(prepared.recoveryBinding.sealDigest);
    await expect(agent.assertion.promote(CG, NAME)).rejects.toMatchObject({ code: 'KA_PROMOTE_RECOVERY_REQUIRED', recoveryJobId: job.jobId });
    expect(finalize).not.toHaveBeenCalled();
    expect(await agent.promoteQueue.list({})).toHaveLength(1);
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
    agent.requiresRfc64ShareInventoryHandoffV1 = () => { throw new SwmCatalogAuthorityNotReady(reason); };
    await expect(agent.assertion.prepareDurableShare(CG, NAME)).rejects.toMatchObject({ code: 'PROMOTE_RETRYABLE_FAILURE' });
    expect(await store.countQuads(finalized.sharedGraphUri)).toBe(0);
  });

  it.each([
    ['fenced', FENCED_LANE, false],
    ['active and accepted', ACTIVE_LANE, true],
  ] as const)('owes the signed inventory handoff at admission only from an authoring lane: %s', async (_label, lane, handoff) => {
    const wallet = new Wallet(`0x${'22'.repeat(32)}`), author = wallet.address.toLowerCase();
    const { agent, store, finalized } = await setup(author);
    agent.resolveRfc64CatalogReceiverAuthorityV1 = () => ({ mode: 'catalog', killSwitchActive: false, ...lane });
    const signer = vi.fn(() => ({ address: author, signMessage: wallet.signMessage.bind(wallet) }));
    agent.createRfc64CatalogAuthorSignerV1 = signer;
    const prepared = await agent.assertion.prepareDurableShare(CG, NAME, { agentAddress: author });
    expect(prepared.recoveryBinding.inventoryRequired).toBe(handoff);
    // The catalog obligation itself is unchanged; only the bound handoff follows the lane.
    expect(agent.requiresRfc64ShareInventoryV1(CG, undefined)).toBe(true);
    if (handoff) expect(signer).toHaveBeenCalledWith(author);
    else expect(signer).not.toHaveBeenCalled();
    expect(await store.countQuads(finalized.sharedGraphUri)).toBe(0);
  });

  it.each([
    ['legacy', { mode: 'legacy', killSwitchActive: false }, undefined, false, false],
    ['kill switch', { mode: 'catalog', killSwitchActive: true, ...FENCED_LANE }, undefined, false, false],
    ['named sub-graph', { mode: 'catalog', killSwitchActive: false, ...ACTIVE_LANE }, 'notes', false, false],
    ['active catalog', { mode: 'catalog', killSwitchActive: false, ...ACTIVE_LANE }, undefined, true, true],
    ['active shadow', { mode: 'shadow', killSwitchActive: false, ...ACTIVE_LANE, reconciliationLane: 'shadow-stage' }, undefined, true, true],
    ['fenced catalog', { mode: 'catalog', killSwitchActive: false, ...FENCED_LANE }, undefined, true, false],
    ['fenced shadow', { mode: 'shadow', killSwitchActive: false, ...FENCED_LANE }, undefined, true, false],
  ] as const)('separates the catalog obligation from the bound handoff: %s', async (_label, authority, subGraphName, obligation, handoff) => {
    const { agent } = await setup();
    const resolve = vi.fn(() => authority);
    agent.resolveRfc64CatalogReceiverAuthorityV1 = resolve;
    expect(agent.requiresRfc64ShareInventoryV1(CG, subGraphName)).toBe(obligation);
    expect(agent.requiresRfc64ShareInventoryHandoffV1(CG, subGraphName)).toBe(handoff);
    // Each decision reads the receiver authority once.
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it('keeps an unavailable catalog policy a typed readiness gap for both decisions', async () => {
    const { agent } = await setup();
    agent.config = { rfc64CatalogDeploymentProfile: { networkId: 'otp:20430' },
      rfc64CatalogAuthoringPolicy: resolveRfc64CatalogAuthoringPolicyV1({ selectedCatalogAuthoringControls: [], acceptedPolicies: [],
        legacyPublicFallback: { mode: 'all-accepted-public', config: { peers: [], catalogIssuerDelegationExpiresAt: '253402300799000' } } }) };
    agent.resolveRfc64CatalogReceiverAuthorityV1 = () => ({ mode: 'catalog', killSwitchActive: false, ...ACTIVE_LANE });
    expect(() => agent.requiresRfc64ShareInventoryV1(CG, undefined)).toThrow(SwmCatalogAuthorityNotReady);
    expect(() => agent.requiresRfc64ShareInventoryHandoffV1(CG, undefined)).toThrow(SwmCatalogAuthorityNotReady);
    await expect(agent.assertion.prepareDurableShare(CG, NAME)).rejects.toMatchObject({
      code: 'PROMOTE_RETRYABLE_FAILURE', cause: expect.any(SwmCatalogAuthorityNotReady) });
  });

  it('carries the committed share on a pending handoff failure while the bound obligation stays thrown', async () => {
    const wallet = new Wallet(`0x${'22'.repeat(32)}`), author = wallet.address.toLowerCase();
    const { agent, store, finalized } = await setup(author);
    agent.resolveRfc64CatalogReceiverAuthorityV1 = () => ({ mode: 'catalog', killSwitchActive: false, ...ACTIVE_LANE });
    agent.createRfc64CatalogAuthorSignerV1 = () => ({ address: author, signMessage: wallet.signMessage.bind(wallet) });
    const prepared = await agent.assertion.prepareDurableShare(CG, NAME, { agentAddress: author });
    expect(prepared.recoveryBinding.inventoryRequired).toBe(true);
    // The lane closed after admission and one responsibility pass finds it still closed.
    agent.commitRfc64SwmAuthorInventoryV1 = vi.fn(async () => ({ status: 'dormant', dormantReason: 'inactive-lane' }));
    agent.reconcileRfc64CatalogResponsibilityV1 = vi.fn(async () => ({ active: false, mode: 'catalog' }));
    const failure = await agent.assertion.promote(CG, NAME, prepared).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'PROMOTE_RETRYABLE_FAILURE', cause: { code: 'SWM_INVENTORY_HANDOFF_PENDING', reason: 'inactive-lane' } });
    expect(committedSharePendingCatalogHandoff(failure)).toEqual({ reason: 'inactive-lane', result: { promotedCount: 1,
      sealed: true, publishReady: true, shareOperationId: prepared.recoveryBinding.intent.operationId } });
    expect(agent.reconcileRfc64CatalogResponsibilityV1).toHaveBeenCalledOnce();
    expect(await store.countQuads(finalized.sharedGraphUri)).toBe(1);
    // A policy refusal after the commit is not a pending handoff and carries nothing.
    agent.commitRfc64SwmAuthorInventoryV1 = vi.fn(async () => ({ status: 'dormant', dormantReason: 'policy-mismatch' }));
    const refused = await agent.assertion.promote(CG, NAME, prepared).catch((error: unknown) => error);
    expect(refused).toMatchObject({ code: 'KA_PROMOTE_RECOVERY_BINDING_CONFLICT' });
    expect(committedSharePendingCatalogHandoff(refused)).toBeUndefined();
  });

  it('carries nothing on an unbound promotion whose tail reports a pending handoff', async () => {
    const { agent } = await setup();
    const pending = inventoryHandoffPendingFailure('inactive-lane', 'Durable share inventory remains pending: inactive-lane');
    vi.spyOn(agent, 'afterDurableSwmPromotionV1').mockRejectedValueOnce(pending);
    await expect(agent.assertion.promote(CG, NAME)).rejects.toBe(pending);
    expect(committedSharePendingCatalogHandoff(pending)).toBeUndefined();
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
    else await expect(transfer).rejects.toMatchObject({ code: 'PROMOTE_RETRYABLE_FAILURE',
      cause: { code: 'SWM_INVENTORY_HANDOFF_PENDING', reason: 'confirmed-ownership' } });
  });
});
