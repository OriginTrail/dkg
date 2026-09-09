import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOperationContext } from '@origintrail-official/dkg-core';
import { fetchSyncPages } from '../src/sync/requester/page-fetch.js';
import { MemorySyncCheckpointStore } from '../src/sync/checkpoint/state.js';
import { createPrivateSwmRecoveryWindow } from '../src/sync/requester/private-swm-recovery-budget.js';
import { isSyncTransportFailure } from '../src/sync/error-tags.js';

function request(overrides: Partial<Parameters<typeof fetchSyncPages>[0]> = {}) {
  return fetchSyncPages({
    ctx: createOperationContext('sync'), remotePeerId: 'budget-peer', contextGraphId: 'budget-cg',
    includeSharedMemory: true, phase: 'snapshot', graphUri: '',
    deadline: Date.now() + 60_000, syncPageTimeoutMs: 5_000, syncRouterAttempts: 2,
    syncPageRetryAttempts: 3, syncPageSize: 500, syncDeniedResponse: '#DENIED',
    debugSyncProgress: false, protocolSync: '/dkg/10.0.2/sync',
    checkpointStore: new MemorySyncCheckpointStore(),
    buildSyncRequest: async () => new Uint8Array([1]),
    parseAndFilter: async (body) => ({
      quads: body ? [{ subject: 'urn:s', predicate: 'urn:p', object: '"v"', graph: '' }] : [],
      totalQuads: body ? 500 : 0,
    }),
    send: async () => new Uint8Array(),
    logInfo: () => {}, logWarn: () => {}, logDebug: () => {},
    ...overrides,
  });
}

describe('page and transport admission within one operation', () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('caps every page using monotonic time after a wall-clock rollback during the fetch', async () => {
    let elapsed = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
    vi.spyOn(Date, 'now').mockImplementation(() => 10_000 - elapsed * 100);
    const workAdmission = createPrivateSwmRecoveryWindow(100);
    const timeouts: number[] = [];
    const result = await request({
      workAdmission,
      send: async (_peer, _protocol, _bytes, timeoutMs) => {
        timeouts.push(timeoutMs);
        elapsed += 50;
        return new TextEncoder().encode('page');
      },
    });
    expect(timeouts).toEqual([100, 50]);
    expect(result).toMatchObject({ completed: false, timedOut: false, incompleteReason: 'local-budget-yield' });
    expect(result.quads).toHaveLength(2);
  });

  it('admits no send after authentication consumes the allowance', async () => {
    let elapsed = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
    const workAdmission = createPrivateSwmRecoveryWindow(100);
    const send = vi.fn(async () => new Uint8Array());
    const result = await request({
      workAdmission, send,
      buildSyncRequest: async () => { elapsed = 100; return new Uint8Array([1]); },
    });
    expect(send).not.toHaveBeenCalled();
    expect(result).toMatchObject({ completed: false, timedOut: false, incompleteReason: 'local-budget-yield' });
  });

  it('recomputes the timeout for each retry after the wall clock rolls back', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let elapsed = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
    vi.spyOn(Date, 'now').mockImplementation(() => 10_000 - elapsed * 100);
    const timeouts: number[] = [];
    const result = request({
      workAdmission: createPrivateSwmRecoveryWindow(100),
      send: async (_peer, _protocol, _bytes, timeoutMs) => {
        timeouts.push(timeoutMs);
        if (timeouts.length === 1) { elapsed = 40; throw new Error('request timeout'); }
        return new Uint8Array();
      },
    });
    await vi.runAllTimersAsync();
    expect(await result).toMatchObject({ completed: true, timedOut: false });
    expect(timeouts).toEqual([100, 60]);
  });

  it('keeps an admitted transport failure when the allowance expires during retry backoff', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let elapsed = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
    const failure = new Error('request timeout');
    const send = vi.fn(async () => { throw failure; });
    const outcome = request({
      workAdmission: createPrivateSwmRecoveryWindow(100), send,
      logWarn: () => { elapsed = 100; },
    }).then(() => null, error => error);
    await vi.runAllTimersAsync();
    expect(await outcome).toBe(failure);
    expect(isSyncTransportFailure(await outcome)).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('floors a fractional allowance before passing it to the transport', async () => {
    let elapsed = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
    const workAdmission = createPrivateSwmRecoveryWindow(100);
    elapsed = 0.5;
    const send = vi.fn(async () => new Uint8Array());

    await request({ workAdmission, send });

    expect(send).toHaveBeenCalledWith(
      expect.anything(), expect.anything(), expect.anything(),
      99, expect.anything(), undefined,
    );
  });

  it('yields locally when less than one whole millisecond remains', async () => {
    let elapsed = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
    const workAdmission = createPrivateSwmRecoveryWindow(1);
    elapsed = 0.5;
    const send = vi.fn(async () => new Uint8Array());

    const result = await request({ workAdmission, send });

    expect(send).not.toHaveBeenCalled();
    expect(result).toMatchObject({ completed: false, incompleteReason: 'local-budget-yield' });
  });
});
