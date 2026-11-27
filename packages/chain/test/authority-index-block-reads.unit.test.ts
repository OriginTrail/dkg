// SPDX-License-Identifier: Apache-2.0
import type { Block, JsonRpcProvider } from 'ethers';
import { describe, expect, it, vi } from 'vitest';
import { createAuthorityIndexBlockReadV1 } from '../src/authority-index-block-reads.js';
import { activeRpcRequestContext, withRpcRequestContext } from '../src/rpc-request-transport.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const block = (hash: string) => ({ number: 100, hash }) as Block;
function fixture() {
  let lifecycle = new AbortController();
  const active = new Set<Promise<unknown>>();
  const read = createAuthorityIndexBlockReadV1({
    lifecycleSignal: () => lifecycle.signal,
    track: <T>(load: () => Promise<T>) => {
      const pending = load(); active.add(pending);
      void pending.finally(() => active.delete(pending)).catch(() => undefined);
      return pending;
    },
  });
  return { read, active, close: () => lifecycle.abort(new Error('closed')),
    reopen: () => { lifecycle = new AbortController(); } };
}

describe('authority block reads without retained values', () => {
  it('shares same-turn reads but observes a changed hash on the next read', async () => {
    const f = fixture(), getBlock = vi.fn(async () => block('first'));
    const provider = { getBlock } as unknown as JsonRpcProvider;
    const results = await Promise.all(Array.from({ length: 4 }, () => f.read(provider, 100, 'anchor')));
    expect(getBlock).toHaveBeenCalledTimes(1);
    expect(results.every(value => value?.hash === 'first')).toBe(true);
    getBlock.mockResolvedValueOnce(block('reorg'));
    expect((await f.read(provider, 100, 'stabilize'))?.hash).toBe('reorg');
    expect(getBlock).toHaveBeenCalledTimes(2);
  });

  it('never gives a late caller a block request dispatched before it arrived', async () => {
    const f = fixture(), entered = deferred<void>(), release = deferred<Block>();
    const getBlock = vi.fn().mockImplementationOnce(() => { entered.resolve(); return release.promise; })
      .mockResolvedValue(block('new-head'));
    const provider = { getBlock } as unknown as JsonRpcProvider;
    const first = f.read(provider, 'latest', 'before scan');
    await entered.promise;
    const later = f.read(provider, 'latest', 'after scan');
    expect(getBlock).toHaveBeenCalledTimes(1);
    release.resolve(block('old-head'));
    expect((await first)?.hash).toBe('old-head');
    expect((await later)?.hash).toBe('new-head');
    expect(getBlock).toHaveBeenCalledTimes(2);
  });

  it('keeps one cancelled caller from cancelling the other caller or its physical read', async () => {
    const f = fixture(), entered = deferred<void>(), release = deferred<Block>();
    const a = new AbortController(), b = new AbortController();
    let physical: AbortSignal | undefined;
    const getBlock = vi.fn(() => { physical = activeRpcRequestContext().signal; entered.resolve(); return release.promise; });
    const provider = { getBlock } as unknown as JsonRpcProvider;
    const first = withRpcRequestContext({ signal: a.signal }, () => f.read(provider, 100, 'anchor'));
    const rejected = expect(first).rejects.toThrow('caller left');
    const second = f.read(provider, 100, 'anchor', b.signal);
    await entered.promise; a.abort(new Error('caller left')); await rejected;
    expect(physical?.aborted).toBe(false);
    release.resolve(block('valid'));
    expect((await second)?.hash).toBe('valid');
    expect(getBlock).toHaveBeenCalledTimes(1);
  });

  it('separates providers, block numbers, request classes and authority priority', async () => {
    const f = fixture(), getA = vi.fn(async () => block('a')), getB = vi.fn(async () => block('b'));
    const a = { getBlock: getA } as unknown as JsonRpcProvider;
    const b = { getBlock: getB } as unknown as JsonRpcProvider;
    await Promise.all([
      f.read(a, 100, 'anchor'), f.read(a, 101, 'anchor'), f.read(b, 100, 'anchor'),
      withRpcRequestContext({ requestClass: 'background' }, () => f.read(a, 100, 'anchor')),
      withRpcRequestContext({ admissionPriority: 'authority' }, () => f.read(a, 100, 'anchor')),
    ]);
    expect(getA).toHaveBeenCalledTimes(4); expect(getB).toHaveBeenCalledTimes(1);
  });

  it('drains physical work after shutdown and gives a reopened reader a fresh generation', async () => {
    const f = fixture(), entered = deferred<void>(), release = deferred<Block>();
    let physical: AbortSignal | undefined;
    const getBlock = vi.fn().mockImplementationOnce(() => {
      physical = activeRpcRequestContext().signal; entered.resolve(); return release.promise;
    }).mockResolvedValue(block('reopened'));
    const provider = { getBlock } as unknown as JsonRpcProvider;
    const old = f.read(provider, 100, 'anchor');
    const rejected = expect(old).rejects.toThrow('closed');
    await entered.promise; f.close(); await rejected;
    expect(physical?.aborted).toBe(true); expect(f.active.size).toBe(1);
    f.reopen(); expect((await f.read(provider, 100, 'anchor'))?.hash).toBe('reopened');
    release.resolve(block('abandoned'));
    await Promise.allSettled(f.active); expect(f.active.size).toBe(0);
  });
});
