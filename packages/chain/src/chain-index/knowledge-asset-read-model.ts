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
   */
  readContextGraphKaList(
    contextGraphId: bigint,
    options?: KnowledgeAssetReadOptions,
  ): Promise<ContextGraphKaList | undefined>;
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
   * The block range this family can be folded over, or `undefined` when the
   * caller must go live.
   *
   * This is the ONE place the horizon and the coverage meet. A `finalized` read
   * is capped at the settled cursor; a range the coverage does not include is
   * not a smaller answer, it is no answer.
   */
  async function resolveWindow(
    family: string,
    address: string,
    view: KnowledgeAssetReadView,
    ownWrite: KnowledgeAssetOwnWrite | undefined,
    requiredFromBlockNumber: number | undefined,
  ): Promise<ResolvedWindow | undefined> {
    const state = await store.load(scope);
    if (state === undefined) return undefined;
    // BEFORE coverage, because coverage is what goes quiet. A tick that stopped
    // committing leaves every range below exactly where it was, and a frozen
    // range is indistinguishable from a chain on which nothing happened — so a
    // stalled log would go on answering `kaToContextGraph` and an ordinal from
    // whenever it stopped, with no way for the caller to tell.
    if (chainEventLogStateReadRefusal(state, maxHeadAgeMs === undefined
      ? {}
      : { nowMs: now(), maxHeadAgeMs }) !== undefined) return undefined;
    const coverage = findChainEventLogCoverage(state.coverage, family, address);
    if (coverage === undefined) return undefined;

    const target = view === 'finalized'
      ? state.cursor.settledBlockNumber
      : state.cursor.head.number;
    const horizon = Math.min(coverage.coveredThroughBlock, target);
    if (horizon < coverage.coveredFromBlock) return undefined;

    if (ownWrite !== undefined) {
      // The barrier holds until the log has walked PAST the own write on the
      // SAME lineage. `blockHashAt` answers from the log's own rows, so a hash
      // that does not match is a log that followed a different fork.
      if (horizon < ownWrite.blockNumber) return undefined;
      const expected = normalizeChainEventLogHash(ownWrite.blockHash);
      const held = normalizeChainEventLogHash(await store.blockHashAt(scope, ownWrite.blockNumber));
      if (expected === undefined || held === undefined || held !== expected) return undefined;
    }

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

  async function foldRegistrations(
    window: ResolvedWindow,
    view: KnowledgeAssetReadView,
    topic1?: readonly string[],
  ): Promise<ReturnType<typeof reduceContextGraphKaRegistrations>> {
    const rows = await store.readEvents(scope, {
      fromBlockNumber: window.fromBlockNumber,
      throughBlockNumber: window.throughBlockNumber,
      addresses: [contextGraphStorageAddress],
      ...(topic1 === undefined ? {} : { topic1 }),
    });
    const horizonRows = view === 'finalized' ? rows.filter((row) => row.settled) : rows;
    return reduceContextGraphKaRegistrations(
      registry.decodeContextGraphKaRegistrations(horizonRows),
    );
  }

  return Object.freeze({
    async readContextGraphForKa(
      kaId: bigint,
      readOptions: KnowledgeAssetReadOptions = {},
    ): Promise<ContextGraphForKaAnswer | undefined> {
      const view = readOptions.view ?? 'finalized';
      const window = await resolveWindow(
        'context-graph-ka',
        contextGraphStorageAddress,
        view,
        readOptions.ownWrite,
        undefined,
      );
      if (window === undefined) return undefined;
      const fold = await foldRegistrations(window, view);
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

    async readContextGraphKaList(
      contextGraphId: bigint,
      readOptions: KnowledgeAssetReadOptions = {},
    ): Promise<ContextGraphKaList | undefined> {
      if (contextGraphId < 0n) return undefined;
      const view = readOptions.view ?? 'finalized';
      // `ContextGraphCreated` and `KnowledgeAssetRegisteredToContextGraph` both
      // sit on `ContextGraphStorage` and both carry the graph id as their FIRST
      // indexed argument, so ONE `topic1`-filtered read answers both halves of
      // this question: where the ordinals start, and what has been registered
      // since. It also makes the filter self-checking — if the stored topic
      // encoding did not match the one built here, the graph's own creation row
      // would not come back either, and an empty list is refused rather than
      // served as a confident zero.
      const topic1 = [contextGraphIdTopic(contextGraphId)];
      const creationWindow = await resolveWindow(
        'context-graph-authority',
        contextGraphStorageAddress,
        view,
        readOptions.ownWrite,
        undefined,
      );
      if (creationWindow === undefined || !creationWindow.caughtUp) return undefined;
      const rows = await store.readEvents(scope, {
        fromBlockNumber: creationWindow.fromBlockNumber,
        throughBlockNumber: creationWindow.throughBlockNumber,
        addresses: [contextGraphStorageAddress],
        topic1,
      });
      const horizonRows = view === 'finalized' ? rows.filter((row) => row.settled) : rows;
      const createdBlockNumber = creationBlockOf(
        registry.decodeContextGraphAuthority(horizonRows),
        contextGraphId,
      );
      // No creation row in the walked range means the log cannot say where this
      // graph's ordinal 0 is. A list folded from the middle has the wrong
      // `getContextGraphKaAt` for every position, so there is no partial answer
      // to give — only a live read.
      if (createdBlockNumber === undefined) return undefined;

      const window = await resolveWindow(
        'context-graph-ka',
        contextGraphStorageAddress,
        view,
        readOptions.ownWrite,
        createdBlockNumber,
      );
      if (window === undefined || !window.caughtUp) return undefined;
      // Never above what was actually read. The two families keep separate
      // coverage on the same address, so the KA family can claim a block this
      // one read stopped below; folding to the lower of the two under-reports
      // the horizon, which costs a re-read and never a missing registration.
      const throughBlockNumber = Math.min(
        window.throughBlockNumber,
        creationWindow.throughBlockNumber,
      );
      const fold = reduceContextGraphKaRegistrations(
        registry.decodeContextGraphKaRegistrations(
          horizonRows.filter((row) => row.blockNumber >= createdBlockNumber
            && row.blockNumber <= throughBlockNumber),
        ),
      );
      const list = fold.listsByContextGraph.get(contextGraphId.toString());
      if (list !== undefined) {
        return Object.freeze({ ...list, throughBlockNumber });
      }
      // A graph with no registrations yet is a real, servable answer HERE
      // (unlike `kaToContextGraph`) because coverage was proven back to the
      // graph's own creation block: there is nowhere earlier for a registration
      // to hide, and the creation row proves the filter is looking.
      return Object.freeze({
        contextGraphId,
        kaIds: Object.freeze([]),
        throughBlockNumber,
      });
    },
  });
}
