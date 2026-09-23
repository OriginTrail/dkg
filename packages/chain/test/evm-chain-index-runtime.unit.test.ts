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
const RUNTIME_SCOPE = 'evm:31337:hub=0xa1:0xa1';

const HUB_EVENTS = [
  'event NewContract(string contractName, address newContractAddress)',
  'event ContractChanged(string contractName, address newContractAddress)',
  'event ContractRemoved(string contractName, address contractAddress)',
  'event NewAssetStorage(string contractName, address newContractAddress)',
  'event AssetStorageChanged(string contractName, address newContractAddress)',
  'event AssetStorageRemoved(string contractName, address contractAddress)',
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
const CONTEXT_GRAPH_CREATED_SCAN_IDENTITY = Object.freeze({
  eventType: 'ContextGraphCreated' as const,
  contextGraphStorageAddress: CG_STORAGE_ADDRESS,
  topic0: cgInterface.getEvent('ContextGraphCreated')!.topicHash,
});
const CONTEXT_GRAPH_KA_SCAN_IDENTITY = Object.freeze({
  eventType: 'KnowledgeAssetRegisteredToContextGraph' as const,
  contextGraphStorageAddress: CG_STORAGE_ADDRESS,
  topic0: cgInterface.getEvent('KnowledgeAssetRegisteredToContextGraph')!.topicHash,
});

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
  eventName: 'ContractChanged' | 'AssetStorageChanged' | 'ContractRemoved' | 'AssetStorageRemoved'
    = 'ContractChanged',
  contractAddress = '0x00000000000000000000000000000000000000c1',
): ethers.Log {
  const encoded = hubInterface.encodeEventLog(hubInterface.getEvent(eventName)!, [
    contractName,
    contractAddress,
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
  readonly usageConsumers: string[];
  readonly runtime: ReturnType<typeof createEvmChainIndexRuntime>;
  /** Every delay requested by the real runtime-owned runner. */
  readonly runnerDelays: number[];
  /** Fire the currently scheduled runner timer and settle its pass. */
  fireRunner(): Promise<void>;
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
  resumeFromBlockNumber?: number;
  /** Deploy both indexed contracts here; defaults to their real fixture floors. */
  deploymentBlockNumber?: number;
  /** Refuse wider eth_getLogs spans the way mainnet.base.org does. */
  maxLogRangeBlocks?: number;
}): Harness {
  const headNumber = options?.headNumber ?? 1_000;
  const logs = options?.logs ?? [];
  let nowMs = 1_700_000_000_000;
  const store = new MemoryChainEventLogStore();
  const labels: string[] = [];
  const usageConsumers: string[] = [];
  const runnerDelays: number[] = [];
  let runnerTimer: (() => void) | undefined;
  let runnerDelayMs = 0;
  // Honours the ADDRESS array, not only the range. A fake that ignored it
  // would hand the Hub's own rotation back to the re-request the tick issues
  // for the newly bound address, and the duplicate would read as a decoder bug.
  const getLogs = vi.fn(async (filter: {
    address: readonly string[];
    fromBlock: number;
    toBlock: number;
  }) => {
    const cap = options?.maxLogRangeBlocks;
    if (cap !== undefined && filter.toBlock - filter.fromBlock + 1 > cap) {
      throw new Error(`eth_getLogs is limited to a ${cap.toLocaleString('en-US')} range`);
    }
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
    scope: RUNTIME_SCOPE,
    store,
    intervalMs: options?.intervalMs ?? 6_000,
    reorgHoldbackBlocks: options?.reorgHoldbackBlocks ?? 5,
    backfillPageBlocks: 100,
    maxCatchUpBlocks: 10_000,
    ...(options?.resumeFromBlockNumber === undefined
      ? {}
      : { resumeFromBlockNumber: options.resumeFromBlockNumber }),
    hub: {
      address: HUB_ADDRESS,
      contractInterface: hubInterface,
      deploymentBlockNumber: options?.deploymentBlockNumber ?? 1,
    },
    contextGraphStorage: {
      address: CG_STORAGE_ADDRESS,
      contractInterface: cgInterface,
      deploymentBlockNumber: options?.deploymentBlockNumber ?? 2,
      // Exactly what the adapter passes: the registry this address was
      // resolved through. It seeds the tick's bindings, which is what makes a
      // rotation of this name a MOVE off this address.
      hubBinding: { name: 'ContextGraphStorage', kind: 'assetStorage' },
    },
    readTipProvider: async (label, read, readOptions) => {
      labels.push(label);
      if (typeof readOptions?.rpcUsageConsumer === 'string') {
        usageConsumers.push(readOptions.rpcUsageConsumer);
      }
      return read(provider as never);
    },
    now: () => nowMs,
    runnerHooks: {
      now: () => nowMs,
      setTimer: (fn, ms) => {
        runnerDelays.push(ms);
        runnerTimer = fn;
        runnerDelayMs = ms;
        return 0 as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimer: () => { runnerTimer = undefined; },
    },
  });
  return {
    store,
    heads,
    getLogs,
    blocks,
    labels,
    usageConsumers,
    runtime,
    runnerDelays,
    fireRunner: async () => {
      const timer = runnerTimer;
      const scheduledBeforePass = runnerDelays.length;
      runnerTimer = undefined;
      nowMs += runnerDelayMs;
      runnerDelayMs = 0;
      timer?.();
      for (let drain = 0; drain < 50 && runnerDelays.length === scheduledBeforePass; drain += 1) {
        await Promise.resolve();
      }
    },
    advanceMs: (ms: number) => { nowMs += ms; },
  };
}

describe('createEvmChainIndexRuntime', () => {
  it('wires the production idle budget to the anchor ceiling at large T', async () => {
    // T=150s: Hub liveness accepts 450s, while the authority anchor caps at
    // 300s. One third of the binding 300s bound is held as static headroom,
    // leaving a useful 200s idle delay even though T is half the capped budget.
    // A deleted budget stays at 150s; using the Hub bound widens to 300s.
    const h = harness({
      intervalMs: 150_000,
      deploymentBlockNumber: 1_000,
      chainTimeLeadSeconds: 3_600,
    });
    h.runtime.start();

    for (let pass = 0; pass < 3; pass += 1) await h.fireRunner();

    expect(h.runnerDelays).toEqual([0, 150_000, 150_000, 200_000]);
    await h.runtime.stop();
  });

  it('threads the existing authority cursor into the first one-log range', async () => {
    const h = harness({ headNumber: 5_000, resumeFromBlockNumber: 4_000 });

    await h.runtime.tick.runOnce(new AbortController().signal);

    expect(h.getLogs).toHaveBeenCalled();
    expect(h.getLogs.mock.calls[0]![0].fromBlock).toBe(4_001);
    const authority = (await h.store.load(RUNTIME_SCOPE))?.coverage.find(
      (entry) => entry.family === 'context-graph-authority',
    );
    expect(authority?.coveredFromBlock).toBe(4_001);
  });

  it('fits a catch-up range wider than the provider\'s eth_getLogs span cap', async () => {
    // A node resuming 4,000 blocks behind its folded checkpoint.
    const h = harness({
      headNumber: 5_000,
      resumeFromBlockNumber: 1_000,
      maxLogRangeBlocks: 2_000,
    });
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const result = await h.runtime.tick.runOnce(new AbortController().signal);

      expect(result.outcome).toBe('advanced');
      const ranges = h.getLogs.mock.calls.map(([filter]) => [filter.fromBlock, filter.toBlock]);
      const [refused, ...served] = ranges;
      expect(refused![1]! - refused![0]! + 1).toBeGreaterThan(2_000);
      // The refused range, re-read in contiguous spans the provider accepts.
      expect(served[0]![0]).toBe(refused![0]);
      expect(served.every(([from, to]) => to! - from! + 1 <= 2_000)).toBe(true);
      expect(served.some(([, to]) => to === refused![1])).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

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
    expect(h.usageConsumers).toContain('chainIndex.head');
    expect(h.usageConsumers).toContain('chainIndex.lineage');
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

    const coverage = (await h.store.load(RUNTIME_SCOPE))!.coverage.find((entry) => (
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
    // The remaining KA views consume ContextGraphStorage events only; a node
    // does not need DKGKnowledgeAssets bound to serve positive bindings and
    // known ordinals.
    expect(h.runtime.binding.knowledgeAssets).toBeDefined();
  });

  it('refuses an event-scan horizon before the first pass commits', async () => {
    const h = harness();

    await expect(h.runtime.binding.readEventScanLease!(CONTEXT_GRAPH_CREATED_SCAN_IDENTITY))
      .resolves.toBeUndefined();
  });

  it('lends each exact-family lease without another chain request', async () => {
    const h = harness();
    await h.runtime.tick.runOnce(new AbortController().signal);
    const state = (await h.store.load(RUNTIME_SCOPE))!;
    h.store.seed(RUNTIME_SCOPE, {
      ...state,
      coverage: state.coverage.map((entry) => entry.family === 'context-graph-ka'
        ? { ...entry, coveredThroughBlock: 997 }
        : entry),
    });
    const requestsBefore = h.getLogs.mock.calls.length + h.heads.mock.calls.length
      + h.blocks.mock.calls.length;

    const created = await h.runtime.binding.readEventScanLease!(
      CONTEXT_GRAPH_CREATED_SCAN_IDENTITY,
    );
    const registered = await h.runtime.binding.readEventScanLease!(
      CONTEXT_GRAPH_KA_SCAN_IDENTITY,
    );
    expect(created?.throughBlockNumber).toBe(1_000);
    expect(registered?.throughBlockNumber).toBe(997);
    await expect(created!.holds()).resolves.toBe(true);
    await expect(registered!.holds()).resolves.toBe(true);
    expect(
      h.getLogs.mock.calls.length + h.heads.mock.calls.length + h.blocks.mock.calls.length,
    ).toBe(requestsBefore);

    // Corrupt/forward coverage must never turn this into a head oracle: the
    // runtime lends at most the head whose lineage it actually observed.
    h.store.seed(RUNTIME_SCOPE, {
      ...state,
      coverage: state.coverage.map((entry) => ({
        ...entry,
        coveredThroughBlock: 1_010,
      })),
    });
    const capped = await h.runtime.binding.readEventScanLease!(
      CONTEXT_GRAPH_CREATED_SCAN_IDENTITY,
    );
    expect(capped?.throughBlockNumber).toBe(1_000);
  });

  it('refuses an event-scan lease unless its address and selected topic match exactly', async () => {
    const h = harness();
    await h.runtime.tick.runOnce(new AbortController().signal);

    await expect(h.runtime.binding.readEventScanLease!({
      ...CONTEXT_GRAPH_CREATED_SCAN_IDENTITY,
      contextGraphStorageAddress: '0x00000000000000000000000000000000000000c3',
    })).resolves.toBeUndefined();
    await expect(h.runtime.binding.readEventScanLease!({
      ...CONTEXT_GRAPH_CREATED_SCAN_IDENTITY,
      topic0: hexWord(91),
    })).resolves.toBeUndefined();
    await expect(h.runtime.binding.readEventScanLease!({
      ...CONTEXT_GRAPH_KA_SCAN_IDENTITY,
      topic0: hexWord(92),
    })).resolves.toBeUndefined();
  });

  it('refuses coverage committed by a different decoder topic generation', async () => {
    const h = harness();
    await h.runtime.tick.runOnce(new AbortController().signal);
    const state = (await h.store.load(RUNTIME_SCOPE))!;
    h.store.seed(RUNTIME_SCOPE, {
      ...state,
      cursor: { ...state.cursor, topicSetVersion: 'retired-topics' },
    });

    await expect(h.runtime.binding.readEventScanLease!(CONTEXT_GRAPH_CREATED_SCAN_IDENTITY))
      .resolves.toBeUndefined();
  });

  it('refuses an event-scan lease without exact-address coverage for its family', async () => {
    const h = harness();
    await h.runtime.tick.runOnce(new AbortController().signal);
    const state = (await h.store.load(RUNTIME_SCOPE))!;
    h.store.seed(RUNTIME_SCOPE, {
      ...state,
      coverage: state.coverage.map((entry) => entry.family === 'context-graph-ka'
        ? { ...entry, address: '0x00000000000000000000000000000000000000c3' }
        : entry),
    });
    await expect(h.runtime.binding.readEventScanLease!(CONTEXT_GRAPH_KA_SCAN_IDENTITY))
      .resolves.toBeUndefined();

    h.store.seed(RUNTIME_SCOPE, {
      ...state,
      coverage: state.coverage.filter((entry) => entry.family !== 'context-graph-ka'),
    });

    await expect(h.runtime.binding.readEventScanLease!(CONTEXT_GRAPH_KA_SCAN_IDENTITY))
      .resolves.toBeUndefined();
  });

  it('retires a lease when the underlying log revision changes', async () => {
    const h = harness();
    await h.runtime.tick.runOnce(new AbortController().signal);
    const lease = await h.runtime.binding.readEventScanLease!(
      CONTEXT_GRAPH_CREATED_SCAN_IDENTITY,
    );
    expect(lease).toBeDefined();
    await expect(lease!.holds()).resolves.toBe(true);

    const state = (await h.store.load(RUNTIME_SCOPE))!;
    h.store.seed(RUNTIME_SCOPE, {
      ...state,
      cursor: { ...state.cursor, revision: state.cursor.revision + 1 },
    });
    await expect(lease!.holds()).resolves.toBe(false);
  });

  it('refuses event-scan horizons from frozen, future-stamped or fork-suspect state', async () => {
    const h = harness();
    await h.runtime.tick.runOnce(new AbortController().signal);

    h.advanceMs(3 * 6_000 + 1);
    await expect(h.runtime.binding.readEventScanLease!(CONTEXT_GRAPH_CREATED_SCAN_IDENTITY))
      .resolves.toBeUndefined();

    h.advanceMs(-(3 * 6_000 + 2));
    await expect(h.runtime.binding.readEventScanLease!(CONTEXT_GRAPH_CREATED_SCAN_IDENTITY))
      .resolves.toBeUndefined();

    h.advanceMs(1);
    const state = (await h.store.load(RUNTIME_SCOPE))!;
    h.store.seed(RUNTIME_SCOPE, {
      ...state,
      suspectedForkBlockNumber: state.cursor.settledBlockNumber,
    });
    await expect(h.runtime.binding.readEventScanLease!(CONTEXT_GRAPH_CREATED_SCAN_IDENTITY))
      .resolves.toBeUndefined();
  });

  it('refuses a Hub window before the first pass has committed anything', async () => {
    const h = harness();
    await expect(h.runtime.binding.readHubRotationWindow!(undefined, 50))
      .resolves.toBeUndefined();
  });

  it('refuses Hub baseline and empty windows while a fork suspicion is held', async () => {
    const h = harness();
    await h.runtime.tick.runOnce(new AbortController().signal);
    const state = (await h.store.load(RUNTIME_SCOPE))!;
    h.store.seed(RUNTIME_SCOPE, {
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

  it('surfaces a pure Hub removal to the adapter listener from the one-log window', async () => {
    const h = harness({
      headNumber: 1_000,
      logs: [rotationLog(
        'ContextGraphStorage',
        998,
        0,
        'AssetStorageRemoved',
        CG_STORAGE_ADDRESS,
      )],
    });
    await h.runtime.tick.runOnce(new AbortController().signal);

    const window = await h.runtime.binding.readHubRotationWindow!(997, 2);

    expect(window!.rotations).toEqual([{
      blockNumber: 998,
      blockHash: hexWord(998),
      logIndex: 0,
      contractName: 'ContextGraphStorage',
    }]);
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

  it('refuses a Hub window when the wall clock is behind its fetch stamp', async () => {
    const h = harness();
    await h.runtime.tick.runOnce(new AbortController().signal);
    h.advanceMs(-1);

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
