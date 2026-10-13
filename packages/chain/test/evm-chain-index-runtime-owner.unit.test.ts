// SPDX-License-Identifier: Apache-2.0

/**
 * The owner of the one-log runtime, and what it does when a start cannot
 * complete for now.
 *
 * A start whose reads were not admitted in time, timed out, or found its
 * endpoints throttled or unreachable has learned nothing about the chain. It
 * used to end there, and nothing started it again: the node ran without its
 * log until a restart. These pin the retry that replaced that, the three ways
 * it ends, and the failures that still end the start at once.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChainEventLogBinding } from '../src/chain-event-log-binding.js';
import {
  createRpcAdmissionTimeoutError,
  createRpcTimeoutError,
  RpcEndpointsExhaustedError,
} from '../src/chain-rpc-transport-error.js';
import {
  CHAIN_INDEX_START_RETRY_INITIAL_DELAY_MS,
  CHAIN_INDEX_START_RETRY_MAX_DELAY_MS,
  CHAIN_INDEX_START_STILL_DEFERRED_REPORT_MS,
  EvmChainIndexRuntimeOwner,
  type EvmChainIndexRuntimeOwnerOptions,
} from '../src/evm-chain-index-runtime-owner.js';
import type { EvmChainIndexRuntime } from '../src/evm-chain-index-runtime.js';
import { RpcRequestGovernorQueueFullError } from '../src/rpc-request-governor.js';
import {
  activeRpcRequestContext,
  withDetachedRpcRequestContext,
  withRpcRequestContext,
  type RpcRequestContext,
} from '../src/rpc-request-transport.js';
import { MemoryChainEventLogStore } from './helpers/chain-event-log.js';

type Build = Parameters<EvmChainIndexRuntimeOwner['start']>[0];

/** The error a deploy-block read raises when it is not admitted before its deadline. */
const refused = (): Error => createRpcAdmissionTimeoutError(
  'chainIndex deploy block eth_getCode at block 123 waited 4000ms for local RPC admission and was not sent',
);

function fakeRuntime(name: string) {
  return {
    binding: { scope: name } as unknown as ChainEventLogBinding,
    tick: {} as EvmChainIndexRuntime['tick'],
    start: vi.fn(),
    stop: vi.fn(async () => {}),
  };
}

function fixture(options: Omit<EvmChainIndexRuntimeOwnerOptions, 'report'> = {}) {
  const report = {
    disabled: vi.fn(),
    deferred: vi.fn(),
    stillDeferred: vi.fn(),
    started: vi.fn(),
  };
  const store = new MemoryChainEventLogStore();
  const owner = new EvmChainIndexRuntimeOwner(store, { report, ...options });
  return { owner, report, store };
}

/** A build that is refused `refusals` times and then returns `runtime`. */
function refusedThenBuilt(refusals: number, runtime: EvmChainIndexRuntime) {
  let calls = 0;
  const build = vi.fn<Build>(async () => {
    calls += 1;
    if (calls <= refusals) throw refused();
    return runtime;
  });
  return build;
}

/** A build whose every attempt is settled by the test. */
function manualBuild() {
  const attempts: Array<{
    resolve: (runtime: EvmChainIndexRuntime) => void;
    reject: (error: unknown) => void;
  }> = [];
  const build = vi.fn<Build>(() => new Promise<EvmChainIndexRuntime>((resolve, reject) => {
    attempts.push({ resolve, reject });
  }));
  return { build, attempts };
}

/** Let settled promises run without moving the clock. */
const settle = (): Promise<void> => vi.advanceTimersByTimeAsync(0).then(() => undefined);

describe('EvmChainIndexRuntimeOwner', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('starts a refused build again until the runtime attaches', async () => {
    const { owner, report, store } = fixture();
    const runtime = fakeRuntime('log');
    const build = refusedThenBuilt(1, runtime);

    owner.start(build);
    const starting = owner.starting;
    await settle();

    // Refused, not failed: the start is still the owner's, and one line says so.
    expect(build).toHaveBeenCalledTimes(1);
    expect(owner.binding).toBeUndefined();
    expect(owner.starting).toBe(starting);
    expect(report.deferred).toHaveBeenCalledTimes(1);
    expect(report.deferred.mock.calls[0]![0]).toMatchObject({
      code: 'RPC_REQUEST_GOVERNOR_QUEUE_FULL',
    });
    expect(report.deferred.mock.calls[0]![1]).toBe(CHAIN_INDEX_START_RETRY_INITIAL_DELAY_MS);

    await vi.advanceTimersByTimeAsync(CHAIN_INDEX_START_RETRY_INITIAL_DELAY_MS - 1);
    expect(build).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await starting;

    expect(build).toHaveBeenCalledTimes(2);
    expect(build).toHaveBeenLastCalledWith(store);
    expect(owner.binding).toBe(runtime.binding);
    expect(owner.runtime).toBe(runtime);
    expect(runtime.start).toHaveBeenCalledTimes(1);
    expect(report.started).toHaveBeenCalledTimes(1);
    expect(report.started).toHaveBeenCalledWith(2, CHAIN_INDEX_START_RETRY_INITIAL_DELAY_MS);
    expect(report.disabled).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('doubles the wait up to the cap and reports the deferral once, not per attempt', async () => {
    const { owner, report } = fixture();
    const runtime = fakeRuntime('log');
    const refusals = 7;
    const build = refusedThenBuilt(refusals, runtime);

    owner.start(build);
    await settle();

    const waits = [5_000, 10_000, 20_000, 40_000, 60_000, 60_000, 60_000];
    expect(waits[0]).toBe(CHAIN_INDEX_START_RETRY_INITIAL_DELAY_MS);
    expect(Math.max(...waits)).toBe(CHAIN_INDEX_START_RETRY_MAX_DELAY_MS);
    for (const [index, wait] of waits.entries()) {
      await vi.advanceTimersByTimeAsync(wait - 1);
      expect(build).toHaveBeenCalledTimes(index + 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(build).toHaveBeenCalledTimes(index + 2);
    }
    await owner.starting;

    expect(owner.binding).toBe(runtime.binding);
    expect(report.deferred).toHaveBeenCalledTimes(1);
    expect(report.started).toHaveBeenCalledTimes(1);
    expect(report.started).toHaveBeenCalledWith(
      refusals + 1,
      waits.reduce((total, wait) => total + wait, 0),
    );
    expect(report.disabled).not.toHaveBeenCalled();
  });

  it.each([
    // The node's own capacity.
    ['a read that was not admitted to the local queue in time', refused()],
    ['a full local queue', new RpcRequestGovernorQueueFullError(256)],
    ['every endpoint exhausted', new RpcEndpointsExhaustedError('all endpoints throttled')],
    // An endpoint, at the moment of the start.
    ['a head probe that timed out at its endpoint', createRpcTimeoutError(
      'chainIndex deploy block backend head probe timed out after 4000ms',
    )],
    ['a throttled endpoint', Object.assign(new Error('server response 429'), {
      code: 'SERVER_ERROR',
      response: { statusCode: 429 },
    })],
    ['an endpoint that answers 503', Object.assign(new Error('server response 503'), {
      code: 'SERVER_ERROR',
      response: { statusCode: 503 },
    })],
    ['a connection that was reset', Object.assign(new Error('read ECONNRESET'), {
      code: 'ECONNRESET',
    })],
    ['a host that does not resolve', Object.assign(new Error('getaddrinfo ENOTFOUND rpc.invalid'), {
      code: 'ENOTFOUND',
    })],
  ])('retries on %s', async (_name, error) => {
    const { owner, report } = fixture();
    const runtime = fakeRuntime('log');
    const build = vi.fn<Build>()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce(runtime);

    owner.start(build);
    await settle();
    expect(report.deferred).toHaveBeenCalledWith(error, CHAIN_INDEX_START_RETRY_INITIAL_DELAY_MS);
    await vi.advanceTimersByTimeAsync(CHAIN_INDEX_START_RETRY_INITIAL_DELAY_MS);
    await owner.starting;

    expect(owner.binding).toBe(runtime.binding);
  });

  it('ends the start on any other failure, as it always has', async () => {
    const { owner, report } = fixture();
    const error = new Error('Hub address is unresolvable');
    const build = vi.fn<Build>().mockRejectedValueOnce(error);

    owner.start(build);
    await owner.starting;

    expect(report.disabled).toHaveBeenCalledTimes(1);
    expect(report.disabled).toHaveBeenCalledWith(error);
    expect(report.deferred).not.toHaveBeenCalled();
    expect(owner.binding).toBeUndefined();
    // The single-flight is released, and nothing is left to fire.
    expect(owner.starting).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10 * CHAIN_INDEX_START_RETRY_MAX_DELAY_MS);
    expect(build).toHaveBeenCalledTimes(1);

    // Which is what lets the next `initContracts` start it again.
    const runtime = fakeRuntime('log');
    owner.start(async () => runtime);
    await owner.starting;
    expect(owner.binding).toBe(runtime.binding);
    expect(report.started).not.toHaveBeenCalled();
  });

  it.each([
    ['a revert', Object.assign(new Error('execution reverted: ContractDoesNotExist'), {
      code: 'CALL_EXCEPTION',
    })],
    ['an invalid setting', new RangeError('chain.indexTickMs must be a positive integer')],
    // Raised when every endpoint answered the head probe and none of them with
    // a block number: nothing a later attempt against the same endpoints changes.
    ['no endpoint that can anchor the search', new Error(
      'chainIndex deploy block: no RPC backend returned a block number to anchor the log scan.',
    )],
  ])('ends the start on %s, which another attempt cannot change', async (_name, error) => {
    const { owner, report } = fixture();
    const build = vi.fn<Build>().mockRejectedValue(error);

    owner.start(build);
    await owner.starting;
    await vi.advanceTimersByTimeAsync(10 * CHAIN_INDEX_START_RETRY_MAX_DELAY_MS);

    expect(report.disabled).toHaveBeenCalledTimes(1);
    expect(report.disabled).toHaveBeenCalledWith(error);
    expect(report.deferred).not.toHaveBeenCalled();
    expect(build).toHaveBeenCalledTimes(1);
    expect(owner.starting).toBeUndefined();
  });

  it('stops retrying when a later attempt fails for another reason', async () => {
    const { owner, report } = fixture();
    const error = new Error('chain.indexTickMs must be a positive integer');
    const build = vi.fn<Build>()
      .mockRejectedValueOnce(refused())
      .mockRejectedValueOnce(error);

    owner.start(build);
    await settle();
    await vi.advanceTimersByTimeAsync(CHAIN_INDEX_START_RETRY_INITIAL_DELAY_MS);

    expect(report.deferred).toHaveBeenCalledTimes(1);
    expect(report.disabled).toHaveBeenCalledTimes(1);
    expect(report.disabled).toHaveBeenCalledWith(error);
    expect(report.started).not.toHaveBeenCalled();
    expect(owner.starting).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ends the start when the runtime it built cannot be started', async () => {
    const { owner, report } = fixture();
    const runtime = fakeRuntime('log');
    const error = new Error('tick interval refused');
    runtime.start.mockImplementation(() => { throw error; });

    owner.start(async () => runtime);
    await owner.starting;

    expect(report.disabled).toHaveBeenCalledWith(error);
    expect(owner.starting).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps the start single-flight while it is deferred', async () => {
    const { owner } = fixture();
    const runtime = fakeRuntime('log');
    const build = refusedThenBuilt(1, runtime);
    const other = vi.fn<Build>(async () => fakeRuntime('other'));

    owner.start(build);
    const starting = owner.starting;
    await settle();
    // `initContracts` running again, for a rotation the log does not index.
    owner.start(other);
    expect(owner.starting).toBe(starting);

    await vi.advanceTimersByTimeAsync(CHAIN_INDEX_START_RETRY_INITIAL_DELAY_MS);
    await starting;
    owner.start(other);

    expect(other).not.toHaveBeenCalled();
    expect(owner.binding).toBe(runtime.binding);
  });

  it('makes no further attempt after stop() while it waits', async () => {
    const { owner, report } = fixture();
    const build = refusedThenBuilt(1, fakeRuntime('log'));

    owner.start(build);
    const starting = owner.starting;
    await settle();
    expect(vi.getTimerCount()).toBe(1);

    owner.stop();
    // The wait ends with the owner, not at its deadline.
    expect(vi.getTimerCount()).toBe(0);
    await starting;
    await vi.advanceTimersByTimeAsync(10 * CHAIN_INDEX_START_RETRY_MAX_DELAY_MS);

    expect(build).toHaveBeenCalledTimes(1);
    expect(owner.binding).toBeUndefined();
    expect(owner.starting).toBeUndefined();
    expect(report.started).not.toHaveBeenCalled();
    expect(report.disabled).not.toHaveBeenCalled();
  });

  it('does not keep the process alive for an attempt that is still to come', async () => {
    vi.useRealTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const { owner, report } = fixture({ retryInitialDelayMs: 3_600_000 });

    owner.start(async () => { throw refused(); });
    const starting = owner.starting;
    await vi.waitFor(() => { expect(report.deferred).toHaveBeenCalledTimes(1); });

    const scheduled = setTimeoutSpy.mock.calls.findIndex(([, delayMs]) => delayMs === 3_600_000);
    expect(scheduled).toBeGreaterThanOrEqual(0);
    const timer = setTimeoutSpy.mock.results[scheduled]!.value as NodeJS.Timeout;
    // A one-shot command that built an adapter must be able to exit.
    expect(timer.hasRef()).toBe(false);

    owner.stop();
    await starting;
  });

  it('stops the runtime of a retry that completes after stop()', async () => {
    const { owner, report } = fixture();
    const { build, attempts } = manualBuild();
    const runtime = fakeRuntime('late');

    owner.start(build);
    const starting = owner.starting;
    attempts[0]!.reject(refused());
    await settle();
    await vi.advanceTimersByTimeAsync(CHAIN_INDEX_START_RETRY_INITIAL_DELAY_MS);
    expect(attempts).toHaveLength(2);

    owner.stop();
    attempts[1]!.resolve(runtime);
    await starting;

    expect(runtime.stop).toHaveBeenCalledTimes(1);
    expect(runtime.start).not.toHaveBeenCalled();
    expect(owner.binding).toBeUndefined();
    expect(owner.runtime).toBeUndefined();
    expect(report.started).not.toHaveBeenCalled();
  });

  it('lets a rotation retire a deferred start, and builds the next one from the new builder', async () => {
    const { owner, report } = fixture();
    const retired = refusedThenBuilt(1, fakeRuntime('retired'));
    const rotated = fakeRuntime('rotated');

    owner.start(retired);
    const retiredStart = owner.starting;
    await settle();
    expect(report.deferred).toHaveBeenCalledTimes(1);

    owner.rebuild();
    expect(owner.starting).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    owner.start(async () => rotated);
    await owner.starting;
    await retiredStart;
    await vi.advanceTimersByTimeAsync(10 * CHAIN_INDEX_START_RETRY_MAX_DELAY_MS);

    // The retired builder closed over the retired addresses; it never runs again.
    expect(retired).toHaveBeenCalledTimes(1);
    expect(owner.binding).toBe(rotated.binding);
    expect(owner.runtime).toBe(rotated);
    // The new start was never deferred, so it has nothing to report.
    expect(report.started).not.toHaveBeenCalled();
    expect(report.disabled).not.toHaveBeenCalled();
  });

  it('does not let a retired retry attach, schedule or report', async () => {
    const { owner, report } = fixture();
    const retired = manualBuild();
    const current = manualBuild();
    const rotated = fakeRuntime('rotated');

    owner.start(retired.build);
    const retiredStart = owner.starting;
    retired.attempts[0]!.reject(refused());
    await settle();
    await vi.advanceTimersByTimeAsync(CHAIN_INDEX_START_RETRY_INITIAL_DELAY_MS);
    expect(retired.attempts).toHaveLength(2);

    // The rotation lands while the second attempt is in flight.
    owner.rebuild();
    owner.start(current.build);
    const currentStart = owner.starting;

    // Refused again, but its generation is gone: nothing is scheduled for it.
    retired.attempts[1]!.reject(refused());
    await retiredStart;
    expect(vi.getTimerCount()).toBe(0);
    expect(owner.starting).toBe(currentStart);

    current.attempts[0]!.resolve(rotated);
    await currentStart;
    await vi.advanceTimersByTimeAsync(10 * CHAIN_INDEX_START_RETRY_MAX_DELAY_MS);

    expect(retired.build).toHaveBeenCalledTimes(2);
    expect(owner.binding).toBe(rotated.binding);
    expect(report.deferred).toHaveBeenCalledTimes(1);
    expect(report.started).not.toHaveBeenCalled();
    expect(report.disabled).not.toHaveBeenCalled();
  });

  it('stops a retired retry that still builds, without touching the current runtime', async () => {
    const { owner } = fixture();
    const retired = manualBuild();
    const rotated = fakeRuntime('rotated');
    const late = fakeRuntime('late');

    owner.start(retired.build);
    const retiredStart = owner.starting;
    retired.attempts[0]!.reject(refused());
    await settle();
    await vi.advanceTimersByTimeAsync(CHAIN_INDEX_START_RETRY_INITIAL_DELAY_MS);

    owner.rebuild();
    owner.start(async () => rotated);
    await owner.starting;
    retired.attempts[1]!.resolve(late);
    await retiredStart;

    expect(late.stop).toHaveBeenCalledTimes(1);
    expect(late.start).not.toHaveBeenCalled();
    expect(owner.binding).toBe(rotated.binding);
    expect(owner.runtime).toBe(rotated);
    expect(rotated.stop).not.toHaveBeenCalled();
  });

  it('still reports a retired build that fails for another reason, and leaves the current start alone', async () => {
    const { owner, report } = fixture();
    const retired = manualBuild();
    const current = manualBuild();
    const error = new Error('Hub address is unresolvable');

    owner.start(retired.build);
    const retiredStart = owner.starting;
    owner.rebuild();
    owner.start(current.build);
    const currentStart = owner.starting;

    retired.attempts[0]!.reject(error);
    await retiredStart;

    expect(report.disabled).toHaveBeenCalledWith(error);
    expect(owner.starting).toBe(currentStart);
  });

  it('runs every attempt in the request context the start was made in', async () => {
    const { owner } = fixture();
    const runtime = fakeRuntime('log');
    const contexts: RpcRequestContext[] = [];
    let calls = 0;
    const build: Build = async () => {
      contexts.push(activeRpcRequestContext());
      calls += 1;
      if (calls <= 2) throw refused();
      return runtime;
    };

    // What `initContracts` does: the start keeps the class of the caller that
    // initialized the adapter and nothing else of it.
    withDetachedRpcRequestContext('background', () => { owner.start(build); });
    await settle();
    // The retries are driven from a foreign context, as a timer would be.
    await withRpcRequestContext(
      { requestClass: 'foreground', admissionPriority: 'authority' },
      async () => {
        await vi.advanceTimersByTimeAsync(CHAIN_INDEX_START_RETRY_INITIAL_DELAY_MS);
        await vi.advanceTimersByTimeAsync(2 * CHAIN_INDEX_START_RETRY_INITIAL_DELAY_MS);
      },
    );
    await owner.starting;

    expect(contexts).toEqual([
      { requestClass: 'background' },
      { requestClass: 'background' },
      { requestClass: 'background' },
    ]);
    expect(owner.binding).toBe(runtime.binding);
  });

  it('says again that the start is deferred once per long interval, with the latest failure', async () => {
    const { owner, report } = fixture();
    const failures: Error[] = [];
    const runtime = fakeRuntime('log');
    let attaches = false;
    const build = vi.fn<Build>(async () => {
      if (attaches) return runtime;
      failures.push(createRpcTimeoutError(`head probe timed out, attempt ${failures.length + 1}`));
      throw failures.at(-1);
    });

    owner.start(build);
    await settle();
    // Attempts fail at 0, 5, 15, 35 and 75 s, then every 60 s. The first one
    // half an hour or more after the deferral is the 34th, at 1,815 s.
    expect(CHAIN_INDEX_START_STILL_DEFERRED_REPORT_MS).toBe(30 * 60_000);
    await vi.advanceTimersByTimeAsync(1_814_999);
    expect(build).toHaveBeenCalledTimes(33);
    expect(report.stillDeferred).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(report.stillDeferred).toHaveBeenCalledTimes(1);
    expect(report.stillDeferred).toHaveBeenLastCalledWith(failures[33], 34, 1_815_000);

    // The next one is due half an hour after that line, not after the deferral.
    await vi.advanceTimersByTimeAsync(1_799_999);
    expect(report.stillDeferred).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(report.stillDeferred).toHaveBeenCalledTimes(2);
    expect(report.stillDeferred).toHaveBeenLastCalledWith(failures[63], 64, 3_615_000);

    attaches = true;
    await vi.advanceTimersByTimeAsync(CHAIN_INDEX_START_RETRY_MAX_DELAY_MS);
    await owner.starting;

    expect(report.deferred).toHaveBeenCalledTimes(1);
    expect(report.deferred).toHaveBeenCalledWith(failures[0], CHAIN_INDEX_START_RETRY_INITIAL_DELAY_MS);
    expect(report.started).toHaveBeenCalledWith(65, 3_675_000);
    expect(report.disabled).not.toHaveBeenCalled();
  });

  it('honours the interval it is given for saying so again', async () => {
    const { owner, report } = fixture({
      retryInitialDelayMs: 100,
      retryMaxDelayMs: 100,
      stillDeferredReportMs: 300,
    });

    // Attempts fail at 0, 100, 200, ... ms: the interval is met exactly.
    owner.start(async () => { throw refused(); });
    await settle();
    await vi.advanceTimersByTimeAsync(299);
    expect(report.stillDeferred).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(report.stillDeferred).toHaveBeenCalledTimes(1);
    expect(report.stillDeferred.mock.calls[0]!.slice(1)).toEqual([4, 300]);
    await vi.advanceTimersByTimeAsync(300);
    expect(report.stillDeferred).toHaveBeenCalledTimes(2);
    expect(report.stillDeferred.mock.calls[1]!.slice(1)).toEqual([7, 600]);

    owner.stop();
  });

  it('honours the retry bounds it is given', async () => {
    const { owner, report } = fixture({ retryInitialDelayMs: 100, retryMaxDelayMs: 150 });
    const runtime = fakeRuntime('log');
    const build = refusedThenBuilt(3, runtime);

    owner.start(build);
    await settle();
    expect(report.deferred.mock.calls[0]![1]).toBe(100);
    await vi.advanceTimersByTimeAsync(100);
    expect(build).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(150);
    expect(build).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(150);
    await owner.starting;

    expect(report.started).toHaveBeenCalledWith(4, 400);
  });

  it('asks its caller what is worth retrying when told to', async () => {
    const { owner, report } = fixture({ isRetryable: () => false });

    owner.start(async () => { throw refused(); });
    await owner.starting;

    expect(report.deferred).not.toHaveBeenCalled();
    expect(report.disabled).toHaveBeenCalledTimes(1);
  });

  it('does nothing at all without a store', async () => {
    const report = {
      disabled: vi.fn(),
      deferred: vi.fn(),
      stillDeferred: vi.fn(),
      started: vi.fn(),
    };
    const owner = new EvmChainIndexRuntimeOwner(undefined, { report });
    const build = vi.fn<Build>(async () => fakeRuntime('log'));

    owner.start(build);
    owner.rebuild();
    owner.stop();

    expect(build).not.toHaveBeenCalled();
    expect(owner.starting).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  describe('what it prints by default', () => {
    it('says once that the start is deferred, and once that the log came up', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      const owner = new EvmChainIndexRuntimeOwner(new MemoryChainEventLogStore());
      const error = new Error(
        'chainIndex deploy block eth_getCode failed at https://user:secret@rpc.example/v2/key',
      );
      Object.assign(error, { code: 'RPC_ENDPOINTS_EXHAUSTED' });
      const build = vi.fn<Build>()
        .mockRejectedValueOnce(error)
        .mockRejectedValueOnce(refused())
        .mockResolvedValueOnce(fakeRuntime('log'));

      owner.start(build);
      await settle();
      await vi.advanceTimersByTimeAsync(5_000);
      await vi.advanceTimersByTimeAsync(10_000);
      await owner.starting;

      // One line for the deferral, none for the second refusal.
      expect(warn.mock.calls).toEqual([[
        '[chain] one-log chain index start deferred (retrying, next attempt in 5s): '
          + 'chainIndex deploy block eth_getCode failed at rpc.example',
      ]]);
      expect(log.mock.calls).toEqual([[
        '[chain] one-log chain index started on attempt 3, 15s after its start was deferred',
      ]]);
    });

    it('says once per long interval that the start is still deferred', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const owner = new EvmChainIndexRuntimeOwner(new MemoryChainEventLogStore());
      const throttled = Object.assign(
        new Error('server response 429 (requestUrl="https://rpc.example/v2/key")'),
        { code: 'SERVER_ERROR', response: { statusCode: 429 } },
      );

      owner.start(async () => { throw throttled; });
      await settle();
      await vi.advanceTimersByTimeAsync(CHAIN_INDEX_START_STILL_DEFERRED_REPORT_MS + 15_000);

      expect(warn.mock.calls).toEqual([
        ['[chain] one-log chain index start deferred (retrying, next attempt in 5s): '
          + 'server response 429 (requestUrl="rpc.example")'],
        ['[chain] one-log chain index start still deferred after 34 attempts in 30 min (retrying): '
          + 'server response 429 (requestUrl="rpc.example")'],
      ]);
      owner.stop();
    });

    it('keeps the line a failed start has always printed', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const owner = new EvmChainIndexRuntimeOwner(new MemoryChainEventLogStore());

      owner.start(async () => { throw new Error('Hub address is unresolvable'); });
      await owner.starting;
      owner.start(async () => { throw 'not an error object'; });
      await owner.starting;

      expect(warn.mock.calls).toEqual([
        ['[chain] one-log chain index disabled: Hub address is unresolvable'],
        ['[chain] one-log chain index disabled: not an error object'],
      ]);
    });
  });
});
