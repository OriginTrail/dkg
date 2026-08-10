import { ethers } from 'ethers';
import { describe, expect, it, vi } from 'vitest';
import {
  callsForMethod,
  deferred,
  fixture,
  NAME_HASH,
  OTHER_HASH,
} from './context-graph-name-hash-reverse-resolution.fixtures.js';

describe('Context Graph name-hash cache and index invalidation', () => {
  it('single-flights concurrent callers and lets one caller stop waiting', async () => {
    const { adapter, readContractWithOptions } = fixture([NAME_HASH]);
    const pending = deferred<string>();
    readContractWithOptions.mockImplementation(async (
      _contract: unknown,
      _label: string,
      method: string,
    ) => method === 'getLatestContextGraphId' ? 1n : pending.promise);
    const controller = new AbortController();

    const aborted = adapter.resolveContextGraphIdByNameHash(NAME_HASH, {
      signal: controller.signal,
    });
    const survivor = adapter.resolveContextGraphIdByNameHash(NAME_HASH);
    controller.abort(new Error('caller stopped'));

    await expect(aborted).rejects.toThrow('caller stopped');
    pending.resolve(NAME_HASH);
    await expect(survivor).resolves.toBe(1n);
    expect(callsForMethod(readContractWithOptions, 'getLatestContextGraphId')).toHaveLength(2);
    expect(callsForMethod(readContractWithOptions, 'getNameHash')).toHaveLength(2);
  });

  it('reuses an unchanged high-water snapshot across different hashes', async () => {
    const { adapter, readContractWithOptions } = fixture([NAME_HASH, OTHER_HASH]);

    await expect(adapter.resolveContextGraphIdByNameHash(NAME_HASH)).resolves.toBe(1n);
    await expect(adapter.resolveContextGraphIdByNameHash(OTHER_HASH)).resolves.toBe(2n);

    expect(callsForMethod(readContractWithOptions, 'getLatestContextGraphId')).toHaveLength(4);
    expect(callsForMethod(readContractWithOptions, 'getNameHash')).toHaveLength(4);
  });

  it('fails closed when a same-count reorg replaces the uniquely indexed slot', async () => {
    const { adapter, hashes, readContractWithOptions } = fixture([NAME_HASH]);
    await expect(adapter.resolveContextGraphIdByNameHash(NAME_HASH)).resolves.toBe(1n);

    hashes.set(1n, OTHER_HASH);
    await expect(adapter.resolveContextGraphIdByNameHash(NAME_HASH)).rejects.toThrow(
      /indexed slot 1 currently commits.*expected/i,
    );

    // Initial scan + initial positive verification + O(1) revalidation. The
    // unchanged counter does not trigger a second full enumeration.
    expect(callsForMethod(readContractWithOptions, 'getNameHash')).toHaveLength(3);
  });

  it('rebuilds on a changed chain anchor and catches a same-count duplicate', async () => {
    const {
      adapter,
      hashes,
      readContractWithOptions,
      setAnchorHash,
    } = fixture([NAME_HASH, OTHER_HASH]);
    await expect(adapter.resolveContextGraphIdByNameHash(NAME_HASH)).resolves.toBe(1n);

    hashes.set(2n, NAME_HASH);
    setAnchorHash(`0x${'22'.repeat(32)}`);
    await expect(adapter.resolveContextGraphIdByNameHash(NAME_HASH)).rejects.toThrow(
      /ambiguous.*2 numeric ids/i,
    );

    // Initial full scan + exact candidate check, then one bounded full rebuild
    // after the retained canonical anchor changed.
    expect(callsForMethod(readContractWithOptions, 'getNameHash')).toHaveLength(5);
  });

  it('scans only appended slots after the high-water mark advances', async () => {
    const { adapter, hashes, readContractWithOptions, setLatestId } = fixture([NAME_HASH]);
    await expect(adapter.resolveContextGraphIdByNameHash(NAME_HASH)).resolves.toBe(1n);

    hashes.set(2n, OTHER_HASH);
    setLatestId(2n);
    await expect(adapter.resolveContextGraphIdByNameHash(OTHER_HASH)).resolves.toBe(2n);

    expect(callsForMethod(readContractWithOptions, 'getNameHash').map(
      (call) => BigInt(call[3][0]),
    )).toEqual([1n, 1n, 2n, 2n]);
  });

  it('indexes a later duplicate from the delta and fails closed', async () => {
    const { adapter, hashes, readContractWithOptions, setLatestId } = fixture([NAME_HASH]);
    await expect(adapter.resolveContextGraphIdByNameHash(NAME_HASH)).resolves.toBe(1n);

    hashes.set(2n, NAME_HASH);
    setLatestId(2n);
    await expect(adapter.resolveContextGraphIdByNameHash(NAME_HASH)).rejects.toThrow(
      /ambiguous.*2 numeric ids/i,
    );
    expect(callsForMethod(readContractWithOptions, 'getNameHash').map(
      (call) => BigInt(call[3][0]),
    )).toEqual([1n, 1n, 2n]);
  });

  it('rebuilds from slot one when the registry high-water mark decreases', async () => {
    const { adapter, hashes, readContractWithOptions, setLatestId } = fixture([
      NAME_HASH,
      OTHER_HASH,
    ]);
    await expect(adapter.resolveContextGraphIdByNameHash(OTHER_HASH)).resolves.toBe(2n);

    hashes.set(1n, OTHER_HASH);
    hashes.delete(2n);
    setLatestId(1n);
    await expect(adapter.resolveContextGraphIdByNameHash(OTHER_HASH)).resolves.toBe(1n);

    expect(callsForMethod(readContractWithOptions, 'getNameHash').map(
      (call) => BigInt(call[3][0]),
    )).toEqual([1n, 2n, 2n, 1n, 1n]);
  });

  it('rebuilds when the ContextGraphStorage address changes', async () => {
    const { adapter, hashes, readContractWithOptions, setStorageAddress } = fixture([NAME_HASH]);
    await expect(adapter.resolveContextGraphIdByNameHash(NAME_HASH)).resolves.toBe(1n);

    hashes.set(1n, OTHER_HASH);
    setStorageAddress('0x00000000000000000000000000000000000000d7');
    await expect(adapter.resolveContextGraphIdByNameHash(OTHER_HASH)).resolves.toBe(1n);

    expect(callsForMethod(readContractWithOptions, 'getNameHash')).toHaveLength(4);
  });

  it('rebuilds when the configured provider identity changes', async () => {
    const { adapter, hashes, readContractWithOptions } = fixture([NAME_HASH]);
    await expect(adapter.resolveContextGraphIdByNameHash(NAME_HASH)).resolves.toBe(1n);

    hashes.set(1n, OTHER_HASH);
    adapter.providers = [{}];
    adapter.rpcUrls = ['http://127.0.0.1:59997'];
    await expect(adapter.resolveContextGraphIdByNameHash(OTHER_HASH)).resolves.toBe(1n);

    expect(callsForMethod(readContractWithOptions, 'getNameHash')).toHaveLength(4);
  });

  it('serializes first refreshes for different hashes onto one slot scan', async () => {
    const { adapter, readContractWithOptions } = fixture([NAME_HASH, OTHER_HASH]);
    const release = deferred<void>();
    readContractWithOptions.mockImplementation(async (
      _contract: unknown,
      _label: string,
      method: string,
      args: readonly unknown[],
    ) => {
      if (method === 'getLatestContextGraphId') return 2n;
      await release.promise;
      return BigInt(args[0] as bigint) === 1n ? NAME_HASH : OTHER_HASH;
    });

    const first = adapter.resolveContextGraphIdByNameHash(NAME_HASH);
    const second = adapter.resolveContextGraphIdByNameHash(OTHER_HASH);
    await vi.waitFor(() => {
      expect(callsForMethod(readContractWithOptions, 'getNameHash')).toHaveLength(2);
    });
    expect(callsForMethod(readContractWithOptions, 'getLatestContextGraphId')).toHaveLength(1);
    release.resolve(undefined);

    await expect(first).resolves.toBe(1n);
    await expect(second).resolves.toBe(2n);
    expect(callsForMethod(readContractWithOptions, 'getLatestContextGraphId')).toHaveLength(4);
    expect(callsForMethod(readContractWithOptions, 'getNameHash')).toHaveLength(4);
  });

  it('leaves the prior high-water intact after a failed delta refresh', async () => {
    const { adapter, hashes, readContractWithOptions, setLatestId } = fixture([NAME_HASH]);
    await expect(adapter.resolveContextGraphIdByNameHash(NAME_HASH)).resolves.toBe(1n);
    hashes.set(2n, OTHER_HASH);
    setLatestId(2n);
    let failDelta = true;
    readContractWithOptions.mockImplementation(async (
      _contract: unknown,
      _label: string,
      method: string,
      args: readonly unknown[],
    ) => {
      if (method === 'getLatestContextGraphId') return 2n;
      const id = BigInt(args[0] as bigint);
      if (id === 2n && failDelta) {
        throw Object.assign(new Error('delta RPC timed out'), { code: 'RPC_TIMEOUT' });
      }
      return hashes.get(id) ?? ethers.ZeroHash;
    });

    await expect(adapter.resolveContextGraphIdByNameHash(OTHER_HASH)).rejects.toThrow(
      /insufficient covering RPC quorum.*0 of 1 backends responded, need 1/i,
    );
    failDelta = false;
    await expect(adapter.resolveContextGraphIdByNameHash(OTHER_HASH)).resolves.toBe(2n);

    expect(callsForMethod(readContractWithOptions, 'getNameHash').map(
      (call) => BigInt(call[3][0]),
    )).toEqual([1n, 1n, 2n, 2n, 2n]);
  });

  it('lets an aborted caller leave a shared different-hash refresh usable', async () => {
    const { adapter, readContractWithOptions } = fixture([NAME_HASH, OTHER_HASH]);
    const release = deferred<void>();
    readContractWithOptions.mockImplementation(async (
      _contract: unknown,
      _label: string,
      method: string,
      args: readonly unknown[],
    ) => {
      if (method === 'getLatestContextGraphId') return 2n;
      await release.promise;
      return BigInt(args[0] as bigint) === 1n ? NAME_HASH : OTHER_HASH;
    });
    const controller = new AbortController();
    const abandoned = adapter.resolveContextGraphIdByNameHash(NAME_HASH, {
      signal: controller.signal,
    });
    await vi.waitFor(() => {
      expect(callsForMethod(readContractWithOptions, 'getNameHash')).toHaveLength(2);
    });
    controller.abort(new Error('caller stopped'));
    await expect(abandoned).rejects.toThrow('caller stopped');

    const survivor = adapter.resolveContextGraphIdByNameHash(OTHER_HASH);
    release.resolve(undefined);
    await expect(survivor).resolves.toBe(2n);
    expect(callsForMethod(readContractWithOptions, 'getNameHash')).toHaveLength(4);
  });

  it('discards a refresh invalidated while its slot reads are in flight', async () => {
    const { adapter, readContractWithOptions } = fixture([NAME_HASH]);
    const firstRead = deferred<string>();
    let blockFirst = true;
    readContractWithOptions.mockImplementation(async (
      _contract: unknown,
      _label: string,
      method: string,
    ) => {
      if (method === 'getLatestContextGraphId') return 1n;
      if (blockFirst) return firstRead.promise;
      return NAME_HASH;
    });

    const invalidated = adapter.resolveContextGraphIdByNameHash(NAME_HASH);
    await vi.waitFor(() => {
      expect(callsForMethod(readContractWithOptions, 'getNameHash')).toHaveLength(1);
    });
    adapter.invalidatePublishPreflightCache();
    blockFirst = false;
    firstRead.resolve(NAME_HASH);
    await expect(invalidated).rejects.toThrow(/binding changed during current-slot refresh/i);

    await expect(adapter.resolveContextGraphIdByNameHash(NAME_HASH)).resolves.toBe(1n);
    expect(callsForMethod(readContractWithOptions, 'getNameHash')).toHaveLength(3);
  });

  it('discards a same-count storage rotation after index resolve but before exact verification', async () => {
    const scenario = fixture([NAME_HASH, OTHER_HASH]);
    const loadHighWaters = vi.spyOn(scenario.fence, 'loadProviderHighWaters');
    let calls = 0;
    loadHighWaters.mockImplementation(async () => {
      calls += 1;
      if (calls === 2) {
        scenario.setStorageAddress('0x00000000000000000000000000000000000000d7');
        scenario.hashes.set(2n, NAME_HASH);
        scenario.adapter.invalidatePublishPreflightCache();
      }
      return {
        latestId: 2n,
        providerHighWaters: new Map([[scenario.adapter.providers[0], 2n]]),
        unavailableProviderCount: 0,
      };
    });

    await expect(scenario.adapter.resolveContextGraphIdByNameHash(NAME_HASH)).rejects.toThrow(
      /binding changed during current-slot resolution/i,
    );
  });

  it('clears a cached miss when a different-hash delta discovers new slots', async () => {
    const { adapter, hashes, readContractWithOptions, setLatestId } = fixture([null]);
    await expect(adapter.resolveContextGraphIdByNameHash(NAME_HASH)).resolves.toBeNull();
    await expect(adapter.resolveContextGraphIdByNameHash(NAME_HASH)).resolves.toBeNull();

    hashes.set(2n, NAME_HASH);
    setLatestId(2n);
    await expect(adapter.resolveContextGraphIdByNameHash(OTHER_HASH)).resolves.toBeNull();
    await expect(adapter.resolveContextGraphIdByNameHash(NAME_HASH)).resolves.toBe(2n);

    expect(callsForMethod(readContractWithOptions, 'getNameHash').map(
      (call) => BigInt(call[3][0]),
    )).toEqual([1n, 2n, 2n]);
  });

  it('short-caches a current-state miss and retries after the TTL', async () => {
    vi.useFakeTimers({ now: 0 });
    try {
      const { adapter, hashes, readContractWithOptions, setLatestId } = fixture([null]);
      await expect(adapter.resolveContextGraphIdByNameHash(NAME_HASH)).resolves.toBeNull();
      await expect(adapter.resolveContextGraphIdByNameHash(NAME_HASH)).resolves.toBeNull();
      expect(callsForMethod(readContractWithOptions, 'getNameHash')).toHaveLength(1);

      vi.setSystemTime(30_001);
      hashes.set(2n, NAME_HASH);
      setLatestId(2n);
      await expect(adapter.resolveContextGraphIdByNameHash(NAME_HASH)).resolves.toBe(2n);
      expect(callsForMethod(readContractWithOptions, 'getNameHash')).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('invalidates a cached miss immediately with the adapter-wide cache reset', async () => {
    const { adapter, hashes, readContractWithOptions } = fixture([null]);
    await expect(adapter.resolveContextGraphIdByNameHash(NAME_HASH)).resolves.toBeNull();
    await expect(adapter.resolveContextGraphIdByNameHash(NAME_HASH)).resolves.toBeNull();
    expect(callsForMethod(readContractWithOptions, 'getNameHash')).toHaveLength(1);

    hashes.set(1n, NAME_HASH);
    adapter.invalidatePublishPreflightCache();

    await expect(adapter.resolveContextGraphIdByNameHash(NAME_HASH)).resolves.toBe(1n);
    expect(callsForMethod(readContractWithOptions, 'getNameHash')).toHaveLength(3);
  });

  it('rejects malformed inputs before chain initialisation and treats zero as opt-out', async () => {
    const { adapter } = fixture();
    await expect(adapter.resolveContextGraphIdByNameHash('not-a-hash')).rejects.toThrow(
      /bytes32 nameHash/,
    );
    await expect(adapter.resolveContextGraphIdByNameHash(ethers.ZeroHash)).resolves.toBeNull();
    expect(adapter.init).not.toHaveBeenCalled();
  });
});
