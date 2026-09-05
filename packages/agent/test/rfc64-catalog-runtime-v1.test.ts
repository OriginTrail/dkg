import { describe, expect, it, vi } from 'vitest';

import { createOperationContext } from '@origintrail-official/dkg-core';
import {
  Rfc64CatalogRuntimeV1,
  type Rfc64CatalogRuntimeOptionsV1,
} from '../src/rfc64/catalog-runtime-v1.js';

type RuntimeCallV1 =
  | 'publicCatalog.whenIdle'
  | 'bootstrap.whenIdle'
  | 'projection.whenIdle'
  | 'inventoryObservers.close'
  | 'publicCatalog.closeReceiverAdmission'
  | 'publicCatalog.close'
  | 'bootstrap.close'
  | 'projection.close';

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
    publicCatalog: {
      start: vi.fn(() => { calls.push('publicCatalog.start'); }),
      whenIdle: callback('publicCatalog.whenIdle'),
      closeReceiverAdmission: callback('publicCatalog.closeReceiverAdmission'),
      close: callback('publicCatalog.close'),
    },
    workloads: [{
      start: vi.fn(() => { calls.push('bootstrap.start'); }),
      whenIdle: callback('bootstrap.whenIdle'),
      close: callback('bootstrap.close'),
    }, {
      start: vi.fn(() => { calls.push('projection.start'); }),
      whenIdle: callback('projection.whenIdle'),
      close: callback('projection.close'),
    }],
  };
}

describe('Rfc64CatalogRuntimeV1', () => {
  const failurePoints = [
    'inventoryObservers.close',
    'publicCatalog.closeReceiverAdmission',
    'publicCatalog.close',
    'bootstrap.close',
    'projection.close',
  ] as const;

  it.each(failurePoints)('attempts every later close stage when %s rejects', async (rejected) => {
    const calls: string[] = [];
    const options = runtimeOptions(calls, rejected);
    const runtime = new Rfc64CatalogRuntimeV1(options);
    runtime.start(createOperationContext('system'));

    await expect(runtime.close()).rejects.toThrow(`failed ${rejected}`);
    expect(options.inventoryObservers.close).toHaveBeenCalledOnce();
    expect(options.publicCatalog.closeReceiverAdmission).toHaveBeenCalledOnce();
    expect(options.publicCatalog.close).toHaveBeenCalledOnce();
    expect(options.workloads[0]!.close).toHaveBeenCalledOnce();
    expect(options.workloads[1]!.close).toHaveBeenCalledOnce();
    expect(() => runtime.start(createOperationContext('system')))
      .toThrow('cannot start while close is in progress');
  });

  it('composes workload owners without exposing their mutable state', async () => {
    const calls: string[] = [];
    const options = runtimeOptions(calls);
    const runtime = new Rfc64CatalogRuntimeV1(options);
    const ctx = createOperationContext('system');

    runtime.start(ctx);
    await runtime.whenIdle();

    expect(calls.slice(0, 3)).toEqual([
      'publicCatalog.start',
      'bootstrap.start',
      'projection.start',
    ]);
    expect(options.publicCatalog.start).toHaveBeenCalledWith(ctx);
    expect(options.workloads[0]!.start).toHaveBeenCalledWith(ctx);
    expect(options.workloads[1]!.start).toHaveBeenCalledWith(ctx);
    expect(options.publicCatalog.whenIdle).toHaveBeenCalledOnce();
    expect(options.workloads[0]!.whenIdle).toHaveBeenCalledOnce();
    expect(options.workloads[1]!.whenIdle).toHaveBeenCalledOnce();
  });

  it('observes blocked public-catalog work and owns one idempotent close/restart fence', async () => {
    const baseOptions = runtimeOptions([]);
    let releaseIdle!: () => void;
    let releaseClose!: () => void;
    const idleGate = new Promise<void>((resolve) => { releaseIdle = resolve; });
    const closeGate = new Promise<void>((resolve) => { releaseClose = resolve; });
    const options: Rfc64CatalogRuntimeOptionsV1 = {
      ...baseOptions,
      publicCatalog: {
        ...baseOptions.publicCatalog,
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
    await vi.waitFor(() => expect(options.publicCatalog.close).toHaveBeenCalledOnce());
    expect(closeSettled).toBe(false);
    releaseClose();
    await close;

    runtime.start(ctx);
    expect(options.publicCatalog.start).toHaveBeenCalledTimes(2);
  });
});
