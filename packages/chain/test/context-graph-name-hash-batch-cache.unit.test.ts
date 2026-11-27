// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from 'vitest';
import { EvmContextGraphNameHashResolver } from '../src/evm-context-graph-name-hash-resolver.js';
import { ContextGraphNameHashResolver } from '../src/context-graph-name-hash-resolver.js';
import { SingleFlightInvalidatedError } from '../src/keyed-ttl-single-flight-cache.js';
import type { EvmContextGraphNameHashSource } from '../src/evm-context-graph-name-hash-fence.js';
import { activeRpcRequestContext, withRpcRequestContext } from '../src/rpc-request-transport.js';
import { deferred, NAME_HASH, OTHER_HASH } from './context-graph-name-hash-reverse-resolution.fixtures.js';

const requestClasses = ['foreground', 'background'] as const;

function cacheFixture() {
  const source = {
    currentSlotRevision: 0,
    resolve: vi.fn(async (_name: string): Promise<bigint | null> => null),
    resolveMany: vi.fn(async (names: readonly string[]): Promise<ReadonlyMap<string, bigint | null>> =>
      new Map(names.map((name) => [name, 66n]))),
    invalidate: vi.fn(),
  } satisfies EvmContextGraphNameHashSource;
  const resolver = new EvmContextGraphNameHashResolver({ source });
  const scalar = (name: string, requestClass: typeof requestClasses[number]) => withRpcRequestContext(
    { requestClass }, () => resolver.resolve(name),
  );
  return { source, resolver, scalar };
}

describe('bulk evidence invalidates conflicting scalar name-hash evidence', () => {
  it('rejects a completed but undelivered miss after named evidence supersedes it', async () => {
    const fresh = deferred<bigint | null>();
    const load = vi.fn<(_name: string, signal: AbortSignal) => Promise<bigint | null>>()
      .mockResolvedValueOnce(null)
      .mockImplementation(() => fresh.promise);
    let replacement: Promise<bigint | null> | undefined;
    let scheduled = false;
    const resolver = new ContextGraphNameHashResolver({
      load,
      generation: () => {
        if (!scheduled) {
          scheduled = true;
          // The physical load has finished, but its single-flight result has
          // not been delivered. Invalidate and begin newer work in that gap.
          queueMicrotask(() => {
            resolver.invalidateNames([NAME_HASH]);
            replacement = resolver.resolve(NAME_HASH);
          });
        }
        return 0;
      },
    });
    const [oldResult] = await Promise.allSettled([resolver.resolve(NAME_HASH)]);
    fresh.resolve(66n);
    expect(replacement).toBeDefined();
    await expect(replacement!).resolves.toBe(66n);
    expect(oldResult.status).toBe('rejected');
    if (oldResult.status === 'rejected') {
      expect(oldResult.reason).toBeInstanceOf(SingleFlightInvalidatedError);
    }
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('retries a completed but undelivered miss after the source generation rotates', async () => {
    const fresh = deferred<bigint | null>();
    const load = vi.fn<(_name: string, signal: AbortSignal) => Promise<bigint | null>>()
      .mockResolvedValueOnce(null)
      .mockImplementation(() => fresh.promise);
    let replacement: Promise<bigint | null> | undefined;
    let scheduled = false;
    const resolver = new ContextGraphNameHashResolver({
      load,
      generation: () => {
        if (!scheduled) {
          scheduled = true;
          queueMicrotask(() => {
            resolver.invalidateAll();
            replacement = resolver.resolve(NAME_HASH);
          });
        }
        return 0;
      },
    });

    const oldResult = resolver.resolve(NAME_HASH);
    await vi.waitFor(() => expect(replacement).toBeDefined());
    fresh.resolve(66n);

    await expect(oldResult).resolves.toBe(66n);
    await expect(replacement!).resolves.toBe(66n);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('invalidates normalized names in both partitions, retaining unrelated misses and no positive cache', async () => {
    const { source, resolver, scalar } = cacheFixture();
    for (const requestClass of requestClasses) {
      await expect(scalar(NAME_HASH, requestClass)).resolves.toBeNull();
      await expect(scalar(OTHER_HASH, requestClass)).resolves.toBeNull();
    }
    expect(source.resolve).toHaveBeenCalledTimes(4);
    source.resolve.mockImplementation(async (name) => name === NAME_HASH ? 66n : null);
    expect((await resolver.resolveMany([`0x${'AB'.repeat(32)}`])).get(NAME_HASH)).toBe(66n);
    for (const requestClass of requestClasses) {
      await expect(scalar(OTHER_HASH, requestClass)).resolves.toBeNull();
    }
    expect(source.resolve).toHaveBeenCalledTimes(4);
    for (const requestClass of requestClasses) {
      await expect(scalar(NAME_HASH, requestClass)).resolves.toBe(66n);
    }
    await expect(scalar(NAME_HASH, 'foreground')).resolves.toBe(66n);
    expect(source.resolve).toHaveBeenCalledTimes(7);
    expect(source.invalidate).not.toHaveBeenCalled();
  });

  it('rejects late scalar misses even when both physical loaders ignore cancellation', async () => {
    const { source, resolver, scalar } = cacheFixture();
    const stale = deferred<bigint | null>();
    const unrelated = deferred<bigint | null>();
    const staleSignals: AbortSignal[] = [];
    let unrelatedSignal: AbortSignal | undefined;
    source.resolve.mockImplementation(async (name) => {
      const signal = activeRpcRequestContext().signal!;
      if (name === OTHER_HASH) {
        unrelatedSignal = signal;
        return unrelated.promise;
      }
      staleSignals.push(signal);
      return stale.promise;
    });
    const staleResults = Promise.allSettled(requestClasses.map((requestClass) => scalar(NAME_HASH, requestClass)));
    const unrelatedResult = scalar(OTHER_HASH, 'foreground');
    await vi.waitFor(() => expect(source.resolve).toHaveBeenCalledTimes(3));
    expect((await resolver.resolveMany([NAME_HASH])).get(NAME_HASH)).toBe(66n);
    const abortedBeforeRelease = staleSignals.map((signal) => signal.aborted);
    const unrelatedAborted = unrelatedSignal?.aborted;
    stale.resolve(null);
    unrelated.resolve(null);
    const results = await staleResults;
    await expect(unrelatedResult).resolves.toBeNull();
    expect(abortedBeforeRelease).toEqual([true, true]);
    expect(unrelatedAborted).toBe(false);
    for (const result of results) {
      expect(result.status).toBe('rejected');
      if (result.status === 'rejected') {
        expect(result.reason).toBeInstanceOf(SingleFlightInvalidatedError);
      }
    }
    source.resolve.mockResolvedValue(66n);
    for (const requestClass of requestClasses) {
      await expect(scalar(NAME_HASH, requestClass)).resolves.toBe(66n);
    }
    await expect(scalar(OTHER_HASH, 'foreground')).resolves.toBeNull();
    expect(source.resolve).toHaveBeenCalledTimes(5);
  });

  it.each(['failed', 'cancelled'] as const)('preserves scalar caches when a bulk proof is %s', async (outcome) => {
    const { source, resolver, scalar } = cacheFixture();
    for (const requestClass of requestClasses) {
      await expect(scalar(NAME_HASH, requestClass)).resolves.toBeNull();
    }
    const controller = new AbortController();
    source.resolveMany.mockImplementation(async () => {
      if (outcome === 'failed') throw new Error('bulk proof failed');
      controller.abort(new Error('bulk caller stopped'));
      return new Map([[NAME_HASH, 66n]]);
    });
    await expect(resolver.resolveMany([NAME_HASH], controller.signal)).rejects.toThrow(
      outcome === 'failed' ? 'bulk proof failed' : 'bulk caller stopped',
    );
    for (const requestClass of requestClasses) {
      await expect(scalar(NAME_HASH, requestClass)).resolves.toBeNull();
    }
    expect(source.resolve).toHaveBeenCalledTimes(2);
  });
});
