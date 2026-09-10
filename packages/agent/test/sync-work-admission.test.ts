import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOperationContext } from '@origintrail-official/dkg-core';
import { fetchSyncPages } from '../src/sync/requester/page-fetch.js';
import { MemorySyncCheckpointStore } from '../src/sync/checkpoint/state.js';
import { createPrivateSwmRecoveryWindow } from '../src/sync/requester/private-swm-recovery-budget.js';
import { isSyncTransportFailure } from '../src/sync/error-tags.js';

function roundAdmission(budgetMs: number) {
  return createPrivateSwmRecoveryWindow(budgetMs).admitRound(Date.now() + 60_000, {
    sharing: 'exclusive',
    owner: 'sync-work-admission-test',
  });
}

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

  it.each([
    { name: 'round deadline', jobMs: 30_000, failedAttempts: 1 },
    { name: 'shorter private job window', jobMs: 5_000, failedAttempts: 1 },
    { name: 'round deadline with two stalled sends', jobMs: 30_000, failedAttempts: 2 },
  ])('reserves fresh attempts within the $name after full transport timeouts', async ({ jobMs, failedAttempts }) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
    vi.setSystemTime(10_000);
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const startedAt = Date.now();
    const deadline = startedAt + 10_000;
    const window = createPrivateSwmRecoveryWindow(jobMs);
    const attempts: Array<{ startedAt: number; timeoutMs: number }> = [];
    const result = request({
      deadline,
      syncPageTimeoutMs: 30_000,
      workAdmission: window.admitRound(deadline, { sharing: 'exclusive', owner: 'retry-slice' }),
      send: async (_peer, _protocol, _bytes, timeoutMs) => {
        attempts.push({ startedAt: Date.now(), timeoutMs });
        if (attempts.length <= failedAttempts) {
          await new Promise(resolve => setTimeout(resolve, timeoutMs));
          throw new Error('request timeout');
        }
        await new Promise(resolve => setTimeout(resolve, Math.floor(timeoutMs / 2)));
        return new Uint8Array();
      },
    }).then(value => ({ value }), error => ({ error }));

    await vi.runAllTimersAsync();

    expect(await result).toMatchObject({ value: { completed: true, timedOut: false } });
    expect(attempts).toHaveLength(failedAttempts + 1);
    expect(attempts[0].timeoutMs).toBeLessThan(10_000);
    for (const attempt of attempts) {
      expect(attempt.timeoutMs).toBeGreaterThan(0);
      expect(attempt.startedAt + attempt.timeoutMs).toBeLessThanOrEqual(deadline);
      expect(attempt.startedAt + attempt.timeoutMs).toBeLessThanOrEqual(startedAt + jobMs);
    }
    expect(Date.now()).toBeLessThan(deadline);
    expect(Date.now()).toBeLessThan(startedAt + jobMs);
  });

  it('caps every page using monotonic time after a wall-clock rollback during the fetch', async () => {
    let elapsed = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
    vi.spyOn(Date, 'now').mockImplementation(() => 10_000 - elapsed * 100);
    const workAdmission = roundAdmission(100);
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
    expect(result).toMatchObject({
      completed: false,
      timedOut: false,
      localYield: true as const,
    });
    expect(result.quads).toHaveLength(2);
  });

  it('admits no send after authentication consumes the allowance', async () => {
    let elapsed = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
    const workAdmission = roundAdmission(100);
    const send = vi.fn(async () => new Uint8Array());
    const result = await request({
      workAdmission, send,
      buildSyncRequest: async () => { elapsed = 100; return new Uint8Array([1]); },
    });
    expect(send).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      completed: false,
      timedOut: false,
      localYield: true as const,
    });
  });

  it('recomputes the timeout for each retry after the wall clock rolls back', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let elapsed = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
    vi.spyOn(Date, 'now').mockImplementation(() => 10_000 - elapsed * 100);
    const timeouts: number[] = [];
    const result = request({
      workAdmission: roundAdmission(100),
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
    let signalBackoffStarted: () => void = () => {};
    const backoffStarted = new Promise<void>((resolve) => {
      signalBackoffStarted = resolve;
    });
    vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
    const failure = new Error('request timeout');
    const send = vi.fn(async () => { throw failure; });
    const outcome = request({
      workAdmission: roundAdmission(100), send,
      logWarn: signalBackoffStarted,
    }).then(() => null, error => error);
    await backoffStarted;
    elapsed = 100;
    await vi.runAllTimersAsync();
    expect(await outcome).toBe(failure);
    expect(isSyncTransportFailure(await outcome)).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('classifies sub-millisecond round exhaustion after authentication without sending', async () => {
    let elapsed = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
    vi.spyOn(Date, 'now').mockImplementation(() => 10_000 + elapsed);
    const deadline = Date.now() + 10;
    const window = createPrivateSwmRecoveryWindow(30_000);
    const send = vi.fn(async () => new Uint8Array());
    const result = await request({
      deadline,
      workAdmission: window.admitRound(deadline, { sharing: 'exclusive', owner: 'fractional-round' }),
      buildSyncRequest: async () => { elapsed = 9.5; return new Uint8Array([1]); },
      send,
    });
    expect(send).not.toHaveBeenCalled();
    expect(result).toMatchObject({ completed: false, timedOut: true });
    expect(result.localYield).toBeUndefined();
  });

  it('floors a fractional allowance before passing it to the transport', async () => {
    let elapsed = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
    const workAdmission = roundAdmission(100);
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
    const workAdmission = roundAdmission(1);
    elapsed = 0.5;
    const send = vi.fn(async () => new Uint8Array());

    const result = await request({ workAdmission, send });

    expect(send).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      completed: false,
      localYield: true as const,
    });
  });
});
