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
  providerHighWaterSnapshot,
  providerQuorumFixture,
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
    const enumerationSnapshot = {
      latestId: 2n,
      providerHighWaters: enumerationHighWaters,
      unavailableProviderCount: 0,
    };
    const verificationSnapshot = {
      latestId: 2n,
      providerHighWaters: verificationHighWaters,
      unavailableProviderCount: 0,
    };
    vi.spyOn(fence, 'loadProviderHighWaters')
      .mockResolvedValueOnce(enumerationSnapshot)
      .mockResolvedValueOnce(verificationSnapshot);
    const slotReader = vi.spyOn(fence, 'readCurrentNameHash').mockImplementation(
      async (id) => id === 2n ? NAME_HASH : null,
    );

    await expect(adapter.resolveContextGraphIdByNameHash(NAME_HASH)).resolves.toBe(2n);

    const rangeReads = slotReader.mock.calls.filter(
      (call) => call[1] instanceof AbortSignal,
    );
    expect(rangeReads).toHaveLength(2);
    expect(rangeReads.every((call) => call[2] === enumerationSnapshot)).toBe(true);
    const exactRead = slotReader.mock.calls.find((call) => call[1] === undefined);
    expect(exactRead?.[2]).toBe(verificationSnapshot);
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
    )).toEqual([1n, 1n, 2n, 2n]);
  });

  it('does not let a lower-high-water RPC hide a slot from a current backend', async () => {
    const primary = { id: 'lagging' };
    const backup = { id: 'current' };
    const { adapter, fence } = providerQuorumFixture({
      providers: [primary, backup],
      readNameHash: async (provider) => provider === primary ? ethers.ZeroHash : NAME_HASH,
    });

    await expect(fence.readCurrentNameHash(
      1n,
      undefined,
      providerHighWaterSnapshot([[primary, 0n], [backup, 1n]]),
    )).resolves.toBe(NAME_HASH);
    expect(adapter.rebindContract).toHaveBeenCalledTimes(1);
  });

  it('fails closed when same-high-water RPCs disagree on a current slot', async () => {
    const primary = { id: 'fork-a' };
    const backup = { id: 'fork-b' };
    const { fence } = providerQuorumFixture({
      providers: [primary, backup],
      readNameHash: async (provider) => provider === primary ? ethers.ZeroHash : NAME_HASH,
    });

    await expect(fence.readCurrentNameHash(
      1n,
      undefined,
      providerHighWaterSnapshot([[primary, 1n], [backup, 1n]]),
    )).rejects.toThrow(
      /RPC backends disagree on current slot 1/i,
    );
  });

  it('fails closed when one of two covering RPCs is transiently unavailable', async () => {
    const failing = { id: 'failing' };
    const responding = { id: 'responding' };
    const { adapter, fence } = providerQuorumFixture({
      providers: [failing, responding],
      readNameHash: async (provider) => {
        if (provider === failing) {
          throw Object.assign(new Error('slot read timed out'), { code: 'RPC_TIMEOUT' });
        }
        return ethers.ZeroHash;
      },
    });

    await expect(fence.readCurrentNameHash(
      2n,
      undefined,
      providerHighWaterSnapshot([[failing, 2n], [responding, 2n]]),
    )).rejects.toThrow(
      /insufficient covering RPC quorum.*1 of 2 backends responded, need 2/i,
    );
    expect(adapter.rebindContract).toHaveBeenCalledTimes(2);
  });

  it.each([
    [
      'timeout',
      () => Object.assign(new Error('slot read timed out'), { code: 'RPC_TIMEOUT' }),
    ],
    [
      'HTTP 429',
      () => Object.assign(new Error('too many requests'), { status: 429 }),
    ],
  ])('accepts a two-of-three agreeing quorum when one RPC has a retryable %s', async (
    _failureKind,
    createFailure,
  ) => {
    const unavailable = { id: 'unavailable' };
    const respondingA = { id: 'responding-a' };
    const respondingB = { id: 'responding-b' };
    const { fence } = providerQuorumFixture({
      providers: [unavailable, respondingA, respondingB],
      readNameHash: async (provider) => {
        if (provider === unavailable) throw createFailure();
        return NAME_HASH;
      },
    });

    await expect(fence.readCurrentNameHash(
      2n,
      undefined,
      providerHighWaterSnapshot([
        [unavailable, 2n],
        [respondingA, 2n],
        [respondingB, 2n],
      ]),
    )).resolves.toBe(NAME_HASH);
  });

  it('fails closed when two of three covering RPCs are transiently unavailable', async () => {
    const unavailableA = { id: 'unavailable-a' };
    const unavailableB = { id: 'unavailable-b' };
    const responding = { id: 'responding' };
    const { fence } = providerQuorumFixture({
      providers: [unavailableA, unavailableB, responding],
      readNameHash: async (provider) => {
        if (provider !== responding) {
          throw Object.assign(new Error('slot read timed out'), { code: 'RPC_TIMEOUT' });
        }
        return NAME_HASH;
      },
    });

    await expect(fence.readCurrentNameHash(
      2n,
      undefined,
      providerHighWaterSnapshot([
        [unavailableA, 2n],
        [unavailableB, 2n],
        [responding, 2n],
      ]),
    )).rejects.toThrow(
      /insufficient covering RPC quorum.*1 of 3 backends responded, need 2/i,
    );
  });

  it.each([
    ['CALL_EXCEPTION', 'execution reverted'],
    ['BAD_DATA', 'could not decode result data'],
  ])('fails closed on non-retryable slot %s despite an agreeing majority', async (
    code,
    message,
  ) => {
    const invalid = { id: 'invalid' };
    const respondingA = { id: 'responding-a' };
    const respondingB = { id: 'responding-b' };
    const { fence } = providerQuorumFixture({
      providers: [invalid, respondingA, respondingB],
      readNameHash: async (provider) => {
        if (provider === invalid) {
          throw Object.assign(new Error(message), { code });
        }
        return NAME_HASH;
      },
    });

    await expect(fence.readCurrentNameHash(
      2n,
      undefined,
      providerHighWaterSnapshot([
        [invalid, 2n],
        [respondingA, 2n],
        [respondingB, 2n],
      ]),
    )).rejects.toThrow(
      /non-retryable failure for current slot 2/i,
    );
  });

  it('fails closed when fulfilled RPCs disagree despite reaching quorum', async () => {
    const unavailable = { id: 'unavailable' };
    const forkA = { id: 'fork-a' };
    const forkB = { id: 'fork-b' };
    const { fence } = providerQuorumFixture({
      providers: [unavailable, forkA, forkB],
      readNameHash: async (provider) => {
        if (provider === unavailable) {
          throw Object.assign(new Error('slot read timed out'), { code: 'RPC_TIMEOUT' });
        }
        return provider === forkA ? NAME_HASH : OTHER_HASH;
      },
    });

    await expect(fence.readCurrentNameHash(
      2n,
      undefined,
      providerHighWaterSnapshot([
        [unavailable, 2n],
        [forkA, 2n],
        [forkB, 2n],
      ]),
    )).rejects.toThrow(
      /RPC backends disagree on current slot 2/i,
    );
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
      providerHighWaterSnapshot([[provider, 1n]]),
    );
    await started.promise;
    controller.abort(new Error('sibling slot failed'));

    await expect(read).rejects.toThrow('sibling slot failed');
  });

  it('accepts a transient initial high-water failure after complete verification', async () => {
    const unavailable = { id: 'unavailable' };
    const respondingA = { id: 'responding-a' };
    const respondingB = { id: 'responding-b' };
    let unavailableReads = 0;
    const {
      adapter,
      getLatestContextGraphId,
      getNameHash,
    } = providerQuorumFixture({
      providers: [unavailable, respondingA, respondingB],
      readHighWater: async (provider) => {
        if (provider === unavailable && unavailableReads++ === 0) {
          throw Object.assign(new Error('high-water timed out'), { code: 'RPC_TIMEOUT' });
        }
        return 1n;
      },
      readNameHash: async () => NAME_HASH,
    });

    await expect(adapter.resolveContextGraphIdByNameHash(NAME_HASH)).resolves.toBe(1n);
    expect(getLatestContextGraphId).toHaveBeenCalledTimes(6);
    expect(getNameHash).toHaveBeenCalledTimes(5);
  });

  it.each([
    ['zero observed ids', 0n, ethers.ZeroHash],
    ['a stale null result', 1n, ethers.ZeroHash],
    ['a stale positive result', 1n, NAME_HASH],
  ])('fails closed before returning %s while a current backend high-water is unknown', async (
    _scenario,
    respondingHighWater,
    slotHash,
  ) => {
    const unavailable = { id: 'unavailable-current-backend' };
    const laggingA = { id: 'lagging-a' };
    const laggingB = { id: 'lagging-b' };
    const { adapter, fence } = providerQuorumFixture({
      providers: [unavailable, laggingA, laggingB],
      readHighWater: async (provider) => {
        if (provider === unavailable) {
          throw Object.assign(new Error('high-water timed out'), { code: 'RPC_TIMEOUT' });
        }
        return respondingHighWater;
      },
      readNameHash: async () => slotHash,
    });

    await expect(adapter.resolveContextGraphIdByNameHash(NAME_HASH)).rejects.toThrow(
      /incomplete registry high-water coverage during current-slot resolution; 2 of 3/i,
    );
    expect(fence.currentSlotRevision).toBe(0);
  });

  it('keeps the unavailable-provider count attached to the typed high-water snapshot', async () => {
    const responding = { id: 'responding' };
    const { fence } = providerQuorumFixture({
      providers: [responding],
      readNameHash: async () => NAME_HASH,
    });

    await expect(fence.readCurrentNameHash(
      2n,
      undefined,
      providerHighWaterSnapshot([[responding, 2n]], 2),
    )).rejects.toThrow(
      /insufficient covering RPC quorum.*1 of 3 backends responded, need 2/i,
    );
  });

  it('does not collapse two transient high-water failures into an unsafe one-of-one', async () => {
    const unavailableA = { id: 'unavailable-a' };
    const unavailableB = { id: 'unavailable-b' };
    const responding = { id: 'responding' };
    const { adapter, fence } = providerQuorumFixture({
      providers: [unavailableA, unavailableB, responding],
      readHighWater: async (provider) => {
        if (provider !== responding) {
          throw Object.assign(new Error('high-water timed out'), { code: 'RPC_TIMEOUT' });
        }
        return 1n;
      },
      readNameHash: async () => NAME_HASH,
    });

    await expect(adapter.resolveContextGraphIdByNameHash(NAME_HASH)).rejects.toThrow(
      /insufficient covering RPC quorum.*1 of 3 backends responded, need 2/i,
    );
    expect(fence.currentSlotRevision).toBe(0);
  });

  it.each([
    ['CALL_EXCEPTION', 'execution reverted'],
    ['BAD_DATA', 'could not decode result data'],
  ])('fails closed on non-retryable high-water %s despite two agreeing providers', async (
    code,
    message,
  ) => {
    const invalid = { id: 'invalid' };
    const respondingA = { id: 'responding-a' };
    const respondingB = { id: 'responding-b' };
    const { adapter, fence } = providerQuorumFixture({
      providers: [invalid, respondingA, respondingB],
      readHighWater: async (provider) => {
        if (provider === invalid) {
          throw Object.assign(new Error(message), { code });
        }
        return 1n;
      },
      readNameHash: async () => NAME_HASH,
    });

    await expect(adapter.resolveContextGraphIdByNameHash(NAME_HASH)).rejects.toThrow(
      /non-retryable registry high-water failure/i,
    );
    expect(fence.currentSlotRevision).toBe(0);
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

    const slot = fence.readCurrentNameHash(1n, undefined, snapshot);
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

  it('does not commit a partial index when slot quorum fails and aborts sibling reads', async () => {
    const { adapter, fence, readContractWithOptions } = fixture([null, null, NAME_HASH, null]);
    const failure = Object.assign(
      new Error('all RPC endpoints failed getNameHash(2)'),
      { code: 'RPC_TIMEOUT' },
    );
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
      /insufficient covering RPC quorum.*0 of 1 backends responded, need 1/i,
    );
    expect(fence.currentSlotRevision).toBe(0);
    const observedSignals = slotReader.mock.calls
      .map((call) => call[1])
      .filter((signal): signal is AbortSignal => signal instanceof AbortSignal);
    expect(observedSignals).not.toHaveLength(0);
    expect(observedSignals.every((signal) => signal.aborted)).toBe(true);
  });


});
