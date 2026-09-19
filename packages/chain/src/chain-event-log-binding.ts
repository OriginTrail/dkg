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

export interface ChainEventLogBinding {
  readonly subscription: ChainEventLogSubscription;
  /** The physical `ContextGraphStorage` the tick indexed, lowercased. */
  readonly contextGraphStorageAddress: string;
  /** The physical `DKGKnowledgeAssets`, when one is bound in the Hub. */
  readonly knowledgeAssetStorageAddress?: string;
  /** Stage-4 views. Absent while only the subscriber half is wired. */
  readonly knowledgeAssets?: KnowledgeAssetReadModel;
}
