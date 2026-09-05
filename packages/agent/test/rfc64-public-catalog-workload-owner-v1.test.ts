import { describe, expect, it, vi } from 'vitest';

import { createOperationContext } from '@origintrail-official/dkg-core';
import type { Rfc64PublicCatalogServiceV1 } from
  '../src/rfc64/public-catalog-service-v1.js';
import { Rfc64PublicCatalogWorkloadOwnerV1 } from
  '../src/rfc64/public-catalog-workload-owner-v1.js';

function fakeService(overrides: Partial<Readonly<{
  start: () => void;
  whenReceiverIdle: () => Promise<void>;
  closeReceiverAdmissionAndDrain: () => Promise<void>;
  close: () => Promise<void>;
}>> = {}): Rfc64PublicCatalogServiceV1 {
  return {
    start: vi.fn(),
    whenReceiverIdle: vi.fn(async () => undefined),
    closeReceiverAdmissionAndDrain: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    ...overrides,
  } as unknown as Rfc64PublicCatalogServiceV1;
}

function authorityOwner(overrides: Partial<Readonly<{
  start: () => void;
  whenIdle: () => Promise<void>;
  close: () => Promise<void>;
}>> = {}) {
  return {
    start: vi.fn(),
    whenIdle: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe('Rfc64PublicCatalogWorkloadOwnerV1', () => {
  it('preserves dormant starts without arming authority refresh', async () => {
    const authorityRefresh = authorityOwner();
    const createService = vi.fn(() => null);
    const openMutationPersistence = vi.fn();
    const closeMutationPersistence = vi.fn(async () => undefined);
    const owner = new Rfc64PublicCatalogWorkloadOwnerV1({
      createService,
      authorityRefresh,
      openMutationPersistence,
      closeMutationPersistence,
      onServiceStarted: vi.fn(),
    });
    const ctx = createOperationContext('system');

    owner.start(ctx);
    owner.start(ctx);

    expect(createService).toHaveBeenCalledOnce();
    expect(openMutationPersistence).toHaveBeenCalledOnce();
    expect(authorityRefresh.start).not.toHaveBeenCalled();
    expect(owner.service).toBeUndefined();
    await owner.close();
    expect(authorityRefresh.close).toHaveBeenCalledOnce();
    expect(closeMutationPersistence).toHaveBeenCalledOnce();

    owner.start(ctx);
    expect(createService).toHaveBeenCalledTimes(2);
    await owner.close();
  });

  it('starts and observes transport plus authority as one workload', async () => {
    const calls: string[] = [];
    const service = fakeService({
      start: vi.fn(() => { calls.push('service.start'); }),
      whenReceiverIdle: vi.fn(async () => { calls.push('service.whenIdle'); }),
    });
    const authorityRefresh = authorityOwner({
      start: vi.fn(() => { calls.push('authority.start'); }),
      whenIdle: vi.fn(async () => { calls.push('authority.whenIdle'); }),
    });
    const owner = new Rfc64PublicCatalogWorkloadOwnerV1({
      createService: () => service,
      authorityRefresh,
      openMutationPersistence: () => { calls.push('persistence.open'); },
      closeMutationPersistence: async () => { calls.push('persistence.close'); },
      onServiceStarted: () => { calls.push('owner.started'); },
    });
    const ctx = createOperationContext('system');

    owner.start(ctx);
    await owner.whenIdle();

    expect(owner.service).toBe(service);
    expect(calls.slice(0, 4)).toEqual([
      'persistence.open',
      'service.start',
      'authority.start',
      'owner.started',
    ]);
    expect(calls).toContain('service.whenIdle');
    expect(calls).toContain('authority.whenIdle');
    await owner.close();
  });

  it('fences receiver admission and all-settles retirement before persistence', async () => {
    const serviceFailure = new Error('service close failed');
    const authorityFailure = new Error('authority close failed');
    const service = fakeService({
      close: vi.fn(async () => { throw serviceFailure; }),
    });
    const authorityRefresh = authorityOwner({
      close: vi.fn(async () => { throw authorityFailure; }),
    });
    const closeMutationPersistence = vi.fn(async () => undefined);
    const owner = new Rfc64PublicCatalogWorkloadOwnerV1({
      createService: () => service,
      authorityRefresh,
      openMutationPersistence: vi.fn(),
      closeMutationPersistence,
      onServiceStarted: vi.fn(),
    });
    owner.start(createOperationContext('system'));

    await owner.closeReceiverAdmission();
    expect(service.closeReceiverAdmissionAndDrain).toHaveBeenCalledOnce();
    const closing = owner.close();
    expect(owner.service).toBeUndefined();
    expect(owner.close()).toBe(closing);
    await expect(closing).rejects.toMatchObject({
      errors: [serviceFailure, authorityFailure],
    });
    expect(service.close).toHaveBeenCalledOnce();
    expect(authorityRefresh.close).toHaveBeenCalledOnce();
    expect(closeMutationPersistence).toHaveBeenCalledOnce();
    expect(() => owner.start(createOperationContext('system')))
      .toThrow('cannot start while close is in progress');
  });

  it('waits for physical retirement and supports restart after a successful close', async () => {
    let releaseService!: () => void;
    const serviceGate = new Promise<void>((resolve) => { releaseService = resolve; });
    const first = fakeService({ close: vi.fn(() => serviceGate) });
    const second = fakeService();
    const services = [first, second];
    const authorityRefresh = authorityOwner();
    const owner = new Rfc64PublicCatalogWorkloadOwnerV1({
      createService: () => services.shift() ?? null,
      authorityRefresh,
      openMutationPersistence: vi.fn(),
      closeMutationPersistence: vi.fn(async () => undefined),
      onServiceStarted: vi.fn(),
    });
    const ctx = createOperationContext('system');
    owner.start(ctx);

    let settled = false;
    const closing = owner.close();
    void closing.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    releaseService();
    await closing;

    owner.start(ctx);
    expect(owner.service).toBe(second);
    expect(authorityRefresh.start).toHaveBeenCalledTimes(2);
    await owner.close();
  });
});
