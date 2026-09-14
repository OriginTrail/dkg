// SPDX-License-Identifier: Apache-2.0

import { ethers } from 'ethers';
import { describe, expect, it, vi } from 'vitest';
import { MockChainAdapter } from '../src/mock-adapter.js';
import {
  callsForMethod,
  deferred,
  fixture,
  historicalFixture,
  NAME_HASH,
  OTHER_HASH,
} from './context-graph-name-hash-reverse-resolution.fixtures.js';

const hash = (n: number) => ethers.zeroPadValue(ethers.toBeHex(n), 32);

function batchHistory(pages: readonly (readonly bigint[])[] = [[42n], [43n]]) {
  const scenario = historicalFixture(pages);
  const names = new Map([[42n, NAME_HASH], [43n, OTHER_HASH]]);
  scenario.adapter.contracts.contextGraphStorage.interface.parseLog.mockImplementation(({ data }: { data: string }) => ({
    name: 'ContextGraphCreated',
    args: { contextGraphId: BigInt(data), nameHash: names.get(BigInt(data)) ?? NAME_HASH },
  }));
  scenario.getNameHash.mockImplementation(async (id: bigint) => names.get(id) ?? NAME_HASH);
  return { ...scenario, names };
}

describe('bounded Context Graph name-hash batch resolution', () => {
  it('resolves 1200 mixed names using one complete current-slot fence', async () => {
    const scenario = fixture([NAME_HASH, OTHER_HASH]);
    const names = [NAME_HASH, OTHER_HASH, ...Array.from({ length: 1198 }, (_, n) => hash(n + 1))];
    const result = await scenario.adapter.resolveContextGraphIdsByNameHashes(names);
    expect(result.size).toBe(1200);
    expect(result.get(NAME_HASH)).toBe(1n);
    expect(result.get(OTHER_HASH)).toBe(2n);
    expect(result.get(hash(1198))).toBeNull();
    expect(callsForMethod(scenario.readContractWithOptions, 'getLatestContextGraphId')).toHaveLength(3);
    expect(callsForMethod(scenario.readContractWithOptions, 'getNameHash')).toHaveLength(4);
  });

  it('normalizes and deduplicates input and preserves the zero commitment miss', async () => {
    const scenario = fixture([NAME_HASH]);
    const result = await scenario.adapter.resolveContextGraphIdsByNameHashes([
      NAME_HASH, `0x${'AB'.repeat(32)}`, ethers.ZeroHash,
    ]);
    expect([...result]).toEqual([[NAME_HASH, 1n], [ethers.ZeroHash, null]]);
  });

  it.each([{ names: ['invalid'] }, { names: 'not-an-array' }])(
    'rejects invalid payloads before chain reads', async ({ names }) => {
      const scenario = fixture([]);
      await expect(scenario.adapter.resolveContextGraphIdsByNameHashes(names)).rejects.toThrow();
      expect(scenario.readContractWithOptions).not.toHaveBeenCalled();
    },
  );

  it('does not retain a negative batch answer across independent requests', async () => {
    const scenario = fixture([]);
    expect((await scenario.adapter.resolveContextGraphIdsByNameHashes([NAME_HASH])).get(NAME_HASH)).toBeNull();
    scenario.hashes.set(1n, NAME_HASH);
    scenario.setLatestId(1n);
    expect((await scenario.adapter.resolveContextGraphIdsByNameHashes([NAME_HASH])).get(NAME_HASH)).toBe(1n);
  });

  it('rejects the entire batch if any requested name has duplicate slots', async () => {
    const scenario = fixture([NAME_HASH, OTHER_HASH, OTHER_HASH]);
    await expect(scenario.adapter.resolveContextGraphIdsByNameHashes([NAME_HASH, OTHER_HASH]))
      .rejects.toThrow(/ambiguous/i);
  });

  it('rejects the complete batch when the registry advances during verification', async () => {
    const scenario = fixture([NAME_HASH]);
    let reads = 0;
    const original = scenario.readContractWithOptions.getMockImplementation()!;
    scenario.readContractWithOptions.mockImplementation(async (...args: Parameters<typeof original>) => {
      if (args[2] === 'getLatestContextGraphId') return ++reads === 1 ? 1n : 2n;
      return original(...args);
    });
    await expect(scenario.adapter.resolveContextGraphIdsByNameHashes([NAME_HASH, OTHER_HASH]))
      .rejects.toThrow(/registry advanced/i);
  });

  it('rechecks the current head after all positive batch bindings are verified', async () => {
    const scenario = fixture([NAME_HASH, OTHER_HASH]);
    const original = scenario.fence.readCurrentNameHash.bind(scenario.fence);
    vi.spyOn(scenario.fence, 'readCurrentNameHash').mockImplementation(async (...args) => {
      const result = await original(...args);
      if (args[1] === undefined) scenario.setAnchorHash(`0x${'55'.repeat(32)}`);
      return result;
    });
    await expect(scenario.adapter.resolveContextGraphIdsByNameHashes([NAME_HASH, OTHER_HASH]))
      .rejects.toThrow(/canonical chain anchor changed/i);
  });

  it('keeps positive batch verification concurrency at four', async () => {
    const names = Array.from({ length: 12 }, (_, n) => hash(n + 1));
    const scenario = fixture(names);
    let active = 0;
    let maximum = 0;
    vi.spyOn(scenario.fence, 'readCurrentNameHash').mockImplementation(async (id, signal) => {
      if (signal === undefined) {
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => setTimeout(resolve, 1));
        active -= 1;
      }
      return names[Number(id) - 1];
    });
    expect((await scenario.adapter.resolveContextGraphIdsByNameHashes(names)).size).toBe(12);
    expect(maximum).toBe(4);
  });

  it('returns no partial map when a current slot cannot be read', async () => {
    const scenario = fixture([NAME_HASH, OTHER_HASH]);
    vi.spyOn(scenario.fence, 'readCurrentNameHash').mockImplementation(async (id) => {
      if (id === 2n) throw new Error('slot unavailable');
      return NAME_HASH;
    });
    await expect(scenario.adapter.resolveContextGraphIdsByNameHashes([NAME_HASH, OTHER_HASH]))
      .rejects.toThrow('slot unavailable');
  });

  it('rejects pre-aborted work without dispatching any chain read', async () => {
    const scenario = fixture([NAME_HASH]);
    const controller = new AbortController();
    controller.abort(new Error('caller left'));
    await expect(scenario.adapter.resolveContextGraphIdsByNameHashes([NAME_HASH], { signal: controller.signal }))
      .rejects.toThrow('caller left');
    expect(scenario.readContractWithOptions).not.toHaveBeenCalled();
  });

  it('stops dispatching current-slot work after cancellation', async () => {
    const scenario = fixture(Array.from({ length: 8 }, () => NAME_HASH));
    const controller = new AbortController();
    const started = deferred<void>();
    const pending = deferred<string | null>();
    const reader = vi.spyOn(scenario.fence, 'readCurrentNameHash').mockImplementation(async () => {
      if (reader.mock.calls.length === 4) started.resolve();
      return pending.promise;
    });
    const result = scenario.adapter.resolveContextGraphIdsByNameHashes([NAME_HASH], { signal: controller.signal });
    const rejected = expect(result).rejects.toThrow('caller left');
    await started.promise;
    controller.abort(new Error('caller left'));
    pending.resolve(NAME_HASH);
    await rejected;
    expect(reader).toHaveBeenCalledTimes(4);
  });

  it('shares one complete historical creation inventory for mixed hits and misses', async () => {
    const scenario = batchHistory();
    const result = await scenario.adapter.resolveContextGraphIdsByNameHashes([NAME_HASH, OTHER_HASH, hash(1)]);
    expect([...result]).toEqual([[NAME_HASH, 42n], [OTHER_HASH, 43n], [hash(1), null]]);
    expect(scenario.resolveContractDeployBlock).toHaveBeenCalledTimes(1);
    expect(scenario.filterFactory).toHaveBeenCalledWith(null, null, null);
    expect(scenario.queryEventLogsPage).toHaveBeenCalledTimes(2);
    expect(scenario.getNameHash.mock.calls.map(([id]) => id)).toEqual([42n, 43n]);
  });

  it('uses the same historical pages for 1 and 1200 names, retaining a private binding at the end', async () => {
    for (const count of [1, 1200]) {
      const scenario = batchHistory([[42n], [], [43n]]);
      const names = [...Array.from({ length: count - 1 }, (_, n) => hash(n + 1)), OTHER_HASH];
      const result = await scenario.adapter.resolveContextGraphIdsByNameHashes(names);
      expect(result.size).toBe(count);
      expect(result.get(OTHER_HASH)).toBe(43n);
      if (count > 1) expect(result.get(hash(1199))).toBeNull();
      expect(result.has(NAME_HASH)).toBe(false);
      expect(scenario.resolveContractDeployBlock).toHaveBeenCalledTimes(1);
      expect(scenario.queryEventLogsPage).toHaveBeenCalledTimes(3);
      expect(scenario.filterFactory.mock.calls.every(([, , requested]) => requested === null)).toBe(true);
      expect(scenario.getNameHash.mock.calls.map(([id]) => id)).toEqual([43n]);
    }
  });

  it('does not dispatch another historical page after cancellation', async () => {
    const scenario = batchHistory([[], []]);
    const controller = new AbortController();
    scenario.queryEventLogsPage.mockImplementation(async () => {
      controller.abort(new Error('caller left'));
      return { logs: [], provider: scenario.provider };
    });
    await expect(scenario.adapter.resolveContextGraphIdsByNameHashes(
      Array.from({ length: 600 }, (_, n) => hash(n + 1)), { signal: controller.signal },
    )).rejects.toThrow('caller left');
    expect(scenario.queryEventLogsPage).toHaveBeenCalledTimes(1);
  });

  it('rejects the batch if a later historical page fails after earlier positives', async () => {
    const scenario = batchHistory([[42n], []]);
    const original = scenario.queryEventLogsPage.getMockImplementation()!;
    let calls = 0;
    scenario.queryEventLogsPage.mockImplementation(async (...args: unknown[]) => {
      if (++calls === 2) throw new Error('page unavailable');
      return original(...args);
    });
    await expect(scenario.adapter.resolveContextGraphIdsByNameHashes(
      [NAME_HASH, ...Array.from({ length: 600 }, (_, n) => hash(n + 1))],
    )).rejects.toThrow('page unavailable');
    expect(scenario.queryEventLogsPage).toHaveBeenCalledTimes(2);
    expect(scenario.getNameHash).not.toHaveBeenCalled();
  });

  it('validates unrelated creation events before ignoring them', async () => {
    const scenario = batchHistory([[66n]]);
    scenario.names.set(66n, OTHER_HASH);
    await expect(scenario.adapter.resolveContextGraphIdsByNameHashes([NAME_HASH]))
      .rejects.toThrow(/invalid Context Graph id/i);
    expect(scenario.getNameHash).not.toHaveBeenCalled();
  });

  it('rejects malformed unrelated event commitments before ignoring them', async () => {
    const scenario = batchHistory([[43n]]);
    scenario.names.set(43n, 'not-a-commitment');
    await expect(scenario.adapter.resolveContextGraphIdsByNameHashes([NAME_HASH]))
      .rejects.toThrow(/invalid ContextGraphCreated log/i);
  });

  it('does not manufacture a miss when an internal batch result omits a key', async () => {
    const scenario = fixture([NAME_HASH]);
    vi.spyOn(scenario.fence as unknown as {
      enqueueCurrentSlotResolution: () => Promise<unknown>;
    }, 'enqueueCurrentSlotResolution').mockResolvedValue({ mode: 'current', bindings: new Map() });
    await expect(scenario.adapter.resolveContextGraphIdsByNameHashes([NAME_HASH]))
      .rejects.toThrow(/incomplete.*binding/i);
  });

  it('rejects historical duplicate bindings instead of returning other successful names', async () => {
    const scenario = batchHistory([[42n], [44n]]);
    await expect(scenario.adapter.resolveContextGraphIdsByNameHashes([NAME_HASH, OTHER_HASH]))
      .rejects.toThrow(/ambiguous/i);
  });

  it('rejects an incomplete historical page and preserves no partial map', async () => {
    const scenario = batchHistory();
    scenario.queryEventLogsPage.mockRejectedValueOnce(new Error('page unavailable'));
    await expect(scenario.adapter.resolveContextGraphIdsByNameHashes([NAME_HASH, OTHER_HASH]))
      .rejects.toThrow('page unavailable');
    expect(scenario.getNameHash).not.toHaveBeenCalled();
  });

  it('rejects a changed historical head after collecting bindings', async () => {
    const scenario = batchHistory();
    const original = scenario.queryEventLogsPage.getMockImplementation()!;
    scenario.queryEventLogsPage.mockImplementation(async (...args: unknown[]) => {
      const result = await original(...args);
      scenario.setHeadHash(`0x${'44'.repeat(32)}`);
      return result;
    });
    await expect(scenario.adapter.resolveContextGraphIdsByNameHashes([NAME_HASH, OTHER_HASH]))
      .rejects.toThrow(/canonical chain anchor changed/i);
  });

  it('rejects historical provider high-water uncertainty for the whole batch', async () => {
    const scenario = batchHistory();
    const original = scenario.fence.loadProviderHighWaters.bind(scenario.fence);
    let calls = 0;
    vi.spyOn(scenario.fence, 'loadProviderHighWaters').mockImplementation(async () => {
      const snapshot = await original();
      return ++calls > 1 ? { ...snapshot, unavailableProviderCount: 1 } : snapshot;
    });
    await expect(scenario.adapter.resolveContextGraphIdsByNameHashes([NAME_HASH, OTHER_HASH]))
      .rejects.toThrow(/incomplete registry high-water/i);
  });

  it('provides complete normalized Mock adapter parity including private registrations', async () => {
    const adapter: any = new MockChainAdapter();
    adapter.contextGraphs.set(1n, { nameHash: NAME_HASH, accessPolicy: 1 });
    expect([...await adapter.resolveContextGraphIdsByNameHashes([NAME_HASH, OTHER_HASH])])
      .toEqual([[NAME_HASH, 1n], [OTHER_HASH, null]]);
    adapter.contextGraphs.set(2n, { nameHash: NAME_HASH, accessPolicy: 0 });
    await expect(adapter.resolveContextGraphIdsByNameHashes([NAME_HASH, OTHER_HASH])).rejects.toThrow(/ambiguous/i);
  });
});
