// SPDX-License-Identifier: Apache-2.0

/**
 * Subscribers over the ONE log.
 *
 * The publisher's `contextGraphDiscovery` and `vmReconcile` lanes and the Hub
 * rotation listener each ran their own `eth_getLogs` against the same chain the
 * tick was already scanning — three scanners for one set of events. This is
 * what they read instead. It issues NO chain requests of its own; if the log
 * cannot prove it holds a range, the subscriber is told so and keeps its
 * existing behaviour rather than being handed a silently short answer.
 *
 * THE CURSOR RULE. A lane advances `lastBlock` to whatever upper bound it was
 * given, whether or not the scan returned anything for the top of that range
 * (`chain-event-lane-runner.ts:289`). So handing a lane a range wider than the
 * log actually holds would skip every event in the gap FOREVER — the same
 * failure the adapter's `skipPreferred` carve-out exists to prevent
 * (`evm-adapter-events.ts:29-35`). {@link ChainEventLogSubscription.servableRange}
 * is therefore the only entry point: it clamps the range to proven coverage,
 * and a subscriber that cannot be served is told to fall back rather than
 * quietly given less.
 */

import {
  chainEventLogCoverageIncludes,
  findChainEventLogCoverage,
  normalizeChainEventLogAddress,
  type ChainEventLogRow,
  type ChainEventLogStore,
} from './chain-event-log.js';
import type {
  ChainEventDecoderRegistry,
  ChainEventLogFamily,
  ContextGraphKaRegistration,
  HubRotationEvent,
} from './chain-event-decoders.js';
import type { KnowledgeAssetReadView } from './knowledge-asset-read-model.js';

export interface ChainEventLogSubscriptionOptions {
  readonly scope: string;
  readonly store: ChainEventLogStore;
  readonly registry: ChainEventDecoderRegistry;
}

/** A range the log has PROVEN it holds, clamped to its coverage. */
export interface ChainEventLogServableRange {
  /** The exact event family whose coverage proved this range. */
  readonly family: ChainEventLogFamily;
  /** The normalized emitter address whose coverage proved this range. */
  readonly address: string;
  readonly fromBlockNumber: number;
  readonly throughBlockNumber: number;
}

export interface ChainEventLogSubscription {
  /**
   * The part of `[fromBlockNumber, requestedThroughBlockNumber]` this family
   * can be served from, or `undefined` when the subscriber must fall back.
   *
   * A subscriber MUST advance its cursor to `throughBlockNumber` and no
   * further, because that is exactly what was looked at.
   */
  servableRange(
    family: ChainEventLogFamily,
    address: string,
    fromBlockNumber: number,
    requestedThroughBlockNumber: number,
    view?: KnowledgeAssetReadView,
  ): Promise<ChainEventLogServableRange | undefined>;
  /** Raw rows of one family over a range `servableRange` already approved. */
  readRows(
    range: ChainEventLogServableRange,
    view?: KnowledgeAssetReadView,
  ): Promise<readonly ChainEventLogRow[]>;
  readKaRegistrations(
    range: ChainEventLogServableRange,
    view?: KnowledgeAssetReadView,
  ): Promise<readonly ContextGraphKaRegistration[]>;
  readHubRotations(
    range: ChainEventLogServableRange,
    view?: KnowledgeAssetReadView,
  ): Promise<readonly HubRotationEvent[]>;
}

export function createChainEventLogSubscription(
  options: ChainEventLogSubscriptionOptions,
): ChainEventLogSubscription {
  const { scope, store, registry } = options;

  async function rowsFor(
    range: ChainEventLogServableRange,
    view: KnowledgeAssetReadView,
  ): Promise<readonly ChainEventLogRow[]> {
    const rows = await store.readEvents(scope, {
      fromBlockNumber: range.fromBlockNumber,
      throughBlockNumber: range.throughBlockNumber,
      addresses: [range.address],
    });
    return rows.filter((row) =>
      registry.familyOf(row) === range.family && (view !== 'finalized' || row.settled));
  }

  return Object.freeze({
    async servableRange(
      family: ChainEventLogFamily,
      address: string,
      fromBlockNumber: number,
      requestedThroughBlockNumber: number,
      view: KnowledgeAssetReadView = 'latest',
    ): Promise<ChainEventLogServableRange | undefined> {
      const normalized = normalizeChainEventLogAddress(address);
      if (normalized === undefined) return undefined;
      if (!Number.isSafeInteger(fromBlockNumber) || fromBlockNumber < 0) return undefined;
      if (!Number.isSafeInteger(requestedThroughBlockNumber)) return undefined;
      const state = await store.load(scope);
      if (state === undefined) return undefined;
      // A first settled-hash mismatch retains rows and coverage until a second
      // pass confirms or withdraws it. None of those rows is a safe answer in
      // the meantime: a lane that consumes them advances its durable cursor,
      // so a later tombstone would leave replacement-chain events behind that
      // cursor forever. Refuse the log and let the caller use its live scan.
      if (state.suspectedForkBlockNumber !== undefined) return undefined;
      const coverage = findChainEventLogCoverage(state.coverage, family, normalized);
      if (coverage === undefined) return undefined;

      // The lane's own bottom must be inside coverage. Clamping the BOTTOM up
      // would hide the blocks between the lane's cursor and the log's floor,
      // which the lane would then never revisit.
      const horizon = view === 'finalized'
        ? Math.min(coverage.coveredThroughBlock, state.cursor.settledBlockNumber)
        : coverage.coveredThroughBlock;
      const through = Math.min(requestedThroughBlockNumber, horizon);
      if (through < fromBlockNumber) return undefined;
      if (!chainEventLogCoverageIncludes(coverage, fromBlockNumber, through)) return undefined;
      return Object.freeze({
        family,
        address: normalized,
        fromBlockNumber,
        throughBlockNumber: through,
      });
    },

    readRows(
      range: ChainEventLogServableRange,
      view: KnowledgeAssetReadView = 'latest',
    ): Promise<readonly ChainEventLogRow[]> {
      return rowsFor(range, view);
    },

    async readKaRegistrations(
      range: ChainEventLogServableRange,
      view: KnowledgeAssetReadView = 'latest',
    ): Promise<readonly ContextGraphKaRegistration[]> {
      return registry.decodeContextGraphKaRegistrations(await rowsFor(range, view));
    },

    async readHubRotations(
      range: ChainEventLogServableRange,
      view: KnowledgeAssetReadView = 'latest',
    ): Promise<readonly HubRotationEvent[]> {
      return registry.decodeHubRotations(await rowsFor(range, view));
    },
  });
}
