import { describe, expect, it, vi } from 'vitest';

import { createOperationContext } from '@origintrail-official/dkg-core';
import {
  Rfc64CatalogRuntimeV1,
  type Rfc64CatalogRuntimeOptionsV1,
} from '../src/rfc64/catalog-runtime-v1.js';

function runtimeOptions(
  calls: string[],
  rejected?: keyof Rfc64CatalogRuntimeOptionsV1,
): Rfc64CatalogRuntimeOptionsV1 {
  const callback = (name: keyof Rfc64CatalogRuntimeOptionsV1) => vi.fn(async () => {
    calls.push(name);
    if (name === rejected) throw new Error(`failed ${name}`);
  });
  return {
    openInventoryObservers: vi.fn(),
    startService: vi.fn(),
    startBootstrap: vi.fn(),
    startProjection: vi.fn(),
    whenBootstrapIdle: callback('whenBootstrapIdle'),
    whenProjectionIdle: callback('whenProjectionIdle'),
    closeInventoryObservers: callback('closeInventoryObservers'),
    closeReceiverAdmission: callback('closeReceiverAdmission'),
    closeBootstrap: callback('closeBootstrap'),
    closeProjection: callback('closeProjection'),
    closeServiceAndMutations: callback('closeServiceAndMutations'),
  };
}

describe('Rfc64CatalogRuntimeV1', () => {
  const failurePoints = [
    'closeInventoryObservers',
    'closeReceiverAdmission',
    'closeBootstrap',
    'closeProjection',
    'closeServiceAndMutations',
  ] as const;

  it.each(failurePoints)('attempts every later close stage when %s rejects', async (rejected) => {
    const calls: string[] = [];
    const options = runtimeOptions(calls, rejected);
    const runtime = new Rfc64CatalogRuntimeV1<object, object>(options);
    runtime.start(createOperationContext('system'));

    await expect(runtime.close()).rejects.toThrow(`failed ${rejected}`);
    expect(options.closeInventoryObservers).toHaveBeenCalledOnce();
    expect(options.closeReceiverAdmission).toHaveBeenCalledOnce();
    expect(options.closeBootstrap).toHaveBeenCalledOnce();
    expect(options.closeProjection).toHaveBeenCalledOnce();
    expect(options.closeServiceAndMutations).toHaveBeenCalledOnce();
    expect(calls.at(-1)).toBe('closeServiceAndMutations');
    expect(() => runtime.start(createOperationContext('system')))
      .toThrow('cannot start while close is in progress');
  });

  it('binds bootstrap and projection state types at construction', () => {
    const runtime = new Rfc64CatalogRuntimeV1<{ bootstrap: true }, { projection: true }>(
      runtimeOptions([]),
    );
    runtime.writeBootstrapState({ bootstrap: true });
    runtime.writeProjectionState({ projection: true });
    expect(runtime.readBootstrapState()).toEqual({ bootstrap: true });
    expect(runtime.readProjectionState()).toEqual({ projection: true });
  });
});
