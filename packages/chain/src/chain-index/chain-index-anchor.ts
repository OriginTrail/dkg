// SPDX-License-Identifier: Apache-2.0

import { confirmedStateBlockAtHead } from '../evm-adapter-constants.js';
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
 *
 * THE FOUR THINGS A LIVE ANCHOR GAVE FOR FREE, and where each one now comes
 * from. `resolveEvmFinalityAnchorBlockV1` + `stabilize()` are what stand
 * between a moved anchor and a served authority answer that gates catalog
 * admission, and none of it may be lost by reading the log instead:
 *
 * 1. FRESHNESS IN FETCH TIME. A live head is zero milliseconds old by
 *    construction; a stored one is only as fresh as the moment the last
 *    committed pass ASKED for it — which is earlier than that pass's commit by
 *    the whole of its duration, and is the instant
 *    `ChainEventLogHead.fetchedAtMs` carries for exactly that reason.
 *    {@link ResolveChainIndexAuthorityAnchorInput.maxHeadAgeMs} is that bound —
 *    `min(max(3T, 15s), 5m)`, the projection cache's `staleMs` exactly — and it
 *    is what makes a tick that stopped committing refuse instead of pinning its
 *    last head forever. It bounds the DATA, so a slow pass spends its own
 *    duration out of the budget rather than being handed a fresh one at commit.
 * 2. FRESHNESS IN CHAIN TIME. A responsive but LAGGING endpoint answers a head
 *    probe instantly with an old block, so fetch time alone proves nothing
 *    about what the answer is an answer about. The head's own block timestamp
 *    is the only evidence of that, and it is checked here for the SCAN, not
 *    only — as before — for a cached projection.
 * 3. DEPTH. The anchor must be the block
 *    `confirmedStateBlockAtHead(head, chain.finalityConfirmations)` names, the
 *    node's single definition of finality — that block EXACTLY, never merely
 *    one at least as deep. "At least as deep" is only safe on the reorg axis;
 *    on the STALENESS axis a deeper anchor is strictly weaker, and staleness is
 *    what decides whether a revoked participant is still in the served roster.
 *    Neither age guard above covers it: both are statements about `cursor.head`
 *    and say nothing about `anchor.finalized`. The log can name exactly two
 *    blocks with a hash — its observed head and its settled boundary — so at
 *    the default depth of 1 the anchor is the head, exactly as the live
 *    resolver's is, and at any other depth it is the settled boundary or there
 *    is no anchor at all. Naming `head - confirmations + 1` for an arbitrary
 *    depth would need the tick to record that block's hash; until it does, a
 *    depth the two nameable blocks do not land on is a refusal, which is the
 *    live scan.
 * 4. LINEAGE. A held fork suspicion means the tick saw its settled hash change
 *    and has not yet been able to confirm or withdraw it; nothing derived from
 *    that scope may be served until it does.
 *
 * The `stabilize()` fence is the fifth, and it is
 * {@link chainIndexAuthorityAnchorHolds}.
 */
export interface ChainIndexAuthorityAnchor {
  /** Highest block the log can answer for, with its verified hash. */
  readonly finalized: Readonly<{ number: number; hash: string }>;
  /** The head the tick last observed, with its CHAIN time (review S2). */
  readonly head: Readonly<{ number: number; hash: string; timestampSeconds: number }>;
  /**
   * When the tick ASKED for that head. Age is measured against BOTH.
   *
   * The tick stamps this before the head RPC and carries it unchanged into the
   * commit, so it dates the head's OBSERVATION and not the end of the pass that
   * stored it — see `ChainEventLogHead.fetchedAtMs`. That is what lets the same
   * number serve the gate below AND be handed to the projection cache as the
   * fold's data age without one of the two being wrong.
   */
  readonly fetchedAtMs: number;
  /**
   * The store's CAS token at the moment the anchor was resolved.
   *
   * This is what {@link chainIndexAuthorityAnchorHolds} compares, and it is the
   * whole of the `stabilize()` replacement. See that function for why a token
   * is a STRONGER fence here than the hash re-read it stands in for.
   */
  readonly revision: number;
  /** Binds the anchor to one chain instance, exactly as the cursor does. */
  readonly lineage: string;
}

export type ChainIndexAnchorRefusal =
  | 'no-cursor'
  | 'no-coverage'
  /** The tick has not reached the block the reader needs. */
  | 'below-required-block'
  /** The log holds no settled prefix yet, so there is nothing to anchor on. */
  | 'nothing-settled'
  /** The tick has stopped committing; its last head proves nothing now. */
  | 'stale-head'
  /** The head the tick committed is too old IN CHAIN TIME to anchor a read. */
  | 'head-behind-chain-time'
  /** Nothing the log can name with a hash is as deep as the operator asked. */
  | 'below-finality-depth'
  /**
   * The deepest block the log can name is DEEPER than the finality anchor, so
   * serving it would answer staler than the live read the caller would have
   * done. Deeper is only "safer" against reorgs; against staleness it is the
   * weaker side, and nothing else here bounds the distance.
   */
  | 'behind-finality-anchor'
  /** A settled-hash mismatch is held and not yet confirmed or withdrawn. */
  | 'fork-suspected';

export interface ChainIndexAnchorResult {
  readonly anchor?: ChainIndexAuthorityAnchor;
  readonly refusal?: ChainIndexAnchorRefusal;
}

export interface ResolveChainIndexAuthorityAnchorInput {
  readonly state: ChainEventLogState | undefined;
  readonly contractAddress: string;
  readonly deploymentBlockNumber: number;
  /**
   * `chain.finalityConfirmations` — the node's SINGLE definition of finality,
   * read per call so a re-resolved configuration cannot leave a reader pinned
   * to a stale depth. Confirmation 1 is the head, matching
   * `resolveEvmFinalityAnchorBlockV1`.
   */
  readonly finalityConfirmations: number;
  /** Wall clock, injected so a faked `Date` is honoured by every age guard. */
  readonly nowMs: number;
  /**
   * How old the tick's last head read may be in FETCH time.
   * `min(max(3T, 15s), 5m)`: three missed passes for an operator-sized T, never
   * shorter than one slow failover pass, and never longer than the ceiling the
   * projection cache caps its own `staleMs` at.
   *
   * The caller computes it; this resolver only applies it. It is the cache's
   * `staleMs` to the millisecond so the log can never serve an answer the cache
   * holding the same view would already have dropped.
   */
  readonly maxHeadAgeMs: number;
  /**
   * How old that head may be in CHAIN time. ONE-SIDED, exactly as the
   * projection cache's guard is: a head stamped in the future is clock skew or
   * a devnet's `evm_increaseTime`, never the lagging endpoint this bound
   * exists for.
   */
  readonly headTimestampToleranceMs: number;
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

  // LINEAGE FIRST. A scope whose settled hash was seen to change is under
  // suspicion until a second pass either confirms it (tombstone) or withdraws
  // it; between the two, every row it holds may belong to a chain this node is
  // no longer on, so nothing derived from it may anchor an authority answer.
  if (state.suspectedForkBlockNumber !== undefined) {
    return Object.freeze({ refusal: 'fork-suspected' as const });
  }

  const cursor = state.cursor;
  const head = cursor.head;
  // FETCH time: is the tick still running? A negative age is a wall clock that
  // stepped backwards, which proves no age at all — refuse it the same way.
  const headAgeMs = input.nowMs - head.fetchedAtMs;
  if (!(headAgeMs >= 0) || headAgeMs > input.maxHeadAgeMs) {
    return Object.freeze({ refusal: 'stale-head' as const });
  }
  // CHAIN time: is the head the tick committed an answer about NOW? Only the
  // block's own timestamp can say; a lagging endpoint answers promptly.
  if (input.nowMs - head.timestampSeconds * 1_000 > input.headTimestampToleranceMs) {
    return Object.freeze({ refusal: 'head-behind-chain-time' as const });
  }

  if (cursor.settledBlockNumber < input.deploymentBlockNumber) {
    return Object.freeze({ refusal: 'nothing-settled' as const });
  }

  // DEPTH, from the node's single definition of it. The candidates are the two
  // blocks the log can name WITH A HASH, and the anchor is whichever of them IS
  // `confirmedStateBlockAtHead` — the same block `resolveEvmFinalityAnchorBlockV1`
  // would have pinned for this read, not merely one at least that deep.
  //
  // WHY EQUALITY, and not "deep enough". Taking the settled boundary whenever it
  // clears the depth reads as the safe direction and is not: with the production
  // `reorgHoldbackBlocks` of 50 it puts the anchor up to 49 blocks BELOW the live
  // one the moment an operator raises the depth to 2 — and an authority answer
  // this index gates catalog admission on is wrong when it is STALE, not only
  // when it is shallow. A participant revoked thirty blocks ago would still be in
  // the served roster. Neither age guard says anything about it: both are about
  // `cursor.head`, coverage is satisfied BY DEFINITION at a lower anchor, and the
  // reader admits a fold by running the CALLER'S OWN projection over it and
  // taking it iff that projection completes — a rule about whether the caller's
  // target is THERE, never about how old its state is. A projection over a
  // present-but-stale graph completes exactly as one over a fresh graph does, so
  // an existing graph's stale state is accepted rather than discarded; only an
  // ABSENT target falls through to the live scan. Equality is the only bound that
  // holds at EVERY `finalityConfirmations`, and missing it costs exactly the
  // live scan that was here before the log existed.
  //
  // The depth is re-validated here rather than trusted from the caller, for the
  // same reason `resolveEvmFinalityAnchorBlockV1` re-validates it: a depth of 0
  // resolves to `head + 1`, an anchor ABOVE the head, which would admit the
  // head unconditionally and make the check decorative.
  const confirmations = input.finalityConfirmations;
  if (!Number.isSafeInteger(confirmations) || confirmations < 1) {
    return Object.freeze({ refusal: 'below-finality-depth' as const });
  }
  const deepestAdmissible = confirmedStateBlockAtHead(head.number, confirmations);
  if (deepestAdmissible === null) {
    return Object.freeze({ refusal: 'below-finality-depth' as const });
  }
  const finalized = head.number === deepestAdmissible
    ? { number: head.number, hash: head.hash }
    : (cursor.settledBlockNumber === deepestAdmissible
      ? { number: cursor.settledBlockNumber, hash: cursor.settledBlockHash }
      : undefined);
  if (finalized === undefined) {
    // Two ways to miss it, and they are not the same failure. Above the anchor
    // the log is too SHALLOW to answer at this depth; below it the log can only
    // answer STALER than the caller's own read would have. Both refuse.
    return Object.freeze({
      refusal: cursor.settledBlockNumber > deepestAdmissible
        ? ('below-finality-depth' as const)
        : ('behind-finality-anchor' as const),
    });
  }

  const coverage = findChainEventLogCoverage(
    state.coverage,
    'context-graph-authority',
    contractAddress,
  );
  // COMPLETENESS IS ENFORCED HERE, and only here.
  //
  // The range that must be held is everything from the contract's deployment up
  // to the anchor. That is strictly stronger than
  // `chainEventLogCoverageIsComplete`, which asks only
  // `coveredFromBlock <= floorBlock`: this family's floor IS this contract's
  // deploy block (`chainIndexFloorBlocks` in `evm-chain-index-runtime.ts` seeds
  // `context-graph-authority` from `contextGraphStorage.deploymentBlockNumber`,
  // and a rotation's successor inherits a floor at or ABOVE its rebind block),
  // so a coverage record that reaches `input.deploymentBlockNumber` has by
  // definition reached its floor. History still being backfilled leaves
  // `coveredFromBlock` above the deploy block and is refused right here.
  //
  // This matters because an absence is the one answer a log can invent: a
  // MISSING Context Graph read off an unwalked range is "not indexed yet"
  // reported as "does not exist". The anchor deliberately carries no
  // `complete` flag for a caller to consult — a flag nothing reads is a guard
  // nothing has — so an incomplete family never becomes an anchor at all, and
  // the reader's second gate (`project(candidate).complete`, which sends an
  // absent target to the live scan) sits behind this one rather than beside it.
  if (!chainEventLogCoverageIncludes(
    coverage,
    input.deploymentBlockNumber,
    finalized.number,
  )) {
    return Object.freeze({ refusal: 'no-coverage' as const });
  }
  if (input.requiredBlockNumber !== undefined
    && finalized.number < input.requiredBlockNumber) {
    return Object.freeze({ refusal: 'below-required-block' as const });
  }

  return Object.freeze({
    anchor: Object.freeze({
      finalized: Object.freeze(finalized),
      head: Object.freeze({
        number: head.number,
        hash: head.hash,
        timestampSeconds: head.timestampSeconds,
      }),
      fetchedAtMs: head.fetchedAtMs,
      revision: cursor.revision,
      lineage: cursor.lineage,
    }),
  });
}

/**
 * The `stabilize()` fence, moved to the side that owns the rows.
 *
 * A live scan re-reads the anchor block's hash after folding and refuses when
 * it changed, because the pages it just read could have come from a fork the
 * chain has since dropped. A fold over the log has exactly the same exposure —
 * the anchor is the head at the default depth, and the tick replaces the whole
 * tail every pass — so it needs the same fence.
 *
 * The CAS token is that fence, and it is strictly stronger than the hash
 * re-read it replaces. Every way the rows under a fold can change is a COMMIT:
 * a tail replacement, a newly recorded fork suspicion, and the tombstone that a
 * confirmed fork writes all move the revision, and the store never reuses one.
 * So "the revision is what it was" means "not one row under this fold moved",
 * where the live fence only ever established that ONE block hash still matched.
 *
 * It costs no RPC, and the window it guards is a handful of local SQLite reads
 * against a tick that commits once per T — so a refusal here is rare, and it is
 * retryable: the next attempt resolves the newer anchor, or falls back to the
 * chain.
 */
export async function chainIndexAuthorityAnchorHolds(
  load: () => Promise<ChainEventLogState | undefined>,
  anchor: ChainIndexAuthorityAnchor,
): Promise<boolean> {
  const state = await load();
  if (state === undefined) return false;
  return state.cursor.revision === anchor.revision
    && state.cursor.lineage === anchor.lineage
    && state.suspectedForkBlockNumber === undefined;
}
