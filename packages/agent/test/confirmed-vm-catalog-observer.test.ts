import { describe, expect, it, vi } from 'vitest';
import { Logger, createOperationContext, type SwmAuthorInventoryScopeV1 } from '@origintrail-official/dkg-core';
import { observeConfirmedVmCatalogV1 } from '../src/internal/confirmed-vm-catalog-observer.js';
import { AUTHOR, CONTEXT_GRAPH_ID, NETWORK_ID, assertionSealV1, authorSealV1 } from './support/rfc64-local-catalog-repair-fixture.js';

type Dependencies = { -readonly [Key in keyof Parameters<typeof observeConfirmedVmCatalogV1>[0]]: Parameters<typeof observeConfirmedVmCatalogV1>[0][Key] };

async function fixture() {
  const deps: Dependencies = {
    owner: {},
    log: new Logger('confirmed-catalog-test'),
    finalizedPrivateScope: () => null,
    storeRepair: vi.fn(async () => {}),
    requestPlacement: vi.fn(() => ({ accepted: false })),
    removeShadow: vi.fn(async () => ({ status: 'absent', action: 'remove', attempts: 0, headObjectDigest: null, error: null })),
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
  const scope: SwmAuthorInventoryScopeV1 = {
    networkId: NETWORK_ID, contextGraphId: CONTEXT_GRAPH_ID, authorAddress: AUTHOR,
    governanceChainId: null, governanceContractAddress: null, ownershipTransitionDigest: null,
    subGraphName: null, era: '1',
  };
  return { deps, params, scope };
}

describe('confirmed VM catalog completion certificate', () => {
  it.each(['applied', 'absent', 'dormant', 'failed'] as const)('reports public removal %s honestly', async (status) => {
    const { deps, params } = await fixture();
    deps.removeShadow = vi.fn(async () => ({ status, action: 'remove', attempts: 0, headObjectDigest: null, error: null }));
    expect(await observeConfirmedVmCatalogV1(deps, params)).toBe(status !== 'failed');
    expect(deps.storeRepair).not.toHaveBeenCalled();
    expect(deps.requestProjection).toHaveBeenCalledTimes(status === 'applied' || status === 'absent' ? 1 : 0);
  });

  it('does not certify a private placement before its durable repair marker commits', async () => {
    const { deps, params, scope } = await fixture();
    deps.finalizedPrivateScope = () => scope;
    let release!: () => void;
    deps.storeRepair = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    let settled = false;
    const pending = observeConfirmedVmCatalogV1(deps, params).then((result) => { settled = true; return result; });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(deps.requestPlacement).not.toHaveBeenCalled();
    release();
    expect(await pending).toBe(true); // Supervisor refusal leaves a durable independent owner.
    expect(deps.requestPlacement).toHaveBeenCalledOnce();
  });

  it('retains the certificate after supervisor failure only when the marker was stored', async () => {
    const { deps, params, scope } = await fixture();
    deps.finalizedPrivateScope = () => scope;
    deps.requestPlacement = vi.fn(() => { throw new Error('supervisor unavailable'); });
    expect(await observeConfirmedVmCatalogV1(deps, params)).toBe(true);
    deps.storeRepair = vi.fn(async () => { throw new Error('disk unavailable'); });
    expect(await observeConfirmedVmCatalogV1(deps, params)).toBe(false);
  });

  it('does not certify unavailable authority or an escaped public removal failure', async () => {
    const { deps, params } = await fixture();
    deps.finalizedPrivateScope = () => { throw new Error('authority unavailable'); };
    expect(await observeConfirmedVmCatalogV1(deps, params)).toBe(false);
    deps.finalizedPrivateScope = () => null;
    deps.removeShadow = vi.fn(async () => { throw new Error('store unavailable'); });
    expect(await observeConfirmedVmCatalogV1(deps, params)).toBe(false);
  });
});
