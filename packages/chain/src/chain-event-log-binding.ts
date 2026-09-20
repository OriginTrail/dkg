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

export interface ChainEventLogBinding {
  readonly subscription: ChainEventLogSubscription;
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
