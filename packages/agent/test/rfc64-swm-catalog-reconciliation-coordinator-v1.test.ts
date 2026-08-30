import { describe, expect, it } from 'vitest';

import { Rfc64SwmCatalogReconciliationCoordinatorV1 } from
  '../src/rfc64/swm-catalog-reconciliation-coordinator-v1.js';

const scope = Object.freeze({
  contextGraphId: 'public-cg' as never,
  authorAddress: '0x1111111111111111111111111111111111111111' as never,
});

describe('RFC-64 SWM catalog reconciliation coordinator', () => {
  it('coalesces a burst onto one pass plus one latest-state follow-up', async () => {
    const observedVersions: number[] = [];
    let version = 1;
    let releaseFirst!: () => void;
    let markFirstEntered!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const firstEntered = new Promise<void>((resolve) => { markFirstEntered = resolve; });
    const reconcile = async (): Promise<void> => {
      observedVersions.push(version);
      if (observedVersions.length === 1) {
        markFirstEntered();
        await firstGate;
      }
    };
    const coordinator = new Rfc64SwmCatalogReconciliationCoordinatorV1(reconcile);

    const first = coordinator.request(scope);
    await firstEntered;
    version = 2;
    const second = coordinator.request(scope);
    version = 3;
    const third = coordinator.request(scope);
    expect(second).toBe(first);
    expect(third).toBe(first);

    releaseFirst();
    await Promise.all([first, second, third]);
    expect(observedVersions).toEqual([1, 3]);
  });

  it('uses a mutation arriving during failure as the bounded retry request', async () => {
    let attempts = 0;
    let requestRetry!: () => void;
    const retryRequested = new Promise<void>((resolve) => { requestRetry = resolve; });
    const reconcile = async (): Promise<void> => {
      attempts += 1;
      if (attempts === 1) {
        requestRetry();
        await Promise.resolve();
        throw new Error('transient failure');
      }
    };
    const coordinator = new Rfc64SwmCatalogReconciliationCoordinatorV1(reconcile);

    const first = coordinator.request(scope);
    await retryRequested;
    const retry = coordinator.request(scope);
    expect(retry).toBe(first);
    await expect(first).resolves.toBeUndefined();
    expect(attempts).toBe(2);
  });

  it('starts a replacement for a request at the successful settlement boundary', async () => {
    let attempts = 0;
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const coordinator = new Rfc64SwmCatalogReconciliationCoordinatorV1(() => {
      attempts += 1;
      return attempts === 1 ? firstGate : Promise.resolve();
    });

    const first = coordinator.request(scope);
    await Promise.resolve();
    let replacement!: Promise<void>;
    releaseFirst();
    await new Promise<void>((resolve) => {
      queueMicrotask(() => {
        replacement = coordinator.request(scope);
        resolve();
      });
    });

    expect(replacement).not.toBe(first);
    await expect(Promise.all([first, replacement])).resolves.toEqual([undefined, undefined]);
    expect(attempts).toBe(2);
  });

  it('starts a replacement for a request at the rejected settlement boundary', async () => {
    let attempts = 0;
    let rejectFirst!: (cause: Error) => void;
    const firstGate = new Promise<void>((_resolve, reject) => { rejectFirst = reject; });
    const coordinator = new Rfc64SwmCatalogReconciliationCoordinatorV1(() => {
      attempts += 1;
      return attempts === 1 ? firstGate : Promise.resolve();
    });

    const first = coordinator.request(scope);
    void first.catch(() => undefined);
    await Promise.resolve();
    let replacement!: Promise<void>;
    rejectFirst(new Error('settlement failure'));
    await new Promise<void>((resolve) => {
      queueMicrotask(() => {
        replacement = coordinator.request(scope);
        resolve();
      });
    });

    expect(replacement).not.toBe(first);
    await expect(first).rejects.toThrow('settlement failure');
    await expect(replacement).resolves.toBeUndefined();
    expect(attempts).toBe(2);
  });
});
