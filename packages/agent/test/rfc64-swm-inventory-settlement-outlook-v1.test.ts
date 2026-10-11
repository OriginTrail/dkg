/**
 * The post-commit settlement retries of a durable SWM promotion exist for a
 * graph whose catalog lane is about to appear. They must not repeat an
 * authority read that cannot succeed inside their window: the detached observer
 * holds the asset's serialized tail while it retries, and a confirmed publish
 * of the same asset waits on that tail before it answers.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Rfc64CatalogAutoPublishMethods } from '../src/dkg-agent-rfc64-catalog-auto-publish.js';
import { rfc64SwmInventoryShadowRuntimeV1 } from '../src/rfc64/swm-inventory-shadow-runtime-v1.js';
import { rfc64SwmInventorySettlementCanConvergeV1 } from '../src/rfc64/swm-inventory-settlement-outlook-v1.js';

const CG = 'settlement-outlook-cg';
const DORMANT_NO_LANE = Object.freeze({
  status: 'dormant', action: 'upsert', attempts: 0, headObjectDigest: null, error: null,
  dormantReason: 'inactive-lane',
} as const);
const DEFAULT_CATALOG_RESPONSIBILITY = Object.freeze({
  contextGraphId: CG, responsible: true, active: false, mode: 'catalog', selectionSource: 'default',
});

/** The observer's own collaborators, with the reason the last authority refresh recorded. */
function createObserverHost(reasons: { current: string | null; afterReconcile?: string | null }) {
  const host = {
    log: { warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
    recordRfc64SwmAuthorInventoryShadowV1: vi.fn(async () => DORMANT_NO_LANE),
    reconcileRfc64CatalogResponsibilityV1: vi.fn(async () => {
      if (reasons.afterReconcile !== undefined) reasons.current = reasons.afterReconcile;
      return DEFAULT_CATALOG_RESPONSIBILITY;
    }),
    rfc64CatalogAuthorityRefreshFailureReasonV1: vi.fn(() => reasons.current),
    requestRfc64SwmCatalogProjectionV1: vi.fn(() => true),
  };
  const observe = () => Rfc64CatalogAutoPublishMethods.prototype.observeRfc64DurableSwmPromotionV1.call(
    host as never,
    {
      contextGraphId: CG,
      subGraphName: null,
      assertionCoordinate: 'asset',
      lifecycleAgentAddress: `0x${'11'.repeat(20)}`,
      shareOperationId: 'share-1',
      ctx: { operationId: 'op', operation: 'share' },
    } as never,
  );
  return { host, observe };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('rfc64SwmInventorySettlementCanConvergeV1', () => {
  it.each([
    'registered-authority-unfinalized',
    'registered-authority-binding-mismatch',
    'registered-authority-adapter-unsupported',
    'authority-rpc-circuit-open',
  ])('rules out the settlement window for %s', (reason) => {
    expect(rfc64SwmInventorySettlementCanConvergeV1(reason)).toBe(false);
  });

  it.each([
    null,
    'registered-private-roster-unresolved',
    'unregistered-private-roster-unresolved',
    'unregistered-owner-unresolved',
    'access-policy-unresolved',
    'catalog-service-unavailable',
    'authority-resolution-failed',
  ])('keeps the settlement window for %s', (reason) => {
    expect(rfc64SwmInventorySettlementCanConvergeV1(reason)).toBe(true);
  });
});

describe('durable SWM promotion observer: settlement retries', () => {
  it('ends without an authority read when the last refresh recorded chain finality lag', async () => {
    const { host, observe } = createObserverHost({ current: 'registered-authority-unfinalized' });

    await observe();

    expect(host.reconcileRfc64CatalogResponsibilityV1).not.toHaveBeenCalled();
    expect(host.recordRfc64SwmAuthorInventoryShadowV1).toHaveBeenCalledTimes(1);
    expect(host.requestRfc64SwmCatalogProjectionV1).not.toHaveBeenCalled();
    expect(host.log.warn).not.toHaveBeenCalled();
  });

  it('stops after the one authority read that records the condition', async () => {
    const { host, observe } = createObserverHost({
      current: null,
      afterReconcile: 'registered-authority-unfinalized',
    });

    await observe();

    expect(host.reconcileRfc64CatalogResponsibilityV1).toHaveBeenCalledTimes(1);
    // The first delay of the window is zero, so the row is prepared once more and the
    // next pass reads the recorded reason before it would read the authority again.
    expect(host.recordRfc64SwmAuthorInventoryShadowV1).toHaveBeenCalledTimes(2);
  });

  it('leaves the asset tail free for a confirmed publish of the same asset', async () => {
    const { host, observe } = createObserverHost({ current: 'authority-rpc-circuit-open' });
    const runtime = rfc64SwmInventoryShadowRuntimeV1(host);
    const order: string[] = [];

    runtime.schedule('asset-key', async () => {
      await observe();
      order.push('share observer');
    });
    await runtime.runExclusive('asset-key', async () => {
      order.push('confirmed publish');
    });

    expect(order).toEqual(['share observer', 'confirmed publish']);
    expect(host.reconcileRfc64CatalogResponsibilityV1).not.toHaveBeenCalled();
  });

  it('still uses the whole window while local lifecycle state can arrive', async () => {
    vi.useFakeTimers();
    const { host, observe } = createObserverHost({ current: 'unregistered-private-roster-unresolved' });
    const runtime = rfc64SwmInventoryShadowRuntimeV1(host);
    const attempts = runtime.responsibilitySettlementRetryDelaysMs.length;

    const done = observe();
    await vi.advanceTimersByTimeAsync(
      runtime.responsibilitySettlementRetryDelaysMs.reduce((sum, delay) => sum + delay, 0),
    );
    await done;

    expect(host.reconcileRfc64CatalogResponsibilityV1).toHaveBeenCalledTimes(attempts);
    expect(host.recordRfc64SwmAuthorInventoryShadowV1).toHaveBeenCalledTimes(attempts + 1);
  });

  it('records the row as soon as the lane appears inside the window', async () => {
    const { host, observe } = createObserverHost({ current: null });
    host.recordRfc64SwmAuthorInventoryShadowV1
      .mockResolvedValueOnce(DORMANT_NO_LANE)
      .mockResolvedValueOnce({
        status: 'applied', action: 'upsert', attempts: 1, headObjectDigest: `0x${'ab'.repeat(32)}`, error: null,
      } as never);

    await observe();

    expect(host.reconcileRfc64CatalogResponsibilityV1).toHaveBeenCalledTimes(1);
    expect(host.requestRfc64SwmCatalogProjectionV1).toHaveBeenCalledTimes(1);
  });
});
