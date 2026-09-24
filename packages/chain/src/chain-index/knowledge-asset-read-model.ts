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

import {
  normalizeChainEventLogAddress,
  type ChainEventLogStore,
} from './chain-event-log.js';
import type { ChainEventDecoderRegistry } from './chain-event-decoders.js';
import type { ContextGraphKaList } from './knowledge-asset-reducer.js';
import {
  createKnowledgeAssetReadSnapshot,
  evaluateKnowledgeAssetSnapshot,
  planKnowledgeAssetSnapshotRead,
  type KnowledgeAssetSnapshotRead,
  type KnowledgeAssetSnapshotResult,
} from './knowledge-asset-read-model-snapshot.js';
import type { KnowledgeAssetReadKind } from './knowledge-asset-read-contract.js';

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
  /** Cancellation for implementations that schedule reads asynchronously. */
  readonly signal?: AbortSignal;
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
  /** Optional scalar path so worker callers need not copy a complete KA list. */
  readContextGraphKaAt?(
    contextGraphId: bigint,
    index: bigint,
    options?: KnowledgeAssetReadOptions,
  ): Promise<Readonly<{ kaId: bigint; asOfBlockNumber: number }> | undefined>;
}

/** Serializable binding supplied to a composition-root read-model factory. */
export interface KnowledgeAssetReadModelFactoryOptions {
  readonly scope: string;
  readonly contextGraphStorageAddress: string;
  readonly contextGraphStorageAbi: string;
  readonly maxHeadAgeMs: number;
}

export type KnowledgeAssetReadModelFactory = (
  options: KnowledgeAssetReadModelFactoryOptions,
) => KnowledgeAssetReadModel;

/** Capture through the store port, then use the same evaluator as the worker. */
export function createKnowledgeAssetReadModel(
  options: KnowledgeAssetReadModelOptions,
): KnowledgeAssetReadModel {
  const address = normalizeChainEventLogAddress(options.contextGraphStorageAddress);
  if (address === undefined) {
    throw new Error('Knowledge asset read model ContextGraphStorage address is invalid');
  }
  const { scope, store, registry, maxHeadAgeMs } = options;
  const now = options.now ?? (() => Date.now());

  async function read<K extends KnowledgeAssetReadKind>(
    request: KnowledgeAssetSnapshotRead<K>,
    readOptions: KnowledgeAssetReadOptions = {},
  ): Promise<KnowledgeAssetSnapshotResult<K> | undefined> {
    readOptions.signal?.throwIfAborted();
    const state = await store.load(scope);
    if (state === undefined) return undefined;
    const plan = planKnowledgeAssetSnapshotRead({
      state, contextGraphStorageAddress: address!, read: request,
      options: readOptions, maxHeadAgeMs, nowMs: now(),
    });
    if (plan === undefined) return undefined;
    const rows = await store.readEvents(scope, plan.query);
    const ownWriteHash = readOptions.ownWrite === undefined ? undefined
      : await store.blockHashAt(scope, readOptions.ownWrite.blockNumber);
    // The generic store port has no transaction API. Refuse interleaved writes
    // rather than combine a cursor and rows from different revisions.
    const current = await store.load(scope);
    if (current === undefined || current.cursor.revision !== state.cursor.revision
      || current.cursor.lineage !== state.cursor.lineage
      || current.cursor.topicSetVersion !== state.cursor.topicSetVersion) return undefined;
    return evaluateKnowledgeAssetSnapshot(
      createKnowledgeAssetReadSnapshot(plan, rows, ownWriteHash), registry,
      { now, signal: readOptions.signal },
    );
  }

  return Object.freeze({
    readContextGraphForKa: (kaId: bigint, readOptions?: KnowledgeAssetReadOptions) =>
      read<'binding'>({ kind: 'binding', args: { kaId } }, readOptions),
    readContextGraphKaList: (contextGraphId: bigint, readOptions?: KnowledgeAssetReadOptions) =>
      read<'list'>({ kind: 'list', args: { contextGraphId } }, readOptions),
    readContextGraphKaAt: (contextGraphId: bigint, index: bigint, readOptions?: KnowledgeAssetReadOptions) =>
      read<'ordinal'>({ kind: 'ordinal', args: { contextGraphId, index } }, readOptions),
  });
}
