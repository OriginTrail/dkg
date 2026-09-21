// SPDX-License-Identifier: Apache-2.0

/**
 * What an adapter needs in order to read the node's ONE log instead of the
 * chain.
 *
 * Deliberately a value the process hands DOWN to every adapter rather than
 * something an adapter builds: there is one tick, one cursor and one events
 * table per node, and per-wallet publisher adapters are constructed without a
 * store at all (`publisher-runner.ts:81-88`). An adapter that built its own
 * would be the second scanner this whole change exists to delete.
 *
 * The addresses are carried explicitly, not resolved from the Hub at read
 * time: coverage is recorded per (family, ADDRESS), so asking the log about a
 * different address than the one the tick walked would compare a range against
 * coverage that was never about it.
 */

import type {
  ChainEventLogSubscription,
  ChainIndexAnchorResult,
  ChainIndexAuthorityAnchor,
  ChainIndexAuthorityPageSource,
  KnowledgeAssetReadModel,
} from './chain-index/index.js';

/**
 * One Hub rotation the log already holds.
 *
 * Only what the rotation listener acts on. The listener's whole job is to hand
 * a contract NAME to the invalidation allowlist; block and index are carried
 * so it can keep its own idempotence rather than trusting the log for it.
 */
export interface ChainEventLogHubRotation {
  readonly blockNumber: number;
  /** Canonical fork identity of the stored row. */
  readonly blockHash: string;
  readonly logIndex: number;
  readonly contractName: string;
}

/**
 * The window of Hub history the log can answer for, and the rotations in it.
 *
 * The clamping lives on the LOG side, not in the listener: coverage is the
 * only thing that knows how far down the backfill has walked, and a listener
 * that picked its own lower bound would either re-dispatch history it already
 * saw or skip a rotation below the log's floor.
 */
export interface ChainEventLogHubRotationWindow {
  readonly fromBlockNumber: number;
  readonly throughBlockNumber: number;
  readonly rotations: readonly ChainEventLogHubRotation[];
}

/**
 * The exact ContextGraphStorage identity a publisher event lane is about to
 * scan.
 *
 * The one-log runtime compares all three values with the address and topics it
 * indexed before it lends out a horizon. A family name alone is not enough:
 * two generations of the same contract, or two sibling events at one address,
 * must never share a coverage claim.
 */
export type ChainEventLogIndexedEventType =
  | 'ContextGraphCreated'
  | 'KnowledgeAssetRegisteredToContextGraph';

export interface ChainEventLogEventScanIdentity {
  readonly eventType: ChainEventLogIndexedEventType;
  readonly contextGraphStorageAddress: string;
  readonly topic0: string;
}

/**
 * A revision-pinned claim over one exact indexed event family.
 *
 * `holds()` reloads the store and requires the same cursor revision, topic set,
 * clean lineage and coverage. A tick, reorg repair or runtime rebuild while a
 * consumer awaits dispatch therefore retires the lease instead of allowing a
 * cursor to advance over rows from a different log generation.
 */
export interface ChainEventLogEventScanLease {
  readonly throughBlockNumber: number;
  holds(): Promise<boolean>;
}

/**
 * Everything the #2670 Context Graph authority index needs to run over the log
 * instead of over its own `eth_getLogs` scan.
 *
 * The three parts are inseparable and that is why they are ONE value: the
 * anchor says which block the fold may reach, the page source serves only rows
 * inside coverage, and the fence proves nothing moved underneath the fold. A
 * reader handed the pages without the anchor would fold an unbounded range; one
 * handed the anchor without the fence would keep today's staleness story and
 * lose `stabilize()`.
 */
export interface ChainEventLogAuthoritySource {
  /**
   * The physical `ContextGraphStorage` the TICK walked, lowercased. A reader
   * must compare it with the address it resolved itself and fall back when they
   * differ: coverage is recorded per (family, address), so proving a range
   * against one address while reading another compares a range to coverage that
   * was never about it.
   */
  readonly contractAddress: string;
  readonly pageSource: ChainIndexAuthorityPageSource;
  /**
   * Optional owner-side immutable creation lookup. The owner may answer only
   * from its existing complete finalized authority index/log; a borrower must
   * never construct an index or scanner of its own. `undefined` is a proof
   * miss and sends the borrower to its unchanged live point reads.
   */
  readContextGraphFinalizedCreation?(
    contextGraphId: bigint,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<Readonly<{ nameHash: string; accessPolicy: 0 | 1 }> | undefined>;
  /** The anchor for one read, or the reason there is none. Never throws. */
  resolveAnchor(input: Readonly<{
    deploymentBlockNumber: number;
    finalityConfirmations: number;
    requiredBlockNumber?: number;
  }>): Promise<ChainIndexAnchorResult>;
  /** The `stabilize()` equivalent: false means the fold must be discarded. */
  anchorHolds(anchor: ChainIndexAuthorityAnchor): Promise<boolean>;
}

export interface ChainEventLogBinding {
  /**
   * Durable scope of the ONE runtime that produced this binding.
   *
   * Runtime-produced bindings always carry it. It remains optional only for
   * backwards-compatible direct/static attachments in tests and SDK hosts.
   * A borrowed binding source is accepted only when this exactly matches the
   * reader adapter's chain + Hub scope; absence therefore fails closed to the
   * reader's live path.
   */
  readonly scope?: string;
  readonly subscription: ChainEventLogSubscription;
  /**
   * Absent when the Hub binds no `ContextGraphStorage`, so a reader with no
   * source keeps the live scan rather than guessing an address.
   */
  readonly contextGraphAuthority?: ChainEventLogAuthoritySource;
  /**
   * The physical `ContextGraphStorage` the tick indexed, lowercased. Absent
   * when the Hub binds none — `initContracts` tolerates that deployment, and a
   * reader with no address must fall back rather than guess one.
   */
  readonly contextGraphStorageAddress?: string;
  /** The physical `DKGKnowledgeAssets`, when one is bound in the Hub. */
  readonly knowledgeAssetStorageAddress?: string;
  /** Stage-4 views. Absent while only the subscriber half is wired. */
  readonly knowledgeAssets?: KnowledgeAssetReadModel;
  /**
   * A conservative, possibly lagging upper bound for background publisher
   * event scans, or `undefined` when the one log cannot prove one for the
   * exact current ContextGraphStorage generation and requested indexed topic.
   *
   * This is deliberately not a chain-head API and carries no authorization or
   * finality meaning. Callers still pass each requested range through
   * `subscription.servableRange`, whose lower-bound/floor check decides
   * whether rows can replace that lane's live scan.
   */
  readEventScanLease?(
    identity: ChainEventLogEventScanIdentity,
  ): Promise<ChainEventLogEventScanLease | undefined>;
  /**
   * Hub rotations out of the log, or `undefined` when the log cannot prove it
   * covers the window the listener asked for — or cannot prove it is still
   * RUNNING. A tick that stopped committing leaves coverage frozen, and frozen
   * coverage is indistinguishable from a chain that produced no blocks, so the
   * window is refused once the log's own head read is older than a multiple of
   * the tick interval.
   *
   * `undefined` is the listener's cue to do exactly what it did before the log
   * existed — one `eth_getBlockNumber` and one `eth_getLogs` against the Hub —
   * so a cold, lagging or stalled log degrades to the old cost and never to a
   * missed rotation. `lastScannedBlock === undefined` asks for a BASELINE: the window
   * comes back with no rotations, because a listener that has never scanned
   * must not replay the history the backfill has since walked into the log.
   */
  readHubRotationWindow?(
    lastScannedBlock: number | undefined,
    reorgBufferBlocks: number,
  ): Promise<ChainEventLogHubRotationWindow | undefined>;
}

/**
 * Late-bound view of another adapter's current one-log binding.
 *
 * The returned object must stay stable for one owner generation. Returning
 * `undefined` during cold start, rebuild or shutdown is meaningful: borrowers
 * immediately use their existing live chain fallback and must not consult a
 * previously attached value.
 */
export type ChainEventLogBindingSource = () => ChainEventLogBinding | undefined;
