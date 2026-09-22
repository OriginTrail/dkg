// SPDX-License-Identifier: Apache-2.0

/**
 * The node's ONE chain log: model, durable port and coverage arithmetic.
 *
 * Every indexed on-chain event this node cares about is fetched exactly once,
 * by one tick, and written here once. Nothing else polls the chain for those
 * events; every reducer (authority today, knowledge assets next) folds over
 * these rows. That is the whole point of the file: if a second component ever
 * needs `eth_getLogs` for an event in {@link ChainEventLogTopicSet}, the answer
 * is to subscribe here, not to open a second scanner.
 *
 * The chain package owns the model and the semantics; the durable side is a
 * narrow port so `node-ui` can implement it over SQLite without interpreting a
 * single authority-bearing byte, exactly as `ContextGraphAuthorityIndexStore`
 * already does for the folded checkpoint.
 */

const HEX_32 = /^0x[0-9a-f]{64}$/;
const HEX_20 = /^0x[0-9a-f]{40}$/;

/** One raw log, as fetched. Decoding happens per reducer, never here. */
export interface ChainEventLogRow {
  readonly blockNumber: number;
  readonly blockHash: string;
  readonly logIndex: number;
  readonly transactionHash: string;
  /** Lowercased emitter. Dispatch is by (address, topic0), never by topic0 alone. */
  readonly address: string;
  /** topic0..topic3 as emitted; absent topics are omitted, never zero-filled. */
  readonly topics: readonly string[];
  readonly data: string;
  /**
   * `false` while the row is inside the reorg tail. Tail rows are replaced
   * wholesale every tick; settled rows are written once and never re-read.
   */
  readonly settled: boolean;
}

/** The ONE cursor. There is no second one, per contract or per reducer. */
export interface ChainEventLogCursor {
  /** Store-owned CAS token. Never reused, so a tombstone cannot be undone. */
  readonly revision: number;
  /**
   * Binds this scope to ONE chain instance (S5).
   *
   * `node-ui.db` survives a devnet reset (`chain-reset-wipe.ts:56-58`) and
   * deterministic redeploys reproduce the same chainId + Hub address, so the
   * scope string alone cannot tell a fresh chain from the old one. The lineage
   * is the block hash observed at the deployment block: it changes with the
   * chain even when every address is identical, so an id-reuse answer from the
   * previous chain can never be served.
   */
  readonly lineage: string;
  readonly deploymentBlockNumber: number;
  /** Contiguous prefix whose rows are final. Never re-fetched. */
  readonly settledBlockNumber: number;
  readonly settledBlockHash: string;
  readonly head: ChainEventLogHead;
  /** Bumps whenever the indexed address/topic set changes, forcing a backfill. */
  readonly topicSetVersion: string;
}

export interface ChainEventLogHead {
  readonly number: number;
  readonly hash: string;
  /**
   * CHAIN time, not fetch time (review S2). A responsive but lagging endpoint
   * answers instantly with an old head, so only the block's own timestamp says
   * what the answer is an answer ABOUT.
   */
  readonly timestampSeconds: number;
  /**
   * When the tick ASKED for this head — stamped before the head RPC, never at
   * the commit that stored it.
   *
   * The distinction is the whole value of the field. A pass reads the head
   * first and commits last, and between them sit an identity verification, an
   * `eth_getLogs` and a settled-boundary read, each under its own capped
   * watchdog policy. A commit-time stamp therefore dates the END of the pass
   * while naming the head's fetch, which makes every age derived from it short
   * by the pass duration.
   *
   * Two things measure against it and both need the conservative side:
   *
   *  - LIVENESS. The authority anchor and the knowledge-asset read model refuse
   *    past `min(max(3T, 15s), 5m)`, the Hub rotation window past the uncapped
   *    `max(3T, 15s)`, so a tick that stopped committing cannot pin its last
   *    head forever. A stamp taken
   *    before the head RPC only ever makes these refuse SOONER, and a refusal
   *    is the live read that was there before the log existed — never a wrong
   *    answer. It still catches every frozen tick, because a stamp becomes
   *    visible to a reader only by being committed.
   *  - DATA AGE. The authority reader hands this instant to the projection
   *    cache in its explicit `log` origin, which is what `onServed.ageMs`
   *    reports and what the RFC-64 breaker dates its evidence by. That number
   *    must never move towards zero.
   */
  readonly fetchedAtMs: number;
}

/**
 * Whether a stored head-fetch stamp proves a non-negative age inside a
 * reader's freshness budget. All one-log read paths use this fail-closed clock
 * rule even when their maximum ages deliberately differ.
 */
export function chainEventLogHeadAgeIsServable(
  fetchedAtMs: number,
  nowMs: number,
  maxAgeMs: number,
): boolean {
  const ageMs = nowMs - fetchedAtMs;
  return ageMs >= 0 && ageMs <= maxAgeMs;
}

/**
 * How much of history one reducer family actually holds for one address.
 *
 * This is what separates "indexed, and the thing is absent" from "not indexed
 * yet". Serving the second as the first is how a log turns an unknown graph
 * into a PUBLIC or a 0, so every read that can answer ABSENT must consult
 * {@link chainEventLogCoverageIncludes} first.
 */
export interface ChainEventLogCoverage {
  readonly family: string;
  readonly address: string;
  /** Lowest block held. Walks DOWN as the bounded backfill makes progress. */
  readonly coveredFromBlock: number;
  /** Highest block held. Walks UP with the tick. */
  readonly coveredThroughBlock: number;
  /**
   * Lowest block this family must reach before absence is knowable — the
   * emitting contract's deploy block. `coveredFromBlock > floorBlock` means the
   * backfill is still running and NOTHING may be reported absent.
   */
  readonly floorBlock: number;
}

export interface ChainEventLogState {
  readonly cursor: ChainEventLogCursor;
  readonly coverage: readonly ChainEventLogCoverage[];
  /**
   * A settled-hash mismatch seen on an earlier tick but not yet confirmed.
   *
   * Review S4: one lagging or lying endpoint must not be able to wipe the
   * node's only chain truth on a whim. A mismatch is recorded here and only a
   * SECOND independent confirmation tombstones the scope.
   */
  readonly suspectedForkBlockNumber?: number;
}

/** Why a reader must fall back instead of serving state from the one log. */
export type ChainEventLogStateReadRefusal = 'fork-suspected' | 'stale-head';

/**
 * Apply the state-wide safety gates shared by every one-log reader.
 *
 * Callers that only need the lineage gate omit the age options. Readers that
 * replace a current-chain read provide both values; providing just one is a
 * configuration error and therefore refuses closed.
 */
export function chainEventLogStateReadRefusal(
  state: ChainEventLogState,
  options: Readonly<{ nowMs?: number; maxHeadAgeMs?: number }> = {},
): ChainEventLogStateReadRefusal | undefined {
  if (state.suspectedForkBlockNumber !== undefined) return 'fork-suspected';
  const hasNow = options.nowMs !== undefined;
  const hasMaxAge = options.maxHeadAgeMs !== undefined;
  if (hasNow !== hasMaxAge) return 'stale-head';
  if (hasNow && hasMaxAge && !chainEventLogHeadAgeIsServable(
    state.cursor.head.fetchedAtMs,
    options.nowMs!,
    options.maxHeadAgeMs!,
  )) return 'stale-head';
  return undefined;
}

/** A closed block interval. Both ends are held. */
export interface ChainEventLogBlockRange {
  readonly fromBlockNumber: number;
  readonly throughBlockNumber: number;
}

/** Everything one tick writes, applied in ONE transaction under the CAS token. */
export interface ChainEventLogCommit {
  readonly cursor: Omit<ChainEventLogCursor, 'revision'>;
  /**
   * Rows fetched this tick. Settled ones are appended idempotently (a settled
   * row is written once); the tail inside {@link ChainEventLogCommit.replacedRange}
   * is dropped first, so an orphaned log simply ceases to exist — no undo
   * journal, no parent walk.
   */
  readonly rows: readonly ChainEventLogRow[];
  /**
   * The blocks this commit RE-FETCHED, and so the ONLY tail rows it may
   * replace. Omitted means the commit walked no tail at all.
   *
   * This is the whole of the coverage/rows invariant, and it lives on the
   * commit rather than in the tick because the store owns the DELETE. Coverage
   * never shrinks ({@link extendChainEventLogCoverage}), so a commit that
   * dropped the WHOLE tail without re-supplying it — a backfill page, an idle
   * head refresh, a fork-suspicion note — left coverage claiming a range whose
   * rows were gone, and the next read answered 0 events for a range that really
   * held one. Deleting only inside the re-fetched range makes "coverage claims
   * a block ⇒ the rows it had are still there" true by construction: settled
   * rows are never deleted, and a tail row can only vanish in the same
   * transaction that re-supplies the range it sat in.
   */
  readonly replacedRange?: ChainEventLogBlockRange;
  readonly coverage: readonly ChainEventLogCoverage[];
  readonly suspectedForkBlockNumber?: number;
  /**
   * Withdraw a held fork suspicion.
   *
   * Suspicion is STICKY in the store: it is the tick's only memory between two
   * passes, and a commit that merely omitted the field used to erase it — so a
   * backfill interleaved between two mismatching passes handed the second one a
   * clean slate and the S4 tombstone could never fire. Only a pass that re-read
   * the settled hash and saw it MATCH may clear it.
   */
  readonly clearsForkSuspicion?: boolean;
}

export interface ChainEventLogQuery {
  readonly fromBlockNumber: number;
  readonly throughBlockNumber: number;
  /** Lowercased emitters; omitted means every address in the scope. */
  readonly addresses?: readonly string[];
  readonly topic0?: readonly string[];
  /** Indexed arg 1 — the per-graph backfill filter the KA read model needs. */
  readonly topic1?: readonly string[];
}

/**
 * Durable side of the one log. Opaque to `node-ui`: it stores and returns rows,
 * it never decides what a row means.
 */
export interface ChainEventLogStore {
  load(scope: string): Promise<ChainEventLogState | undefined>;
  /**
   * Apply one tick atomically. Returns the new revision, or `undefined` when
   * another writer won the CAS — the caller then reloads rather than
   * overwriting, exactly like the authority checkpoint repository.
   */
  commit(
    scope: string,
    expectedRevision: number | undefined,
    commit: ChainEventLogCommit,
  ): Promise<number | undefined>;
  /**
   * Drop every row, coverage record and derived entity row under the scope and
   * advance the revision. This is the reorg-beyond-the-tail / chain-reset path,
   * so it must leave nothing behind that a later read could serve.
   */
  tombstone(scope: string, expectedRevision: number): Promise<number | undefined>;
  readEvents(scope: string, query: ChainEventLogQuery): Promise<readonly ChainEventLogRow[]>;
  /** Block hash for a block the log already holds, without an RPC round trip. */
  blockHashAt(scope: string, blockNumber: number): Promise<string | undefined>;
}

/** The address+topic set one tick fetches. Its digest versions the coverage. */
export interface ChainEventLogTopicSet {
  /** Lowercased, de-duplicated, sorted. This is the `eth_getLogs` address array. */
  readonly addresses: readonly string[];
  /** OR'd topic0 set. Sorted, so the digest is stable across orderings. */
  readonly topic0: readonly string[];
}

export function normalizeChainEventLogAddress(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  return HEX_20.test(normalized) ? normalized : undefined;
}

export function normalizeChainEventLogHash(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  return HEX_32.test(normalized) ? normalized : undefined;
}

export function normalizeChainEventLogBlockNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

/**
 * True only when `[fromBlockNumber, throughBlockNumber]` is genuinely held.
 *
 * Deliberately total and boring: every "is this absent?" answer in the node
 * bottoms out here, and the fail-closed direction is `false`.
 */
export function chainEventLogCoverageIncludes(
  coverage: ChainEventLogCoverage | undefined,
  fromBlockNumber: number,
  throughBlockNumber: number,
): boolean {
  if (coverage === undefined) return false;
  if (!Number.isSafeInteger(fromBlockNumber) || !Number.isSafeInteger(throughBlockNumber)) {
    return false;
  }
  if (throughBlockNumber < fromBlockNumber) return false;
  return coverage.coveredFromBlock <= fromBlockNumber
    && coverage.coveredThroughBlock >= throughBlockNumber;
}

/**
 * True when the family has reached its floor, so "no row" means "no event".
 *
 * A complete family is the ONLY state in which a zero/absent answer may be
 * served from the log instead of from the chain.
 */
export function chainEventLogCoverageIsComplete(
  coverage: ChainEventLogCoverage | undefined,
): boolean {
  return coverage !== undefined && coverage.coveredFromBlock <= coverage.floorBlock;
}

export function findChainEventLogCoverage(
  coverage: readonly ChainEventLogCoverage[],
  family: string,
  address: string,
): ChainEventLogCoverage | undefined {
  const normalized = normalizeChainEventLogAddress(address);
  if (normalized === undefined) return undefined;
  return coverage.find((entry) => entry.family === family && entry.address === normalized);
}

/** Merge one tick's progress into a family's coverage without ever shrinking it. */
export function extendChainEventLogCoverage(
  previous: ChainEventLogCoverage | undefined,
  next: ChainEventLogCoverage,
): ChainEventLogCoverage {
  if (previous === undefined) return Object.freeze({ ...next });
  if (previous.family !== next.family || previous.address !== next.address) {
    throw new Error('Chain event log coverage entries are not comparable');
  }
  // A contiguous prefix is the only thing coverage can mean, so a new range
  // that does not TOUCH the held one cannot widen it: keeping the old bounds
  // reports less coverage than is held, which is the fail-closed direction.
  const contiguousBelow = next.coveredThroughBlock + 1 >= previous.coveredFromBlock;
  const contiguousAbove = next.coveredFromBlock <= previous.coveredThroughBlock + 1;
  return Object.freeze({
    family: previous.family,
    address: previous.address,
    floorBlock: Math.min(previous.floorBlock, next.floorBlock),
    coveredFromBlock: contiguousBelow
      ? Math.min(previous.coveredFromBlock, next.coveredFromBlock)
      : previous.coveredFromBlock,
    coveredThroughBlock: contiguousAbove
      ? Math.max(previous.coveredThroughBlock, next.coveredThroughBlock)
      : previous.coveredThroughBlock,
  });
}

/**
 * Stable digest of what the tick is subscribed to.
 *
 * Coverage is only meaningful relative to a filter: adding an address or a
 * topic means the blocks already walked were walked WITHOUT it, so the held
 * range no longer proves absence for the new family. Persisting this with the
 * cursor lets the tick notice that and re-open the backfill instead of
 * silently answering absent from a range that never looked.
 */
export function chainEventLogTopicSetVersion(topicSet: ChainEventLogTopicSet): string {
  return JSON.stringify([
    'dkg-chain-event-log-topic-set-v1',
    [...topicSet.addresses].sort(),
    [...topicSet.topic0].sort(),
  ]);
}
