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
  // The Hub keeps contracts and asset storages in two registries with two event
  // sets (`Hub.sol:189-222`); the indexed storages live in the second one, so
  // that is what a rotation of THEM looks like.
  eventName: 'ContractChanged' | 'AssetStorageChanged' = 'ContractChanged',
): ethers.Log {
  const encoded = hubInterface.encodeEventLog(hubInterface.getEvent(eventName)!, [
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
  /** Wall clock the runtime reads, so a quiet tick can be aged on demand. */
  advanceMs(ms: number): void;
}

function harness(options?: {
  headNumber?: number;
  logs?: readonly ethers.Log[];
  reorgHoldbackBlocks?: number;
  /** T. Only the age bounds derived from it care, so it defaults. */
  intervalMs?: number;
  /**
   * Seconds added to every block timestamp the fake returns.
   *
   * A head stamped AHEAD of the host clock is a case both the cache and the
   * anchor treat as normal (skew, or a devnet after `evm_increaseTime`), and it
   * is what lets a test move the wall clock without the one-sided CHAIN-time
   * guard firing first and masking the fetch-time bound under test.
   */
  chainTimeLeadSeconds?: number;
}): Harness {
  const headNumber = options?.headNumber ?? 1_000;
  const logs = options?.logs ?? [];
  let nowMs = 1_700_000_000_000;
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
  const blockTimestamp = 1_700_000_000 + (options?.chainTimeLeadSeconds ?? 0);
  const heads = vi.fn(async () => ({
    number: headNumber,
    hash: hexWord(headNumber),
    timestamp: blockTimestamp,
  }));
  const blocks = vi.fn(async (blockNumber: number) => ({
    number: blockNumber,
    hash: hexWord(blockNumber),
    timestamp: blockTimestamp,
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
    intervalMs: options?.intervalMs ?? 6_000,
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
      // Exactly what the adapter passes: the registry this address was
      // resolved through. It seeds the tick's bindings, which is what makes a
      // rotation of this name a MOVE off this address.
      hubBinding: { name: 'ContextGraphStorage', kind: 'assetStorage' },
    },
    readTipProvider: async (label, read) => {
      labels.push(label);
      return read(provider as never);
    },
    now: () => nowMs,
  });
  return {
    store,
    heads,
    getLogs,
    blocks,
    labels,
    runtime,
    advanceMs: (ms: number) => { nowMs += ms; },
  };
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

  it('caps the rotated-away storage at its rebind block, end to end', async () => {
    const h = harness({
      logs: [rotationLog('ContextGraphStorage', 998, 0, 'AssetStorageChanged')],
    });
    await h.runtime.tick.runOnce(new AbortController().signal);

    const coverage = (await h.store.load('scope'))!.coverage.find((entry) => (
      entry.family === 'context-graph-authority'
      && entry.address === CG_STORAGE_ADDRESS.toLowerCase()
    ))!;
    // The composition root is the only place that knows which Hub name each
    // indexed address was resolved under, so this is where "a rotation retires
    // the old address" is either true for the running node or true only in the
    // tick's unit test.
    expect(coverage.coveredThroughBlock).toBe(997);
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

  it('refuses Hub baseline and empty windows while a fork suspicion is held', async () => {
    const h = harness();
    await h.runtime.tick.runOnce(new AbortController().signal);
    const state = (await h.store.load())!;
    h.store.seed({
      ...state,
      suspectedForkBlockNumber: state.cursor.settledBlockNumber,
    });

    await expect(h.runtime.binding.readHubRotationWindow!(undefined, 50))
      .resolves.toBeUndefined();
    await expect(h.runtime.binding.readHubRotationWindow!(1_000, 50))
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

  it('refuses a window the tick has gone quiet under, however servable it looks', async () => {
    const h = harness({ logs: [rotationLog('ContextGraphStorage', 998, 0)] });
    await h.runtime.tick.runOnce(new AbortController().signal);
    // Same call, same coverage, and it IS servable — this is the one below,
    // asserted here before the clock moves so the refusal cannot be vacuous.
    await expect(h.runtime.binding.readHubRotationWindow!(1_000, 50))
      .resolves.toBeDefined();

    // A tick that stopped committing looks exactly like a chain that stopped
    // producing: coverage frozen, "nothing new walked". The listener treats any
    // window as handled and skips its live scan, so an hour-old log would hold
    // Hub-binding invalidation for as long as the tick stayed quiet — against
    // the 30s memo TTL that is meant to be the backstop.
    h.advanceMs(3 * 6_000 + 1);

    await expect(h.runtime.binding.readHubRotationWindow!(1_000, 50))
      .resolves.toBeUndefined();
    // And the baseline is refused too: a listener with no cursor must not take
    // one from a log that cannot say how old its own answer is.
    await expect(h.runtime.binding.readHubRotationWindow!(undefined, 50))
      .resolves.toBeUndefined();
  });

  it('caps the authority anchor age at the ceiling the projection cache caps staleMs at', async () => {
    // The log path is documented as the cache's gates minus the tick gate, so
    // it must not answer where the cache would refuse. `max(3T, 15s)` alone
    // breaks that above T=100s: at T=150s the cache stops at 300s and an
    // uncapped log ran to 450s, and `resolveContextGraphAuthorityIndexTickMs`
    // accepts that T. The ceiling is the cache's own.
    const h = harness({ intervalMs: 150_000, chainTimeLeadSeconds: 3_600 });
    await h.runtime.tick.runOnce(new AbortController().signal);
    // Coverage must reach the ContextGraphStorage deploy block first, or the
    // anchor refuses for a reason that is not the age.
    for (let pass = 0; pass < 20; pass += 1) {
      if ((await h.runtime.tick.backfillOnce(new AbortController().signal)).outcome === 'idle') {
        break;
      }
    }
    const anchor = () => h.runtime.binding.contextGraphAuthority!.resolveAnchor({
      deploymentBlockNumber: 2,
      finalityConfirmations: 1,
    });
    await expect(anchor()).resolves.toMatchObject({ anchor: expect.anything() });

    // 3T is 450s. The cache's `staleMs` is min(450s, 5m) = 300s, and so is this.
    h.advanceMs(299_000);
    await expect(anchor()).resolves.toMatchObject({ anchor: expect.anything() });
    h.advanceMs(2_000);

    await expect(anchor()).resolves.toEqual({ refusal: 'stale-head' });
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
