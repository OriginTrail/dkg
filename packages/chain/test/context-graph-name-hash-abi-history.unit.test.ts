// SPDX-License-Identifier: Apache-2.0

import { Contract, ethers, type JsonRpcProvider } from 'ethers';
import { describe, expect, it, vi } from 'vitest';

import { loadAbi } from '../src/evm-adapter-abi.js';
import { EvmContextGraphNameHashFence } from '../src/evm-context-graph-name-hash-fence.js';
import { EvmContextGraphNameHashResolver } from '../src/evm-context-graph-name-hash-resolver.js';
import { CONTEXT_GRAPH_NAME_HASH_FAST_ENUMERATION_MAX_IDS } from '../src/evm-context-graph-name-hash-fence.js';

const STORAGE_ADDRESS = '0x00000000000000000000000000000000000000c6';
const OWNER = '0x000000000000000000000000000000000000000b';
const NAME_HASH = `0x${'ab'.repeat(32)}`;
const OTHER_HASH = `0x${'cd'.repeat(32)}`;
const HEAD_HASH = `0x${'33'.repeat(32)}`;
const HISTORICAL_HIGH_WATER = CONTEXT_GRAPH_NAME_HASH_FAST_ENUMERATION_MAX_IDS + 1n;

type RawLog = {
  readonly blockNumber: number;
  readonly topics: readonly string[];
  readonly data: string;
};

function createdLog(
  contextGraphStorage: Contract,
  blockNumber: number,
  contextGraphId: bigint,
  nameHash: string,
): RawLog {
  const event = contextGraphStorage.interface.getEvent('ContextGraphCreated');
  if (event === null) throw new Error('ContextGraphCreated missing from shipped ABI');
  const encoded = contextGraphStorage.interface.encodeEventLog(event, [
    contextGraphId,
    OWNER,
    nameHash,
    [],
    0n,
    0,
    0,
    ethers.ZeroAddress,
    0n,
  ]);
  return { blockNumber, topics: encoded.topics, data: encoded.data };
}

function topicMatches(actual: string, expected: string | readonly string[] | null): boolean {
  if (expected === null) return true;
  return Array.isArray(expected)
    ? expected.some((candidate) => candidate.toLowerCase() === actual.toLowerCase())
    : expected.toLowerCase() === actual.toLowerCase();
}

describe('Context Graph name-hash historical ABI path', () => {
  it('uses the shipped ABI exact-topic filter and parsing while retaining page and high-water fences', async () => {
    // A real ethers Contract is important here: both the deferred filter and
    // parseLog are generated from the shipped ContextGraphStorage ABI. The
    // controlled query seam below emulates eth_getLogs topic matching only.
    const contextGraphStorage = new Contract(
      STORAGE_ADDRESS,
      loadAbi('ContextGraphStorage'),
    );
    const allLogs = [
      createdLog(contextGraphStorage, 100, 88n, OTHER_HASH),
      createdLog(contextGraphStorage, 102, 77n, NAME_HASH),
      createdLog(contextGraphStorage, 103, 89n, OTHER_HASH),
    ];
    const getBlock = vi.fn(async (blockNumber: number) => ({
      number: blockNumber,
      hash: HEAD_HASH,
    }));
    const provider = { getBlock } as unknown as JsonRpcProvider;
    const pageCalls: Array<{
      readonly lo: number;
      readonly hi: number;
      readonly topics: readonly (string | readonly string[] | null)[];
      readonly returnedIds: readonly bigint[];
    }> = [];
    const providerHighWaterReads: Array<{ readonly blockTag?: number } | undefined> = [];
    const currentSlotReads: bigint[] = [];

    const resolver = new EvmContextGraphNameHashResolver({
      source: new EvmContextGraphNameHashFence({
        initialize: async () => {},
        requireContextGraphStorage: () => contextGraphStorage,
        providers: () => [provider],
        rpcUrls: () => ['http://history.test.invalid'],
        scanPageSize: () => 2,
        ensureConfiguredStaticChainIdValidated: async () => 31337n,
        rebindContract: () => ({
          getLatestContextGraphId: async (options?: { blockTag?: number }) => {
            providerHighWaterReads.push(options);
            return HISTORICAL_HIGH_WATER;
          },
          getNameHash: async (id: bigint) => {
            currentSlotReads.push(id);
            return id === 77n ? NAME_HASH : OTHER_HASH;
          },
        }) as unknown as Contract,
        readLatestBlock: async () => ({ number: 103, hash: HEAD_HASH }),
        readAnchorHash: async () => HEAD_HASH,
        resolveContractDeployBlock: async () => ({
          fromBlock: 100,
          head: 103,
          scanProviders: [{ provider, backendHead: 103 }],
        }),
        queryEventLogsPage: async (_contract, filter, lo, hi) => {
          const topics = await (filter as {
            getTopicFilter: () => Promise<readonly (string | readonly string[] | null)[]>;
          }).getTopicFilter();
          const selected = allLogs.filter((log) =>
            log.blockNumber >= lo
            && log.blockNumber <= hi
            && topics.every((expected, index) => topicMatches(log.topics[index]!, expected)),
          );
          pageCalls.push({
            lo,
            hi,
            topics,
            returnedIds: selected.map((log) =>
              BigInt(contextGraphStorage.interface.parseLog(log)!.args.contextGraphId)),
          });
          return {
            logs: selected as unknown as readonly ethers.Log[],
            provider,
          };
        },
      }),
    });

    await expect(resolver.resolve(NAME_HASH)).resolves.toBe(77n);

    // The ABI filter is ContextGraphCreated(any id, any owner, NAME_HASH).
    // OTHER_HASH logs share topic0 but are excluded by indexed topic[3].
    expect(pageCalls.map(({ lo, hi }) => [lo, hi])).toEqual([
      [100, 101],
      [102, 103],
    ]);
    expect(pageCalls.map(({ returnedIds }) => returnedIds)).toEqual([[], [77n]]);
    expect(pageCalls[0]!.topics).toHaveLength(4);
    expect(pageCalls[0]!.topics[1]).toBeNull();
    expect(pageCalls[0]!.topics[2]).toBeNull();
    expect(pageCalls[0]!.topics[3]?.toString().toLowerCase()).toBe(NAME_HASH);

    // The scan is pinned to one registry counter at the exact scan head and
    // fenced against a current counter re-read before returning the binding.
    expect(providerHighWaterReads.filter((options) => options !== undefined)).toEqual([
      { blockTag: 103 },
    ]);
    // One current high-water chooses the historical lane; the historical
    // candidate verification and final registry fence add two more.
    expect(providerHighWaterReads.filter((options) => options === undefined)).toHaveLength(3);
    expect(currentSlotReads).toEqual([77n]);
    expect(getBlock).toHaveBeenCalledWith(103);
  });
});
