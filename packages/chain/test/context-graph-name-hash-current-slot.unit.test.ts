import { ethers } from 'ethers';
import { describe, expect, it, vi } from 'vitest';
import {
  CONTEXT_GRAPH_NAME_HASH_ENUMERATION_CONCURRENCY,
} from '../src/evm-context-graph-name-hash-fence.js';
import { EVMChainAdapter } from '../src/evm-adapter.js';
import {
  callsForMethod,
  deferred,
  fixture,
  historicalFixture,
  minimalConfig,
  NAME_HASH,
  OTHER_HASH,
  resolverInternals,
} from './context-graph-name-hash-reverse-resolution.fixtures.js';

describe('current-slot Context Graph name-hash reverse resolution', () => {
  it('enumerates every current slot and returns the one exact match', async () => {
    const {
      adapter,
      fence,
      readContractWithOptions,
      resolveContractDeployBlock,
      queryEventLogsPage,
    } = fixture([
      null,
      OTHER_HASH,
      NAME_HASH,
      null,
      OTHER_HASH,
    ]);
    const slotReader = vi.spyOn(fence, 'readCurrentNameHash');

    await expect(adapter.resolveContextGraphIdByNameHash(NAME_HASH)).resolves.toBe(3n);

    expect(callsForMethod(readContractWithOptions, 'getLatestContextGraphId')).toHaveLength(2);
    const slotCalls = callsForMethod(readContractWithOptions, 'getNameHash');
    expect(slotCalls).toHaveLength(6);
    expect(slotCalls.map((call) => BigInt(call[3][0])).sort()).toEqual([
      1n, 2n, 3n, 3n, 4n, 5n,
    ]);
    expect(slotReader.mock.calls.filter((call) => call[1] instanceof AbortSignal)).toHaveLength(5);
    expect(slotReader.mock.calls.filter((call) => call[1] === undefined)).toHaveLength(1);
    expect(resolveContractDeployBlock).not.toHaveBeenCalled();
    expect(queryEventLogsPage).not.toHaveBeenCalled();
  });

  it('passes the exact high-water snapshot explicitly into every range read', async () => {
    const { adapter, fence } = fixture([null, NAME_HASH]);
    const enumerationHighWaters = new Map([[{} as any, 2n]]);
    const verificationHighWaters = new Map([[{} as any, 2n]]);
    vi.spyOn(fence, 'loadProviderHighWaters')
      .mockResolvedValueOnce({ latestId: 2n, providerHighWaters: enumerationHighWaters })
      .mockResolvedValueOnce({ latestId: 2n, providerHighWaters: verificationHighWaters });
    const slotReader = vi.spyOn(fence, 'readCurrentNameHash').mockImplementation(
      async (id) => id === 2n ? NAME_HASH : null,
    );

    await expect(adapter.resolveContextGraphIdByNameHash(NAME_HASH)).resolves.toBe(2n);

    const rangeReads = slotReader.mock.calls.filter(
      (call) => call[1] instanceof AbortSignal,
    );
    expect(rangeReads).toHaveLength(2);
    expect(rangeReads.every((call) => call[2] === enumerationHighWaters)).toBe(true);
    const exactRead = slotReader.mock.calls.find((call) => call[1] === undefined);
    expect(exactRead?.[2]).toBe(verificationHighWaters);
  });

  it('normalizes an uppercase bytes32 input before current-slot comparison', async () => {
    const { adapter, resolver } = fixture([NAME_HASH]);
    const upperCaseHash = `0x${'AB'.repeat(32)}`;
    const load = vi.spyOn(resolver, 'loadFromChain');

    await expect(adapter.resolveContextGraphIdByNameHash(upperCaseHash)).resolves.toBe(1n);
    expect(load).toHaveBeenCalledWith(NAME_HASH);
  });

  it('normalizes an uppercase bytes32 input before the historical exact-topic filter', async () => {
    const { adapter, filterFactory, getNameHash } = historicalFixture([[42n]]);
    const upperCaseHash = `0x${'AB'.repeat(32)}`;

    await expect(adapter.resolveContextGraphIdByNameHash(upperCaseHash)).resolves.toBe(42n);
    expect(filterFactory).toHaveBeenCalledWith(null, null, NAME_HASH);
    expect(getNameHash).toHaveBeenCalledWith(42n);
  });

  it('returns null only after every current slot misses', async () => {
    const { adapter, readContractWithOptions } = fixture([null, OTHER_HASH, null]);

    await expect(adapter.resolveContextGraphIdByNameHash(NAME_HASH)).resolves.toBeNull();
    expect(callsForMethod(readContractWithOptions, 'getNameHash')).toHaveLength(3);
  });

  it('does not negative-cache a current-slot miss when the registry advances', async () => {
    const { adapter, hashes, readContractWithOptions } = fixture([null, NAME_HASH]);
    let highWaterReads = 0;
    readContractWithOptions.mockImplementation(async (
      _contract: unknown,
      _label: string,
      method: string,
      args: readonly unknown[],
    ) => {
      if (method === 'getLatestContextGraphId') {
        highWaterReads += 1;
        return highWaterReads === 1 ? 1n : 2n;
      }
      return hashes.get(BigInt(args[0] as bigint)) ?? ethers.ZeroHash;
    });

    await expect(adapter.resolveContextGraphIdByNameHash(NAME_HASH)).rejects.toThrow(
      /registry advanced from 1 to 2 during current-slot resolution/i,
    );
    await expect(adapter.resolveContextGraphIdByNameHash(NAME_HASH)).resolves.toBe(2n);

    expect(callsForMethod(readContractWithOptions, 'getLatestContextGraphId')).toHaveLength(4);
    expect(callsForMethod(readContractWithOptions, 'getNameHash').map(
      (call) => BigInt(call[3][0]),
    )).toEqual([1n, 2n, 2n]);
  });

  it('does not let a lower-high-water RPC hide a slot from a current backend', async () => {
    const adapter: any = new EVMChainAdapter(minimalConfig());
    adapter.initialized = true;
    adapter.init = vi.fn(async () => {});
    const primary = { id: 'lagging' };
    const backup = { id: 'current' };
    const storage = { getAddress: vi.fn(async () => '0x00000000000000000000000000000000000000c6') };
    adapter.contracts = { contextGraphStorage: storage };
    adapter.rebindContract = vi.fn((_contract: unknown, provider: unknown) => ({
      getNameHash: vi.fn(async () => provider === primary ? ethers.ZeroHash : NAME_HASH),
    }));
    const { fence } = resolverInternals(adapter);

    await expect(fence.readCurrentNameHash(
      1n,
      undefined,
      new Map([[primary, 0n], [backup, 1n]]),
    )).resolves.toBe(NAME_HASH);
    expect(adapter.rebindContract).toHaveBeenCalledTimes(1);
  });

  it('fails closed when same-high-water RPCs disagree on a current slot', async () => {
    const adapter: any = new EVMChainAdapter(minimalConfig());
    adapter.initialized = true;
    adapter.init = vi.fn(async () => {});
    const primary = { id: 'fork-a' };
    const backup = { id: 'fork-b' };
    const storage = { getAddress: vi.fn(async () => '0x00000000000000000000000000000000000000c6') };
    adapter.contracts = { contextGraphStorage: storage };
    adapter.rebindContract = vi.fn((_contract: unknown, provider: unknown) => ({
      getNameHash: vi.fn(async () => provider === primary ? ethers.ZeroHash : NAME_HASH),
    }));
    const { fence } = resolverInternals(adapter);

    await expect(fence.readCurrentNameHash(
      1n,
      undefined,
      new Map([[primary, 1n], [backup, 1n]]),
    )).rejects.toThrow(
      /RPC backends disagree on current slot 1/i,
    );
  });

  it('fails closed when any covering RPC cannot read the current slot', async () => {
    const adapter: any = new EVMChainAdapter(minimalConfig());
    adapter.initialized = true;
    adapter.init = vi.fn(async () => {});
    const failing = { id: 'failing' };
    const responding = { id: 'responding' };
    const storage = { getAddress: vi.fn(async () => '0x00000000000000000000000000000000000000c6') };
    adapter.contracts = { contextGraphStorage: storage };
    adapter.rebindContract = vi.fn((_contract: unknown, provider: unknown) => ({
      getNameHash: vi.fn(async () => {
        if (provider === failing) throw new Error('slot read timed out');
        return ethers.ZeroHash;
      }),
    }));
    const { fence } = resolverInternals(adapter);

    await expect(fence.readCurrentNameHash(
      2n,
      undefined,
      new Map([[failing, 2n], [responding, 2n]]),
    )).rejects.toThrow(
      /1 of 2 covering RPC backends failed to read current slot 2/i,
    );
    expect(adapter.rebindContract).toHaveBeenCalledTimes(2);
  });

  it('aborts an in-flight provider slot read instead of waiting for its stall timeout', async () => {
    const adapter: any = new EVMChainAdapter(minimalConfig());
    adapter.initialized = true;
    adapter.init = vi.fn(async () => {});
    const provider = { id: 'hung' };
    const storage = { getAddress: vi.fn(async () => '0x00000000000000000000000000000000000000c6') };
    const started = deferred<void>();
    adapter.contracts = { contextGraphStorage: storage };
    adapter.rebindContract = vi.fn(() => ({
      getNameHash: vi.fn(() => {
        started.resolve(undefined);
        return new Promise<string>(() => {});
      }),
    }));
    const { fence } = resolverInternals(adapter);
    const controller = new AbortController();
    const read = fence.readCurrentNameHash(
      1n,
      controller.signal,
      new Map([[provider, 1n]]),
    );
    await started.promise;
    controller.abort(new Error('sibling slot failed'));

    await expect(read).rejects.toThrow('sibling slot failed');
  });

  it('fans out provider high-water and covering-slot reads concurrently', async () => {
    const adapter: any = new EVMChainAdapter(minimalConfig());
    adapter.initialized = true;
    adapter.init = vi.fn(async () => {});
    const first = { id: 'first' };
    const second = { id: 'second' };
    adapter.providers = [first, second];
    adapter.rpcUrls = ['http://first.invalid', 'http://second.invalid'];
    adapter.ensureConfiguredStaticChainIdValidated = vi.fn(async () => 31337n);
    adapter.contracts = {
      contextGraphStorage: {
        getAddress: vi.fn(async () => '0x00000000000000000000000000000000000000c6'),
      },
    };
    const highWaterRelease = deferred<void>();
    const slotRelease = deferred<void>();
    let activeHighWaters = 0;
    let activeSlots = 0;
    adapter.rebindContract = vi.fn(() => ({
      getLatestContextGraphId: async () => {
        activeHighWaters += 1;
        await highWaterRelease.promise;
        return 1n;
      },
      getNameHash: async () => {
        activeSlots += 1;
        await slotRelease.promise;
        return ethers.ZeroHash;
      },
    }));
    const { fence } = resolverInternals(adapter);

    const highWaters = fence.loadProviderHighWaters();
    await vi.waitFor(() => expect(activeHighWaters).toBe(2));
    highWaterRelease.resolve(undefined);
    const snapshot = await highWaters;

    const slot = fence.readCurrentNameHash(1n, undefined, snapshot.providerHighWaters);
    await vi.waitFor(() => expect(activeSlots).toBe(2));
    slotRelease.resolve(undefined);
    await expect(slot).resolves.toBeNull();
  });

  it('scans past the first match and fails closed on an ambiguous duplicate', async () => {
    const { adapter, readContractWithOptions } = fixture([
      NAME_HASH,
      OTHER_HASH,
      null,
      NAME_HASH,
    ]);

    await expect(adapter.resolveContextGraphIdByNameHash(NAME_HASH)).rejects.toThrow(
      /ambiguous.*2 numeric ids/i,
    );
    expect(callsForMethod(readContractWithOptions, 'getNameHash')).toHaveLength(4);
  });

  it('uses the maximum reachable high-water so a lagging primary cannot hide an appended duplicate', async () => {
    const adapter: any = new EVMChainAdapter(minimalConfig());
    adapter.initialized = true;
    adapter.init = vi.fn(async () => {});
    const lagging = { id: 'lagging' };
    const current = { id: 'current' };
    adapter.providers = [lagging, current];
    adapter.rpcUrls = ['http://lagging.invalid', 'http://current.invalid'];
    adapter.ensureConfiguredStaticChainIdValidated = vi.fn(async () => 31337n);
    adapter.contracts = {
      contextGraphStorage: {
        getAddress: vi.fn(async () => '0x00000000000000000000000000000000000000c6'),
      },
    };
    const getLatestContextGraphId = vi.fn(async (provider: unknown) =>
      provider === lagging ? 1n : 2n);
    const getNameHash = vi.fn(async (provider: unknown, id: bigint) => {
      if (id === 1n) return NAME_HASH;
      return provider === current && id === 2n ? NAME_HASH : ethers.ZeroHash;
    });
    adapter.rebindContract = vi.fn((_contract: unknown, provider: unknown) => ({
      getLatestContextGraphId: () => getLatestContextGraphId(provider),
      getNameHash: (id: bigint) => getNameHash(provider, id),
    }));
    const anchorHash = `0x${'11'.repeat(32)}`;
    const { fence } = resolverInternals(adapter);
    vi.spyOn(fence, 'captureAnchor').mockResolvedValue({
      blockNumber: 100,
      blockHash: anchorHash,
    });
    vi.spyOn(fence, 'loadAnchorHash').mockResolvedValue(anchorHash);

    await expect(adapter.resolveContextGraphIdByNameHash(NAME_HASH)).rejects.toThrow(
      /ambiguous.*2 numeric ids/i,
    );
    expect(getLatestContextGraphId).toHaveBeenCalledTimes(2);
    expect(getNameHash).toHaveBeenCalledWith(current, 2n);
    expect(adapter.ensureConfiguredStaticChainIdValidated).toHaveBeenCalledWith(lagging);
    expect(adapter.ensureConfiguredStaticChainIdValidated).toHaveBeenCalledWith(current);
  });

  it('never exceeds four concurrent getNameHash reads and still scans the full range', async () => {
    const { adapter, readContractWithOptions } = fixture(Array.from({ length: 13 }, () => null));
    const release = deferred<void>();
    let active = 0;
    let maxActive = 0;
    readContractWithOptions.mockImplementation(async (
      _contract: unknown,
      _label: string,
      method: string,
      _args: readonly unknown[],
      _options: { signal?: AbortSignal },
    ) => {
      if (method === 'getLatestContextGraphId') return 13n;
      active += 1;
      maxActive = Math.max(maxActive, active);
      await release.promise;
      active -= 1;
      return ethers.ZeroHash;
    });

    const resolution = adapter.resolveContextGraphIdByNameHash(NAME_HASH);
    await vi.waitFor(() => {
      expect(active).toBe(CONTEXT_GRAPH_NAME_HASH_ENUMERATION_CONCURRENCY);
    });
    expect(maxActive).toBe(CONTEXT_GRAPH_NAME_HASH_ENUMERATION_CONCURRENCY);
    release.resolve(undefined);

    await expect(resolution).resolves.toBeNull();
    expect(maxActive).toBe(CONTEXT_GRAPH_NAME_HASH_ENUMERATION_CONCURRENCY);
    expect(callsForMethod(readContractWithOptions, 'getNameHash')).toHaveLength(13);
  });

  it('fails closed on any slot read error and aborts sibling failover reads', async () => {
    const { adapter, fence, readContractWithOptions } = fixture([null, null, NAME_HASH, null]);
    const failure = new Error('all RPC endpoints failed getNameHash(2)');
    const slotReader = vi.spyOn(fence, 'readCurrentNameHash');
    readContractWithOptions.mockImplementation(async (
      _contract: unknown,
      _label: string,
      method: string,
      args: readonly unknown[],
      _options: { signal?: AbortSignal },
    ) => {
      if (method === 'getLatestContextGraphId') return 4n;
      if (BigInt(args[0] as bigint) === 2n) throw failure;
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      return BigInt(args[0] as bigint) === 3n ? NAME_HASH : ethers.ZeroHash;
    });

    await expect(adapter.resolveContextGraphIdByNameHash(NAME_HASH)).rejects.toThrow(
      /1 of 1 covering RPC backends failed to read current slot 2/i,
    );
    const observedSignals = slotReader.mock.calls
      .map((call) => call[1])
      .filter((signal): signal is AbortSignal => signal instanceof AbortSignal);
    expect(observedSignals).not.toHaveLength(0);
    expect(observedSignals.every((signal) => signal.aborted)).toBe(true);
  });


});
