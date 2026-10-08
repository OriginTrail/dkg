// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from 'vitest';
import { runRpcProviderPass } from '../src/rpc-provider-pass.js';

const transient = () => Object.assign(new Error('endpoint unavailable'), { code: 'NETWORK_ERROR' });
const retryAll = { isRetryable: () => true };

describe('runRpcProviderPass', () => {
  it('settles each ordered attempt before serving the first usable response', async () => {
    const events: string[] = [];
    let release!: (value: string | null) => void;
    const primary = new Promise<string | null>((resolve) => { release = resolve; });
    const pending = runRpcProviderPass(['primary', 'fallback', 'unused'], async (endpoint, index) => {
      events.push(`read:${endpoint}:${index}`);
      return endpoint === 'primary' ? primary : 'view';
    }, {
      ...retryAll,
      isEmptyResult: value => value === null,
      onAttempt: (endpoint, index) => { events.push(`attempt:${endpoint}:${index}`); },
      onServed: (endpoint, value) => { events.push(`served:${endpoint}:${value}`); },
      onFailure: endpoint => { events.push(`failed:${endpoint}`); },
    });
    expect(events).toEqual(['attempt:primary:0', 'read:primary:0']);
    release(null);
    await expect(pending).resolves.toEqual({ status: 'served', value: 'view' });
    expect(events).toEqual([
      'attempt:primary:0', 'read:primary:0',
      'attempt:fallback:1', 'read:fallback:1', 'served:fallback:view',
    ]);
  });

  it.each([false, 0, ''])('serves %j when the caller has not declared it empty', async (value) => {
    const read = vi.fn(async () => value);
    await expect(runRpcProviderPass(['primary', 'unused'], read, retryAll))
      .resolves.toEqual({ status: 'served', value });
    expect(read).toHaveBeenCalledOnce();
  });

  it('retains both the last error and last empty response for caller exhaustion policy', async () => {
    const first = transient(), last = transient();
    const failures: string[] = [], served = vi.fn();
    const result = await runRpcProviderPass(['first', 'empty', 'last', 'last-empty'], async (endpoint) => {
      if (endpoint === 'first') throw first;
      if (endpoint === 'last') throw last;
      return endpoint === 'empty' ? null : undefined;
    }, {
      ...retryAll,
      isEmptyResult: value => value == null,
      onFailure: endpoint => { failures.push(endpoint); },
      onServed: served,
    });
    expect(result).toEqual({
      status: 'exhausted', lastError: last, empty: { value: undefined }, stopped: false,
    });
    expect(failures).toEqual(['first', 'last']);
    expect(served).not.toHaveBeenCalled();
  });

  it('propagates local pressure before consulting a permissive retry classifier', async () => {
    const pressure = Object.assign(new Error('shared local capacity'), { code: 'RPC_REQUEST_GOVERNOR_QUEUE_FULL' });
    const read = vi.fn(async () => { throw pressure; });
    const isRetryable = vi.fn(() => true), onFailure = vi.fn();
    await expect(runRpcProviderPass(['primary', 'fallback'], read, { isRetryable, onFailure }))
      .rejects.toBe(pressure);
    expect(read).toHaveBeenCalledOnce();
    expect(isRetryable).not.toHaveBeenCalled();
    expect(onFailure).not.toHaveBeenCalled();
  });

  it('rethrows a nonretryable failure without recording failure or starting fallback', async () => {
    const error = Object.assign(new Error('deterministic refusal'), { code: 'CALL_EXCEPTION' });
    const read = vi.fn(async () => { throw error; }), onFailure = vi.fn();
    await expect(runRpcProviderPass(['primary', 'fallback'], read, {
      isRetryable: () => false, onFailure,
    })).rejects.toBe(error);
    expect(read).toHaveBeenCalledOnce();
    expect(onFailure).not.toHaveBeenCalled();
  });

  it('checks the start gate before observers and work, including the first attempt', async () => {
    const read = vi.fn(async () => 'view'), onAttempt = vi.fn(), onFailure = vi.fn();
    await expect(runRpcProviderPass(['primary'], read, {
      ...retryAll, canStartAttempt: () => false, onAttempt, onFailure,
    })).resolves.toEqual({ status: 'exhausted', empty: null, stopped: true });
    expect(read).not.toHaveBeenCalled();
    expect(onAttempt).not.toHaveBeenCalled();
    expect(onFailure).not.toHaveBeenCalled();
  });

  it('preserves prior empty evidence when a deadline stops the next attempt', async () => {
    const read = vi.fn(async () => null), onAttempt = vi.fn();
    await expect(runRpcProviderPass(['primary', 'fallback'], read, {
      ...retryAll, isEmptyResult: value => value === null,
      canStartAttempt: (_endpoint, index) => index === 0, onAttempt,
    })).resolves.toEqual({ status: 'exhausted', empty: { value: null }, stopped: true });
    expect(read).toHaveBeenCalledOnce();
    expect(onAttempt).toHaveBeenCalledExactlyOnceWith('primary', 0);
  });

  it('reports zero endpoints without invoking the start gate or any work', async () => {
    const read = vi.fn(async () => 'view'), canStartAttempt = vi.fn(() => false);
    await expect(runRpcProviderPass([], read, { ...retryAll, canStartAttempt }))
      .resolves.toEqual({ status: 'exhausted', empty: null, stopped: false });
    expect(read).not.toHaveBeenCalled();
    expect(canStartAttempt).not.toHaveBeenCalled();
  });

  it('classifies synchronous attempt-observer errors within the same attempt', async () => {
    const error = transient(), events: string[] = [];
    const result = await runRpcProviderPass(['primary', 'fallback'], async (endpoint) => {
      events.push(`read:${endpoint}`);
      return 'view';
    }, {
      ...retryAll,
      onAttempt: endpoint => { if (endpoint === 'primary') throw error; },
      onFailure: endpoint => { events.push(`failed:${endpoint}`); },
    });
    expect(result).toEqual({ status: 'served', value: 'view' });
    expect(events).toEqual(['failed:primary', 'read:fallback']);
  });
});
