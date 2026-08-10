import { describe, expect, it, vi } from 'vitest';
import {
  CONTEXT_GRAPH_NAME_HASH_FAST_ENUMERATION_MAX_IDS,
} from '../src/evm-context-graph-name-hash-fence.js';
import { CG_REGISTRY_MAX_SCAN_PAGES } from '../src/evm-adapter-base.js';
import {
  callsForMethod,
  fixture,
  historicalFixture,
  NAME_HASH,
  OTHER_HASH,
} from './context-graph-name-hash-reverse-resolution.fixtures.js';

describe('historical Context Graph name-hash reverse resolution', () => {
  it('switches above the fast cap before issuing any getNameHash read', async () => {
    const {
      adapter,
      fence,
      readContractWithOptions,
      setLatestId,
    } = fixture([]);
    setLatestId(CONTEXT_GRAPH_NAME_HASH_FAST_ENUMERATION_MAX_IDS + 1n);
    const historical = vi.spyOn(
      fence as unknown as { resolveHistorical: (nameHash: string) => Promise<bigint | null> },
      'resolveHistorical',
    ).mockResolvedValue(77n);

    await expect(adapter.resolveContextGraphIdByNameHash(NAME_HASH)).resolves.toBe(77n);
    expect(callsForMethod(readContractWithOptions, 'getLatestContextGraphId')).toHaveLength(1);
    expect(callsForMethod(readContractWithOptions, 'getNameHash')).toHaveLength(0);
    expect(historical).toHaveBeenCalledWith(NAME_HASH);
  });

  it('falls back to exact-topic deploy-anchored pages and verifies the live slot', async () => {
    const {
      adapter,
      filter,
      filterFactory,
      queryEventLogsPage,
      getNameHash,
    } = historicalFixture([[], [42n], []]);

    await expect(adapter.resolveContextGraphIdByNameHash(NAME_HASH)).resolves.toBe(42n);

    expect(filterFactory).toHaveBeenCalledWith(null, null, NAME_HASH);
    expect(queryEventLogsPage.mock.calls.map((call) => [call[1], call[2], call[3]])).toEqual([
      [filter, 100, 101],
      [filter, 102, 103],
      [filter, 104, 105],
    ]);
    expect(getNameHash).toHaveBeenCalledWith(42n);
  });

  it('keeps the historical scan live when one same-head RPC cannot load the anchor block', async () => {
    const scenario = historicalFixture([[42n]]);
    const failingProvider = {
      getBlock: vi.fn(async () => { throw new Error('head block unavailable'); }),
    };
    scenario.resolveContractDeployBlock.mockResolvedValue({
      fromBlock: 100,
      head: 101,
      scanProviders: [
        { provider: failingProvider, backendHead: 101 },
        { provider: scenario.provider, backendHead: 101 },
      ],
    });

    await expect(scenario.adapter.resolveContextGraphIdByNameHash(NAME_HASH)).resolves.toBe(42n);
    expect(failingProvider.getBlock).toHaveBeenCalledWith(101);
    expect(scenario.provider.getBlock).toHaveBeenCalledWith(101);
  });

  it('fails closed when same-height RPCs disagree on the historical anchor hash', async () => {
    const scenario = historicalFixture([[42n]]);
    const forkedProvider = {
      getBlock: vi.fn(async (blockNumber: number) => ({
        number: blockNumber,
        hash: `0x${'44'.repeat(32)}`,
      })),
    };
    scenario.resolveContractDeployBlock.mockResolvedValue({
      fromBlock: 100,
      head: 101,
      scanProviders: [
        { provider: scenario.provider, backendHead: 101 },
        { provider: forkedProvider, backendHead: 101 },
      ],
    });

    await expect(scenario.adapter.resolveContextGraphIdByNameHash(NAME_HASH)).rejects.toThrow(
      /RPC backends disagree on canonical block hash at historical head 101/i,
    );
    expect(scenario.queryEventLogsPage).not.toHaveBeenCalled();
  });

  it('fails closed when same-head RPCs disagree on the pinned historical high-water', async () => {
    const scenario = historicalFixture([[42n]]);
    const pinnedHighWater = CONTEXT_GRAPH_NAME_HASH_FAST_ENUMERATION_MAX_IDS + 1n;
    const peerProvider = {
      getBlock: vi.fn(async (blockNumber: number) => ({
        number: blockNumber,
        hash: `0x${'33'.repeat(32)}`,
      })),
    };
    const primaryRead = vi.fn(async () => pinnedHighWater);
    const peerRead = vi.fn(async (options?: { blockTag?: number }) =>
      options?.blockTag === 101 ? pinnedHighWater + 1n : pinnedHighWater);
    scenario.adapter.providers = [scenario.provider, peerProvider];
    scenario.resolveContractDeployBlock.mockResolvedValue({
      fromBlock: 100,
      head: 101,
      scanProviders: [
        { provider: scenario.provider, backendHead: 101 },
        { provider: peerProvider, backendHead: 101 },
      ],
    });
    scenario.adapter.rebindContract.mockImplementation(
      (_contract: unknown, provider: unknown) => ({
        getLatestContextGraphId: provider === peerProvider ? peerRead : primaryRead,
        getNameHash: scenario.getNameHash,
      }),
    );

    await expect(scenario.adapter.resolveContextGraphIdByNameHash(NAME_HASH)).rejects.toThrow(
      'resolveContextGraphIdByNameHash: RPC backends disagree on registry ' +
      'high-water at historical head 101',
    );
    expect(primaryRead).toHaveBeenCalledWith({ blockTag: 101 });
    expect(peerRead).toHaveBeenCalledWith({ blockTag: 101 });
    expect(scenario.queryEventLogsPage).not.toHaveBeenCalled();
    expect(scenario.getNameHash).not.toHaveBeenCalled();
  });

  it('fails closed when one same-head RPC cannot read the pinned historical high-water', async () => {
    const scenario = historicalFixture([[42n]]);
    const pinnedHighWater = CONTEXT_GRAPH_NAME_HASH_FAST_ENUMERATION_MAX_IDS + 1n;
    const peerFailure = new Error('pinned counter unavailable');
    const peerProvider = {
      getBlock: vi.fn(async (blockNumber: number) => ({
        number: blockNumber,
        hash: `0x${'33'.repeat(32)}`,
      })),
    };
    const primaryRead = vi.fn(async () => pinnedHighWater);
    const peerRead = vi.fn(async (options?: { blockTag?: number }) => {
      if (options?.blockTag === 101) throw peerFailure;
      return pinnedHighWater;
    });
    scenario.adapter.providers = [scenario.provider, peerProvider];
    scenario.resolveContractDeployBlock.mockResolvedValue({
      fromBlock: 100,
      head: 101,
      scanProviders: [
        { provider: scenario.provider, backendHead: 101 },
        { provider: peerProvider, backendHead: 101 },
      ],
    });
    scenario.adapter.rebindContract.mockImplementation(
      (_contract: unknown, provider: unknown) => ({
        getLatestContextGraphId: provider === peerProvider ? peerRead : primaryRead,
        getNameHash: scenario.getNameHash,
      }),
    );

    let failure: unknown;
    try {
      await scenario.adapter.resolveContextGraphIdByNameHash(NAME_HASH);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(
      'resolveContextGraphIdByNameHash: 1 of 2 RPC backends failed to read ' +
      'registry high-water at historical head 101',
    );
    expect((failure as Error & { cause?: unknown }).cause).toBe(peerFailure);
    expect(primaryRead).toHaveBeenCalledWith({ blockTag: 101 });
    expect(peerRead).toHaveBeenCalledWith({ blockTag: 101 });
    expect(scenario.queryEventLogsPage).not.toHaveBeenCalled();
    expect(scenario.getNameHash).not.toHaveBeenCalled();
  });

  it('keeps the historical fallback fail-closed on duplicate numeric slots', async () => {
    const { adapter, getNameHash } = historicalFixture([[42n, 43n]]);

    await expect(adapter.resolveContextGraphIdByNameHash(NAME_HASH)).rejects.toThrow(
      /ambiguous.*2 numeric ids/i,
    );
    expect(getNameHash).not.toHaveBeenCalled();
  });

  it('rejects the historical fallback before logs when its page budget is exceeded', async () => {
    const { adapter, resolveContractDeployBlock, queryEventLogsPage } = historicalFixture();
    resolveContractDeployBlock.mockResolvedValue({
      fromBlock: 100,
      head: 100 + (CG_REGISTRY_MAX_SCAN_PAGES * 2),
      scanProviders: [{
        provider: {},
        backendHead: 100 + (CG_REGISTRY_MAX_SCAN_PAGES * 2),
      }],
    });

    await expect(adapter.resolveContextGraphIdByNameHash(NAME_HASH)).rejects.toThrow(
      new RegExp(`budget ${CG_REGISTRY_MAX_SCAN_PAGES} pages`),
    );
    expect(queryEventLogsPage).not.toHaveBeenCalled();
  });

  it('fails closed when the historical candidate no longer matches its live slot', async () => {
    const { adapter, getNameHash } = historicalFixture([[42n]]);
    getNameHash.mockResolvedValue(OTHER_HASH);

    await expect(adapter.resolveContextGraphIdByNameHash(NAME_HASH)).rejects.toThrow(
      /currently commits.*expected/i,
    );
  });

  it('fails closed when historical slot verification has only one known high-water backend', async () => {
    const scenario = historicalFixture([[42n]]);
    const current = { id: 'current' };
    const unavailableA = { id: 'unavailable-a' };
    const unavailableB = { id: 'unavailable-b' };
    const retryableFailure = () => Object.assign(
      new Error('current high-water timed out'),
      { code: 'RPC_TIMEOUT' },
    );
    scenario.adapter.providers = [current, unavailableA, unavailableB];
    scenario.adapter.rpcUrls = [
      'http://current.invalid',
      'http://unavailable-a.invalid',
      'http://unavailable-b.invalid',
    ];
    scenario.adapter.rebindContract.mockImplementation(
      (_contract: unknown, provider: unknown) => ({
        getLatestContextGraphId: async (options?: { blockTag?: number }) => {
          if (options?.blockTag !== undefined) {
            return CONTEXT_GRAPH_NAME_HASH_FAST_ENUMERATION_MAX_IDS + 1n;
          }
          if (provider !== current) throw retryableFailure();
          return CONTEXT_GRAPH_NAME_HASH_FAST_ENUMERATION_MAX_IDS + 1n;
        },
        getNameHash: scenario.getNameHash,
      }),
    );

    await expect(scenario.adapter.resolveContextGraphIdByNameHash(NAME_HASH)).rejects.toThrow(
      /insufficient covering RPC quorum.*1 of 3 backends responded, need 2/i,
    );
    expect(scenario.getNameHash).toHaveBeenCalledTimes(1);
    expect(scenario.getNameHash).toHaveBeenCalledWith(42n);
  });

  it('discards a historical result when the adapter binding rotates mid-scan', async () => {
    const fixture = historicalFixture([[42n]]);
    fixture.queryEventLogsPage.mockImplementationOnce(async () => {
      fixture.adapter.invalidatePublishPreflightCache();
      return {
        logs: [{ topics: [], data: '42' }],
        provider: fixture.provider,
      };
    });

    await expect(fixture.adapter.resolveContextGraphIdByNameHash(NAME_HASH)).rejects.toThrow(
      /binding changed during historical scan/i,
    );
    expect(fixture.getNameHash).not.toHaveBeenCalled();
  });

  it('discards a historical result when its canonical head changes mid-scan', async () => {
    const fixture = historicalFixture([[42n]]);
    fixture.queryEventLogsPage.mockImplementationOnce(async () => {
      fixture.setHeadHash(`0x${'44'.repeat(32)}`);
      return {
        logs: [{ topics: [], data: '42' }],
        provider: fixture.provider,
      };
    });

    await expect(fixture.adapter.resolveContextGraphIdByNameHash(NAME_HASH)).rejects.toThrow(
      /canonical chain anchor changed during historical scan/i,
    );
    expect(fixture.getNameHash).not.toHaveBeenCalled();
  });

  it('discards a historical result when a new CG advances the registry after the scanned head', async () => {
    const scenario = historicalFixture([[42n]]);
    scenario.queryEventLogsPage.mockImplementationOnce(async () => {
      scenario.setLatestId(CONTEXT_GRAPH_NAME_HASH_FAST_ENUMERATION_MAX_IDS + 2n);
      return {
        logs: [{ topics: [], data: '42' }],
        provider: scenario.provider,
      };
    });

    await expect(scenario.adapter.resolveContextGraphIdByNameHash(NAME_HASH)).rejects.toThrow(
      /registry high-water changed from 1025 to 1026 during historical scan/i,
    );
    expect(scenario.getNameHash).toHaveBeenCalledWith(42n);
  });

  it('does not negative-cache a historical miss when the registry advances during the scan', async () => {
    const scenario = historicalFixture([[]]);
    scenario.queryEventLogsPage.mockImplementationOnce(async () => {
      scenario.setLatestId(CONTEXT_GRAPH_NAME_HASH_FAST_ENUMERATION_MAX_IDS + 2n);
      return { logs: [], provider: scenario.provider };
    });

    await expect(scenario.adapter.resolveContextGraphIdByNameHash(NAME_HASH)).rejects.toThrow(
      /registry high-water changed from 1025 to 1026 during historical scan/i,
    );

    scenario.setLatestId(CONTEXT_GRAPH_NAME_HASH_FAST_ENUMERATION_MAX_IDS + 1n);
    await expect(scenario.adapter.resolveContextGraphIdByNameHash(NAME_HASH)).resolves.toBeNull();
    expect(scenario.queryEventLogsPage).toHaveBeenCalledTimes(2);
  });


});
