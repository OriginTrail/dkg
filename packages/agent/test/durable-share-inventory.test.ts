import { RemoteSignerError } from '@origintrail-official/dkg-chain';
import { Rfc64ControlEnvelopeSigningErrorV1 } from '../src/rfc64/control-envelope-signer-v1.js';
import { AUTHOR, AUTHOR_WALLET, CONTEXT_GRAPH_ID, NETWORK_ID, seedDurableWorkspaceAssetV1, startRepairAgentV1 } from './support/rfc64-local-catalog-repair-fixture.js';
import { Rfc64SwmAuthorInventoryProducerErrorV1 } from '../src/rfc64/swm-author-inventory-producer-v1.js';
import { InventoryV1CandidateError } from '../src/rfc64/inventory-v1/index.js';
import { SwmCatalogAuthorityNotReady, SwmInventoryWriteFailure } from '../src/internal/swm-inventory-write.js';
import { describe, expect, it, vi } from 'vitest';
import { createOperationContext } from '@origintrail-official/dkg-core';
import { commitDurableShareInventory, finishDurableShare } from '../src/internal/promote/durable-share-inventory.js';
import { SWM_INVENTORY_HANDOFF_PENDING_CODE } from '../src/internal/promote/inventory-recovery-failure.js';
import { rfc64SwmInventoryShadowRuntimeV1 } from '../src/rfc64/swm-inventory-shadow-runtime-v1.js';

const params = { contextGraphId: 'cg', assertionCoordinate: 'asset', lifecycleAgentAddress: `0x${'11'.repeat(20)}`,
  recoveryBinding: { version: 1 as const, sealDigest: `0x${'11'.repeat(32)}`, inventoryRequired: true,
    intent: { version: 1 as const, operationId: 'original-operation', timestampMs: 1, confirmationRequired: false, accessPolicy: 'public' as const, allowedPeers: [] } }, ctx: createOperationContext('share') };

describe('durable inventory handoff', () => {
  it.each(['REMOTE_SIGNER_TIMEOUT', 'REMOTE_SIGNER_UNAVAILABLE', 'REMOTE_SIGNER_UNAUTHORIZED', 'REMOTE_SIGNER_INVALID_SIGNATURE'] as const)(
    'distinguishes transport interruption from signer refusal: %s', async code => {
      const cause = new Rfc64SwmAuthorInventoryProducerErrorV1('swm-inventory-producer-signer', 'signing failed', {
        cause: new Rfc64ControlEnvelopeSigningErrorV1('callback', 'callback failed', { cause: new RemoteSignerError(code, 'fixture') }),
      });
      const agent = { commitRfc64SwmAuthorInventoryV1: vi.fn(async () => { throw new SwmInventoryWriteFailure('inventory-maintenance', null, cause); }) };
      const result = commitDurableShareInventory(agent as any, params);
      if (code === 'REMOTE_SIGNER_TIMEOUT' || code === 'REMOTE_SIGNER_UNAVAILABLE') {
        await expect(result).rejects.toMatchObject({ code: 'PROMOTE_RETRYABLE_FAILURE', cause });
      } else await expect(result).rejects.toBe(cause);
    });

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
      requestRfc64SwmCatalogProjectionV1: vi.fn(), rfc64CatalogAuthorityRefreshFailureReasonV1: vi.fn(() => null),
      reconcileRfc64CatalogResponsibilityV1: vi.fn(async () => ({ active: false, mode: 'catalog' })) };
    const failure = await commitDurableShareInventory(agent as any, params).catch(error => error);
    expect(failure).toMatchObject({ code: 'PROMOTE_RETRYABLE_FAILURE' });
    // A typed, closed-set cause lets the daemon name the waiting step.
    expect(failure.cause).toMatchObject({ code: SWM_INVENTORY_HANDOFF_PENDING_CODE, reason: dormantReason,
      message: `Durable share inventory remains pending: ${dormantReason}` });
    expect(agent.commitRfc64SwmAuthorInventoryV1).toHaveBeenCalledOnce();
    expect(agent.reconcileRfc64CatalogResponsibilityV1).toHaveBeenCalledOnce();
    expect(agent.reconcileRfc64CatalogResponsibilityV1).toHaveBeenCalledWith('cg');
    expect(agent.requestRfc64SwmCatalogProjectionV1).not.toHaveBeenCalled();
  });
  it.each(['inactive-lane', 'authority-transition'])('reopens a lane that closed after admission (%s) with one responsibility pass and commits once', async dormantReason => {
    const agent = { commitRfc64SwmAuthorInventoryV1: vi.fn()
      .mockResolvedValueOnce({ status: 'dormant', dormantReason })
      .mockResolvedValueOnce({ status: 'applied', attempts: 1, headObjectDigest: 'head', kaUal: 'did:dkg:asset' }),
    requestRfc64SwmCatalogProjectionV1: vi.fn(() => true), rfc64CatalogAuthorityRefreshFailureReasonV1: vi.fn(() => null),
    reconcileRfc64CatalogResponsibilityV1: vi.fn(async () => ({ active: true, mode: 'catalog' })) };
    await commitDurableShareInventory(agent as any, params);
    expect(agent.commitRfc64SwmAuthorInventoryV1).toHaveBeenCalledTimes(2);
    for (const [call] of agent.commitRfc64SwmAuthorInventoryV1.mock.calls) {
      expect(call).toMatchObject({ shareOperationId: 'original-operation' });
    }
    expect(agent.reconcileRfc64CatalogResponsibilityV1).toHaveBeenCalledOnce();
    expect(agent.requestRfc64SwmCatalogProjectionV1).toHaveBeenCalledOnce();
  });
  it('reports the second attempt when the reopened lane is still closed at commit', async () => {
    const agent = { commitRfc64SwmAuthorInventoryV1: vi.fn()
      .mockResolvedValueOnce({ status: 'dormant', dormantReason: 'inactive-lane' })
      .mockResolvedValueOnce({ status: 'dormant', dormantReason: 'authority-transition' }),
    requestRfc64SwmCatalogProjectionV1: vi.fn(), rfc64CatalogAuthorityRefreshFailureReasonV1: vi.fn(() => null),
    reconcileRfc64CatalogResponsibilityV1: vi.fn(async () => ({ active: true, mode: 'shadow' })) };
    const failure = await commitDurableShareInventory(agent as any, params).catch(error => error);
    expect(failure.cause).toMatchObject({ code: SWM_INVENTORY_HANDOFF_PENDING_CODE, reason: 'authority-transition' });
    expect(agent.commitRfc64SwmAuthorInventoryV1).toHaveBeenCalledTimes(2);
    expect(agent.reconcileRfc64CatalogResponsibilityV1).toHaveBeenCalledOnce();
    expect(agent.requestRfc64SwmCatalogProjectionV1).not.toHaveBeenCalled();
  });
  it.each([
    ['a refresh failure that outlasts settlement', { refreshFailure: 'registered-authority-unfinalized' }],
    ['a failed responsibility pass', { reconcileError: new Error('responsibility read interrupted') }],
    ['a legacy selection', { selection: { active: true, mode: 'legacy' } }],
    ['an inactive selection', { selection: { active: false, mode: 'catalog' } }],
  ] as const)('keeps %s pending without a second attempt', async (_label, setup: { refreshFailure?: string; reconcileError?: Error; selection?: object }) => {
    const agent = { commitRfc64SwmAuthorInventoryV1: vi.fn(async () => ({ status: 'dormant', dormantReason: 'inactive-lane' })),
      requestRfc64SwmCatalogProjectionV1: vi.fn(), rfc64CatalogAuthorityRefreshFailureReasonV1: vi.fn(() => setup.refreshFailure ?? null),
      reconcileRfc64CatalogResponsibilityV1: vi.fn(async () => {
        if (setup.reconcileError) throw setup.reconcileError;
        return setup.selection;
      }) };
    const failure = await commitDurableShareInventory(agent as any, params).catch(error => error);
    expect(failure).toMatchObject({ code: 'PROMOTE_RETRYABLE_FAILURE' });
    expect(failure.cause).toMatchObject({ code: SWM_INVENTORY_HANDOFF_PENDING_CODE, reason: 'inactive-lane' });
    expect(agent.commitRfc64SwmAuthorInventoryV1).toHaveBeenCalledOnce();
    expect(agent.reconcileRfc64CatalogResponsibilityV1).toHaveBeenCalledTimes(setup.refreshFailure ? 0 : 1);
    expect(agent.requestRfc64SwmCatalogProjectionV1).not.toHaveBeenCalled();
  });
  it('does not run a responsibility pass for a pending projection admission', async () => {
    const agent = { commitRfc64SwmAuthorInventoryV1: vi.fn(async () => ({ status: 'existing' })),
      requestRfc64SwmCatalogProjectionV1: vi.fn(() => false), rfc64CatalogAuthorityRefreshFailureReasonV1: vi.fn(() => null),
      reconcileRfc64CatalogResponsibilityV1: vi.fn(async () => ({ active: true, mode: 'catalog' })) };
    const failure = await commitDurableShareInventory(agent as any, params).catch(error => error);
    expect(failure.cause).toMatchObject({ code: SWM_INVENTORY_HANDOFF_PENDING_CODE, reason: 'projection-admission' });
    expect(agent.reconcileRfc64CatalogResponsibilityV1).not.toHaveBeenCalled();
    expect(agent.commitRfc64SwmAuthorInventoryV1).toHaveBeenCalledOnce();
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
      requestRfc64SwmCatalogProjectionV1: vi.fn(() => true) };
    const pending = commitDurableShareInventory(agent as any, params);
    expect(agent.requestRfc64SwmCatalogProjectionV1).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(finish).toEqual(expect.any(Function)));
    finish({ status: 'existing' }); await pending;
    expect(agent.commitRfc64SwmAuthorInventoryV1).toHaveBeenCalledWith(expect.objectContaining({
      shareOperationId: 'original-operation', lifecycleAgentAddress: params.lifecycleAgentAddress,
    }));
    expect(agent.requestRfc64SwmCatalogProjectionV1).toHaveBeenCalledOnce();
  });
  it('retains the original obligation when projection admission returns false', async () => {
    const agent = { commitRfc64SwmAuthorInventoryV1: vi.fn(async () => ({ status: 'existing' })),
      requestRfc64SwmCatalogProjectionV1: vi.fn(() => false) };
    const failure = await commitDurableShareInventory(agent as any, params).catch(error => error);
    expect(failure).toMatchObject({ code: 'PROMOTE_RETRYABLE_FAILURE' });
    expect(failure.cause).toMatchObject({ code: SWM_INVENTORY_HANDOFF_PENDING_CODE, reason: 'projection-admission' });
    expect(agent.commitRfc64SwmAuthorInventoryV1).toHaveBeenCalledWith(expect.objectContaining({ shareOperationId: 'original-operation' }));
    expect(agent.requestRfc64SwmCatalogProjectionV1).toHaveBeenCalledOnce();
  });
  it.each(['service-unavailable', 'policy-not-accepted', 'authority-inactive'] as const)('keeps projection readiness %s retryable after acknowledged inventory', async reason => {
    const cause = new SwmCatalogAuthorityNotReady(reason);
    const agent = { commitRfc64SwmAuthorInventoryV1: vi.fn(async () => ({ status: 'existing' })),
      requestRfc64SwmCatalogProjectionV1: vi.fn(() => { throw cause; }) };
    await expect(commitDurableShareInventory(agent as any, params)).rejects.toMatchObject({ code: 'PROMOTE_RETRYABLE_FAILURE', cause });
    expect(agent.commitRfc64SwmAuthorInventoryV1).toHaveBeenCalledOnce();
    expect(agent.requestRfc64SwmCatalogProjectionV1).toHaveBeenCalledOnce();
    const refused = new Error('invalid projection authority');
    agent.requestRfc64SwmCatalogProjectionV1.mockImplementation(() => { throw refused; });
    await expect(commitDurableShareInventory(agent as any, params)).rejects.toBe(refused);
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

describe('responsibility pass on a started agent', () => {
  it('runs the real pass once, outside the inventory lock, and keeps a lane that stays closed pending', async () => {
    const agent = await startRepairAgentV1({ name: 'handoff-responsibility-pass' });
    vi.spyOn(agent, 'getCustodialAgentPrivateKey').mockReturnValue(AUTHOR_WALLET.privateKey);
    agent.acceptOpenContextGraphPolicyV1({ networkId: NETWORK_ID, contextGraphId: CONTEXT_GRAPH_ID, ownerAddress: AUTHOR });
    await agent.whenRfc64CatalogResponsibilitiesIdleV1();
    const seeded = await seedDurableWorkspaceAssetV1(agent, 'responsibility-pass', 97n);
    // The lane accepted at admission is closed at commit.
    agent.resolveRfc64CatalogReceiverAuthorityV1 = () => ({ mode: 'catalog', killSwitchActive: false, active: false,
      authoringAllowed: false, reconciliationLane: 'disabled' }) as any;
    const pass = agent.reconcileRfc64CatalogResponsibilityV1.bind(agent);
    const lockedDuringPass: boolean[] = [];
    const reconcile = vi.spyOn(agent, 'reconcileRfc64CatalogResponsibilityV1').mockImplementation(async contextGraphId => {
      // An exclusive section starts its callback synchronously, before it is tracked; one macrotask later a pass
      // running inside the lane lock would see the write.
      await new Promise(resolve => setImmediate(resolve));
      lockedDuringPass.push(rfc64SwmInventoryShadowRuntimeV1(agent).hasInventoryWrites({ contextGraphId: CONTEXT_GRAPH_ID, authorAddress: AUTHOR }));
      return pass(contextGraphId);
    });
    const writer = vi.spyOn(agent, 'commitRfc64SwmAuthorInventoryV1');
    const failure = await commitDurableShareInventory(agent, { ...params, contextGraphId: CONTEXT_GRAPH_ID,
      assertionCoordinate: seeded.assertionCoordinate, lifecycleAgentAddress: AUTHOR,
      recoveryBinding: { ...params.recoveryBinding, intent: { ...params.recoveryBinding.intent, operationId: seeded.shareOperationId } },
    }).catch(error => error);
    expect(failure).toMatchObject({ code: 'PROMOTE_RETRYABLE_FAILURE' });
    expect(failure.cause).toMatchObject({ code: SWM_INVENTORY_HANDOFF_PENDING_CODE, reason: 'inactive-lane' });
    expect(reconcile).toHaveBeenCalledOnce();
    expect(lockedDuringPass).toEqual([false]);
    // The handoff turns a failed pass into the pending answer, so check that the pass itself completed.
    await expect(reconcile.mock.results[0]!.value).resolves.toMatchObject({ contextGraphId: CONTEXT_GRAPH_ID });
    expect(writer.mock.calls.length).toBeGreaterThanOrEqual(1);
    for (const result of writer.mock.results) {
      await expect(result.value).resolves.toMatchObject({ status: 'dormant', dormantReason: 'inactive-lane' });
    }
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
    expect(await agent.transferRfc64ConfirmedVmV1(confirmed)).toBe('owned');
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
    await expect(agent.transferRfc64ConfirmedVmV1({ ...request, assertionCoordinate: seeded.assertionCoordinate,
      assertionUri: 'urn:confirmed', ctx: createOperationContext('publish'), publicationLabel: 'queued publish' })).rejects.toMatchObject({ phase: 'inventory-maintenance', cause });
    expect(agent.rfc64SwmAuthorInventoryShadowStatusV1()).toMatchObject({ attemptedRemovals: 1, failed: 1 });
  });
});
