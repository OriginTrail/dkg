// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';

import { Rfc64SerializedScopeRuntimeV1 } from
  '../src/rfc64/serialized-scope-runtime-v1.js';

describe('RFC-64 serialized scope runtime', () => {
  it('keeps an aborted queued slot behind its active predecessor', async () => {
    const runtime = new Rfc64SerializedScopeRuntimeV1('test scope aborted');
    let releaseFirst!: () => void;
    let markFirstEntered!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const firstEntered = new Promise<void>((resolve) => { markFirstEntered = resolve; });
    let thirdEntered = false;

    const first = runtime.run('scope', async () => {
      markFirstEntered();
      await firstGate;
      return 'first';
    });
    await firstEntered;

    const controller = new AbortController();
    const second = runtime.run('scope', async () => 'second', controller.signal);
    controller.abort(new Error('cancel second'));
    await expect(second).rejects.toThrow('cancel second');

    const third = runtime.run('scope', async () => {
      thirdEntered = true;
      return 'third';
    });
    await Promise.resolve();
    expect(thirdEntered).toBe(false);
    expect(runtime.activeScopeCount).toBe(1);

    releaseFirst();
    await expect(first).resolves.toBe('first');
    await expect(third).resolves.toBe('third');
    await Promise.resolve();
    expect(runtime.activeScopeCount).toBe(0);
  });

  it('keeps an aborted active scope until non-cooperative work settles', async () => {
    const runtime = new Rfc64SerializedScopeRuntimeV1('test scope aborted');
    let releaseFirst!: () => void;
    let markFirstEntered!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const firstEntered = new Promise<void>((resolve) => { markFirstEntered = resolve; });
    let secondEntered = false;

    const controller = new AbortController();
    const first = runtime.run('scope', async () => {
      markFirstEntered();
      await firstGate;
      return 'first';
    }, controller.signal);
    await firstEntered;
    controller.abort(new Error('cancel active'));
    await expect(first).rejects.toThrow('cancel active');

    const second = runtime.run('scope', async () => {
      secondEntered = true;
      return 'second';
    });
    await Promise.resolve();
    expect(secondEntered).toBe(false);
    expect(runtime.activeScopeCount).toBe(1);

    releaseFirst();
    await expect(second).resolves.toBe('second');
    await Promise.resolve();
    expect(runtime.activeScopeCount).toBe(0);
  });

  it('fences admission and drains physical work after caller cancellation', async () => {
    const runtime = new Rfc64SerializedScopeRuntimeV1('test scope aborted');
    let release!: () => void;
    let markEntered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { markEntered = resolve; });
    const controller = new AbortController();
    const caller = runtime.run('scope', async () => {
      markEntered();
      await gate;
    }, controller.signal);
    await entered;
    controller.abort(new Error('cancel caller'));
    await expect(caller).rejects.toThrow('cancel caller');

    let drained = false;
    const closing = runtime.closeAndDrain().then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);
    await expect(runtime.run('late', async () => undefined)).rejects.toThrow('runtime is closed');

    release();
    await closing;
    expect(runtime.activeScopeCount).toBe(0);
    runtime.reopen();
    await expect(runtime.run('after-restart', async () => 'ok')).resolves.toBe('ok');
  });
});
