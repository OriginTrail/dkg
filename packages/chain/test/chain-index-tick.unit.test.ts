// SPDX-License-Identifier: Apache-2.0

import { ethers } from 'ethers';
import { describe, expect, it } from 'vitest';

import { ChainEventDecoderRegistry } from '../src/chain-index/chain-event-decoders.js';
import {
  ChainIndexTick,
  type ChainEventLogFetchedRow,
  type ChainIndexLogRequest,
  type ChainIndexTickPorts,
} from '../src/chain-index/chain-index-tick.js';
import { loadAbi } from '../src/evm-adapter-abi.js';
import { MemoryChainEventLogStore } from './helpers/chain-event-log.js';

const SCOPE = 'evm:31337:0xhub:0xstorage';
const HUB = `0x${'ab'.repeat(20)}`;
const STORAGE = `0x${'cd'.repeat(20)}`;
const ROTATED_STORAGE = `0x${'ef'.repeat(20)}`;

const hash = (seed: number): string => `0x${seed.toString(16).padStart(2, '0').repeat(32)}`;

const hubInterface = new ethers.Interface(loadAbi('Hub'));
const storageInterface = new ethers.Interface(loadAbi('ContextGraphStorage'));

function registry(): ChainEventDecoderRegistry {
  return new ChainEventDecoderRegistry()
    .registerHub(HUB, hubInterface)
    .registerContextGraphAuthority(STORAGE, storageInterface);
}

interface RecordedRequest extends ChainIndexLogRequest {}

interface Harness {
  readonly ports: ChainIndexTickPorts;
  readonly requests: RecordedRequest[];
  readonly headReads: number[];
  readonly blockHashReads: number[];
  head: { number: number; hash: string; timestampSeconds: number };
  blockHashes: Map<number, string>;
  logs: (request: ChainIndexLogRequest) => readonly ChainEventLogFetchedRow[];
}

function harness(overrides: Partial<Harness> = {}): Harness {
  const state: Harness = {
    requests: [],
    headReads: [],
    blockHashReads: [],
    head: { number: 100, hash: hash(0x10), timestampSeconds: 1_700_000_000 },
    blockHashes: new Map<number, string>(),
    logs: () => [],
    ports: undefined as unknown as ChainIndexTickPorts,
    ...overrides,
  };
  state.ports = {
    readHead: async () => {
      state.headReads.push(state.head.number);
      return state.head;
    },
    readBlockHash: async (blockNumber) => {
      state.blockHashReads.push(blockNumber);
      return state.blockHashes.get(blockNumber) ?? hash(blockNumber);
    },
    readLogs: async (request) => {
      state.requests.push(request);
      return state.logs(request);
    },
  };
  return state;
}

function creationLog(
  blockNumber: number,
  logIndex: number,
  contextGraphId: bigint,
): ChainEventLogFetchedRow {
  const fragment = storageInterface.getEvent('ContextGraphCreated')!;
  const encoded = storageInterface.encodeEventLog(fragment, [
    contextGraphId,
    `0x${'11'.repeat(20)}`,
    `0x${'22'.repeat(32)}`,
    [`0x${'11'.repeat(20)}`],
    `0x${'33'.repeat(32)}`,
    1,
    0,
    `0x${'44'.repeat(20)}`,
    7n,
  ]);
  return {
    blockNumber,
    blockHash: hash(blockNumber),
    logIndex,
    transactionHash: hash(0xaa),
    address: STORAGE,
    topics: [...encoded.topics],
    data: encoded.data,
  };
}

function hubLog(
  blockNumber: number,
  logIndex: number,
  eventName: 'NewContract' | 'ContractChanged',
  contractName: string,
  address: string,
): ChainEventLogFetchedRow {
  const fragment = hubInterface.getEvent(eventName)!;
  const encoded = hubInterface.encodeEventLog(fragment, [contractName, address]);
  return {
    blockNumber,
    blockHash: hash(blockNumber),
    logIndex,
    transactionHash: hash(0xbb),
    address: HUB,
    topics: [...encoded.topics],
    data: encoded.data,
  };
}

function tick(
  store: MemoryChainEventLogStore,
  ports: ChainIndexTickPorts,
  options: Partial<ConstructorParameters<typeof ChainIndexTick>[1]> = {},
): ChainIndexTick {
  return new ChainIndexTick(ports, {
    scope: SCOPE,
    store,
    registry: registry(),
    deploymentBlockNumber: 10,
    reorgHoldbackBlocks: 5,
    backfillPageBlocks: 20,
    ...options,
  });
}

describe('ChainIndexTick — one log', () => {
  it('spends one head read and ONE eth_getLogs on a steady pass', async () => {
    const store = new MemoryChainEventLogStore();
    const rig = harness();
    const index = tick(store, rig.ports);

    await index.runOnce(new AbortController().signal);
    rig.requests.length = 0;
    rig.headReads.length = 0;
    rig.head = { number: 130, hash: hash(0x82), timestampSeconds: 1_700_000_060 };

    const result = await index.runOnce(new AbortController().signal);

    expect(result.outcome).toBe('advanced');
    // The whole node's demand for the indexed event set, per pass.
    expect(result.logRequests).toBe(1);
    expect(rig.headReads).toHaveLength(1);
    // Both Hub and ContextGraphStorage travel in the SAME request.
    expect(rig.requests[0]!.addresses).toEqual([HUB.toLowerCase(), STORAGE.toLowerCase()].sort());
    expect(rig.requests[0]!.fromBlock).toBe(96);
  });

  it('never re-reads a settled block: each pass starts above the cursor', async () => {
    const store = new MemoryChainEventLogStore();
    const rig = harness();
    const index = tick(store, rig.ports);

    await index.runOnce(new AbortController().signal);
    const firstSettled = (await store.load())!.cursor.settledBlockNumber;
    rig.head = { number: 140, hash: hash(0x8c), timestampSeconds: 1_700_000_120 };
    rig.requests.length = 0;
    await index.runOnce(new AbortController().signal);

    expect(rig.requests.every((request) => request.fromBlock > firstSettled)).toBe(true);
  });

  it('replaces the tail each pass so an orphaned log disappears', async () => {
    const store = new MemoryChainEventLogStore();
    const orphan = creationLog(99, 0, 4n);
    const rig = harness({ logs: () => [orphan] });
    const index = tick(store, rig.ports);
    await index.runOnce(new AbortController().signal);
    expect(store.rows().some((row) => row.blockNumber === 99 && !row.settled)).toBe(true);

    // The next pass simply does not return it; nothing rolls anything back.
    rig.logs = () => [];
    rig.head = { number: 101, hash: hash(0x11), timestampSeconds: 1_700_000_010 };
    await index.runOnce(new AbortController().signal);

    expect(store.rows().some((row) => row.blockNumber === 99)).toBe(false);
  });

  it('S4: a lagging endpoint is retryable and never tombstones the scope', async () => {
    const store = new MemoryChainEventLogStore();
    const rig = harness();
    const index = tick(store, rig.ports);
    await index.runOnce(new AbortController().signal);
    const settled = (await store.load())!.cursor.settledBlockNumber;

    // An endpoint whose head is BELOW the cursor knows nothing about the chain.
    rig.head = { number: settled - 10, hash: hash(0x01), timestampSeconds: 1_700_000_000 };
    const result = await index.runOnce(new AbortController().signal);

    expect(result.outcome).toBe('endpoint-lagging');
    expect(store.tombstones).toBe(0);
    expect((await store.load())?.cursor.settledBlockNumber).toBe(settled);
  });

  it('S4: one mismatched settled hash is suspected, a second confirms the tombstone', async () => {
    const store = new MemoryChainEventLogStore();
    const rig = harness();
    const index = tick(store, rig.ports);
    await index.runOnce(new AbortController().signal);
    const settled = (await store.load())!.cursor.settledBlockNumber;

    rig.blockHashes.set(settled, hash(0xfe));
    rig.head = { number: 120, hash: hash(0x78), timestampSeconds: 1_700_000_100 };
    const first = await index.runOnce(new AbortController().signal);
    expect(first.outcome).toBe('fork-suspected');
    expect(store.tombstones).toBe(0);

    const second = await index.runOnce(new AbortController().signal);
    expect(second.outcome).toBe('tombstoned');
    expect(store.tombstones).toBe(1);
    expect(await store.load()).toBeUndefined();
  });

  it('coverage reports what was looked at, not the head, while catching up', async () => {
    const store = new MemoryChainEventLogStore();
    const rig = harness({
      head: { number: 10_000, hash: hash(0x27), timestampSeconds: 1_700_000_000 },
    });
    const index = tick(store, rig.ports, { maxCatchUpBlocks: 50, resumeFromBlockNumber: 100 });

    await index.runOnce(new AbortController().signal);

    const coverage = (await store.load())!.coverage
      .find((entry) => entry.family === 'context-graph-authority')!;
    // Resumed at 101, so the cursor sat at 100 and one bounded pass climbed 50.
    expect(coverage.coveredThroughBlock).toBe(150);
    expect(coverage.coveredThroughBlock).toBeLessThan(10_000);
  });

  it('resumes from the existing checkpoint cursor instead of rescanning history', async () => {
    const store = new MemoryChainEventLogStore();
    const rig = harness({
      head: { number: 5_000, hash: hash(0x13), timestampSeconds: 1_700_000_000 },
    });
    const index = tick(store, rig.ports, { resumeFromBlockNumber: 4_000 });

    await index.runOnce(new AbortController().signal);

    // Not the deployment block (10): the folded prefix already covers below.
    expect(rig.requests[0]!.fromBlock).toBe(4_001);
  });

  it('re-queries a rotated address in the SAME pass', async () => {
    const store = new MemoryChainEventLogStore();
    const rig = harness();
    rig.logs = (request) => (
      request.addresses.includes(HUB.toLowerCase())
        ? [hubLog(98, 0, 'NewContract', 'ContextGraphStorage', ROTATED_STORAGE)]
        : []
    );
    const index = tick(store, rig.ports);

    await index.runOnce(new AbortController().signal);

    const requeried = rig.requests.filter((request) => (
      request.addresses.length === 1
      && request.addresses[0] === ROTATED_STORAGE.toLowerCase()
    ));
    expect(requeried).toHaveLength(1);
    expect(requeried[0]!.fromBlock).toBe(98);
  });

  it('treats the Hub emitting NewContract then ContractChanged as one rotation', async () => {
    const store = new MemoryChainEventLogStore();
    const rig = harness();
    rig.logs = (request) => (
      request.addresses.includes(HUB.toLowerCase())
        ? [
            hubLog(98, 0, 'NewContract', 'ContextGraphStorage', ROTATED_STORAGE),
            hubLog(98, 1, 'ContractChanged', 'ContextGraphStorage', ROTATED_STORAGE),
          ]
        : []
    );
    const index = tick(store, rig.ports);

    await index.runOnce(new AbortController().signal);

    expect(index.bindings.filter((binding) => binding.name === 'ContextGraphStorage'))
      .toHaveLength(1);
  });

  it('backfills one bounded page downwards and is resumable from coverage alone', async () => {
    const store = new MemoryChainEventLogStore();
    const rig = harness();
    const index = tick(store, rig.ports, { backfillPageBlocks: 20 });
    await index.runOnce(new AbortController().signal);
    const before = (await store.load())!.coverage
      .find((entry) => entry.family === 'context-graph-authority')!;

    rig.requests.length = 0;
    await index.backfillOnce(new AbortController().signal);
    const after = (await store.load())!.coverage
      .find((entry) => entry.family === 'context-graph-authority')!;

    expect(rig.requests).toHaveLength(1);
    expect(after.coveredFromBlock).toBe(before.coveredFromBlock - 20);
    expect(after.coveredThroughBlock).toBe(before.coveredThroughBlock);
  });

  it('stops the backfill exactly at the family floor', async () => {
    const store = new MemoryChainEventLogStore();
    const rig = harness();
    const index = tick(store, rig.ports, { backfillPageBlocks: 10_000 });
    await index.runOnce(new AbortController().signal);

    // One family per pass, so drain them; the point is where it STOPS.
    for (let pass = 0; pass < 8; pass += 1) {
      if ((await index.backfillOnce(new AbortController().signal)).outcome === 'idle') break;
    }
    const coverage = (await store.load())!.coverage;
    expect(coverage.map((entry) => entry.coveredFromBlock)).toEqual(coverage.map(() => 10));

    rig.requests.length = 0;
    const result = await index.backfillOnce(new AbortController().signal);
    expect(result.outcome).toBe('idle');
    expect(rig.requests).toHaveLength(0);
  });
});
