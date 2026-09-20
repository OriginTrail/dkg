// SPDX-License-Identifier: Apache-2.0

/**
 * The construction that makes the one log REAL.
 *
 * Everything below this file already existed and was inert; what is asserted
 * here is that a running node ends up with ONE tick issuing ONE `eth_getLogs`
 * per pass, and that the Hub window it publishes is clamped to coverage rather
 * than to a head probe of its own.
 */

import { describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';

import { createEvmChainIndexRuntime } from '../src/evm-chain-index-runtime.js';
import { MemoryChainEventLogStore } from './helpers/chain-event-log.js';

const HUB_ADDRESS = '0x00000000000000000000000000000000000000a1';
const CG_STORAGE_ADDRESS = '0x00000000000000000000000000000000000000b2';

const HUB_EVENTS = [
  'event NewContract(string contractName, address newContractAddress)',
  'event ContractChanged(string contractName, address newContractAddress)',
  'event ContractRemoved(string contractName)',
  'event NewAssetStorage(string contractName, address newContractAddress)',
  'event AssetStorageChanged(string contractName, address newContractAddress)',
  'event AssetStorageRemoved(string contractName)',
];

/** The seven signatures `CONTEXT_GRAPH_AUTHORITY_EVENT_NAMES` names, plus the KA one. */
const CG_STORAGE_EVENTS = [
  'event ContextGraphCreated(uint256 indexed contextGraphId, address indexed creator, bytes32 indexed nameHash, uint8 accessPolicy, uint8 publishPolicy)',
  'event ContextGraphDeactivated(uint256 indexed contextGraphId)',
  'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
  'event PublishPolicyUpdated(uint256 indexed contextGraphId, uint8 publishPolicy)',
  'event PublishAuthorityUpdated(uint256 indexed contextGraphId, address indexed agent, bool allowed)',
  'event AgentParticipantAdded(uint256 indexed contextGraphId, address indexed agent)',
  'event AgentParticipantRemoved(uint256 indexed contextGraphId, address indexed agent)',
  'event KnowledgeAssetRegisteredToContextGraph(uint256 indexed contextGraphId, uint256 indexed kaId)',
];

const hubInterface = new ethers.Interface(HUB_EVENTS);
const cgInterface = new ethers.Interface(CG_STORAGE_EVENTS);

/** A distinct, well-formed bytes32 per marker. */
function hexWord(marker: number): string {
  return `0x${marker.toString(16).padStart(64, '0')}`;
}

function rotationLog(
  contractName: string,
  blockNumber: number,
  index: number,
): ethers.Log {
  const encoded = hubInterface.encodeEventLog(hubInterface.getEvent('ContractChanged')!, [
    contractName,
    '0x00000000000000000000000000000000000000c1',
  ]);
  return {
    blockNumber,
    blockHash: hexWord(blockNumber),
    transactionHash: hexWord(blockNumber + 100),
    index,
    address: ethers.getAddress(HUB_ADDRESS),
    topics: encoded.topics,
    data: encoded.data,
  } as unknown as ethers.Log;
}

interface Harness {
  readonly store: MemoryChainEventLogStore;
  readonly heads: ReturnType<typeof vi.fn>;
  readonly getLogs: ReturnType<typeof vi.fn>;
  readonly blocks: ReturnType<typeof vi.fn>;
  readonly labels: string[];
  readonly runtime: ReturnType<typeof createEvmChainIndexRuntime>;
}

function harness(options?: {
  headNumber?: number;
  logs?: readonly ethers.Log[];
  reorgHoldbackBlocks?: number;
}): Harness {
  const headNumber = options?.headNumber ?? 1_000;
  const logs = options?.logs ?? [];
  const store = new MemoryChainEventLogStore();
  const labels: string[] = [];
  // Honours the ADDRESS array, not only the range. A fake that ignored it
  // would hand the Hub's own rotation back to the re-request the tick issues
  // for the newly bound address, and the duplicate would read as a decoder bug.
  const getLogs = vi.fn(async (filter: {
    address: readonly string[];
    fromBlock: number;
    toBlock: number;
  }) => {
    const wanted = new Set(filter.address.map((address) => address.toLowerCase()));
    return logs.filter((log) => log.blockNumber >= filter.fromBlock
      && log.blockNumber <= filter.toBlock
      && wanted.has(log.address.toLowerCase()));
  });
  const heads = vi.fn(async () => ({
    number: headNumber,
    hash: hexWord(headNumber),
    timestamp: 1_700_000_000,
  }));
  const blocks = vi.fn(async (blockNumber: number) => ({
    number: blockNumber,
    hash: hexWord(blockNumber),
    timestamp: 1_700_000_000,
  }));
  const provider = {
    getBlock: async (tag: string | number) => (
      tag === 'latest' ? heads() : blocks(tag as number)
    ),
    getLogs,
  };
  const runtime = createEvmChainIndexRuntime({
    scope: 'evm:31337:hub=0xa1:0xa1',
    store,
    intervalMs: 6_000,
    reorgHoldbackBlocks: options?.reorgHoldbackBlocks ?? 5,
    backfillPageBlocks: 100,
    maxCatchUpBlocks: 10_000,
    hub: {
      address: HUB_ADDRESS,
      contractInterface: hubInterface,
      deploymentBlockNumber: 1,
    },
    contextGraphStorage: {
      address: CG_STORAGE_ADDRESS,
      contractInterface: cgInterface,
      deploymentBlockNumber: 2,
    },
    readTipProvider: async (label, read) => {
      labels.push(label);
      return read(provider as never);
    },
  });
  return { store, heads, getLogs, blocks, labels, runtime };
}

describe('createEvmChainIndexRuntime', () => {
  it('spends ONE eth_getLogs and ONE head read on a pass', async () => {
    const h = harness();
    const result = await h.runtime.tick.runOnce(new AbortController().signal);

    expect(result.outcome).toBe('advanced');
    expect(result.logRequests).toBe(1);
    expect(h.getLogs).toHaveBeenCalledTimes(1);
    // The budget check: one head plus one settled-boundary hash, never a
    // per-contract probe.
    expect(h.heads).toHaveBeenCalledTimes(1);
    expect(h.labels.filter((label) => label === 'chainIndex tick getLogs')).toHaveLength(1);
  });

  it('asks for every indexed address in ONE filter', async () => {
    const h = harness();
    await h.runtime.tick.runOnce(new AbortController().signal);

    const filter = h.getLogs.mock.calls[0]![0] as {
      address: string[];
      topics: string[][];
    };
    expect([...filter.address].sort()).toEqual([HUB_ADDRESS, CG_STORAGE_ADDRESS].sort());
    // Six Hub signatures, seven authority signatures and the KA registration,
    // OR'd into one topic0 position.
    expect(filter.topics[0]!.length).toBe(14);
  });

  it('spends a SECOND request only for an address a rotation just bound', async () => {
    const h = harness({ logs: [rotationLog('ContextGraphStorage', 998, 0)] });
    const result = await h.runtime.tick.runOnce(new AbortController().signal);

    // The first page was fetched with the OLD array, so the blocks from the
    // rotation onwards were never looked at for the new address. That second
    // request is the tick's own documented cost, not a second scanner.
    expect(result.logRequests).toBe(2);
    expect(h.getLogs.mock.calls[1]![0]).toMatchObject({
      address: ['0x00000000000000000000000000000000000000c1'],
      fromBlock: 998,
      toBlock: 1_000,
    });
  });

  it('refuses a log it cannot place on a fork rather than storing it', async () => {
    const malformed = {
      ...rotationLog('ContextGraphStorage', 998, 0),
      blockHash: undefined,
    } as unknown as ethers.Log;
    const h = harness({ logs: [malformed] });
    const result = await h.runtime.tick.runOnce(new AbortController().signal);

    // The tail's entire reorg story is "the row is in the next tail or it is
    // not", which needs a block hash. A row without one is dropped at the port
    // instead of being stored for the decoders to guess about.
    expect(result.fetchedRows).toBe(0);
  });

  it('binds the addresses the tick actually walked', () => {
    const h = harness();
    expect(h.runtime.binding.contextGraphStorageAddress).toBe(CG_STORAGE_ADDRESS);
    expect(h.runtime.binding.knowledgeAssetStorageAddress).toBeUndefined();
    expect(h.runtime.binding.knowledgeAssets).toBeUndefined();
  });

  it('refuses a Hub window before the first pass has committed anything', async () => {
    const h = harness();
    await expect(h.runtime.binding.readHubRotationWindow!(undefined, 50))
      .resolves.toBeUndefined();
  });

  it('answers a BASELINE with no rotations, so history is never replayed', async () => {
    const h = harness({ logs: [rotationLog('ContextGraphStorage', 996, 0)] });
    await h.runtime.tick.runOnce(new AbortController().signal);

    const window = await h.runtime.binding.readHubRotationWindow!(undefined, 50);
    expect(window).toBeDefined();
    expect(window!.rotations).toHaveLength(0);
    // The baseline is the covered top, so the next pass starts above it.
    expect(window!.throughBlockNumber).toBe(1_000);
  });

  it('serves the rotations the tick already fetched, with no chain request', async () => {
    const h = harness({
      headNumber: 1_000,
      logs: [rotationLog('ContextGraphStorage', 998, 0)],
    });
    await h.runtime.tick.runOnce(new AbortController().signal);
    const before = h.getLogs.mock.calls.length + h.heads.mock.calls.length
      + h.blocks.mock.calls.length;

    // A cold start walked only [head - holdback, head], so the listener's
    // re-scan buffer has to fit inside it; a wider one is the refusal below.
    const window = await h.runtime.binding.readHubRotationWindow!(997, 2);

    expect(window!.rotations.map((rotation) => rotation.contractName))
      .toEqual(['ContextGraphStorage']);
    expect(window!.fromBlockNumber).toBe(996);
    expect(window!.throughBlockNumber).toBe(1_000);
    expect(
      h.getLogs.mock.calls.length + h.heads.mock.calls.length + h.blocks.mock.calls.length,
    ).toBe(before);
  });

  it('refuses a window whose bottom is BELOW what the log walked', async () => {
    const h = harness();
    await h.runtime.tick.runOnce(new AbortController().signal);

    // The cold start walked [head - holdback, head]; a listener sitting far
    // below that has blocks in between nobody looked at, and a rotation there
    // would be skipped forever if the window were served anyway.
    await expect(h.runtime.binding.readHubRotationWindow!(10, 50)).resolves.toBeUndefined();
  });

  it('reports an empty window rather than re-dispatching a block it already served', async () => {
    const h = harness({ logs: [rotationLog('ContextGraphStorage', 998, 0)] });
    await h.runtime.tick.runOnce(new AbortController().signal);

    const window = await h.runtime.binding.readHubRotationWindow!(1_000, 50);
    expect(window).toBeDefined();
    expect(window!.rotations).toHaveLength(0);
    expect(window!.throughBlockNumber).toBe(1_000);
  });
});
