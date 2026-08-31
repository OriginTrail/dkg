import { describe, expect, it, vi } from 'vitest';

import { createOperationContext } from '@origintrail-official/dkg-core';
import {
  Rfc64CatalogRuntimeV1,
  type Rfc64CatalogRuntimeOptionsV1,
} from '../src/rfc64/catalog-runtime-v1.js';

type RuntimeCallV1 =
  | 'bootstrap.whenIdle'
  | 'projection.whenIdle'
  | 'inventoryObservers.close'
  | 'receiverAdmission.close'
  | 'bootstrap.close'
  | 'projection.close'
  | 'service.close';

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
      start: vi.fn(),
      close: callback('service.close'),
    },
    receiverAdmission: {
      close: callback('receiverAdmission.close'),
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
  };
}

describe('Rfc64CatalogRuntimeV1', () => {
  const failurePoints = [
    'inventoryObservers.close',
    'receiverAdmission.close',
    'bootstrap.close',
    'projection.close',
    'service.close',
  ] as const;

  it.each(failurePoints)('attempts every later close stage when %s rejects', async (rejected) => {
    const calls: string[] = [];
    const options = runtimeOptions(calls, rejected);
    const runtime = new Rfc64CatalogRuntimeV1(options);
    runtime.start(createOperationContext('system'));

    await expect(runtime.close()).rejects.toThrow(`failed ${rejected}`);
    expect(options.inventoryObservers.close).toHaveBeenCalledOnce();
    expect(options.receiverAdmission.close).toHaveBeenCalledOnce();
    expect(options.bootstrap.close).toHaveBeenCalledOnce();
    expect(options.projection.close).toHaveBeenCalledOnce();
    expect(options.service.close).toHaveBeenCalledOnce();
    expect(calls.at(-1)).toBe('service.close');
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
    expect(options.bootstrap.whenIdle).toHaveBeenCalledOnce();
    expect(options.projection.whenIdle).toHaveBeenCalledOnce();
  });
});
