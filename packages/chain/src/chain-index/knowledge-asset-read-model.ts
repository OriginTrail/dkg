// SPDX-License-Identifier: Apache-2.0

/**
 * The knowledge-asset read model: positive `kaToContextGraph` bindings and
 * known `getContextGraphKaAt` ordinals, answered from the ONE log.
 *
 * Every method here returns `undefined` for "I must not answer this", and the
 * adapter then does exactly what it did before the log existed: one `eth_call`.
 * That is the whole safety story of stage 4 — the log makes reads cheap when it
 * can PROVE it holds the history, and gets out of the way when it cannot.
 *
 * WHY THE GATES DIFFER PER READER
 * - A POSITIVE `kaToContextGraph` is write-once on chain (`ContextGraphStorage`
 *   :359, guarded :355-358, never cleared) so once a SETTLED row says kaId is
 *   bound to cg, that is permanently true and needs no coverage at all.
 * - An ORDINAL (`KaCount`/`KaAt`) is only correct if nothing before it was
 *   skipped, so it needs coverage down to the graph's creation block.
 * - Negative bindings and mutable counts are deliberately not served: a tick
 *   can observe block N immediately after a read at N-1, so absence/count at
 *   N-1 is not equivalent to the unpinned `eth_call` these paths replace.
 *
 * WHY ORDINALS ARE CACHED, AND WHEN A CACHED FOLD IS REUSED
 * An ordinal is a position in a first-wins fold of every registration the graph
 * ever had, so no single row can answer it. The VM reconcile walk and its
 * recovery batches read ordinals one at a time; folding the graph for each read
 * cost O(n) decodes per ordinal and O(n^2) per walk (the largest mainnet graph
 * holds ~29.5k registrations). {@link createKnowledgeAssetReadModel} keeps
 * each graph's folded list per view, keyed by the log's revision: the store
 * bumps the revision in the SAME transaction as every row change, so a list
 * folded at revision R is exactly what a fold at R would answer. At a new
 * revision only the rows past the graph's settled prefix are re-read and folded;
 * the prefix itself is re-proven first (see `buildGraphOrdinals`), and anything
 * the proof cannot cover folds the graph from scratch, exactly as before.
 */

import type { RawContextGraphAuthorityIndexEvent } from
  '../context-graph-authority-index-reducer.js';
import {
  chainEventLogCoverageIncludes,
  chainEventLogStateReadRefusal,
  findChainEventLogCoverage,
  normalizeChainEventLogAddress,
  normalizeChainEventLogBlockNumber,
  normalizeChainEventLogHash,
  type ChainEventLogQuery,
  type ChainEventLogRow,
  type ChainEventLogState,
  type ChainEventLogStore,
} from './chain-event-log.js';
import type { ChainEventDecoderRegistry } from './chain-event-decoders.js';
import {
  reduceContextGraphKaRegistrations,
  type ContextGraphKaList,
} from './knowledge-asset-reducer.js';

/**
 * Which horizon a read folds over.
 *
 * `finalized` stops at the settled cursor and is what every verification path
 * uses: the tail is replaced wholesale each tick, so a root promoted from it
 * could be orphaned out from under the promotion. `latest` includes the tail
 * and exists for nudges and discovery, where being early is the point and being
 * wrong costs a re-sweep.
 */
export type KnowledgeAssetReadView = 'finalized' | 'latest';

/**
 * Read-your-writes barrier (review S6).
 *
 * Block NUMBER is not enough: if the tick followed a different endpoint or a
 * different fork, its head can reach `blockNumber` without ever containing the
 * transaction, and the barrier would drop on a log that does not hold the
 * write. The HASH is what ties the barrier to the lineage the log actually
 * walked.
 */
export interface KnowledgeAssetOwnWrite {
  readonly blockNumber: number;
  readonly blockHash: string;
}

export interface KnowledgeAssetReadOptions {
  readonly view?: KnowledgeAssetReadView;
  readonly ownWrite?: KnowledgeAssetOwnWrite;
}

/** A `kaToContextGraph` answer the log is willing to stand behind. */
export type ContextGraphForKaAnswer =
  Readonly<{ kind: 'bound'; contextGraphId: bigint; asOfBlockNumber: number }>;

/** A `getContextGraphKaAt` answer the log is willing to stand behind. */
export type ContextGraphKaAtAnswer = Readonly<{ kaId: bigint; asOfBlockNumber: number }>;

export interface KnowledgeAssetReadModelOptions {
  readonly scope: string;
  readonly store: ChainEventLogStore;
  readonly registry: ChainEventDecoderRegistry;
  /** Physical `ContextGraphStorage` address these reads are bound to. */
  readonly contextGraphStorageAddress: string;
  /**
   * How old the tick's own head read may be before NOTHING here answers.
   *
   * Coverage alone cannot tell a chain that produced no events from a tick
   * that stopped committing: both leave the stored range exactly where it was,
   * and every gate in this file is a statement about that range. Each method
   * here stands in for an UNPINNED `eth_call`, which is never stale, so the
   * staleness this model may add has to be bounded by something — and the only
   * thing that can bound it is when the log last heard from the chain.
   *
   * `min(max(3T, 15s), 5m)`, supplied by the composition root from the same
   * resolver as the authority projection cache. Omitted (tests, and
   * callers that build a model for rows alone) means unbounded, which is why
   * the runtime never omits it.
   */
  readonly maxHeadAgeMs?: number;
  /** Injected wall clock; late-bound so a faked `Date` is honoured. */
  readonly now?: () => number;
}

export interface KnowledgeAssetReadModel {
  /** `kaToContextGraph(kaId)`; `undefined` means "ask the chain". */
  readContextGraphForKa(
    kaId: bigint,
    options?: KnowledgeAssetReadOptions,
  ): Promise<ContextGraphForKaAnswer | undefined>;
  /**
   * The per-graph KA list.
   *
   * The graph's creation block is resolved FROM THE LOG, never from the caller:
   * the ordinals are only correct once coverage reaches it, and a caller that
   * named a block too high silently truncated the list — `getContextGraphKaAt`
   * then disagreed with the chain from that point on forever.
   *
   * Served from the same per-graph ordinal cache as `readContextGraphKaAt`. A
   * read that races a commit (the log's revision moves while the graph is
   * being folded) answers `undefined` rather than mixing two revisions.
   */
  readContextGraphKaList(
    contextGraphId: bigint,
    options?: KnowledgeAssetReadOptions,
  ): Promise<ContextGraphKaList | undefined>;
  /**
   * `getContextGraphKaAt(contextGraphId, index)`; `undefined` means "ask the
   * chain", including for an index past the list the log holds (the chain
   * reverts on one, and callers read that revert).
   *
   * Exactly `readContextGraphKaList(contextGraphId, options)?.kaIds[index]`,
   * with the same gates, answered from the per-graph ordinal cache instead of a
   * fold per call. The scalar shape is PR #2784's.
   */
  readContextGraphKaAt(
    contextGraphId: bigint,
    index: bigint,
    options?: KnowledgeAssetReadOptions,
  ): Promise<ContextGraphKaAtAnswer | undefined>;
}

interface ResolvedWindow {
  readonly fromBlockNumber: number;
  readonly throughBlockNumber: number;
  /** Coverage reaches the chain horizon this view claims to answer at. */
  readonly caughtUp: boolean;
}

/**
 * The graph id as it sits in `topic1`.
 *
 * The SAME encoding the tick stores (lowercase, zero-padded to 32 bytes) and
 * the same one `eth_getLogs` uses, because the store filters topics with a
 * plain `IN (…)` and nothing folds case on either side.
 */
function contextGraphIdTopic(contextGraphId: bigint): string {
  return `0x${contextGraphId.toString(16).padStart(64, '0')}`;
}

const UINT256_LIMIT = 1n << 256n;

/**
 * The KA id as it sits in `topic2` of `KnowledgeAssetRegisteredToContextGraph`
 * (`uint256 indexed contextGraphId, uint256 indexed kaId`), in the same
 * lowercase, zero-padded encoding as {@link contextGraphIdTopic}.
 *
 * `undefined` for an id no uint256 topic can carry: no registration can name
 * it, so the unfiltered fold could never have bound it either.
 */
function kaIdTopic(kaId: bigint): string | undefined {
  if (kaId < 0n || kaId >= UINT256_LIMIT) return undefined;
  return `0x${kaId.toString(16).padStart(64, '0')}`;
}

/** The block a graph was created at, from the log's own `ContextGraphCreated`. */
function creationBlockOf(
  events: readonly RawContextGraphAuthorityIndexEvent[],
  contextGraphId: bigint,
): number | undefined {
  for (const event of events) {
    if (event.name !== 'ContextGraphCreated') continue;
    // The read was already filtered to this graph's topic; comparing the
    // DECODED id as well is what makes that filter's correctness observable
    // here rather than assumed.
    if (typeof event.contextGraphId !== 'bigint' || event.contextGraphId !== contextGraphId) {
      continue;
    }
    const blockNumber = normalizeChainEventLogBlockNumber(event.blockNumber);
    if (blockNumber !== undefined) return blockNumber;
  }
  return undefined;
}

/**
 * How many (view, graph) ordinal lists one read model keeps. A mainnet core
 * holds 37 graphs; the largest list is ~29.5k ids (a few MB with its set).
 */
const ORDINAL_CACHE_MAX_ENTRIES = 64;

/**
 * A folded run of the graph's registrations that is settled end to end: every
 * registration row of the graph from its creation block through
 * `throughBlockNumber` was settled when it was folded.
 *
 * That is the only part of a fold that can be reused at a later revision.
 * Settled rows are never rewritten and never deleted short of a tombstone, so
 * the run can only change by GAINING rows (which the count below catches) or by
 * the whole log being rebuilt (which the boundary rows catch).
 */
interface SettledPrefix {
  /** The run's last block; it holds at least one registration of the graph. */
  readonly throughBlockNumber: number;
  /** Registration rows of the graph in `[created, throughBlockNumber]`; `countEvents` must agree. */
  readonly rowCount: number;
  /** Ids the run contributes: `kaIds.slice(0, kaCount)`. */
  readonly kaCount: number;
  /** The run's rows at `throughBlockNumber`, block hash included. */
  readonly boundary: readonly ChainEventLogRow[];
}

/** One graph's list under one view, folded at `revision`. Mutated only by its single builder. */
interface GraphOrdinals {
  revision: number;
  lineage: string;
  topicSetVersion: string;
  createdBlockNumber: number;
  throughBlockNumber: number;
  /** Position IS the ordinal. */
  readonly kaIds: bigint[];
  /** Exactly the ids in `kaIds`: the reducer's first-wins set. */
  readonly seen: Set<bigint>;
  prefix: SettledPrefix | undefined;
}

/** Field-by-field row equality; `topics` in order and in arity. */
function sameRows(left: readonly ChainEventLogRow[], right: readonly ChainEventLogRow[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((row, index) => {
    const other = right[index]!;
    return row.blockNumber === other.blockNumber
      && row.logIndex === other.logIndex
      && row.blockHash === other.blockHash
      && row.transactionHash === other.transactionHash
      && row.address === other.address
      && row.data === other.data
      && row.settled === other.settled
      && row.topics.length === other.topics.length
      && row.topics.every((topic, position) => topic === other.topics[position]);
  });
}

/**
 * The last block at or below which every row is settled, and that holds a row.
 * Rows must be in (block, logIndex) order.
 */
function settledThroughBlock(rows: readonly ChainEventLogRow[]): number | undefined {
  const firstTail = rows.find((row) => !row.settled)?.blockNumber ?? Number.POSITIVE_INFINITY;
  let through: number | undefined;
  for (const row of rows) {
    // Settled rows that share a block with the first tail row do not count:
    // that block is not settled end to end.
    if (row.blockNumber >= firstTail) break;
    through = row.blockNumber;
  }
  return through;
}

export function createKnowledgeAssetReadModel(
  options: KnowledgeAssetReadModelOptions,
): KnowledgeAssetReadModel {
  const normalizedContextGraphStorage = normalizeChainEventLogAddress(
    options.contextGraphStorageAddress,
  );
  if (normalizedContextGraphStorage === undefined) {
    throw new Error('Knowledge asset read model ContextGraphStorage address is invalid');
  }
  const contextGraphStorageAddress: string = normalizedContextGraphStorage;
  const { scope, store, registry, maxHeadAgeMs } = options;
  const now = options.now ?? (() => Date.now());

  /**
   * The block range this family can be folded over in `state`, or `undefined`
   * when the caller must go live.
   *
   * This is the ONE place the horizon and the coverage meet. A `finalized` read
   * is capped at the settled cursor; a range the coverage does not include is
   * not a smaller answer, it is no answer. Pure apart from the clock: the own
   * write's block HASH is checked separately ({@link ownWriteHashHolds}).
   */
  function planWindow(
    state: ChainEventLogState,
    family: string,
    view: KnowledgeAssetReadView,
    ownWrite: KnowledgeAssetOwnWrite | undefined,
    requiredFromBlockNumber: number | undefined,
  ): ResolvedWindow | undefined {
    // BEFORE coverage, because coverage is what goes quiet. A tick that stopped
    // committing leaves every range below exactly where it was, and a frozen
    // range is indistinguishable from a chain on which nothing happened — so a
    // stalled log would go on answering `kaToContextGraph` and an ordinal from
    // whenever it stopped, with no way for the caller to tell.
    if (chainEventLogStateReadRefusal(state, maxHeadAgeMs === undefined
      ? {}
      : { nowMs: now(), maxHeadAgeMs }) !== undefined) return undefined;
    const coverage = findChainEventLogCoverage(state.coverage, family, contextGraphStorageAddress);
    if (coverage === undefined) return undefined;

    const target = view === 'finalized'
      ? state.cursor.settledBlockNumber
      : state.cursor.head.number;
    const horizon = Math.min(coverage.coveredThroughBlock, target);
    if (horizon < coverage.coveredFromBlock) return undefined;

    // The barrier holds until the log has walked PAST the own write; that it
    // walked the SAME lineage is `ownWriteHashHolds`.
    if (ownWrite !== undefined && horizon < ownWrite.blockNumber) return undefined;

    const from = requiredFromBlockNumber ?? coverage.coveredFromBlock;
    if (requiredFromBlockNumber !== undefined
      && !chainEventLogCoverageIncludes(coverage, requiredFromBlockNumber, horizon)) {
      return undefined;
    }
    return Object.freeze({
      fromBlockNumber: Math.max(from, coverage.coveredFromBlock),
      throughBlockNumber: horizon,
      caughtUp: coverage.coveredThroughBlock >= target,
    });
  }

  /**
   * Read-your-writes on the SAME lineage. `blockHashAt` answers from the log's
   * own rows, so a hash that does not match is a log that followed a different
   * fork.
   */
  async function ownWriteHashHolds(ownWrite: KnowledgeAssetOwnWrite | undefined): Promise<boolean> {
    if (ownWrite === undefined) return true;
    const expected = normalizeChainEventLogHash(ownWrite.blockHash);
    const held = normalizeChainEventLogHash(await store.blockHashAt(scope, ownWrite.blockNumber));
    return expected !== undefined && held !== undefined && held === expected;
  }

  async function resolveWindow(
    family: string,
    view: KnowledgeAssetReadView,
    ownWrite: KnowledgeAssetOwnWrite | undefined,
  ): Promise<ResolvedWindow | undefined> {
    const state = await store.load(scope);
    if (state === undefined) return undefined;
    const window = planWindow(state, family, view, ownWrite, undefined);
    if (window === undefined || !(await ownWriteHashHolds(ownWrite))) return undefined;
    return window;
  }

  async function foldRegistrations(
    window: ResolvedWindow,
    view: KnowledgeAssetReadView,
    topics: Pick<ChainEventLogQuery, 'topic0' | 'topic1' | 'topic2'> = {},
  ): Promise<ReturnType<typeof reduceContextGraphKaRegistrations>> {
    const rows = await store.readEvents(scope, {
      fromBlockNumber: window.fromBlockNumber,
      throughBlockNumber: window.throughBlockNumber,
      addresses: [contextGraphStorageAddress],
      ...topics,
    });
    const horizonRows = view === 'finalized' ? rows.filter((row) => row.settled) : rows;
    return reduceContextGraphKaRegistrations(
      registry.decodeContextGraphKaRegistrations(horizonRows),
    );
  }

  const ordinalCache = new Map<string, GraphOrdinals>();
  /** One builder per (view, graph): the only writer of that entry's arrays. */
  const building = new Map<string, Promise<unknown>>();

  function remember(key: string, entry: GraphOrdinals): void {
    ordinalCache.delete(key);
    ordinalCache.set(key, entry);
    while (ordinalCache.size > ORDINAL_CACHE_MAX_ENTRIES) {
      ordinalCache.delete(ordinalCache.keys().next().value!);
    }
  }

  /**
   * The graph's ordinal list under `readOptions.view`, handed to `project`
   * synchronously, or `undefined` for "ask the chain".
   *
   * The list is the one `readContextGraphKaList` has always folded: the i-th
   * distinct kaId, first occurrence wins, among the graph's registration rows
   * from its creation block (read from the log's own `ContextGraphCreated`)
   * through the lower of the two families' horizons, settled rows only for the
   * `finalized` view; refused unless both families are caught up and the KA
   * family covers the creation block. `project` runs before this returns and
   * with no await in between, so it never sees a list a later build rewrote.
   */
  async function withGraphOrdinals<T>(
    contextGraphId: bigint,
    readOptions: KnowledgeAssetReadOptions,
    project: (kaIds: readonly bigint[], throughBlockNumber: number) => T,
  ): Promise<T | undefined> {
    if (contextGraphId < 0n || contextGraphId >= UINT256_LIMIT) return undefined;
    const view = readOptions.view ?? 'finalized';
    const key = `${view}:${contextGraphId}`;
    // A reader that finds a build in flight waits for it and looks again, so a
    // burst of reads at a new revision folds the graph once. Bounded, because
    // each look can meet a newer revision; running out is a live read.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const state = await store.load(scope);
      if (state === undefined) return undefined;
      // `ContextGraphCreated` and `KnowledgeAssetRegisteredToContextGraph` both
      // sit on `ContextGraphStorage` and both carry the graph id as their FIRST
      // indexed argument; the creation row says where ordinal 0 is.
      const creationWindow = planWindow(
        state, 'context-graph-authority', view, readOptions.ownWrite, undefined,
      );
      if (creationWindow === undefined || !creationWindow.caughtUp) return undefined;
      if (!(await ownWriteHashHolds(readOptions.ownWrite))) return undefined;

      const held = ordinalCache.get(key);
      if (held !== undefined && held.revision === state.cursor.revision) {
        // Same revision, same rows: the creation row, both windows and the fold
        // are what they were when this was built. Only the per-call gates (the
        // head's age, the own write) can differ, and they were just re-run.
        const window = planWindow(
          state, 'context-graph-ka', view, readOptions.ownWrite, held.createdBlockNumber,
        );
        if (window === undefined || !window.caughtUp) return undefined;
        if (Math.min(window.throughBlockNumber, creationWindow.throughBlockNumber)
          === held.throughBlockNumber) {
          remember(key, held);
          return project(held.kaIds, held.throughBlockNumber);
        }
      }
      const inFlight = building.get(key);
      if (inFlight !== undefined) {
        await inFlight.catch(() => undefined);
        continue;
      }
      const build = buildGraphOrdinals(state, creationWindow, contextGraphId, view, readOptions, key);
      building.set(key, build);
      try {
        const built = await build;
        return built === undefined ? undefined : project(built.kaIds, built.throughBlockNumber);
      } finally {
        if (building.get(key) === build) building.delete(key);
      }
    }
    return undefined;
  }

  /**
   * Fold (or extend) one graph's list at `state`'s revision and cache it.
   *
   * Every read happens first; the fold is applied with no await after the last
   * read, and only when the revision is still the one `state` was loaded at, so
   * no reader can see a half-applied fold or rows from two revisions. A build
   * that straddles a commit caches nothing and answers `undefined`.
   */
  async function buildGraphOrdinals(
    state: ChainEventLogState,
    creationWindow: ResolvedWindow,
    contextGraphId: bigint,
    view: KnowledgeAssetReadView,
    readOptions: KnowledgeAssetReadOptions,
    key: string,
  ): Promise<GraphOrdinals | undefined> {
    const topic1 = Object.freeze([contextGraphIdTopic(contextGraphId)]);
    // Both topic0 sets come from the decoder's own dispatch table, so the store
    // filter lets through exactly the rows the decoder would claim from the
    // graph's unfiltered rows (the tick lowercases every topic on the way in).
    // An empty set must never reach the store: `topic0: []` reads as no filter.
    const authorityTopic0 = registry.topic0For('context-graph-authority', contextGraphStorageAddress);
    const kaTopic0 = registry.topic0For('context-graph-ka', contextGraphStorageAddress);
    // Nothing could decode a creation row, so nothing places ordinal 0.
    if (authorityTopic0.length === 0) return undefined;
    const horizonRows = (rows: readonly ChainEventLogRow[]) => (
      view === 'finalized' ? rows.filter((row) => row.settled) : rows
    );
    const creationRows = horizonRows(await store.readEvents(scope, {
      fromBlockNumber: creationWindow.fromBlockNumber,
      throughBlockNumber: creationWindow.throughBlockNumber,
      addresses: [contextGraphStorageAddress],
      topic0: authorityTopic0,
      topic1,
    }));
    const createdBlockNumber = creationBlockOf(
      registry.decodeContextGraphAuthority(creationRows),
      contextGraphId,
    );
    // No creation row in the walked range means the log cannot say where this
    // graph's ordinal 0 is. A list folded from the middle has the wrong
    // `getContextGraphKaAt` for every position, so there is no partial answer
    // to give — only a live read. The creation row also makes the `topic1`
    // filter self-checking: an encoding that matched nothing hides it too.
    if (createdBlockNumber === undefined) return undefined;
    const window = planWindow(
      state, 'context-graph-ka', view, readOptions.ownWrite, createdBlockNumber,
    );
    if (window === undefined || !window.caughtUp) return undefined;
    // Never above what was actually read. The two families keep separate
    // coverage on the same address, so the KA family can claim a block the
    // authority read stopped below; folding to the lower of the two
    // under-reports the horizon, which costs a re-read and never a missing
    // registration.
    const throughBlockNumber = Math.min(window.throughBlockNumber, creationWindow.throughBlockNumber);

    // A graph with no registrations yet is a real, servable answer HERE
    // (unlike `kaToContextGraph`) because coverage was proven back to the
    // graph's own creation block: there is nowhere earlier for a registration
    // to hide, and the creation row proves the filter is looking. Without the
    // registration family registered, nothing decodes one either.
    if (kaTopic0.length === 0) {
      return {
        revision: state.cursor.revision,
        lineage: state.cursor.lineage,
        topicSetVersion: state.cursor.topicSetVersion,
        createdBlockNumber,
        throughBlockNumber,
        kaIds: [],
        seen: new Set<bigint>(),
        prefix: undefined,
      };
    }
    const registrations = (fromBlockNumber: number, through: number) => ({
      fromBlockNumber,
      throughBlockNumber: through,
      addresses: [contextGraphStorageAddress],
      topic0: kaTopic0,
      topic1,
    });
    // Exactly what the store filter keeps. The fold's first-wins set is
    // per-graph because the read is, so a store that ignored the filter must
    // not be able to widen it.
    const graphRows = (rows: readonly ChainEventLogRow[]) => rows.filter((row) => (
      row.address === contextGraphStorageAddress
      && kaTopic0.includes(row.topics[0] ?? '')
      && row.topics[1] === topic1[0]
    ));
    const countEvents = store.countEvents?.bind(store);

    // Try to extend the cached fold instead of re-reading the whole graph. The
    // lineage, topic-set and creation-block comparisons are shortcuts, not part
    // of the proof below (which alone implies them): they skip it when the log
    // says outright that it is not the log the fold was made from.
    const base = ordinalCache.get(key);
    const reusable = base?.prefix !== undefined
      && countEvents !== undefined
      && base.lineage === state.cursor.lineage
      && base.topicSetVersion === state.cursor.topicSetVersion
      && base.createdBlockNumber === createdBlockNumber
      && base.prefix.throughBlockNumber <= throughBlockNumber
      ? base.prefix
      : undefined;
    let prefix: SettledPrefix | undefined;
    if (reusable !== undefined && countEvents !== undefined) {
      // THE PROOF that the settled run is still exactly what was folded:
      //  - no tail row inside it, and no more rows than were folded. Settled
      //    rows are never rewritten or deleted short of a tombstone, so with no
      //    tombstone in between, an equal count means the same rows;
      //  - its last block still holds the same rows under the same block hash.
      //    After a tombstone the log is re-fetched; the same hash at that block
      //    is the same chain through it, whose registrations there coverage
      //    says the log holds again, and the count says it holds nothing else.
      const run = registrations(createdBlockNumber, reusable.throughBlockNumber);
      if (await countEvents(scope, run) === reusable.rowCount
        && await countEvents(scope, { ...run, settled: false }) === 0
        && sameRows(graphRows(await store.readEvents(scope, registrations(
          reusable.throughBlockNumber, reusable.throughBlockNumber,
        ))), reusable.boundary)) {
        prefix = reusable;
      }
    }
    const rows = graphRows(await store.readEvents(scope, registrations(
      prefix === undefined ? createdBlockNumber : prefix.throughBlockNumber + 1,
      throughBlockNumber,
    )));
    const events = registry.decodeContextGraphKaRegistrations(horizonRows(rows));

    // The new settled run: the old one, plus whatever settled rows lead the
    // rows just read, up to (not into) the first block that holds a tail row.
    const runThrough = settledThroughBlock(rows);
    const runRows = runThrough === undefined
      ? []
      : rows.filter((row) => row.blockNumber <= runThrough);

    const current = await store.load(scope);
    if (current?.cursor.revision !== state.cursor.revision) return undefined;
    // The filter keeps only this graph's topic1, and the decoder reads the id
    // from it. Anything else is a log that disagrees with its own filter.
    if (events.some((event) => event.contextGraphId !== contextGraphId)) {
      ordinalCache.delete(key);
      return undefined;
    }

    // ---- No await below: the fold is applied atomically. ----
    let entry: GraphOrdinals;
    if (prefix !== undefined) {
      entry = base!;
      // Drop what the old tail contributed; the rows re-read replace it.
      for (let index = entry.kaIds.length - 1; index >= prefix.kaCount; index -= 1) {
        entry.seen.delete(entry.kaIds[index]!);
      }
      entry.kaIds.length = prefix.kaCount;
    } else {
      entry = {
        revision: state.cursor.revision,
        lineage: state.cursor.lineage,
        topicSetVersion: state.cursor.topicSetVersion,
        createdBlockNumber,
        throughBlockNumber,
        kaIds: [],
        seen: new Set<bigint>(),
        prefix: undefined,
      };
    }
    let runKaCount = prefix?.kaCount ?? 0;
    for (const event of events) {
      // UNIQUE kaId, first occurrence wins: the reducer's rule. The contract
      // reverts a second registration, so a repeat is a replayed row, and
      // appending it would shift every later ordinal.
      if (!entry.seen.has(event.kaId)) {
        entry.seen.add(event.kaId);
        entry.kaIds.push(event.kaId);
      }
      if (runThrough !== undefined && event.blockNumber <= runThrough) runKaCount = entry.kaIds.length;
    }
    entry.revision = state.cursor.revision;
    entry.lineage = state.cursor.lineage;
    entry.topicSetVersion = state.cursor.topicSetVersion;
    entry.createdBlockNumber = createdBlockNumber;
    entry.throughBlockNumber = throughBlockNumber;
    if (countEvents === undefined) {
      // Nothing to prove a run with: every revision re-folds the graph.
      entry.prefix = undefined;
    } else if (runThrough !== undefined) {
      // `countEvents` counts exactly what `readEvents` returns (the port's
      // contract), so the run's count is the rows it was folded from.
      entry.prefix = Object.freeze({
        throughBlockNumber: runThrough,
        rowCount: (prefix?.rowCount ?? 0) + runRows.length,
        kaCount: runKaCount,
        boundary: Object.freeze(runRows.filter((row) => row.blockNumber === runThrough)),
      });
    } else {
      // The rows read begin with a tail block: the run stays what was proven.
      entry.prefix = prefix;
    }
    remember(key, entry);
    return entry;
  }

  return Object.freeze({
    async readContextGraphForKa(
      kaId: bigint,
      readOptions: KnowledgeAssetReadOptions = {},
    ): Promise<ContextGraphForKaAnswer | undefined> {
      const view = readOptions.view ?? 'finalized';
      // A POINT read, not a fold of the whole family (index and query shape
      // from PR #2784). The registration carries the KA id as its SECOND
      // indexed argument, so `(address, topic0, topic2)` selects exactly the
      // rows that can bind this KA; the store answers it from
      // `idx_chain_events_scope_address_ka` instead of handing tens of
      // thousands of rows to a synchronous read, a map and an ABI decode on
      // the main thread for every lookup.
      //
      // The answer is the full fold's answer. `reduceContextGraphKaRegistrations`
      // keys both its first-wins dedup and `contextGraphByKa` by kaId alone, so
      // another KA's rows cannot change this KA's entry, and the filtered rows
      // arrive in the same (block, logIndex) order. The filter only NARROWS:
      // the decoder still derives the kaId from the row and the lookup below
      // still compares it, so a store that ignored `topic2` would be slow,
      // never wrong, and one whose stored encoding disagreed would come back
      // empty, which is `undefined` — the live read.
      const topic2 = kaIdTopic(kaId);
      // topic0 comes from the decoder's own dispatch table. Empty means the
      // family is not registered at this address, where the unfiltered fold
      // decoded nothing and so bound nothing; it must never reach the store as
      // `topic0: []`, which reads as "no topic0 filter at all".
      const topic0 = registry.topic0For('context-graph-ka', contextGraphStorageAddress);
      if (topic2 === undefined || topic0.length === 0) return undefined;
      const window = await resolveWindow('context-graph-ka', view, readOptions.ownWrite);
      if (window === undefined) return undefined;
      const fold = await foldRegistrations(window, view, { topic0, topic2: [topic2] });
      const bound = fold.contextGraphByKa.get(kaId.toString());
      if (bound !== undefined) {
        return Object.freeze({
          kind: 'bound' as const,
          contextGraphId: bound,
          asOfBlockNumber: window.throughBlockNumber,
        });
      }
      // Absence at the last observed head is not equivalent to an unpinned
      // eth_call: a block can land after that observation and before this read.
      // Keep the log for durable positive bindings only.
      return undefined;
    },

    readContextGraphKaList(
      contextGraphId: bigint,
      readOptions: KnowledgeAssetReadOptions = {},
    ): Promise<ContextGraphKaList | undefined> {
      return withGraphOrdinals(contextGraphId, readOptions, (kaIds, throughBlockNumber) => (
        Object.freeze({
          contextGraphId,
          kaIds: Object.freeze([...kaIds]),
          throughBlockNumber,
        })
      ));
    },

    async readContextGraphKaAt(
      contextGraphId: bigint,
      index: bigint,
      readOptions: KnowledgeAssetReadOptions = {},
    ): Promise<ContextGraphKaAtAnswer | undefined> {
      if (index < 0n) return undefined;
      return withGraphOrdinals(contextGraphId, readOptions, (kaIds, throughBlockNumber) => (
        index < BigInt(kaIds.length)
          ? Object.freeze({ kaId: kaIds[Number(index)]!, asOfBlockNumber: throughBlockNumber })
          : undefined
      ));
    },
  });
}
