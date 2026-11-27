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
  | 'mutationPersistence.close'
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
      open: vi.fn(() => { calls.push('inventoryObservers.open'); }),
      close: callback('inventoryObservers.close'),
    },
    mutationPersistence: {
      open: vi.fn(() => { calls.push('mutationPersistence.open'); }),
      close: callback('mutationPersistence.close'),
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
    'mutationPersistence.close',
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
    expect(options.mutationPersistence.close).toHaveBeenCalledOnce();
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

    expect(calls.slice(0, 5)).toEqual([
      'inventoryObservers.open',
      'mutationPersistence.open',
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

  it('keeps mutation persistence open until every catalog producer retires', async () => {
    const baseOptions = runtimeOptions([]);
    let releaseProjection!: () => void;
    const projectionGate = new Promise<void>((resolve) => { releaseProjection = resolve; });
    const projection = {
      ...baseOptions.workloads[1]!,
      close: vi.fn(() => projectionGate),
    };
    const options: Rfc64CatalogRuntimeOptionsV1 = {
      ...baseOptions,
      workloads: [baseOptions.workloads[0]!, projection],
    };
    const runtime = new Rfc64CatalogRuntimeV1(options);
    runtime.start(createOperationContext('system'));

    let closeSettled = false;
    const closing = runtime.close();
    void closing.then(() => { closeSettled = true; });
    await vi.waitFor(() => expect(projection.close).toHaveBeenCalledOnce());
    expect(options.mutationPersistence.close).not.toHaveBeenCalled();
    expect(closeSettled).toBe(false);

    releaseProjection();
    await closing;
    expect(options.mutationPersistence.close).toHaveBeenCalledOnce();
  });

  it('does not advance shutdown stages before each preceding fence retires', async () => {
    const baseOptions = runtimeOptions([]);
    let releaseInventory!: () => void;
    let releaseReceiver!: () => void;
    let releasePublicOwner!: () => void;
    const inventoryGate = new Promise<void>((resolve) => { releaseInventory = resolve; });
    const receiverGate = new Promise<void>((resolve) => { releaseReceiver = resolve; });
    const publicOwnerGate = new Promise<void>((resolve) => { releasePublicOwner = resolve; });
    const options: Rfc64CatalogRuntimeOptionsV1 = {
      ...baseOptions,
      inventoryObservers: {
        ...baseOptions.inventoryObservers,
        close: vi.fn(() => inventoryGate),
      },
      publicCatalog: {
        ...baseOptions.publicCatalog,
        closeReceiverAdmission: vi.fn(() => receiverGate),
        close: vi.fn(() => publicOwnerGate),
      },
    };
    const runtime = new Rfc64CatalogRuntimeV1(options);
    runtime.start(createOperationContext('system'));

    const closing = runtime.close();
    await vi.waitFor(() => expect(options.inventoryObservers.close).toHaveBeenCalledOnce());
    expect(options.publicCatalog.closeReceiverAdmission).not.toHaveBeenCalled();
    expect(options.publicCatalog.close).not.toHaveBeenCalled();
    expect(options.mutationPersistence.close).not.toHaveBeenCalled();

    releaseInventory();
    await vi.waitFor(() => (
      expect(options.publicCatalog.closeReceiverAdmission).toHaveBeenCalledOnce()
    ));
    expect(options.publicCatalog.close).not.toHaveBeenCalled();
    expect(options.mutationPersistence.close).not.toHaveBeenCalled();

    releaseReceiver();
    await vi.waitFor(() => expect(options.publicCatalog.close).toHaveBeenCalledOnce());
    expect(options.workloads[0]!.close).toHaveBeenCalledOnce();
    expect(options.workloads[1]!.close).toHaveBeenCalledOnce();
    expect(options.mutationPersistence.close).not.toHaveBeenCalled();

    releasePublicOwner();
    await closing;
    expect(options.mutationPersistence.close).toHaveBeenCalledOnce();
  });

  it('joins partial-start rollback before releasing mutation persistence', async () => {
    const baseOptions = runtimeOptions([]);
    let failStart = true;
    let releasePublicClose!: () => void;
    const publicCloseGate = new Promise<void>((resolve) => { releasePublicClose = resolve; });
    const publicCatalog = {
      ...baseOptions.publicCatalog,
      close: vi.fn(() => publicCloseGate),
    };
    const projection = {
      ...baseOptions.workloads[1]!,
      start: vi.fn(() => {
        if (failStart) throw new Error('projection start failed');
      }),
    };
    const options: Rfc64CatalogRuntimeOptionsV1 = {
      ...baseOptions,
      publicCatalog,
      workloads: [baseOptions.workloads[0]!, projection],
    };
    const runtime = new Rfc64CatalogRuntimeV1(options);
    const ctx = createOperationContext('system');

    expect(() => runtime.start(ctx)).toThrow('projection start failed');
    // start() itself must arm rollback. Observe every workload retirement
    // before calling close(), so close() cannot be what initiated cleanup.
    await vi.waitFor(() => expect(publicCatalog.close).toHaveBeenCalledOnce());
    expect(options.workloads[0]!.close).toHaveBeenCalledOnce();
    expect(projection.close).toHaveBeenCalledOnce();
    expect(options.mutationPersistence.close).not.toHaveBeenCalled();

    const rollback = runtime.close();
    expect(runtime.close()).toBe(rollback);
    expect(() => runtime.start(ctx)).toThrow('cannot start while close is in progress');
    expect(options.mutationPersistence.close).not.toHaveBeenCalled();

    releasePublicClose();
    await rollback;
    expect(options.mutationPersistence.close).toHaveBeenCalledOnce();

    failStart = false;
    runtime.start(ctx);
  });

  it('retires only the first lifecycle stage when its open attempt fails', async () => {
    const calls: string[] = [];
    const baseOptions = runtimeOptions(calls);
    const options: Rfc64CatalogRuntimeOptionsV1 = {
      ...baseOptions,
      inventoryObservers: {
        ...baseOptions.inventoryObservers,
        open: vi.fn(() => {
          calls.push('inventoryObservers.open');
          throw new Error('inventory observer open failed');
        }),
      },
    };
    const runtime = new Rfc64CatalogRuntimeV1(options);

    expect(() => runtime.start(createOperationContext('system')))
      .toThrow('inventory observer open failed');
    await expect(runtime.close()).resolves.toBeUndefined();

    expect(options.inventoryObservers.close).toHaveBeenCalledOnce();
    expect(options.mutationPersistence.open).not.toHaveBeenCalled();
    expect(options.mutationPersistence.close).not.toHaveBeenCalled();
    expect(options.publicCatalog.start).not.toHaveBeenCalled();
    expect(options.publicCatalog.closeReceiverAdmission).not.toHaveBeenCalled();
    expect(options.publicCatalog.close).not.toHaveBeenCalled();
    expect(options.workloads[0]!.start).not.toHaveBeenCalled();
    expect(options.workloads[0]!.close).not.toHaveBeenCalled();
    expect(options.workloads[1]!.start).not.toHaveBeenCalled();
    expect(options.workloads[1]!.close).not.toHaveBeenCalled();
  });

  it('retires mutation persistence when its open attempt fails and fences restart', async () => {
    const calls: string[] = [];
    const baseOptions = runtimeOptions(calls);
    let failOpen = true;
    let releaseMutationClose!: () => void;
    const mutationCloseGate = new Promise<void>((resolve) => {
      releaseMutationClose = resolve;
    });
    const options: Rfc64CatalogRuntimeOptionsV1 = {
      ...baseOptions,
      mutationPersistence: {
        open: vi.fn(() => {
          calls.push('mutationPersistence.open');
          if (failOpen) throw new Error('mutation persistence open failed');
        }),
        close: vi.fn(async () => {
          calls.push('mutationPersistence.close');
          await mutationCloseGate;
        }),
      },
    };
    const runtime = new Rfc64CatalogRuntimeV1(options);
    const ctx = createOperationContext('system');

    expect(() => runtime.start(ctx)).toThrow('mutation persistence open failed');
    await vi.waitFor(() => expect(options.mutationPersistence.close).toHaveBeenCalledOnce());
    expect(options.inventoryObservers.close).toHaveBeenCalledOnce();
    expect(options.publicCatalog.start).not.toHaveBeenCalled();
    expect(options.publicCatalog.closeReceiverAdmission).not.toHaveBeenCalled();
    expect(options.publicCatalog.close).not.toHaveBeenCalled();
    expect(options.workloads[0]!.start).not.toHaveBeenCalled();
    expect(options.workloads[0]!.close).not.toHaveBeenCalled();
    expect(options.workloads[1]!.start).not.toHaveBeenCalled();
    expect(options.workloads[1]!.close).not.toHaveBeenCalled();
    expect(calls).toEqual([
      'inventoryObservers.open',
      'mutationPersistence.open',
      'inventoryObservers.close',
      'mutationPersistence.close',
    ]);

    const rollback = runtime.close();
    expect(runtime.close()).toBe(rollback);
    expect(() => runtime.start(ctx)).toThrow('cannot start while close is in progress');
    releaseMutationClose();
    await rollback;

    failOpen = false;
    runtime.start(ctx);
    expect(options.mutationPersistence.open).toHaveBeenCalledTimes(2);
    expect(options.publicCatalog.start).toHaveBeenCalledOnce();
    await runtime.close();
  });

  it('does not retire workloads whose starts were never attempted', async () => {
    const calls: string[] = [];
    const baseOptions = runtimeOptions(calls);
    const firstWorkload = {
      ...baseOptions.workloads[0]!,
      start: vi.fn(() => { throw new Error('bootstrap start failed'); }),
    };
    const neverAttemptedWorkload = baseOptions.workloads[1]!;
    const options: Rfc64CatalogRuntimeOptionsV1 = {
      ...baseOptions,
      workloads: [firstWorkload, neverAttemptedWorkload],
    };
    const runtime = new Rfc64CatalogRuntimeV1(options);

    expect(() => runtime.start(createOperationContext('system')))
      .toThrow('bootstrap start failed');
    await expect(runtime.close()).resolves.toBeUndefined();

    expect(firstWorkload.close).toHaveBeenCalledOnce();
    expect(neverAttemptedWorkload.start).not.toHaveBeenCalled();
    expect(neverAttemptedWorkload.close).not.toHaveBeenCalled();
    expect(options.publicCatalog.close).toHaveBeenCalledOnce();
    expect(options.mutationPersistence.close).toHaveBeenCalledOnce();
  });

  it('retires a failed public-owner start without touching later workloads', async () => {
    const calls: string[] = [];
    const baseOptions = runtimeOptions(calls);
    const options: Rfc64CatalogRuntimeOptionsV1 = {
      ...baseOptions,
      publicCatalog: {
        ...baseOptions.publicCatalog,
        start: vi.fn(() => { throw new Error('public catalog start failed'); }),
      },
    };
    const runtime = new Rfc64CatalogRuntimeV1(options);

    expect(() => runtime.start(createOperationContext('system')))
      .toThrow('public catalog start failed');
    await expect(runtime.close()).resolves.toBeUndefined();

    expect(options.publicCatalog.closeReceiverAdmission).toHaveBeenCalledOnce();
    expect(options.publicCatalog.close).toHaveBeenCalledOnce();
    expect(options.workloads[0]!.start).not.toHaveBeenCalled();
    expect(options.workloads[0]!.close).not.toHaveBeenCalled();
    expect(options.workloads[1]!.start).not.toHaveBeenCalled();
    expect(options.workloads[1]!.close).not.toHaveBeenCalled();
    expect(options.mutationPersistence.close).toHaveBeenCalledOnce();
    expect(options.inventoryObservers.close).toHaveBeenCalledOnce();
  });
});
