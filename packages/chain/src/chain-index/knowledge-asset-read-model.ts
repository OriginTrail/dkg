// SPDX-License-Identifier: Apache-2.0

/**
 * The knowledge-asset read model: `kaToContextGraph`, `getContextGraphKaCount`,
 * `getContextGraphKaAt` and `getLatestMerkleRoot`, answered from the ONE log.
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
 * - A ZERO `kaToContextGraph` is the opposite: it is a claim about the absence
 *   of an event anywhere in history, so it needs COMPLETE contract-wide
 *   coverage and no own-write barrier. A wrong zero is a correctness bug, not a
 *   slow path — it is how a KA gets treated as belonging to no graph.
 * - An ORDINAL (`KaCount`/`KaAt`) is only correct if nothing before it was
 *   skipped, so it needs coverage down to the graph's creation block.
 * - A ROOT needs the KA's own creation event, because a root stack folded from
 *   the middle has the right top and the wrong `rootIndex`.
 */

import type { RawContextGraphAuthorityIndexEvent } from
  '../context-graph-authority-index-reducer.js';
import {
  chainEventLogCoverageIncludes,
  chainEventLogCoverageIsComplete,
  findChainEventLogCoverage,
  normalizeChainEventLogAddress,
  normalizeChainEventLogBlockNumber,
  normalizeChainEventLogHash,
  type ChainEventLogStore,
} from './chain-event-log.js';
import type { ChainEventDecoderRegistry } from './chain-event-decoders.js';
import {
  latestMerkleRootOf,
  reduceContextGraphKaRegistrations,
  reduceKnowledgeAssetEvents,
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
  | Readonly<{ kind: 'bound'; contextGraphId: bigint; asOfBlockNumber: number }>
  | Readonly<{ kind: 'unbound'; asOfBlockNumber: number }>;

export interface KnowledgeAssetReadModelOptions {
  readonly scope: string;
  readonly store: ChainEventLogStore;
  readonly registry: ChainEventDecoderRegistry;
  /** Physical `ContextGraphStorage` address these reads are bound to. */
  readonly contextGraphStorageAddress: string;
  /** Physical `DKGKnowledgeAssets` address, when the node has one bound. */
  readonly knowledgeAssetStorageAddress?: string;
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
   * `max(3T, 15s)`, supplied by the composition root, exactly as the Hub
   * window and the authority anchor bound themselves. Omitted (tests, and
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
  /** `getLatestMerkleRoot(kaId)` with the `rootIndex` that names the version. */
  readLatestMerkleRoot(
    kaId: bigint,
    options?: KnowledgeAssetReadOptions,
  ): Promise<Readonly<{ merkleRoot: string; rootIndex: number; author?: string }> | undefined>;
  /** `getMaxKaNumberForAuthor(author)`: the allocator floor. */
  readMaxKaNumberForAuthor(
    author: string,
    options?: KnowledgeAssetReadOptions,
  ): Promise<bigint | undefined>;
}

interface ResolvedWindow {
  readonly fromBlockNumber: number;
  readonly throughBlockNumber: number;
  readonly complete: boolean;
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
  const knowledgeAssetStorageAddress = options.knowledgeAssetStorageAddress === undefined
    ? undefined
    : normalizeChainEventLogAddress(options.knowledgeAssetStorageAddress);
  if (options.knowledgeAssetStorageAddress !== undefined
    && knowledgeAssetStorageAddress === undefined) {
    throw new Error('Knowledge asset read model DKGKnowledgeAssets address is invalid');
  }
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
    if (maxHeadAgeMs !== undefined) {
      const ageMs = now() - state.cursor.head.fetchedAtMs;
      if (!(ageMs >= 0) || ageMs > maxHeadAgeMs) return undefined;
    }
    // A settled-hash mismatch the tick has seen but not yet confirmed or
    // withdrawn: the rows may belong to a chain this node is no longer on.
    if (state.suspectedForkBlockNumber !== undefined) return undefined;
    const coverage = findChainEventLogCoverage(state.coverage, family, address);
    if (coverage === undefined) return undefined;

    const horizon = view === 'finalized'
      ? Math.min(coverage.coveredThroughBlock, state.cursor.settledBlockNumber)
      : coverage.coveredThroughBlock;
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
      complete: chainEventLogCoverageIsComplete(coverage),
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
      // The only zero this model will ever produce. Anything less than complete
      // contract-wide coverage and the honest answer is "I do not know", which
      // is `undefined` and costs one `eth_call`.
      if (!window.complete) return undefined;
      return Object.freeze({
        kind: 'unbound' as const,
        asOfBlockNumber: window.throughBlockNumber,
      });
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
      if (creationWindow === undefined) return undefined;
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
      if (window === undefined) return undefined;
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

    async readLatestMerkleRoot(
      kaId: bigint,
      readOptions: KnowledgeAssetReadOptions = {},
    ): Promise<Readonly<{ merkleRoot: string; rootIndex: number; author?: string }> | undefined> {
      if (knowledgeAssetStorageAddress === undefined) return undefined;
      const view = readOptions.view ?? 'finalized';
      const window = await resolveWindow(
        'knowledge-asset',
        knowledgeAssetStorageAddress,
        view,
        readOptions.ownWrite,
        undefined,
      );
      if (window === undefined) return undefined;
      const rows = await store.readEvents(scope, {
        fromBlockNumber: window.fromBlockNumber,
        throughBlockNumber: window.throughBlockNumber,
        addresses: [knowledgeAssetStorageAddress],
      });
      const horizonRows = view === 'finalized' ? rows.filter((row) => row.settled) : rows;
      const fold = reduceKnowledgeAssetEvents(registry.decodeKnowledgeAssets(horizonRows));
      // `latestMerkleRootOf` refuses a stack whose bottom was never seen, so a
      // KA created below the backfill's current floor falls through to the
      // chain instead of reporting version 0 of a version-3 asset.
      return latestMerkleRootOf(fold.rootsByKa.get(kaId.toString()));
    },

    async readMaxKaNumberForAuthor(
      author: string,
      readOptions: KnowledgeAssetReadOptions = {},
    ): Promise<bigint | undefined> {
      if (knowledgeAssetStorageAddress === undefined) return undefined;
      const normalized = normalizeChainEventLogAddress(author);
      if (normalized === undefined) return undefined;
      const view = readOptions.view ?? 'finalized';
      const window = await resolveWindow(
        'knowledge-asset',
        knowledgeAssetStorageAddress,
        view,
        readOptions.ownWrite,
        undefined,
      );
      // An allocator floor folded from partial history is LOWER than the truth,
      // and a low floor hands out a KA number that is already taken. Complete
      // coverage or nothing.
      if (window === undefined || !window.complete) return undefined;
      const rows = await store.readEvents(scope, {
        fromBlockNumber: window.fromBlockNumber,
        throughBlockNumber: window.throughBlockNumber,
        addresses: [knowledgeAssetStorageAddress],
      });
      const horizonRows = view === 'finalized' ? rows.filter((row) => row.settled) : rows;
      const fold = reduceKnowledgeAssetEvents(registry.decodeKnowledgeAssets(horizonRows));
      // Complete coverage is the wrong property ON ITS OWN. The floor is built
      // only from creates that carried a decodable author, so an ABI that
      // yields none folds to an empty map — and an empty map under complete
      // coverage reads as a confident zero, which hands out a KA number the
      // chain has already given away.
      if (fold.authorlessCreates > 0) return undefined;
      return fold.maxKaNumberByAuthor.get(normalized) ?? 0n;
    },
  });
}
