// SPDX-License-Identifier: Apache-2.0

import {
  chainEventLogCoverageIncludes,
  findChainEventLogCoverage,
  normalizeChainEventLogAddress,
  type ChainEventLogState,
} from './chain-event-log.js';

/**
 * What a reader may treat as "the chain", given only what the tick has stored.
 *
 * Today every authority read resolves its own head, admits the cursor, scans
 * and stabilizes — which is why the receiver spent ~1,080 `eth_getLogs` and
 * ~1,079 head probes on a run in which 51 things changed on chain. Once the
 * tick owns the fetching, a read must anchor on what the tick REACHED, not on
 * a fresh head probe of its own: an anchor above the log's coverage is an
 * anchor the log cannot answer for, and answering it anyway from the rows it
 * happens to hold is how an unindexed range becomes an absence.
 */
export interface ChainIndexAuthorityAnchor {
  /** Highest block the log can answer for, with its verified hash. */
  readonly finalized: Readonly<{ number: number; hash: string }>;
  /** The head the tick last observed, with its CHAIN time (review S2). */
  readonly head: Readonly<{ number: number; hash: string; timestampSeconds: number }>;
  /** When the tick fetched that head. Age is measured against BOTH. */
  readonly fetchedAtMs: number;
  /**
   * Whether the family has walked down to its floor.
   *
   * `false` means history is still being backfilled, so a MISSING Context
   * Graph is "not indexed yet", never "does not exist". Only a complete family
   * may answer absent from the log.
   */
  readonly complete: boolean;
}

export type ChainIndexAnchorRefusal =
  | 'no-cursor'
  | 'no-coverage'
  /** The tick has not reached the block the reader needs. */
  | 'below-required-block'
  /** The log holds no settled prefix yet, so there is nothing to anchor on. */
  | 'nothing-settled';

export interface ChainIndexAnchorResult {
  readonly anchor?: ChainIndexAuthorityAnchor;
  readonly refusal?: ChainIndexAnchorRefusal;
}

export interface ResolveChainIndexAuthorityAnchorInput {
  readonly state: ChainEventLogState | undefined;
  readonly contractAddress: string;
  readonly deploymentBlockNumber: number;
  /**
   * Own-write barrier (review S6). A read that follows this node's own receipt
   * must not be answered by a log that has not yet reached that block — and
   * the caller must additionally confirm the log's lineage contains the
   * receipt's block HASH, because reaching the height proves nothing about
   * which fork reached it.
   */
  readonly requiredBlockNumber?: number;
}

/**
 * Derive the anchor for one authority read, or say why there is none.
 *
 * Total and fail-closed: every path that cannot PROVE the log covers the read
 * returns a refusal, and a refusal is the caller's cue to do exactly what it
 * did before the log existed — ask the chain.
 */
export function resolveChainIndexAuthorityAnchor(
  input: ResolveChainIndexAuthorityAnchorInput,
): ChainIndexAnchorResult {
  const state = input.state;
  if (state === undefined) return Object.freeze({ refusal: 'no-cursor' as const });
  const contractAddress = normalizeChainEventLogAddress(input.contractAddress);
  if (contractAddress === undefined) return Object.freeze({ refusal: 'no-coverage' as const });

  const cursor = state.cursor;
  if (cursor.settledBlockNumber < input.deploymentBlockNumber) {
    return Object.freeze({ refusal: 'nothing-settled' as const });
  }
  const coverage = findChainEventLogCoverage(
    state.coverage,
    'context-graph-authority',
    contractAddress,
  );
  // The anchor is the settled cursor, so the range that must be held is
  // everything from the contract's deployment up to it.
  if (!chainEventLogCoverageIncludes(
    coverage,
    input.deploymentBlockNumber,
    cursor.settledBlockNumber,
  )) {
    return Object.freeze({ refusal: 'no-coverage' as const });
  }
  if (input.requiredBlockNumber !== undefined
    && cursor.settledBlockNumber < input.requiredBlockNumber) {
    return Object.freeze({ refusal: 'below-required-block' as const });
  }

  return Object.freeze({
    anchor: Object.freeze({
      finalized: Object.freeze({
        number: cursor.settledBlockNumber,
        hash: cursor.settledBlockHash,
      }),
      head: Object.freeze({
        number: cursor.head.number,
        hash: cursor.head.hash,
        timestampSeconds: cursor.head.timestampSeconds,
      }),
      fetchedAtMs: cursor.head.fetchedAtMs,
      // `coverage` is non-undefined here: `chainEventLogCoverageIncludes`
      // already refused an absent record above.
      complete: coverage!.coveredFromBlock <= coverage!.floorBlock,
    }),
  });
}
