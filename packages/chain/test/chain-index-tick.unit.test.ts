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
import type { ChainEventLogCoverage } from '../src/chain-index/chain-event-log.js';
import { resolveChainIndexAuthorityAnchor } from '../src/chain-index/chain-index-anchor.js';
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
  /** A `null` entry is an endpoint that CANNOT answer for that block. */
  blockHashes: Map<number, string | null>;
  logs: (request: ChainIndexLogRequest) => readonly ChainEventLogFetchedRow[];
}

function harness(overrides: Partial<Harness> = {}): Harness {
  const state: Harness = {
    requests: [],
    headReads: [],
    blockHashReads: [],
    head: { number: 100, hash: hash(0x10), timestampSeconds: 1_700_000_000 },
    blockHashes: new Map<number, string | null>(),
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
      return state.blockHashes.has(blockNumber)
        ? state.blockHashes.get(blockNumber)!
        : hash(blockNumber);
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
  eventName: 'NewContract' | 'ContractChanged' | 'ContractRemoved',
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

/** `ContextGraphStorage` as the adapter resolved it, before any rotation. */
const BOUND_STORAGE = Object.freeze([Object.freeze({
  name: 'ContextGraphStorage',
  kind: 'contract' as const,
  address: STORAGE.toLowerCase(),
  fromBlock: 10,
})]);

function authorityCoverage(
  coverage: readonly ChainEventLogCoverage[],
  address: string,
): ChainEventLogCoverage | undefined {
  return coverage.find((entry) => entry.family === 'context-graph-authority'
    && entry.address === address.toLowerCase());
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
    const firstSettled = (await store.load(SCOPE))!.cursor.settledBlockNumber;
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
    expect(store.rows(SCOPE).some((row) => row.blockNumber === 99 && !row.settled)).toBe(true);

    // The next pass simply does not return it; nothing rolls anything back.
    rig.logs = () => [];
    rig.head = { number: 101, hash: hash(0x11), timestampSeconds: 1_700_000_010 };
    await index.runOnce(new AbortController().signal);

    expect(store.rows(SCOPE).some((row) => row.blockNumber === 99)).toBe(false);
  });

  it('S4: a lagging endpoint is retryable and never tombstones the scope', async () => {
    const store = new MemoryChainEventLogStore();
    const rig = harness();
    const index = tick(store, rig.ports);
    await index.runOnce(new AbortController().signal);
    const settled = (await store.load(SCOPE))!.cursor.settledBlockNumber;

    // An endpoint whose head is BELOW the cursor knows nothing about the chain.
    rig.head = { number: settled - 10, hash: hash(0x01), timestampSeconds: 1_700_000_000 };
    const result = await index.runOnce(new AbortController().signal);

    expect(result.outcome).toBe('endpoint-lagging');
    expect(store.tombstones).toBe(0);
    expect((await store.load(SCOPE))?.cursor.settledBlockNumber).toBe(settled);
  });

  it('S4: one mismatched settled hash is suspected, a second confirms the tombstone', async () => {
    const store = new MemoryChainEventLogStore();
    const rig = harness();
    const index = tick(store, rig.ports);
    await index.runOnce(new AbortController().signal);
    const settled = (await store.load(SCOPE))!.cursor.settledBlockNumber;

    rig.blockHashes.set(settled, hash(0xfe));
    rig.head = { number: 120, hash: hash(0x78), timestampSeconds: 1_700_000_100 };
    const first = await index.runOnce(new AbortController().signal);
    expect(first.outcome).toBe('fork-suspected');
    expect(store.tombstones).toBe(0);

    const second = await index.runOnce(new AbortController().signal);
    expect(second.outcome).toBe('tombstoned');
    expect(store.tombstones).toBe(1);
    expect(await store.load(SCOPE)).toBeUndefined();
  });

  it('keeps the verified settled boundary when the next boundary hash is unavailable', async () => {
    const store = new MemoryChainEventLogStore();
    const rig = harness();
    const index = tick(store, rig.ports);
    await index.runOnce(new AbortController().signal);
    const verified = (await store.load(SCOPE))!.cursor;

    rig.head = { number: 151, hash: hash(0x97), timestampSeconds: 1_700_000_100 };
    const nextBoundary = rig.head.number - 5;
    rig.blockHashes.set(nextBoundary, null);
    await index.runOnce(new AbortController().signal);

    const retained = (await store.load(SCOPE))!.cursor;
    expect(retained.settledBlockNumber).toBe(verified.settledBlockNumber);
    expect(retained.settledBlockHash).toBe(verified.settledBlockHash);
    expect(await store.blockHashAt(SCOPE, retained.settledBlockNumber))
      .toBe(verified.settledBlockHash);

    // The retained real hash remains the next pass's deep-reorg fence.
    rig.blockHashes.set(verified.settledBlockNumber, hash(0xfe));
    const mismatch = await index.runOnce(new AbortController().signal);
    expect(mismatch.outcome).toBe('fork-suspected');
  });

  it('does not expose a cold-start zero boundary as a known block hash', async () => {
    const store = new MemoryChainEventLogStore();
    const rig = harness({ logs: () => [creationLog(95, 0, 4n)] });
    rig.blockHashes.set(95, null);
    const index = tick(store, rig.ports);

    await index.runOnce(new AbortController().signal);

    const cursor = (await store.load(SCOPE))!.cursor;
    expect(cursor.settledBlockNumber).toBe(94);
    expect(await store.blockHashAt(SCOPE, cursor.settledBlockNumber)).toBeUndefined();
    expect(store.rows(SCOPE)).toHaveLength(1);
    expect(store.rows(SCOPE)[0]?.settled).toBe(false);
  });

  it('coverage reports what was looked at, not the head, while catching up', async () => {
    const store = new MemoryChainEventLogStore();
    const rig = harness({
      head: { number: 10_000, hash: hash(0x27), timestampSeconds: 1_700_000_000 },
    });
    const index = tick(store, rig.ports, { maxCatchUpBlocks: 50, resumeFromBlockNumber: 100 });

    await index.runOnce(new AbortController().signal);

    const coverage = (await store.load(SCOPE))!.coverage
      .find((entry) => entry.family === 'context-graph-authority')!;
    // Resumed at 101, so the cursor sat at 100 and one bounded pass climbed 50.
    expect(coverage.coveredThroughBlock).toBe(150);
    expect(coverage.coveredThroughBlock).toBeLessThan(10_000);
  });

  it('restarts coverage at the fetched range when the subscribed topic set changes', async () => {
    const store = new MemoryChainEventLogStore();
    const rig = harness();
    const decoderRegistry = registry();
    const index = tick(store, rig.ports, { registry: decoderRegistry, backfillPageBlocks: 20 });

    await index.runOnce(new AbortController().signal);
    await index.backfillOnce(new AbortController().signal);
    const before = authorityCoverage((await store.load(SCOPE))!.coverage, STORAGE)!;

    // Widen the same address from authority events to include KA registration.
    // Blocks walked under the old filter prove nothing about the added topic.
    decoderRegistry.registerContextGraphKnowledgeAssets(STORAGE, storageInterface);
    rig.requests.length = 0;
    rig.head = { number: 110, hash: hash(0x6e), timestampSeconds: 1_700_000_060 };

    await index.runOnce(new AbortController().signal);

    const fetchedFrom = rig.requests[0]!.fromBlock;
    const after = authorityCoverage((await store.load(SCOPE))!.coverage, STORAGE)!;
    expect(after.coveredFromBlock).toBe(fetchedFrom);
    expect(after.coveredFromBlock).toBeGreaterThan(before.coveredFromBlock);
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

  it('STOPS the retired address covering blocks past the one it was rebound at', async () => {
    const store = new MemoryChainEventLogStore();
    const rig = harness();
    rig.logs = (request) => (
      request.addresses.includes(HUB.toLowerCase())
        ? [hubLog(98, 0, 'NewContract', 'ContextGraphStorage', ROTATED_STORAGE)]
        : []
    );
    // The binding the adapter resolved out of the Hub. Without it the rotation
    // is a name seen for the FIRST time, nothing is retired, and the coverage
    // below marches on over a contract the Hub no longer points at.
    const index = tick(store, rig.ports, { initialBindings: BOUND_STORAGE });

    await index.runOnce(new AbortController().signal);

    const coverage = (await store.load(SCOPE))!.coverage;
    const retired = authorityCoverage(coverage, STORAGE)!;
    // The pass read through the head at 100 and its request array still carried
    // the old address — but 98 is where the Hub stopped meaning it, and 98
    // itself holds the rebind transaction, so the top it may claim is 97.
    // Everything above that is refused, which is the only thing that stops a
    // lane advancing past events the NEW contract emitted.
    expect(retired.coveredThroughBlock).toBe(97);
    // And the blocks the same pass DID re-query for the new address are
    // recorded under it, instead of being rows nothing can ever serve.
    const successor = authorityCoverage(coverage, ROTATED_STORAGE)!;
    expect(successor).toBeDefined();
    expect(successor.coveredFromBlock).toBe(98);
    expect(successor.coveredThroughBlock).toBe(100);
    // The rebind block, not the old contract's floor: nothing below it was
    // this name's history.
    expect(successor.floorBlock).toBe(98);
  });

  it('keeps the retired address frozen at the rebind block on every later pass', async () => {
    const store = new MemoryChainEventLogStore();
    const rig = harness();
    rig.logs = (request) => (
      request.addresses.includes(HUB.toLowerCase())
        ? [hubLog(98, 0, 'NewContract', 'ContextGraphStorage', ROTATED_STORAGE)]
        : []
    );
    const index = tick(store, rig.ports, { initialBindings: BOUND_STORAGE });
    await index.runOnce(new AbortController().signal);

    // The rotation now sits BELOW the settled cursor, so no later pass re-reads
    // the Hub row that announced it. The ceiling has to survive that.
    rig.logs = () => [];
    rig.head = { number: 140, hash: hash(0x8c), timestampSeconds: 1_700_000_120 };
    await index.runOnce(new AbortController().signal);

    expect(authorityCoverage((await store.load(SCOPE))!.coverage, STORAGE)!.coveredThroughBlock)
      .toBe(97);
  });

  it('STOPS coverage at a pure Hub removal and keeps it frozen without a successor', async () => {
    const store = new MemoryChainEventLogStore();
    const rig = harness();
    rig.logs = (request) => (
      request.addresses.includes(HUB.toLowerCase())
        ? [hubLog(98, 0, 'ContractRemoved', 'ContextGraphStorage', STORAGE)]
        : []
    );
    const index = tick(store, rig.ports, { initialBindings: BOUND_STORAGE });

    await index.runOnce(new AbortController().signal);

    let coverage = (await store.load(SCOPE))!.coverage;
    expect(authorityCoverage(coverage, STORAGE)!.coveredThroughBlock).toBe(97);
    expect(coverage.filter((entry) => entry.family === 'context-graph-authority'))
      .toHaveLength(1);

    // The removal row is now below the settled cursor. The in-memory binding
    // boundary must continue refusing post-removal coverage without inventing
    // a successor address.
    rig.logs = () => [];
    rig.head = { number: 140, hash: hash(0x8c), timestampSeconds: 1_700_000_120 };
    await index.runOnce(new AbortController().signal);

    coverage = (await store.load(SCOPE))!.coverage;
    expect(authorityCoverage(coverage, STORAGE)!.coveredThroughBlock).toBe(97);
    expect(coverage.filter((entry) => entry.family === 'context-graph-authority'))
      .toHaveLength(1);
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
    const before = (await store.load(SCOPE))!.coverage
      .find((entry) => entry.family === 'context-graph-authority')!;

    rig.requests.length = 0;
    await index.backfillOnce(new AbortController().signal);
    const after = (await store.load(SCOPE))!.coverage
      .find((entry) => entry.family === 'context-graph-authority')!;

    expect(rig.requests).toHaveLength(1);
    expect(after.coveredFromBlock).toBe(before.coveredFromBlock - 20);
    expect(after.coveredThroughBlock).toBe(before.coveredThroughBlock);
  });

  /**
   * THE invariant, at the tick: coverage claims a block ⇒ the rows it held are
   * still in the log.
   *
   * Every "is this absent?" answer is a coverage check followed by a read, so a
   * pass that can drop rows inside a claimed range turns "indexed, and nothing
   * there" into the answer for a block that really held an event.
   */
  async function expectCoverageAndRowsAgree(
    store: MemoryChainEventLogStore,
    blockNumbersThatHeldRows: readonly number[],
  ): Promise<void> {
    const state = await store.load(SCOPE);
    if (state === undefined) return;
    for (const coverage of state.coverage) {
      for (const blockNumber of blockNumbersThatHeldRows) {
        if (blockNumber < coverage.coveredFromBlock) continue;
        if (blockNumber > coverage.coveredThroughBlock) continue;
        expect(store.rows(SCOPE).some((row) => row.blockNumber === blockNumber)).toBe(true);
      }
    }
  }

  it('never lets coverage outlive the rows it claims, whatever a pass does', async () => {
    const store = new MemoryChainEventLogStore();
    // The chain keeps answering with this row for any range containing block
    // 100, so the ONLY way it can leave the log is a commit that dropped it
    // without looking at its block — which is exactly what is under test.
    const held = creationLog(100, 0, 4n);
    const rig = harness({
      logs: (request) => (request.fromBlock <= 100 && request.toBlock >= 100 ? [held] : []),
    });
    const index = tick(store, rig.ports, { backfillPageBlocks: 20 });
    await index.runOnce(new AbortController().signal);
    expect(store.rows(SCOPE).some((row) => row.blockNumber === 100)).toBe(true);

    // Every shape a pass can take, back to back: a backfill page, a head
    // refresh, and an endpoint that fell behind.
    await index.backfillOnce(new AbortController().signal);
    await expectCoverageAndRowsAgree(store, [100]);

    await index.runOnce(new AbortController().signal);
    await expectCoverageAndRowsAgree(store, [100]);

    rig.head = { number: 98, hash: hash(0x62), timestampSeconds: 1_700_000_030 };
    await index.runOnce(new AbortController().signal);
    await expectCoverageAndRowsAgree(store, [100]);
  });

  it('lowercases topics on the way in, beside the address', async () => {
    // Every reader builds its `topic1` filter with `toString(16)` and the store
    // matches it with a plain `IN (…)`. A provider that answered in mixed case
    // would make the per-graph read come back empty — a confident zero, not an
    // error.
    const store = new MemoryChainEventLogStore();
    const shouty = creationLog(100, 0, 4n);
    const rig = harness({
      logs: () => [{ ...shouty, topics: shouty.topics.map((topic) => topic.toUpperCase()) }],
    });
    const index = tick(store, rig.ports);

    await index.runOnce(new AbortController().signal);

    const stored = store.rows(SCOPE).find((row) => row.blockNumber === 100)!;
    expect(stored.topics).toEqual(shouty.topics.map((topic) => topic.toLowerCase()));
  });

  it('refuses a head BELOW the highest one seen instead of shortening the log', async () => {
    const store = new MemoryChainEventLogStore();
    const rig = harness({ logs: () => [creationLog(100, 0, 4n)] });
    const index = tick(store, rig.ports);
    await index.runOnce(new AbortController().signal);

    // Two blocks behind, but still ABOVE the settled cursor, so the old lagging
    // guard did not fire and the pass climbed only to 98 — silently dropping
    // the tail at 99..100 that coverage went on claiming.
    rig.head = { number: 98, hash: hash(0x62), timestampSeconds: 1_700_000_030 };
    const result = await index.runOnce(new AbortController().signal);

    expect(result.outcome).toBe('endpoint-lagging');
    expect(result.logRequests).toBe(0);
    expect(store.rows(SCOPE).some((row) => row.blockNumber === 100)).toBe(true);
  });

  it('a backfill page leaves the tail alone', async () => {
    const store = new MemoryChainEventLogStore();
    const rig = harness({ logs: () => [creationLog(100, 0, 4n)] });
    const index = tick(store, rig.ports, { backfillPageBlocks: 20 });
    await index.runOnce(new AbortController().signal);
    const before = (await store.load(SCOPE))!.coverage
      .find((entry) => entry.family === 'context-graph-authority')!;

    rig.logs = () => [];
    await index.backfillOnce(new AbortController().signal);

    const after = (await store.load(SCOPE))!.coverage
      .find((entry) => entry.family === 'context-graph-authority')!;
    // History moved down and the unfinalized tail is untouched: the backfill
    // walks DOWN and has no business replacing blocks it never looked at.
    expect(after.coveredFromBlock).toBe(before.coveredFromBlock - 20);
    expect(store.rows(SCOPE).some((row) => row.blockNumber === 100 && !row.settled)).toBe(true);
  });

  it('S4: a fork suspicion survives an interleaved backfill', async () => {
    const store = new MemoryChainEventLogStore();
    const rig = harness();
    const index = tick(store, rig.ports, { backfillPageBlocks: 20 });
    await index.runOnce(new AbortController().signal);
    const settled = (await store.load(SCOPE))!.cursor.settledBlockNumber;

    rig.blockHashes.set(settled, hash(0xfe));
    rig.head = { number: 120, hash: hash(0x78), timestampSeconds: 1_700_000_100 };
    expect((await index.runOnce(new AbortController().signal)).outcome).toBe('fork-suspected');

    // The runner puts backfill passes between head passes. If one of those can
    // erase the suspicion, the second confirmation never arrives and the scope
    // can never be tombstoned at all.
    await index.backfillOnce(new AbortController().signal);
    expect((await store.load(SCOPE))!.suspectedForkBlockNumber).toBe(settled);

    const second = await index.runOnce(new AbortController().signal);
    expect(second.outcome).toBe('tombstoned');
    expect(store.tombstones).toBe(1);
  });

  it('S4: a settled hash that matches again withdraws the suspicion', async () => {
    const store = new MemoryChainEventLogStore();
    const rig = harness();
    const index = tick(store, rig.ports);
    await index.runOnce(new AbortController().signal);
    const settled = (await store.load(SCOPE))!.cursor.settledBlockNumber;

    rig.blockHashes.set(settled, hash(0xfe));
    rig.head = { number: 120, hash: hash(0x78), timestampSeconds: 1_700_000_100 };
    expect((await index.runOnce(new AbortController().signal)).outcome).toBe('fork-suspected');

    // One desynchronized answer must not leave a permanent tombstone primer.
    rig.blockHashes.delete(settled);
    rig.head = { number: 130, hash: hash(0x82), timestampSeconds: 1_700_000_160 };
    expect((await index.runOnce(new AbortController().signal)).outcome).toBe('advanced');
    expect((await store.load(SCOPE))!.suspectedForkBlockNumber).toBeUndefined();
  });

  it('S5: verifies the lineage on the path that reads no settled hash', async () => {
    const store = new MemoryChainEventLogStore();
    const rig = harness();
    const index = tick(store, rig.ports, { deploymentBlockNumber: 10 });
    await index.runOnce(new AbortController().signal);
    const settled = (await store.load(SCOPE))!.cursor.settledBlockNumber;

    // A redeployed devnet under a `node-ui.db` that outlived it: the new chain
    // is SHORTER than this cursor, so it cannot answer for the settled block at
    // all — and the old order returned "lagging" there having checked nothing.
    rig.head = { number: 40, hash: hash(0x28), timestampSeconds: 1_700_000_200 };
    rig.blockHashes.set(settled, null);
    rig.blockHashes.set(10, hash(0xee));

    expect((await index.runOnce(new AbortController().signal)).outcome).toBe('fork-suspected');
    expect((await index.runOnce(new AbortController().signal)).outcome).toBe('tombstoned');
    expect(await store.load(SCOPE)).toBeUndefined();
  });

  it('S5: a lagging endpoint on the SAME chain is still only lagging', async () => {
    const store = new MemoryChainEventLogStore();
    const rig = harness();
    const index = tick(store, rig.ports, { deploymentBlockNumber: 10 });
    await index.runOnce(new AbortController().signal);
    const settled = (await store.load(SCOPE))!.cursor.settledBlockNumber;

    // Same shape as the reset above, except the deployment block still hashes
    // the way this scope was pinned to it.
    rig.head = { number: 40, hash: hash(0x28), timestampSeconds: 1_700_000_200 };
    rig.blockHashes.set(settled, null);

    expect((await index.runOnce(new AbortController().signal)).outcome).toBe('endpoint-lagging');
    expect((await index.runOnce(new AbortController().signal)).outcome).toBe('endpoint-lagging');
    expect(store.tombstones).toBe(0);
    expect(await store.load(SCOPE)).toBeDefined();
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
    const coverage = (await store.load(SCOPE))!.coverage;
    expect(coverage.map((entry) => entry.coveredFromBlock)).toEqual(coverage.map(() => 10));

    rig.requests.length = 0;
    const result = await index.backfillOnce(new AbortController().signal);
    expect(result.outcome).toBe('idle');
    expect(rig.requests).toHaveLength(0);
  });
});

/**
 * `cursor.head.fetchedAtMs`, through the tick that writes it.
 *
 * The shipped authority-over-log pins seed this field straight into the store
 * and never construct a `ChainIndexTick`, so the stamping site itself was
 * unreachable from any test: a stamp taken at the END of the pass and called
 * the head's fetch instant survived a whole review round. These run the real
 * pass, with a clock that only moves inside the ports, so the distance between
 * the head read and the commit is a number the test controls.
 */
describe('ChainIndexTick — the head stamp dates the head READ, not the commit', () => {
  const START_MS = 1_700_000_000_000;
  /** A slow-but-not-failing `eth_getLogs`, well inside `watchdogWideLogScan`. */
  const LOG_SCAN_MS = 8_000;
  const POINT_READ_MS = 1_000;

  interface SlowRig {
    readonly rig: Harness;
    readonly ports: ChainIndexTickPorts;
    /** The clock's value at each entry into `readHead` — the stamp's value. */
    readonly headAskedAtMs: number[];
    nowMs(): number;
  }

  /**
   * The harness's ports, with wall clock burned where the real pass burns it:
   * every port call costs time, and the log scan costs most of it.
   */
  function slowRig(overrides: Partial<Harness> = {}): SlowRig {
    const rig = harness(overrides);
    let nowMs = START_MS;
    const headAskedAtMs: number[] = [];
    const ports: ChainIndexTickPorts = {
      readHead: async (signal) => {
        headAskedAtMs.push(nowMs);
        const head = await rig.ports.readHead(signal);
        nowMs += POINT_READ_MS;
        return head;
      },
      readBlockHash: async (blockNumber, signal) => {
        const hashAt = await rig.ports.readBlockHash(blockNumber, signal);
        nowMs += POINT_READ_MS;
        return hashAt;
      },
      readLogs: async (request, signal) => {
        const rows = await rig.ports.readLogs(request, signal);
        nowMs += LOG_SCAN_MS;
        return rows;
      },
    };
    return { rig, ports, headAskedAtMs, nowMs: () => nowMs };
  }

  it('cold start: the stamp is the pre-RPC instant, not the commit', async () => {
    const store = new MemoryChainEventLogStore();
    const slow = slowRig();
    const index = tick(store, slow.ports, { now: slow.nowMs });

    await index.runOnce(new AbortController().signal);

    const committed = (await store.load(SCOPE))!.cursor.head.fetchedAtMs;
    // The lineage read, the log scan and the boundary read all landed between
    // the two, so this is not a distinction without a difference.
    expect(slow.nowMs()).toBeGreaterThan(START_MS + LOG_SCAN_MS);
    expect(committed).toBe(START_MS);
    expect(committed).toBe(slow.headAskedAtMs[0]);
  });

  it('advanced: the stamp is the pre-RPC instant of THIS pass', async () => {
    const store = new MemoryChainEventLogStore();
    const slow = slowRig();
    const index = tick(store, slow.ports, { now: slow.nowMs });
    await index.runOnce(new AbortController().signal);
    slow.rig.head = { number: 130, hash: hash(0x82), timestampSeconds: 1_700_000_060 };

    const result = await index.runOnce(new AbortController().signal);

    expect(result.outcome).toBe('advanced');
    const askedAtMs = slow.headAskedAtMs[1]!;
    expect(slow.nowMs() - askedAtMs).toBeGreaterThan(LOG_SCAN_MS);
    expect((await store.load(SCOPE))!.cursor.head.fetchedAtMs).toBe(askedAtMs);
  });

  it('idle: a pass that fetches nothing still dates its head from the ask', async () => {
    const store = new MemoryChainEventLogStore();
    // Holdback 0 settles at the head itself, so the identity re-read on the
    // next pass asks for the HEAD's hash: the fixture has to agree with itself
    // about that block, or this lands on `fork-suspected` instead of `idle`.
    const slow = slowRig({
      head: { number: 100, hash: hash(100), timestampSeconds: 1_700_000_000 },
    });
    // Holdback 0 settles the whole range, so the next pass has nothing above
    // the cursor and takes the idle commit.
    const index = tick(store, slow.ports, { now: slow.nowMs, reorgHoldbackBlocks: 0 });
    await index.runOnce(new AbortController().signal);

    const result = await index.runOnce(new AbortController().signal);

    expect(result.outcome).toBe('idle');
    const askedAtMs = slow.headAskedAtMs[1]!;
    // An idle pass still verifies the chain identity before it commits.
    expect(slow.nowMs()).toBeGreaterThan(askedAtMs);
    expect((await store.load(SCOPE))!.cursor.head.fetchedAtMs).toBe(askedAtMs);
  });

  it('the anchor gate bounds the DATA, so a slow pass spends its own duration', async () => {
    // Finding A, concretely. T=6s, so `maxHeadAgeMs` is 18s. The pass reads its
    // head at t=0 and commits at t=11s. Stamped at the commit, a read at
    // t=25s measured 14s, served, and reported `{ source: 'log', ageMs: 14_000 }`
    // over a head that was really 25s old. Stamped at the ask, the same read
    // measures 25s and refuses to the live scan.
    const store = new MemoryChainEventLogStore();
    const slow = slowRig();
    const index = tick(store, slow.ports, { now: slow.nowMs, backfillPageBlocks: 10_000 });
    await index.runOnce(new AbortController().signal);
    // Coverage has to reach the deployment block before the anchor is even a
    // candidate, or this would refuse for a reason that is not the one asserted.
    for (let pass = 0; pass < 8; pass += 1) {
      if ((await index.backfillOnce(new AbortController().signal)).outcome === 'idle') break;
    }

    const state = await store.load(SCOPE);
    const askedAtMs = slow.headAskedAtMs[0]!;
    const afterBackfillAtMs = slow.nowMs();
    expect(afterBackfillAtMs - askedAtMs).toBeGreaterThanOrEqual(LOG_SCAN_MS);
    const anchorAt = (nowMs: number) => resolveChainIndexAuthorityAnchor({
      state,
      contractAddress: STORAGE,
      deploymentBlockNumber: 10,
      finalityConfirmations: 1,
      nowMs,
      maxHeadAgeMs: 18_000,
      // Out of the way: this test is about the FETCH-time gate, and the
      // fixture's head timestamp is unrelated to the injected wall clock.
      headTimestampToleranceMs: Number.MAX_SAFE_INTEGER,
    });

    expect(anchorAt(askedAtMs + 17_999).anchor).toBeDefined();
    expect(anchorAt(askedAtMs + 18_001).refusal).toBe('stale-head');
  });
});
