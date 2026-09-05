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
    const owner = new Rfc64PublicCatalogWorkloadOwnerV1({
      createService,
      authorityRefresh,
      onServiceStarted: vi.fn(),
    });
    const ctx = createOperationContext('system');

    owner.start(ctx);
    owner.start(ctx);

    expect(createService).toHaveBeenCalledOnce();
    expect(authorityRefresh.start).not.toHaveBeenCalled();
    expect(owner.service).toBeUndefined();
    await owner.close();
    expect(authorityRefresh.close).toHaveBeenCalledOnce();

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
      onServiceStarted: () => { calls.push('owner.started'); },
    });
    const ctx = createOperationContext('system');

    owner.start(ctx);
    await owner.whenIdle();

    expect(owner.service).toBe(service);
    expect(calls.slice(0, 3)).toEqual([
      'service.start',
      'authority.start',
      'owner.started',
    ]);
    expect(calls).toContain('service.whenIdle');
    expect(calls).toContain('authority.whenIdle');
    await owner.close();
  });

  it('fences receiver admission and all-settles owned retirement', async () => {
    const serviceFailure = new Error('service close failed');
    const authorityFailure = new Error('authority close failed');
    const service = fakeService({
      close: vi.fn(async () => { throw serviceFailure; }),
    });
    const authorityRefresh = authorityOwner({
      close: vi.fn(async () => { throw authorityFailure; }),
    });
    const owner = new Rfc64PublicCatalogWorkloadOwnerV1({
      createService: () => service,
      authorityRefresh,
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

  it.each([
    'service.start',
    'authority.start',
    'started callback',
  ] as const)('transactionally rolls back a %s failure', async (failureStage) => {
    let initialAttempt = true;
    let releaseServiceClose!: () => void;
    const serviceCloseGate = new Promise<void>((resolve) => { releaseServiceClose = resolve; });
    const firstService = fakeService({
      start: vi.fn(() => {
        if (failureStage === 'service.start' && initialAttempt) {
          throw new Error('service start failed');
        }
      }),
      close: vi.fn(() => serviceCloseGate),
    });
    const secondService = fakeService();
    const createService = vi.fn()
      .mockReturnValueOnce(firstService)
      .mockReturnValue(secondService);
    const authorityRefresh = authorityOwner({
      start: vi.fn(() => {
        if (failureStage === 'authority.start' && initialAttempt) {
          throw new Error('authority start failed');
        }
      }),
    });
    const onServiceStarted = vi.fn(() => {
      if (failureStage === 'started callback' && initialAttempt) {
        throw new Error('started callback failed');
      }
    });
    const owner = new Rfc64PublicCatalogWorkloadOwnerV1({
      createService,
      authorityRefresh,
      onServiceStarted,
    });
    const ctx = createOperationContext('system');

    expect(() => owner.start(ctx)).toThrow({
      'service.start': 'service start failed',
      'authority.start': 'authority start failed',
      'started callback': 'started callback failed',
    }[failureStage]);
    const rollback = owner.close();
    expect(owner.close()).toBe(rollback);
    expect(() => owner.start(ctx)).toThrow('cannot start while close is in progress');
    await vi.waitFor(() => expect(firstService.close).toHaveBeenCalledOnce());
    expect(authorityRefresh.close).toHaveBeenCalledTimes(
      failureStage === 'service.start' ? 0 : 1,
    );

    let rollbackSettled = false;
    void rollback.then(() => { rollbackSettled = true; });
    await Promise.resolve();
    expect(rollbackSettled).toBe(false);
    releaseServiceClose();
    await rollback;

    initialAttempt = false;
    owner.start(ctx);
    expect(owner.service).toBe(secondService);
    await owner.close();
  });
});
