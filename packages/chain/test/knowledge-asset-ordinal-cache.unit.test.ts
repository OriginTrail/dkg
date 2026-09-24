// SPDX-License-Identifier: Apache-2.0

/**
 * `readContextGraphKaAt` and the per-graph ordinal cache behind it.
 *
 * The claim under test is equivalence: every answer the cached read model
 * gives, for any history of commits the store accepts, is the answer the
 * pre-cache `readContextGraphKaList` fold gives for the same log at the same
 * moment (`referenceKaList` below is that fold). The property test drives a
 * simulated chain through ticks, tail reorgs, backfill, topic-set changes,
 * tombstones with same-chain and forked rebuilds, replayed registrations,
 * settled rows appearing inside an already folded range, and tail rows below
 * the settled cursor, and compares after every step.
 */

import { ethers } from 'ethers';
import { describe, expect, it } from 'vitest';

import { ChainEventDecoderRegistry } from '../src/chain-index/chain-event-decoders.js';
import {
  createKnowledgeAssetReadModel,
  type KnowledgeAssetReadModel,
  type KnowledgeAssetReadView,
} from '../src/chain-index/knowledge-asset-read-model.js';
import {
  reduceContextGraphKaRegistrations,
  type ContextGraphKaList,
} from '../src/chain-index/knowledge-asset-reducer.js';
import {
  chainEventLogCoverageIncludes,
  findChainEventLogCoverage,
  type ChainEventLogCountQuery,
  type ChainEventLogCoverage,
  type ChainEventLogQuery,
  type ChainEventLogRow,
  type ChainEventLogStore,
} from '../src/chain-index/chain-event-log.js';
import { loadAbi } from '../src/evm-adapter-abi.js';
import { MemoryChainEventLogStore } from './helpers/chain-event-log.js';

const SCOPE = 'evm:31337:0xhub:0xstorage';
const CG_STORAGE = `0x${'cd'.repeat(20)}`;
const OTHER_EMITTER = `0x${'ab'.repeat(20)}`;
const DEPLOY = 10;

const cgInterface = new ethers.Interface(loadAbi('ContextGraphStorage'));
const REGISTRATION_TOPIC0 = cgInterface
  .getEvent('KnowledgeAssetRegisteredToContextGraph')!.topicHash.toLowerCase();
const word = (value: bigint | number): string => `0x${BigInt(value).toString(16).padStart(64, '0')}`;
const addressOf = (seed: number): string => `0x${seed.toString(16).padStart(2, '0').repeat(20)}`;
/** One hash per (fork, block): a fork is a different block at the same height. */
const blockHash = (fork: number, blockNumber: number): string => word((BigInt(fork) << 64n) | BigInt(blockNumber));

function registry(): ChainEventDecoderRegistry {
  return new ChainEventDecoderRegistry()
    .registerContextGraphAuthority(CG_STORAGE, cgInterface)
    .registerContextGraphKnowledgeAssets(CG_STORAGE, cgInterface);
}

interface Position {
  readonly blockNumber: number;
  readonly logIndex: number;
  readonly fork?: number;
  readonly settled?: boolean;
  readonly address?: string;
}

function encoded(name: string, args: readonly unknown[], at: Position): ChainEventLogRow {
  const log = cgInterface.encodeEventLog(cgInterface.getEvent(name)!, [...args]);
  return {
    blockNumber: at.blockNumber,
    blockHash: blockHash(at.fork ?? 0, at.blockNumber),
    logIndex: at.logIndex,
    transactionHash: word(at.blockNumber * 1_000 + at.logIndex),
    address: (at.address ?? CG_STORAGE).toLowerCase(),
    topics: log.topics.map((topic) => topic.toLowerCase()),
    data: log.data,
    settled: at.settled ?? true,
  };
}

const registration = (contextGraphId: bigint, kaId: bigint, at: Position) => encoded(
  'KnowledgeAssetRegisteredToContextGraph', [contextGraphId, kaId], at,
);
const creation = (contextGraphId: bigint, at: Position) => encoded(
  'ContextGraphCreated',
  [contextGraphId, addressOf(0x11), word(0x22), [addressOf(0x11)], 7n, 1, 0, addressOf(0x44), 7n],
  at,
);

function model(store: ChainEventLogStore): KnowledgeAssetReadModel {
  return createKnowledgeAssetReadModel({
    scope: SCOPE,
    store,
    registry: registry(),
    contextGraphStorageAddress: CG_STORAGE,
  });
}

/**
 * The pre-cache `readContextGraphKaList`, in effect: the authority window must
 * be caught up; ONE topic1-filtered read of the graph's rows over it; the
 * creation block from the first matching `ContextGraphCreated`; the KA window
 * must cover it and be caught up; one full decode and reduce of the rows from
 * the creation block through the lower horizon.
 */
async function referenceKaList(
  store: ChainEventLogStore,
  contextGraphId: bigint,
  view: KnowledgeAssetReadView,
): Promise<ContextGraphKaList | undefined> {
  const decoders = registry();
  const state = await store.load(SCOPE);
  if (state === undefined || state.suspectedForkBlockNumber !== undefined) return undefined;
  const target = view === 'finalized' ? state.cursor.settledBlockNumber : state.cursor.head.number;
  const window = (family: string, requiredFrom?: number) => {
    const coverage = findChainEventLogCoverage(state.coverage, family, CG_STORAGE);
    if (coverage === undefined) return undefined;
    const horizon = Math.min(coverage.coveredThroughBlock, target);
    if (horizon < coverage.coveredFromBlock) return undefined;
    if (requiredFrom !== undefined && !chainEventLogCoverageIncludes(coverage, requiredFrom, horizon)) {
      return undefined;
    }
    return coverage.coveredThroughBlock >= target
      ? { from: Math.max(requiredFrom ?? coverage.coveredFromBlock, coverage.coveredFromBlock), through: horizon }
      : undefined;
  };
  const creationWindow = window('context-graph-authority');
  if (creationWindow === undefined) return undefined;
  const rows = await store.readEvents(SCOPE, {
    fromBlockNumber: creationWindow.from,
    throughBlockNumber: creationWindow.through,
    addresses: [CG_STORAGE],
    topic1: [word(contextGraphId)],
  });
  const horizonRows = view === 'finalized' ? rows.filter((row) => row.settled) : rows;
  const created = decoders.decodeContextGraphAuthority(horizonRows)
    .find((event) => event.name === 'ContextGraphCreated' && event.contextGraphId === contextGraphId);
  if (created === undefined) return undefined;
  const createdBlockNumber = created.blockNumber as number;
  const kaWindow = window('context-graph-ka', createdBlockNumber);
  if (kaWindow === undefined) return undefined;
  const through = Math.min(kaWindow.through, creationWindow.through);
  const fold = reduceContextGraphKaRegistrations(decoders.decodeContextGraphKaRegistrations(
    horizonRows.filter((row) => row.blockNumber >= createdBlockNumber && row.blockNumber <= through),
  ));
  return {
    contextGraphId,
    kaIds: fold.listsByContextGraph.get(contextGraphId.toString())?.kaIds ?? [],
    throughBlockNumber: through,
  };
}

/** Records every registration read and count the model makes. */
function recording(inner: MemoryChainEventLogStore, options: { withCount?: boolean } = {}) {
  const reads: ChainEventLogQuery[] = [];
  const counts: ChainEventLogCountQuery[] = [];
  let registrationRowsRead = 0;
  let beforeRead: (() => Promise<void>) | undefined;
  const store: ChainEventLogStore = {
    load: (scope) => inner.load(scope),
    commit: (scope, revision, commit) => inner.commit(scope, revision, commit),
    tombstone: (scope, revision) => inner.tombstone(scope, revision),
    blockHashAt: (scope, blockNumber) => inner.blockHashAt(scope, blockNumber),
    async readEvents(scope, query) {
      if (query.topic0?.includes(REGISTRATION_TOPIC0) === true) {
        await beforeRead?.();
        reads.push(query);
      }
      const rows = await inner.readEvents(scope, query);
      if (query.topic0?.includes(REGISTRATION_TOPIC0) === true) registrationRowsRead += rows.length;
      return rows;
    },
    ...(options.withCount === false ? {} : {
      async countEvents(scope: string, query: ChainEventLogCountQuery) {
        counts.push(query);
        return inner.countEvents(scope, query);
      },
    }),
  };
  return {
    store,
    reads,
    counts,
    rowsRead: () => registrationRowsRead,
    onRegistrationRead(hook: (() => Promise<void>) | undefined) { beforeRead = hook; },
  };
}

/** mulberry32: small, seedable, and the same sequence on every run. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/**
 * A chain, and a tick that walks it into a {@link MemoryChainEventLogStore}
 * the way `ChainIndexTick` does: the tail re-fetched and replaced every pass,
 * rows settled at or below the settled cursor, coverage extended to what was
 * looked at, backfill pages below, tombstone and cold re-initialization.
 */
class SimulatedLog {
  readonly store = new MemoryChainEventLogStore();
  /** block -> (fork, rows) of the canonical chain. */
  readonly blocks = new Map<number, { fork: number; rows: ChainEventLogRow[] }>();
  head = DEPLOY;
  settled = DEPLOY;
  coveredFrom = { 'context-graph-ka': DEPLOY, 'context-graph-authority': DEPLOY } as Record<string, number>;
  coveredThrough = DEPLOY;
  topicSetVersion = 'v1';
  fork = 0;
  nextKaId = 1_000n;
  readonly kaIdsByGraph = new Map<bigint, bigint[]>();
  private readonly random: () => number;

  constructor(seed: number, private readonly creations: ReadonlyMap<bigint, number>) {
    this.random = prng(seed);
  }

  pick<T>(values: readonly T[]): T { return values[Math.floor(this.random() * values.length)]!; }
  chance(probability: number): boolean { return this.random() < probability; }

  /** Generate (or regenerate, on a new fork) one block of the chain. */
  generate(blockNumber: number): void {
    const rows: ChainEventLogRow[] = [];
    const at = (logIndex: number): Position => ({ blockNumber, logIndex, fork: this.fork });
    let logIndex = 0;
    for (const [contextGraphId, createdAt] of this.creations) {
      if (createdAt === blockNumber) rows.push(creation(contextGraphId, at(logIndex++)));
    }
    const registrations = Math.floor(this.random() * 4);
    for (let index = 0; index < registrations; index += 1) {
      const contextGraphId = this.pick([7n, 7n, 7n, 8n, 9n, 11n]);
      const held = this.kaIdsByGraph.get(contextGraphId) ?? [];
      let kaId: bigint;
      if (held.length > 0 && this.chance(0.08)) {
        kaId = this.pick(held); // a replayed registration in the same graph
      } else if (this.chance(0.03)) {
        kaId = this.pick([...this.kaIdsByGraph.values()].flat().concat([this.nextKaId])); // cross-graph replay
      } else {
        kaId = this.nextKaId;
        this.nextKaId += 1n;
      }
      held.push(kaId);
      this.kaIdsByGraph.set(contextGraphId, held);
      rows.push(registration(contextGraphId, kaId, at(logIndex++)));
    }
    if (this.chance(0.2)) {
      // Same event from another emitter, and another graph's authority row.
      rows.push(registration(7n, this.nextKaId, { ...at(logIndex++), address: OTHER_EMITTER }));
    }
    this.blocks.set(blockNumber, { fork: this.fork, rows });
  }

  rowsIn(from: number, through: number, settledThrough: number): ChainEventLogRow[] {
    const rows: ChainEventLogRow[] = [];
    for (let blockNumber = Math.max(from, DEPLOY); blockNumber <= through; blockNumber += 1) {
      if (!this.blocks.has(blockNumber)) this.generate(blockNumber);
      for (const row of this.blocks.get(blockNumber)!.rows) {
        rows.push({ ...row, settled: blockNumber <= settledThrough });
      }
    }
    return rows;
  }

  hashAt(blockNumber: number): string {
    return blockHash(this.blocks.get(blockNumber)?.fork ?? 0, blockNumber);
  }

  coverage(): ChainEventLogCoverage[] {
    return ['context-graph-ka', 'context-graph-authority'].map((family) => ({
      family,
      address: CG_STORAGE,
      coveredFromBlock: this.coveredFrom[family]!,
      coveredThroughBlock: this.coveredThrough,
      floorBlock: DEPLOY,
    }));
  }

  cursor(head = this.head) {
    return {
      lineage: blockHash(0, DEPLOY),
      deploymentBlockNumber: DEPLOY,
      settledBlockNumber: this.settled,
      settledBlockHash: this.hashAt(this.settled),
      head: { number: head, hash: this.hashAt(head), timestampSeconds: 1, fetchedAtMs: 1 },
      topicSetVersion: this.topicSetVersion,
    };
  }

  async revision(): Promise<number> {
    return (await this.store.load(SCOPE))!.cursor.revision;
  }

  /**
   * A cold start: coverage from `liveFrom`, which the backfill walks down.
   * `tailBelowSettled` flags one stretch below the settled cursor as tail,
   * which the store accepts inside the replaced range (the tick never does).
   */
  async initialize(liveFrom: number, tailBelowSettled?: { from: number; through: number }): Promise<void> {
    this.coveredFrom = { 'context-graph-ka': liveFrom, 'context-graph-authority': liveFrom };
    this.coveredThrough = this.head;
    const rows = this.rowsIn(liveFrom, this.head, this.settled).map((row) => (
      tailBelowSettled !== undefined
        && row.blockNumber >= tailBelowSettled.from
        && row.blockNumber <= tailBelowSettled.through
        ? { ...row, settled: false }
        : row
    ));
    const committed = await this.store.commit(SCOPE, undefined, {
      cursor: this.cursor(),
      rows,
      replacedRange: { fromBlockNumber: liveFrom, throughBlockNumber: this.head },
      coverage: this.coverage(),
    });
    expect(committed).toBeDefined();
  }

  /** One `runOnce`: the tail and anything new re-fetched, maybe short of the head. */
  async tick(): Promise<void> {
    const observed = this.head + Math.floor(this.random() * 4);
    const fetchThrough = this.chance(0.1) ? Math.max(this.settled + 1, observed - 2) : observed;
    for (let blockNumber = this.head + 1; blockNumber <= observed; blockNumber += 1) this.generate(blockNumber);
    this.head = observed;
    const fetchFrom = this.settled + 1;
    this.settled = Math.max(this.settled, Math.min(fetchThrough, observed - 3 - Math.floor(this.random() * 3)));
    this.coveredThrough = Math.max(this.coveredThrough, fetchThrough);
    await this.commit({
      cursor: this.cursor(observed),
      rows: this.rowsIn(fetchFrom, fetchThrough, this.settled),
      replacedRange: { fromBlockNumber: fetchFrom, throughBlockNumber: fetchThrough },
      coverage: this.coverage(),
    });
  }

  /** Regenerate the tail on a new fork; the next tick replaces it. */
  reorgTail(): void {
    if (this.head <= this.settled) return;
    this.fork += 1;
    const from = this.settled + 1 + Math.floor(this.random() * (this.head - this.settled));
    for (let blockNumber = from; blockNumber <= this.head; blockNumber += 1) this.generate(blockNumber);
  }

  /** One bounded backfill page for one family, settled rows only. */
  async backfill(): Promise<void> {
    const family = this.pick(['context-graph-ka', 'context-graph-authority']);
    const from = this.coveredFrom[family]!;
    if (from <= DEPLOY) return;
    const through = Math.min(from - 1, this.settled);
    const pageFrom = Math.max(DEPLOY, through - 11);
    if (through < pageFrom) return;
    this.coveredFrom[family] = pageFrom;
    await this.commit({
      cursor: this.cursor(),
      rows: this.rowsIn(pageFrom, through, through),
      coverage: this.coverage(),
    });
  }

  /** The topic set changed: coverage restarts at the live range, rows stay. */
  async changeTopicSet(): Promise<void> {
    this.topicSetVersion = `v${Number(this.topicSetVersion.slice(1)) + 1}`;
    const liveFrom = this.settled + 1;
    this.coveredFrom = { 'context-graph-ka': liveFrom, 'context-graph-authority': liveFrom };
    await this.commit({
      cursor: this.cursor(),
      rows: this.rowsIn(liveFrom, this.head, this.settled),
      replacedRange: { fromBlockNumber: liveFrom, throughBlockNumber: this.head },
      coverage: this.coverage(),
    });
  }

  /** A deep reorg or a chain reset: everything dropped, the chain maybe forked below the settled cursor. */
  async tombstoneAndRebuild(forkBelowSettled: boolean): Promise<void> {
    expect(await this.store.tombstone(SCOPE, await this.revision())).toBeDefined();
    if (forkBelowSettled) {
      this.fork += 1;
      const forkPoint = DEPLOY + 1 + Math.floor(this.random() * (this.settled - DEPLOY));
      for (let blockNumber = forkPoint; blockNumber <= this.head; blockNumber += 1) this.generate(blockNumber);
    }
    const liveFrom = Math.max(DEPLOY, this.settled - 6);
    // Sometimes the rebuilt log holds the same rows as before with part of the
    // settled range flagged as tail: the same count, the same boundary block.
    const tailFrom = liveFrom + Math.floor(this.random() * Math.max(1, this.settled - liveFrom));
    await this.initialize(liveFrom, this.chance(0.4) && tailFrom < this.settled
      ? { from: tailFrom, through: tailFrom + Math.floor(this.random() * (this.settled - tailFrom)) }
      : undefined);
  }

  /** A settled registration the provider missed the first time, now in a folded range. */
  async lateSettledRow(): Promise<void> {
    const blockNumber = this.pick([...this.blocks.keys()].filter((block) => block <= this.settled
      && block >= Math.min(...Object.values(this.coveredFrom))));
    if (blockNumber === undefined) return;
    const contextGraphId = this.pick([7n, 8n]);
    const held = this.kaIdsByGraph.get(contextGraphId) ?? [];
    const kaId = held.length > 0 && this.chance(0.5) ? this.pick(held) : this.nextKaId++;
    const row = registration(contextGraphId, kaId, {
      blockNumber, logIndex: 50 + Math.floor(this.random() * 40), fork: this.blocks.get(blockNumber)!.fork,
    });
    if (this.blocks.get(blockNumber)!.rows.some((held) => held.logIndex === row.logIndex)) return;
    this.blocks.get(blockNumber)!.rows.push(row);
    this.blocks.get(blockNumber)!.rows.sort((left, right) => left.logIndex - right.logIndex);
    await this.commit({ cursor: this.cursor(), rows: [row], coverage: [] });
  }

  /** A tail row the store accepts BELOW the settled cursor (never from the tick). */
  async tailRowBelowSettled(): Promise<void> {
    if (this.settled <= DEPLOY) return;
    const blockNumber = DEPLOY + 1 + Math.floor(this.random() * (this.settled - DEPLOY));
    const row = registration(this.pick([7n, 8n]), this.nextKaId++, {
      blockNumber, logIndex: 100 + Math.floor(this.random() * 40), settled: false,
      fork: this.blocks.get(blockNumber)?.fork ?? 0,
    });
    await this.commit({
      cursor: this.cursor(),
      rows: [row],
      replacedRange: { fromBlockNumber: blockNumber, throughBlockNumber: blockNumber },
      coverage: [],
    });
  }

  private async commit(commit: Parameters<MemoryChainEventLogStore['commit']>[2]): Promise<void> {
    expect(await this.store.commit(SCOPE, await this.revision(), commit)).toBeDefined();
  }
}

const GRAPHS = [7n, 8n, 9n, 10n, 11n] as const;
const VIEWS = ['latest', 'finalized'] as const;

describe('knowledge asset read model — ordinal cache', () => {
  it('answers every ordinal exactly as the per-call fold, across randomized commit histories', async () => {
    const stats = { served: 0, refused: 0, duplicates: 0, extensions: 0, fullReads: 0, tombstones: 0 };
    for (let seed = 1; seed <= 40; seed += 1) {
      // Graph 9 is created late enough to sit in the tail for a while; 10 is
      // never created; 11 gets registrations but no creation row.
      const log = new SimulatedLog(seed, new Map([[7n, 12], [8n, 15], [9n, 40], [10n, 10_000]]));
      const recorded = recording(log.store);
      const cached = model(recorded.store);
      log.head = 30;
      log.settled = 26;
      for (let blockNumber = DEPLOY; blockNumber <= log.head; blockNumber += 1) log.generate(blockNumber);
      await log.initialize(log.chance(0.5) ? DEPLOY : 22);

      for (let step = 0; step < 60; step += 1) {
        const roll = log.pick([
          'tick', 'tick', 'tick', 'tick', 'tick', 'reorg', 'backfill', 'backfill', 'backfill',
          'late-settled-row', 'tail-row-below-settled', 'topic-set', 'tombstone',
        ] as const);
        if (roll === 'tick') await log.tick();
        else if (roll === 'reorg') { log.reorgTail(); await log.tick(); }
        else if (roll === 'backfill') await log.backfill();
        else if (roll === 'late-settled-row') await log.lateSettledRow();
        else if (roll === 'tail-row-below-settled') await log.tailRowBelowSettled();
        else if (roll === 'topic-set' && log.chance(0.3)) await log.changeTopicSet();
        else if (roll === 'tombstone' && log.chance(0.4)) {
          stats.tombstones += 1;
          await log.tombstoneAndRebuild(log.chance(0.5));
        }

        for (const view of VIEWS) {
          for (const contextGraphId of GRAPHS) {
            const expected = await referenceKaList(log.store, contextGraphId, view);
            const context = `seed ${seed} step ${step} ${view} graph ${contextGraphId}`;
            expect(await cached.readContextGraphKaList(contextGraphId, { view }), context).toEqual(expected);
            if (expected === undefined) {
              stats.refused += 1;
              await expect(cached.readContextGraphKaAt(contextGraphId, 0n, { view }), context)
                .resolves.toBeUndefined();
              continue;
            }
            stats.served += 1;
            if (new Set(log.kaIdsByGraph.get(contextGraphId) ?? []).size
              < (log.kaIdsByGraph.get(contextGraphId) ?? []).length) stats.duplicates += 1;
            const length = BigInt(expected.kaIds.length);
            for (const index of [0n, length - 1n, length / 2n, length, length + 3n, -1n]) {
              const answer = await cached.readContextGraphKaAt(contextGraphId, index, { view });
              expect(answer, `${context} ordinal ${index}`).toEqual(index >= 0n && index < length
                ? { kaId: expected.kaIds[Number(index)], asOfBlockNumber: expected.throughBlockNumber }
                : undefined);
            }
          }
        }
      }
      // A cold model agrees with the warm one at the end of the history.
      for (const view of VIEWS) {
        for (const contextGraphId of GRAPHS) {
          expect(await model(log.store).readContextGraphKaList(contextGraphId, { view }))
            .toEqual(await referenceKaList(log.store, contextGraphId, view));
        }
      }
      // A registration read that starts past the graph's creation block is an
      // extension of a cached fold; one that starts at it is a full fold.
      const createdAt = new Map([[word(7n), 12], [word(8n), 15], [word(9n), 40]]);
      for (const query of recorded.reads) {
        const created = createdAt.get(query.topic1![0]!);
        if (created === undefined || query.fromBlockNumber === query.throughBlockNumber) continue;
        if (query.fromBlockNumber > created) stats.extensions += 1; else stats.fullReads += 1;
      }
    }
    // The generator really produced every case the equivalence is about, and
    // the cache really extended far more often than it re-folded.
    expect(stats.served).toBeGreaterThan(3_000);
    expect(stats.refused).toBeGreaterThan(1_000);
    expect(stats.duplicates).toBeGreaterThan(1_000);
    expect(stats.tombstones).toBeGreaterThan(10);
    expect(stats.fullReads).toBeGreaterThan(100);
    expect(stats.extensions).toBeGreaterThan(stats.fullReads * 3);
  }, 120_000);
});

describe('knowledge asset read model — ordinal cache proofs', () => {
  const SETTLED = 100;
  const HEAD = 105;
  const CREATED = 12;

  function cursorAt(settled: number, head: number, fork = 0) {
    return {
      lineage: blockHash(0, DEPLOY),
      deploymentBlockNumber: DEPLOY,
      settledBlockNumber: settled,
      settledBlockHash: blockHash(fork, settled),
      head: { number: head, hash: blockHash(fork, head), timestampSeconds: 1, fetchedAtMs: 1 },
      topicSetVersion: 'v1',
    };
  }

  function coverageThrough(through: number, from = DEPLOY): ChainEventLogCoverage[] {
    return ['context-graph-ka', 'context-graph-authority'].map((family) => ({
      family, address: CG_STORAGE, coveredFromBlock: from, coveredThroughBlock: through, floorBlock: DEPLOY,
    }));
  }

  /** Graph 7 created at 12, one registration per block from 20, kaId = 1000 + block. */
  function history(through: number, options: { fork?: (block: number) => number; kaBase?: (block: number) => bigint } = {}) {
    const rows: ChainEventLogRow[] = [creation(7n, { blockNumber: CREATED, logIndex: 0 })];
    for (let blockNumber = 20; blockNumber <= through; blockNumber += 1) {
      const fork = options.fork?.(blockNumber) ?? 0;
      rows.push(registration(7n, options.kaBase?.(blockNumber) ?? 1_000n + BigInt(blockNumber), {
        blockNumber, logIndex: 1, fork, settled: blockNumber <= SETTLED,
      }));
    }
    return rows;
  }

  async function seededLog(rows: readonly ChainEventLogRow[], withCount = true) {
    const inner = new MemoryChainEventLogStore();
    await inner.commit(SCOPE, undefined, {
      cursor: cursorAt(SETTLED, HEAD),
      rows: [...rows],
      replacedRange: { fromBlockNumber: DEPLOY, throughBlockNumber: HEAD },
      coverage: coverageThrough(HEAD),
    });
    const recorded = recording(inner, { withCount });
    const revision = async () => (await inner.load(SCOPE))!.cursor.revision;
    return {
      inner,
      recorded,
      readModel: model(recorded.store),
      commit: async (commit: Parameters<MemoryChainEventLogStore['commit']>[2]) => {
        expect(await inner.commit(SCOPE, await revision(), commit)).toBeDefined();
      },
      rebuild: async (rebuilt: readonly ChainEventLogRow[]) => {
        expect(await inner.tombstone(SCOPE, await revision())).toBeDefined();
        expect(await inner.commit(SCOPE, undefined, {
          cursor: cursorAt(SETTLED, HEAD),
          rows: [...rebuilt],
          replacedRange: { fromBlockNumber: DEPLOY, throughBlockNumber: HEAD },
          coverage: coverageThrough(HEAD),
        })).toBeDefined();
      },
      /** Full folds: registration reads that start at the creation block. */
      fullReads: () => recorded.reads.filter((query) => query.fromBlockNumber === CREATED).length,
    };
  }

  async function expectReference(
    log: Awaited<ReturnType<typeof seededLog>>,
    view: KnowledgeAssetReadView,
  ): Promise<ContextGraphKaList> {
    const expected = await referenceKaList(log.inner, 7n, view);
    expect(expected).toBeDefined();
    expect(await log.readModel.readContextGraphKaList(7n, { view })).toEqual(expected);
    return expected!;
  }

  it('serves a walk over every ordinal from one fold, then extends it past the settled run', async () => {
    const log = await seededLog(history(HEAD));
    const expected = await referenceKaList(log.inner, 7n, 'latest');
    for (let index = 0; index < expected!.kaIds.length; index += 1) {
      await expect(log.readModel.readContextGraphKaAt(7n, BigInt(index), { view: 'latest' }))
        .resolves.toEqual({ kaId: expected!.kaIds[index], asOfBlockNumber: HEAD });
    }
    expect(log.recorded.reads).toHaveLength(1);
    expect(log.fullReads()).toBe(1);

    // A tick: the tail re-fetched with one more registration, the cursor on.
    await log.commit({
      cursor: cursorAt(SETTLED + 2, HEAD + 1),
      rows: [
        ...history(HEAD).filter((row) => row.blockNumber > SETTLED)
          .map((row) => ({ ...row, settled: row.blockNumber <= SETTLED + 2 })),
        registration(7n, 5_000n, { blockNumber: HEAD + 1, logIndex: 0, settled: false }),
      ],
      replacedRange: { fromBlockNumber: SETTLED + 1, throughBlockNumber: HEAD + 1 },
      coverage: coverageThrough(HEAD + 1),
    });
    const rowsBefore = log.recorded.rowsRead();
    const next = await expectReference(log, 'latest');
    expect(next.kaIds.at(-1)).toBe(5_000n);
    await expect(log.readModel.readContextGraphKaAt(7n, BigInt(next.kaIds.length - 1), { view: 'latest' }))
      .resolves.toEqual({ kaId: 5_000n, asOfBlockNumber: HEAD + 1 });
    // The settled run was proven, not re-read: its boundary block and the tail.
    expect(log.fullReads()).toBe(1);
    expect(log.recorded.rowsRead() - rowsBefore).toBeLessThan(10);
  });

  it('re-folds when a settled row appears inside the folded run', async () => {
    const log = await seededLog(history(HEAD));
    await expectReference(log, 'finalized');
    // Settled rows are never rewritten, but a later commit can ADD one below
    // the cursor (a provider that missed it the first time); the count sees it.
    await log.commit({
      cursor: cursorAt(SETTLED, HEAD),
      rows: [registration(7n, 7_777n, { blockNumber: 40, logIndex: 5 })],
      coverage: [],
    });
    const expected = await expectReference(log, 'finalized');
    expect(expected.kaIds.indexOf(7_777n)).toBe(21);
    expect(log.fullReads()).toBe(2);
  });

  it('re-folds when the log is rebuilt on another fork holding as many rows', async () => {
    const log = await seededLog(history(HEAD));
    await expectReference(log, 'finalized');
    // Tombstoned and rebuilt: the same number of registrations through the
    // same boundary block, but blocks from 61 on are another chain's.
    await log.rebuild(history(HEAD, {
      fork: (block) => (block > 60 ? 1 : 0),
      kaBase: (block) => (block > 60 ? 9_000n : 1_000n) + BigInt(block),
    }));
    const expected = await expectReference(log, 'finalized');
    expect(expected.kaIds.at(-1)).toBe(9_000n + BigInt(SETTLED));
    expect(log.fullReads()).toBe(2);
  });

  it('keeps rows a rebuild flags as tail below the cursor out of the reused run', async () => {
    const log = await seededLog(history(HEAD));
    await expectReference(log, 'finalized');
    // The same chain, the same rows and the same boundary block, but the
    // rebuilt log holds blocks 40-50 as tail: the finalized fold drops them.
    await log.rebuild(history(HEAD).map((row) => (
      row.blockNumber >= 40 && row.blockNumber <= 50 ? { ...row, settled: false } : row
    )));
    const expected = await expectReference(log, 'finalized');
    expect(expected.kaIds).not.toContain(1_045n);
    expect(log.fullReads()).toBe(2);
    await expectReference(log, 'latest');
  });

  it('re-folds when a tail row lands below the settled run', async () => {
    const log = await seededLog(history(HEAD));
    await expectReference(log, 'finalized');
    await expectReference(log, 'latest');
    await log.commit({
      cursor: cursorAt(SETTLED, HEAD),
      rows: [registration(7n, 6_666n, { blockNumber: 30, logIndex: 9, settled: false })],
      replacedRange: { fromBlockNumber: 30, throughBlockNumber: 30 },
      coverage: [],
    });
    expect((await expectReference(log, 'finalized')).kaIds).not.toContain(6_666n);
    expect((await expectReference(log, 'latest')).kaIds).toContain(6_666n);
    expect(log.fullReads()).toBe(4);
  });

  it('re-folds every revision, exactly, on a store that cannot count', async () => {
    const log = await seededLog(history(HEAD), false);
    await expectReference(log, 'latest');
    await expectReference(log, 'latest');
    expect(log.fullReads()).toBe(1);
    await log.commit({ cursor: cursorAt(SETTLED, HEAD), rows: [], coverage: [] });
    await expectReference(log, 'latest');
    expect(log.fullReads()).toBe(2);
  });

  it('folds once for a burst of reads at a new revision', async () => {
    const log = await seededLog(history(HEAD));
    const expected = await referenceKaList(log.inner, 7n, 'latest');
    const answers = await Promise.all(Array.from({ length: 25 }, (_, index) => (
      log.readModel.readContextGraphKaAt(7n, BigInt(index), { view: 'latest' })
    )));
    expect(answers.map((answer) => answer?.kaId)).toEqual(expected!.kaIds.slice(0, 25));
    expect(log.fullReads()).toBe(1);
  });

  it('answers undefined, and caches nothing, when a commit lands mid-fold', async () => {
    const log = await seededLog(history(HEAD));
    let interleaved = false;
    log.recorded.onRegistrationRead(async () => {
      if (interleaved) return;
      interleaved = true;
      await log.commit({ cursor: cursorAt(SETTLED, HEAD), rows: [], coverage: [] });
    });
    await expect(log.readModel.readContextGraphKaAt(7n, 0n, { view: 'latest' })).resolves.toBeUndefined();
    log.recorded.onRegistrationRead(undefined);
    await expect(log.readModel.readContextGraphKaAt(7n, 0n, { view: 'latest' }))
      .resolves.toEqual({ kaId: 1_020n, asOfBlockNumber: HEAD });
    expect(log.fullReads()).toBe(2);
  });

  it('keeps the 64 most recently read lists', async () => {
    const rows: ChainEventLogRow[] = [];
    for (let graph = 1; graph <= 65; graph += 1) {
      rows.push(creation(BigInt(graph), { blockNumber: CREATED, logIndex: graph }));
      rows.push(registration(BigInt(graph), BigInt(graph) * 10n, { blockNumber: 20, logIndex: graph }));
    }
    const log = await seededLog(rows);
    for (let graph = 1; graph <= 65; graph += 1) {
      await expect(log.readModel.readContextGraphKaAt(BigInt(graph), 0n)).resolves.toMatchObject({
        kaId: BigInt(graph) * 10n,
      });
    }
    expect(log.fullReads()).toBe(65);
    await log.readModel.readContextGraphKaAt(65n, 0n);
    expect(log.fullReads()).toBe(65);
    await log.readModel.readContextGraphKaAt(1n, 0n);
    expect(log.fullReads()).toBe(66);
  });
});
