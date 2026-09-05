import { describe, expect, it, vi } from 'vitest';

import { createOperationContext } from '@origintrail-official/dkg-core';
import {
  Rfc64CatalogRuntimeV1,
  type Rfc64CatalogRuntimeOptionsV1,
} from '../src/rfc64/catalog-runtime-v1.js';

type RuntimeCallV1 =
  | 'service.whenIdle'
  | 'authorityRefresh.whenIdle'
  | 'bootstrap.whenIdle'
  | 'projection.whenIdle'
  | 'inventoryObservers.close'
  | 'receiverAdmission.close'
  | 'authorityRefresh.close'
  | 'bootstrap.close'
  | 'projection.close'
  | 'service.close'
  | 'mutationPersistence.close';

function runtimeOptions(
  calls: string[],
  rejected?: RuntimeCallV1,
): Rfc64CatalogRuntimeOptionsV1 {
  const callback = (name: RuntimeCallV1) => vi.fn(async () => {
    calls.push(name);
    if (name === rejected) throw new Error(`failed ${name}`);
  });
  return {
    inventoryObservers: {
      open: vi.fn(),
      close: callback('inventoryObservers.close'),
    },
    service: {
      start: vi.fn(() => true),
      whenIdle: callback('service.whenIdle'),
      close: callback('service.close'),
    },
    receiverAdmission: {
      close: callback('receiverAdmission.close'),
    },
    authorityRefresh: {
      start: vi.fn(),
      whenIdle: callback('authorityRefresh.whenIdle'),
      close: callback('authorityRefresh.close'),
    },
    bootstrap: {
      start: vi.fn(),
      whenIdle: callback('bootstrap.whenIdle'),
      close: callback('bootstrap.close'),
    },
    projection: {
      start: vi.fn(),
      whenIdle: callback('projection.whenIdle'),
      close: callback('projection.close'),
    },
    mutationPersistence: {
      close: callback('mutationPersistence.close'),
    },
  };
}

describe('Rfc64CatalogRuntimeV1', () => {
  const failurePoints = [
    'inventoryObservers.close',
    'receiverAdmission.close',
    'authorityRefresh.close',
    'bootstrap.close',
    'projection.close',
    'service.close',
    'mutationPersistence.close',
  ] as const;

  it.each(failurePoints)('attempts every later close stage when %s rejects', async (rejected) => {
    const calls: string[] = [];
    const options = runtimeOptions(calls, rejected);
    const runtime = new Rfc64CatalogRuntimeV1(options);
    runtime.start(createOperationContext('system'));

    await expect(runtime.close()).rejects.toThrow(`failed ${rejected}`);
    expect(options.inventoryObservers.close).toHaveBeenCalledOnce();
    expect(options.receiverAdmission.close).toHaveBeenCalledOnce();
    expect(options.authorityRefresh.close).toHaveBeenCalledOnce();
    expect(options.bootstrap.close).toHaveBeenCalledOnce();
    expect(options.projection.close).toHaveBeenCalledOnce();
    expect(options.service.close).toHaveBeenCalledOnce();
    expect(options.mutationPersistence.close).toHaveBeenCalledOnce();
    expect(calls.at(-1)).toBe('mutationPersistence.close');
    expect(() => runtime.start(createOperationContext('system')))
      .toThrow('cannot start while close is in progress');
  });

  it('composes workload owners without exposing their mutable state', async () => {
    const options = runtimeOptions([]);
    const runtime = new Rfc64CatalogRuntimeV1(options);
    const ctx = createOperationContext('system');

    runtime.start(ctx);
    await runtime.whenIdle();

    expect(options.bootstrap.start).toHaveBeenCalledWith(ctx);
    expect(options.projection.start).toHaveBeenCalledWith(ctx);
    expect(options.service.whenIdle).toHaveBeenCalledOnce();
    expect(options.authorityRefresh.start).toHaveBeenCalledWith(ctx);
    expect(options.authorityRefresh.whenIdle).toHaveBeenCalledOnce();
    expect(options.bootstrap.whenIdle).toHaveBeenCalledOnce();
    expect(options.projection.whenIdle).toHaveBeenCalledOnce();
  });

  it('keeps authority refresh dormant when the catalog transport is dormant', () => {
    const options = runtimeOptions([]);
    vi.mocked(options.service.start).mockReturnValue(false);
    const runtime = new Rfc64CatalogRuntimeV1(options);
    const ctx = createOperationContext('system');

    runtime.start(ctx);

    expect(options.authorityRefresh.start).not.toHaveBeenCalled();
    expect(options.bootstrap.start).toHaveBeenCalledWith(ctx);
    expect(options.projection.start).toHaveBeenCalledWith(ctx);
  });

  it('observes blocked authority work and owns one idempotent close/restart fence', async () => {
    const baseOptions = runtimeOptions([]);
    let releaseIdle!: () => void;
    let releaseClose!: () => void;
    const idleGate = new Promise<void>((resolve) => { releaseIdle = resolve; });
    const closeGate = new Promise<void>((resolve) => { releaseClose = resolve; });
    const options: Rfc64CatalogRuntimeOptionsV1 = {
      ...baseOptions,
      authorityRefresh: {
        ...baseOptions.authorityRefresh,
        whenIdle: vi.fn(() => idleGate),
        close: vi.fn(() => closeGate),
      },
    };
    const runtime = new Rfc64CatalogRuntimeV1(options);
    const ctx = createOperationContext('system');
    runtime.start(ctx);

    let idleSettled = false;
    const idle = runtime.whenIdle().then(() => { idleSettled = true; });
    await Promise.resolve();
    expect(idleSettled).toBe(false);
    releaseIdle();
    await idle;

    let closeSettled = false;
    const close = runtime.close();
    void close.then(() => { closeSettled = true; });
    expect(runtime.close()).toBe(close);
    expect(() => runtime.start(ctx)).toThrow('cannot start while close is in progress');
    await vi.waitFor(() => expect(options.service.close).toHaveBeenCalledOnce());
    expect(closeSettled).toBe(false);
    releaseClose();
    await close;

    runtime.start(ctx);
    expect(options.service.start).toHaveBeenCalledTimes(2);
    expect(options.authorityRefresh.start).toHaveBeenCalledTimes(2);
  });
});
