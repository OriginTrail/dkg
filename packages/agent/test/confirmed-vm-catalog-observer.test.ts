import { Rfc64CatalogAutoPublishMethods } from '../src/dkg-agent-rfc64-catalog-auto-publish.js';
import { throwInventoryRecoveryFailure } from '../src/internal/promote/inventory-recovery-failure.js';
import { requireInventoryRemovalLane, SwmCatalogAuthorityNotReady } from '../src/internal/swm-inventory-write.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { describe, expect, it, vi } from 'vitest';
import { Logger, createOperationContext, type SwmAuthorInventoryScopeV1 } from '@origintrail-official/dkg-core';
import { SwmInventoryWriteFailure } from '../src/internal/swm-inventory-write.js';
import { observeConfirmedVmTransfer, observeConfirmedVmCatalogV1, transferConfirmedVmCatalogV1 } from '../src/internal/confirmed-vm-catalog-observer.js';
import { CatalogPlacementTimingV1, installCatalogPlacementTimingV1 } from '../src/internal/catalog-placement-timing.js';
import { AUTHOR, AUTHOR_WALLET, CONTEXT_GRAPH_ID, NETWORK_ID, assertionSealV1, authorSealV1 } from './support/rfc64-local-catalog-repair-fixture.js';
import { rfc64SwmInventoryAssetKeyV1, rfc64SwmInventoryShadowRuntimeV1 } from '../src/rfc64/swm-inventory-shadow-runtime-v1.js';

type Dependencies = { -readonly [Key in keyof Parameters<typeof observeConfirmedVmCatalogV1>[0]]: Parameters<typeof observeConfirmedVmCatalogV1>[0][Key] };

async function fixture() {
  const deps: Dependencies = {
    owner: {},
    log: new Logger('confirmed-catalog-test'),
    finalizedPrivateScopeBase: null,
    storeRepair: vi.fn(async () => {}),
    requestPlacement: vi.fn(() => ({ accepted: false })),
    removeInventory: vi.fn(async () => ({ status: 'absent', attempts: 0, snapshot: null })),
    requestProjection: vi.fn(() => false),
  };
  const params = {
    contextGraphId: CONTEXT_GRAPH_ID,
    assertionCoordinate: 'asset-1',
    shareOperationId: 'share-1',
    seal: assertionSealV1(await authorSealV1(1n)),
    assertionUri: 'urn:assertion:asset-1',
    ctx: createOperationContext('publishFromSWM'),
    publicationLabel: 'queued publish' as const,
  };
  const scopeBase: Readonly<Omit<SwmAuthorInventoryScopeV1, 'authorAddress'>> = Object.freeze({
    networkId: NETWORK_ID, contextGraphId: CONTEXT_GRAPH_ID,
    governanceChainId: null, governanceContractAddress: null, ownershipTransitionDigest: null,
    subGraphName: null, era: '1',
  });
  return { deps, params, scopeBase };
}

describe('confirmed VM catalog completion certificate', () => {
  it.each([true,false])('retains retry only for required but inactive removal authority (required=%s)', async required => {
    const {deps,params}=await fixture();
    deps.removeInventory=async()=>{
      try {return requireInventoryRemovalLane(null,()=>required);}
      catch(cause){throw new SwmInventoryWriteFailure('inventory-maintenance',params.seal.kaUal??null,cause);}
    };
    const failure=await transferConfirmedVmCatalogV1(deps,params).catch(error=>error);
    if(required){
      expect(failure.cause).toBeInstanceOf(SwmCatalogAuthorityNotReady);
      await expect(throwInventoryRecoveryFailure(failure)).rejects.toMatchObject({code:'PROMOTE_RETRYABLE_FAILURE'});
    }else{
      await expect(throwInventoryRecoveryFailure(failure)).rejects.toThrow('policy excluded removal');
      expect(failure.cause).not.toBeInstanceOf(SwmCatalogAuthorityNotReady);
    }
  });

  it.each(['applied', 'absent', 'inactive'] as const)('strict recovery accepts only durable public removal: %s', async status => {
    const { deps, params } = await fixture();
    deps.removeInventory = vi.fn(async () => (status === 'inactive' ? { status } : { status, attempts: 0, snapshot: null }));
    expect(await transferConfirmedVmCatalogV1(deps, params))
      .toBe(status === 'applied' || status === 'absent' ? 'owned' : 'inactive');
  });

  it('strict recovery preserves authority refusal and classifies only marker persistence as a write boundary', async () => {
    const { deps, params, scopeBase } = await fixture();
    const refusal = new Error('authority denied');
    const transfer = () => Rfc64CatalogAutoPublishMethods.prototype.transferRfc64ConfirmedVmV1.call(
      { resolveRfc64CatalogAuthoringLaneV1: () => { throw refusal; } } as any, params);
    await expect(transfer()).rejects.toMatchObject({ phase: 'authority', cause: refusal });
    expect(await observeConfirmedVmTransfer(deps.log, params, transfer)).toBe(false);
    deps.finalizedPrivateScopeBase = scopeBase;
    const disk = new Error('disk unavailable');
    deps.storeRepair = vi.fn(async () => { throw disk; });
    const failure = await transferConfirmedVmCatalogV1(deps, params).catch(e => e);
    expect(failure).toBeInstanceOf(SwmInventoryWriteFailure);
    expect(failure).toMatchObject({ phase: 'inventory-maintenance', cause: disk });
    expect(deps.requestPlacement).not.toHaveBeenCalled();
  });

  it.each(['applied', 'throws'] as const)('fences author retirement behind queued public confirmation (%s)', async (outcome) => {
    const { deps, params } = await fixture();
    const runtime = rfc64SwmInventoryShadowRuntimeV1(deps.owner);
    const lane = { contextGraphId: CONTEXT_GRAPH_ID, authorAddress: AUTHOR };
    const assetKey = rfc64SwmInventoryAssetKeyV1({ ...lane, assertionCoordinate: params.assertionCoordinate });
    const context = new AsyncLocalStorage<string>();
    const events: string[] = [];
    let releaseAsset!: () => void;
    let releaseRemoval!: () => void;
    let removalEntered!: () => void;
    const assetGate = new Promise<void>((resolve) => { releaseAsset = resolve; });
    const removalGate = new Promise<void>((resolve) => { releaseRemoval = resolve; });
    const entered = new Promise<void>((resolve) => { removalEntered = resolve; });
    const predecessor = runtime.runExclusive(assetKey, () => assetGate);
    deps.removeInventory = vi.fn(async () => {
      events.push(`remove:${context.getStore()}`);
      removalEntered();
      await removalGate;
      events.push('removal-settled');
      if (outcome === 'throws') throw new Error('removal unavailable');
      return { status: outcome, attempts: 1, snapshot: null };
    });
    const pending = context.run('confirmation', () => observeConfirmedVmCatalogV1(deps, params));
    try {
      // Registration is synchronous, including while this asset's previous work still runs.
      expect(runtime.hasInventoryWrites(lane)).toBe(true);
      expect(context.run('retirement', () => runtime.scheduleAfterInventoryWrites(lane, 'retired-twin', async () => {
        events.push(`retire:${context.getStore()}`);
      }))).toBe(true);
      await Promise.resolve();
      expect(events).toEqual([]);
      context.run('predecessor-release', releaseAsset);
      await entered;
      expect(events).toEqual(['remove:confirmation']);
      expect(runtime.hasInventoryWrites(lane)).toBe(true);
      context.run('removal-release', releaseRemoval);
      await expect(pending).resolves.toBe(outcome === 'applied');
      await runtime.drain();
      expect(events).toEqual(['remove:confirmation', 'removal-settled', 'retire:retirement']);
      expect(runtime.hasInventoryWrites(lane)).toBe(false);
      expect(runtime.inFlightCount).toBe(0);
    } finally {
      releaseAsset();
      releaseRemoval();
      await predecessor;
      await pending;
      await runtime.closeAndDrain();
    }
  });

  it.each(['applied', 'absent', 'inactive'] as const)('reports public removal %s honestly', async (status) => {
    const { deps, params } = await fixture();
    deps.removeInventory = vi.fn(async () => (status === 'inactive' ? { status } : { status, attempts: 0, snapshot: null }));
    expect(await observeConfirmedVmCatalogV1(deps, params)).toBe(true);
    expect(deps.storeRepair).not.toHaveBeenCalled();
    expect(deps.requestProjection).toHaveBeenCalledTimes(status === 'applied' || status === 'absent' ? 1 : 0);
  });

  it('does not certify a private placement before its durable repair marker commits', async () => {
    const { deps, params, scopeBase } = await fixture();
    deps.finalizedPrivateScopeBase = scopeBase;
    params.seal = { ...params.seal, authorAddress: AUTHOR_WALLET.address };
    let release!: () => void;
    deps.storeRepair = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    let settled = false;
    const pending = observeConfirmedVmCatalogV1(deps, params).then((result) => { settled = true; return result; });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(deps.storeRepair).toHaveBeenCalledWith(expect.objectContaining({
      inventoryScope: { ...scopeBase, authorAddress: AUTHOR },
    }));
    expect(deps.removeInventory).not.toHaveBeenCalled();
    expect(deps.requestPlacement).not.toHaveBeenCalled();
    release();
    expect(await pending).toBe(true); // Supervisor refusal leaves a durable independent owner.
    expect(deps.requestPlacement).toHaveBeenCalledOnce();
  });

  it('retains the certificate after supervisor failure only when the marker was stored', async () => {
    const { deps, params, scopeBase } = await fixture();
    deps.finalizedPrivateScopeBase = scopeBase;
    deps.requestPlacement = vi.fn(() => { throw new Error('supervisor unavailable'); });
    expect(await observeConfirmedVmCatalogV1(deps, params)).toBe(true);
    deps.storeRepair = vi.fn(async () => { throw new Error('disk unavailable'); });
    expect(await observeConfirmedVmCatalogV1(deps, params)).toBe(false);
  });

  it('does not certify an escaped public removal failure', async () => {
    const { deps, params } = await fixture();
    deps.removeInventory = vi.fn(async () => { throw new Error('store unavailable'); });
    expect(await observeConfirmedVmCatalogV1(deps, params)).toBe(false);
  });

  it.each([
    ['storeRepair', false, 'placement was not recorded, so nothing owes it'],
    ['requestPlacement', true, 'placement could not be requested; its durable marker stays'],
    ['removeInventory', false, 'SWM inventory shadow removal escaped its failure boundary'],
    ['requestProjection', true, 'SWM inventory shadow removal escaped its failure boundary'],
  ] as const)('keeps the durable verdict and ends timing when the %s getter throws', async (capability, expected, warning) => {
    const { deps, params, scopeBase } = await fixture();
    const privateLane = capability === 'storeRepair' || capability === 'requestPlacement';
    deps.finalizedPrivateScopeBase = privateLane ? scopeBase : null;
    const stored = deps.storeRepair;
    const requested = deps.requestPlacement;
    const removed = deps.removeInventory;
    Object.defineProperty(deps, capability, { get: () => { throw new Error('capability unavailable'); } });
    installCatalogPlacementTimingV1(deps.owner, new CatalogPlacementTimingV1({
      clock: () => 0, logThresholdMs: 0,
    }));
    const warn = vi.spyOn(deps.log, 'warn').mockImplementation(() => {});
    const info = vi.spyOn(deps.log, 'info').mockImplementation(() => {});

    expect(await observeConfirmedVmCatalogV1(deps, params)).toBe(expected);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[1]).toContain(warning);
    expect(warn.mock.calls[0]?.[1]).toContain('capability unavailable');
    expect(info).toHaveBeenCalledOnce();
    expect(info.mock.calls[0]?.[1]).toContain('rfc64_catalog_placement_wait ');
    expect(info.mock.calls[0]?.[1]).toContain(capability === 'requestPlacement'
      ? 'lane=finalized-private' : 'lane=public');
    expect(stored).toHaveBeenCalledTimes(capability === 'requestPlacement' ? 1 : 0);
    expect(requested).not.toHaveBeenCalled();
    expect(removed).toHaveBeenCalledTimes(capability === 'requestProjection' ? 1 : 0);
  });

  it.each(['applied', 'absent'] as const)('retains a committed public %s when projection notification throws', async (status) => {
    const { deps, params } = await fixture();
    deps.removeInventory = vi.fn(async () => ({ status, attempts: 0, snapshot: null }));
    deps.requestProjection = vi.fn(() => { throw new Error('projection unavailable'); });
    const warn = vi.spyOn(deps.log, 'warn').mockImplementation(() => {});
    expect(await observeConfirmedVmCatalogV1(deps, params)).toBe(true);
    expect(deps.requestProjection).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[1]).toContain('SWM inventory shadow removal escaped its failure boundary: projection unavailable');
  });

});
