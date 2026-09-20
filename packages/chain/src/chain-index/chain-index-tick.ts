// SPDX-License-Identifier: Apache-2.0

import {
  chainEventLogCoverageIsComplete,
  chainEventLogTopicSetVersion,
  extendChainEventLogCoverage,
  findChainEventLogCoverage,
  normalizeChainEventLogAddress,
  normalizeChainEventLogHash,
  type ChainEventLogCoverage,
  type ChainEventLogCursor,
  type ChainEventLogHead,
  type ChainEventLogRow,
  type ChainEventLogState,
  type ChainEventLogStore,
} from './chain-event-log.js';
import {
  CHAIN_EVENT_LOG_FAMILIES,
  type ChainEventDecoderRegistry,
} from './chain-event-decoders.js';
import {
  hubBindingSuccessions,
  hubBoundAddressesForRange,
  reduceHubBindings,
  splitRangeAtHubRotations,
  type HubBinding,
  type HubBindingSuccession,
} from './hub-bindings.js';

export const CHAIN_EVENT_LOG_ZERO_HASH = `0x${'00'.repeat(32)}`;

/** Key for {@link ChainIndexTickOptions.familyFloorBlocks}. */
export function chainEventLogFloorKey(family: string, address: string): string {
  return `${family}@${(normalizeChainEventLogAddress(address) ?? address).toLowerCase()}`;
}

/** One fetched log, before the tick decides which side of the horizon it is on. */
export type ChainEventLogFetchedRow = Omit<ChainEventLogRow, 'settled'>;

export interface ChainIndexLogRequest {
  readonly addresses: readonly string[];
  readonly topic0: readonly string[];
  readonly fromBlock: number;
  readonly toBlock: number;
}

/**
 * Everything the tick is allowed to ask the chain. Four calls, no more:
 * a head, a block hash, a log range — and that is the node's ENTIRE demand for
 * the indexed event set.
 */
export interface ChainIndexTickPorts {
  readHead(signal: AbortSignal): Promise<ChainIndexObservedHead>;
  readBlockHash(blockNumber: number, signal: AbortSignal): Promise<string | null>;
  readLogs(
    request: ChainIndexLogRequest,
    signal: AbortSignal,
  ): Promise<readonly ChainEventLogFetchedRow[]>;
}

export interface ChainIndexObservedHead {
  readonly number: number;
  readonly hash: string;
  readonly timestampSeconds: number;
}

export interface ChainIndexTickOptions {
  readonly scope: string;
  readonly store: ChainEventLogStore;
  readonly registry: ChainEventDecoderRegistry;
  /** Hub deploy block: the floor of the scope and the anchor of its lineage. */
  readonly deploymentBlockNumber: number;
  /**
   * Floors, so a contract deployed later is complete at ITS deploy block.
   *
   * Keyed by {@link chainEventLogFloorKey} — `family` AND address, because one
   * address can host two families with different floors: the authority fold
   * resumes from the #2670 checkpoint and is complete there, while the KA
   * ordinals on the SAME `ContextGraphStorage` are only correct from the
   * contract's deploy block. A plain address key would hand one of them the
   * other's floor and let a half-walked range answer "absent".
   */
  readonly familyFloorBlocks?: ReadonlyMap<string, number>;
  /** Blocks held back from the settled prefix; the reorg tail. */
  readonly reorgHoldbackBlocks: number;
  /** Upper bound on ONE backfill page. Bounded so a cold edge never stalls the tick. */
  readonly backfillPageBlocks: number;
  /**
   * Most blocks ONE pass may climb.
   *
   * A node that was down for a day must not turn its first tick into a
   * day-wide `eth_getLogs`. It catches up over several bounded passes instead,
   * and coverage reports how far it actually got, so nothing reads the gap as
   * absence in the meantime.
   */
  readonly maxCatchUpBlocks?: number;
  /**
   * Where a FIRST pass starts when the node already has a folded prefix — the
   * existing #2670 checkpoint cursor.
   *
   * This is the one-shot migration: the authority reducer resumes at its own
   * cursor, so no history is rescanned, while the raw log honestly reports that
   * it holds nothing BELOW this block and lets the backfill walk down.
   */
  readonly resumeFromBlockNumber?: number;
  /**
   * The Hub bindings the indexed addresses were resolved FROM.
   *
   * Without them the tick starts believing nothing is bound, and the first
   * rotation of a contract it was built with reads as a name being registered
   * for the first time: no binding is closed, so nothing marks the old address
   * retired, and its coverage marches straight past the rebind block while the
   * readers still hold that address. Seeding the current binding of each
   * indexed name is what makes that rotation a MOVE
   * ({@link hubBindingSuccessions}) instead of a first sighting.
   *
   * `fromBlock` is the contract's deploy block rather than the block the Hub
   * bound it at, which the adapter does not know: it is only ever used as a
   * lower bound, and the binding is the current one either way.
   */
  readonly initialBindings?: readonly HubBinding[];
  readonly now?: () => number;
}

export type ChainIndexTickOutcome =
  /** Head unchanged: there is nothing above the cursor to fetch. */
  | 'idle'
  /** The endpoint's head is BELOW the cursor. Retryable, never destructive (S4). */
  | 'endpoint-lagging'
  /** A settled-hash mismatch was recorded, awaiting a second confirmation (S4). */
  | 'fork-suspected'
  /** A confirmed mismatch dropped the scope. Every derived row went with it. */
  | 'tombstoned'
  | 'advanced'
  /** Another writer won the CAS. The next tick resumes from its cursor. */
  | 'cas-lost';

export interface ChainIndexTickResult {
  readonly outcome: ChainIndexTickOutcome;
  readonly head?: ChainIndexObservedHead;
  readonly settledBlockNumber?: number;
  readonly fetchedRows?: number;
  /** Physical `eth_getLogs` calls this tick issued. The one-log budget check. */
  readonly logRequests: number;
  readonly blockRequests: number;
}

/** What one pass learned about the chain it is following. */
interface ChainIndexVerification {
  readonly outcome?: 'fork-suspected' | 'tombstoned';
  readonly suspectedForkBlockNumber?: number;
  /** The settled hash was re-read and MATCHED. Nothing else may clear a suspicion. */
  readonly verified: boolean;
  readonly blockRequests: number;
}

interface ChainIndexFetchResult {
  readonly rows: readonly ChainEventLogFetchedRow[];
  readonly bindings: readonly HubBinding[];
  readonly logRequests: number;
  /** Per address, the lowest block this fetch actually looked at. */
  readonly lookedFrom: ReadonlyMap<string, number>;
  /**
   * Per address, the highest block this fetch may CLAIM.
   *
   * The top of what it looked at — except for an address the Hub has rebound a
   * name off, which is capped BELOW the rebind block however far the pass
   * actually read. Past that block the address is no longer the contract the
   * node means, and the only honest answer about those blocks is "not covered,
   * go and scan".
   */
  readonly lookedThrough: ReadonlyMap<string, number>;
  /** Names that moved off an indexed address, as of this pass. */
  readonly successions: readonly HubBindingSuccession[];
}

/**
 * THE tick. One head read and one `eth_getLogs` per pass, for every contract
 * and every event the node indexes, into one table behind one cursor.
 *
 * Settled rows are written once and never re-read. The unfinalized tail is
 * replaced wholesale each pass inside a single transaction, so an orphaned log
 * needs no undo journal: it is simply not in the next tail. A reorg deeper than
 * the tail is caught by re-reading the hash AT the cursor every pass, which is
 * also the only thing standing between a redeployed devnet and this node
 * serving yesterday's chain out of a `node-ui.db` that survived the reset.
 */
export class ChainIndexTick {
  readonly #options: ChainIndexTickOptions;
  readonly #now: () => number;
  #bindings: readonly HubBinding[] = [];

  constructor(
    private readonly ports: ChainIndexTickPorts,
    options: ChainIndexTickOptions,
  ) {
    if (options.scope.trim().length === 0) throw new Error('Chain index scope is empty');
    if (!Number.isSafeInteger(options.reorgHoldbackBlocks) || options.reorgHoldbackBlocks < 0) {
      throw new Error('Chain index reorg holdback must be a non-negative integer');
    }
    if (!Number.isSafeInteger(options.backfillPageBlocks) || options.backfillPageBlocks < 1) {
      throw new Error('Chain index backfill page must be a positive integer');
    }
    this.#options = options;
    this.#now = options.now ?? (() => Date.now());
  }

  /** Hub bindings as of the last completed pass; the address array's provenance. */
  get bindings(): readonly HubBinding[] {
    return this.#bindings;
  }

  async runOnce(signal: AbortSignal): Promise<ChainIndexTickResult> {
    signal.throwIfAborted();
    const { scope, store, registry } = this.#options;
    const state = await store.load(scope);
    this.#bindings = this.#seedBindings();

    // STAMPED BEFORE THE RPC, and carried unchanged into whichever commit this
    // pass reaches. `fetchedAtMs` is read as "when the tick fetched that head",
    // and every consumer measures an AGE against it — so the stamp must be no
    // YOUNGER than the observation it dates.
    //
    // Stamping at the commit instead, as this did, put the whole pass between
    // the two: `#verifyChainIdentity` (a capped `watchdogPointRead`),
    // `#fetchRange` (a capped `watchdogWideLogScan`) and
    // `#resolveSettledBoundary` (another capped point read) all run AFTER the
    // head is read, so the committed stamp was `headFetch + D` for a pass
    // duration D bounded only by those policy caps. Every age measured off it
    // was then SHORT by D — the one direction an age field must never move —
    // and the authority anchor's own fetch-time gate was loosened to
    // `max(3T, 15s) + D` with it.
    //
    // Before, not after, is the identical discipline the sibling projection
    // cache states for its live path
    // (`context-graph-authority-index-projection.ts`, `ageMs`): captured before
    // any RPC, so the fetch's own duration lands INSIDE the age and the age is
    // over-reported rather than under.
    //
    // Every reader of this field is fail-closed on it — the authority anchor,
    // the knowledge-asset read model and the Hub rotation window all answer
    // "go to the chain" when the age exceeds their bound — so over-reporting
    // costs at worst the live read that was there before the log existed,
    // while under-reporting serves a stale answer under a fresh age.
    const headFetchedAtMs = this.#now();
    const head = await this.ports.readHead(signal);
    let blockRequests = 1;
    const observedHead = this.#normalizeHead(head);

    if (state === undefined) {
      return this.#coldStart(observedHead, headFetchedAtMs, blockRequests, signal);
    }

    const cursor = state.cursor;
    // BEFORE the lagging return, not after it. A head below the cursor is the
    // signature of a lagging endpoint AND of a devnet redeployed under a
    // `node-ui.db` that outlived it, and the old order returned on that path
    // having verified nothing at all, so for as long as it lasted the second
    // case could not be detected.
    const verification = await this.#verifyChainIdentity(state, signal);
    blockRequests += verification.blockRequests;
    if (verification.outcome !== undefined) {
      if (verification.outcome === 'tombstoned') {
        await store.tombstone(scope, cursor.revision);
      } else {
        await store.commit(scope, cursor.revision, {
          cursor: { ...cursor, head: { ...observedHead, fetchedAtMs: headFetchedAtMs } },
          rows: [],
          // No `replacedRange`: this pass fetched no logs, so it re-supplies no
          // tail and must not drop the one coverage still claims.
          coverage: [],
          suspectedForkBlockNumber: verification.suspectedForkBlockNumber,
        });
      }
      return this.#result(verification.outcome, {
        head: observedHead,
        blockRequests,
        logRequests: 0,
      });
    }

    // S4. A cursor ABOVE the endpoint's head says nothing about the chain; it
    // says this endpoint is behind. Treating that as evidence is what turns one
    // lagging provider into a repeated wipe of the node's only chain truth.
    //
    // Measured against the highest block this scope ever observed, not only its
    // settled prefix: a head between the two is still a shorter chain than the
    // one the tail came from, and climbing only to it would leave the blocks
    // above holding rows that no later pass re-fetches — while coverage, which
    // never shrinks, went on claiming them.
    if (observedHead.number < Math.max(cursor.settledBlockNumber, cursor.head.number)) {
      return this.#result('endpoint-lagging', { head: observedHead, blockRequests, logRequests: 0 });
    }

    const topicSetVersion = chainEventLogTopicSetVersion(registry.topicSet());
    const headUnchanged = observedHead.number === cursor.head.number
      && observedHead.hash === cursor.head.hash
      && topicSetVersion === cursor.topicSetVersion;
    const fetchFrom = cursor.settledBlockNumber + 1;
    if (headUnchanged && fetchFrom > observedHead.number) {
      // Nothing above the cursor and nothing new subscribed: record the fresh
      // head so the age guards see a live tick, and issue no log request.
      const revision = await store.commit(scope, cursor.revision, {
        cursor: { ...cursor, head: { ...observedHead, fetchedAtMs: headFetchedAtMs } },
        rows: [],
        // No `replacedRange` here either: an idle pass looked at no block, so
        // the tail it holds is still the best account of those blocks there is.
        coverage: [],
        clearsForkSuspicion: verification.verified,
      });
      return this.#result(revision === undefined ? 'cas-lost' : 'idle', {
        head: observedHead,
        settledBlockNumber: cursor.settledBlockNumber,
        blockRequests,
        logRequests: 0,
      });
    }

    const fetchThrough = this.#catchUpThrough(cursor.settledBlockNumber, observedHead.number);
    const fetch = await this.#fetchRange(fetchFrom, fetchThrough, signal);
    this.#bindings = fetch.bindings;

    const settledTarget = Math.max(
      cursor.settledBlockNumber,
      Math.min(fetchThrough, observedHead.number - this.#options.reorgHoldbackBlocks),
    );
    const settled = await this.#resolveSettledBoundary(cursor, observedHead, settledTarget, signal);
    blockRequests += settled.blockRequests;

    const nextCursor: Omit<ChainEventLogCursor, 'revision'> = {
      lineage: cursor.lineage,
      deploymentBlockNumber: cursor.deploymentBlockNumber,
      settledBlockNumber: settled.number,
      settledBlockHash: settled.hash,
      head: { ...observedHead, fetchedAtMs: headFetchedAtMs },
      topicSetVersion,
    };
    const revision = await store.commit(scope, cursor.revision, {
      cursor: nextCursor,
      rows: this.#flagRows(fetch.rows, settled.number),
      // Exactly the blocks this pass re-fetched. The store replaces the tail
      // only inside it, so nothing coverage claims can go missing.
      replacedRange: { fromBlockNumber: fetchFrom, throughBlockNumber: fetchThrough },
      // What was actually LOOKED AT, per address, and never the head. Claiming
      // the head while a catch-up is still climbing is exactly how an unindexed
      // range becomes an "indexed and absent" answer — and so is claiming a
      // rebound contract's blocks for the proxy it was rebound off.
      coverage: this.#extendCoverage(
        state.coverage,
        fetch,
        topicSetVersion !== cursor.topicSetVersion,
      ),
      clearsForkSuspicion: verification.verified,
    });

    return this.#result(revision === undefined ? 'cas-lost' : 'advanced', {
      head: observedHead,
      settledBlockNumber: settled.number,
      fetchedRows: fetch.rows.length,
      blockRequests,
      logRequests: fetch.logRequests,
    });
  }

  /**
   * Walk ONE bounded page of history downwards for the families that have not
   * reached their floor, and record the new coverage.
   *
   * Separate from {@link runOnce} on purpose: the tick's cost must stay flat and
   * predictable per pass, and a cold edge must not turn "keep the head fresh"
   * into "scan the contract's whole history first". Resumable across restarts
   * because the only progress marker is the durable coverage row.
   */
  async backfillOnce(signal: AbortSignal): Promise<ChainIndexTickResult> {
    signal.throwIfAborted();
    const { scope, store } = this.#options;
    const state = await store.load(scope);
    if (state === undefined) {
      return this.#result('idle', { blockRequests: 0, logRequests: 0 });
    }
    const incomplete = state.coverage.find((entry) => !chainEventLogCoverageIsComplete(entry));
    if (incomplete === undefined) {
      return this.#result('idle', { blockRequests: 0, logRequests: 0 });
    }
    // Clamped at the settled cursor so a page can never reach into the tail.
    // History is settled history; if a coverage row ever started above the
    // cursor, walking down from it would produce tail rows that this commit —
    // which replaces no tail — is not allowed to write.
    const throughBlock = Math.min(
      incomplete.coveredFromBlock - 1,
      state.cursor.settledBlockNumber,
    );
    const fromBlock = Math.max(
      incomplete.floorBlock,
      throughBlock - this.#options.backfillPageBlocks + 1,
    );
    if (throughBlock < fromBlock) {
      return this.#result('idle', { blockRequests: 0, logRequests: 0 });
    }

    const fetch = await this.#fetchRange(fromBlock, throughBlock, signal, [incomplete.address]);
    // Backfilled history is BELOW the settled cursor by construction, so every
    // row of it is settled and is written once.
    //
    // No `replacedRange`, and that is the point: a backfill walks DOWN, it
    // never looks at the tail, and the commit that used to drop the whole tail
    // anyway left the log with no unfinalized rows at all for most of every
    // interval while coverage went on claiming them.
    const revision = await store.commit(scope, state.cursor.revision, {
      cursor: { ...state.cursor },
      rows: this.#flagRows(fetch.rows, throughBlock),
      coverage: [extendChainEventLogCoverage(incomplete, {
        ...incomplete,
        coveredFromBlock: fromBlock,
        coveredThroughBlock: incomplete.coveredThroughBlock,
      })],
    });
    return this.#result(revision === undefined ? 'cas-lost' : 'advanced', {
      settledBlockNumber: state.cursor.settledBlockNumber,
      fetchedRows: fetch.rows.length,
      blockRequests: 0,
      logRequests: fetch.logRequests,
    });
  }

  /** Highest block one pass may fetch through, so catch-up stays bounded. */
  #catchUpThrough(settledBlockNumber: number, headBlockNumber: number): number {
    const max = this.#options.maxCatchUpBlocks;
    if (max === undefined || !Number.isSafeInteger(max) || max < 1) return headBlockNumber;
    return Math.min(headBlockNumber, settledBlockNumber + max);
  }

  /**
   * What the tick believes is bound before it has read a single Hub row.
   *
   * The pairs the adapter resolved, once, and then whatever the passes have
   * folded on top. Starting from nothing is what made the FIRST rotation of an
   * indexed contract invisible as a rotation: `reduceHubBindings` had no open
   * binding to close, so nothing was ever marked retired.
   *
   * RESIDUAL, written down because the coverage model cannot represent it.
   * Bindings are process memory (hub-bindings.ts), so a rotation REBUILD seeds
   * only the addresses that are current now and carries no record that the old
   * one was retired at block R. Inert while a retired address is never read
   * again — which is what the reader's address equality and the retired-address
   * ceiling enforce — but a rotate-BACK (A -> B -> A) would hand A a single
   * interval coverage record spanning the B era it never walked, and
   * `chainEventLogCoverageIncludes` is a plain `from <= x && through >= y` with
   * no hole in it. A `topicSetVersion` bump on rebuild would force the backfill
   * that closes it.
   */
  #seedBindings(): readonly HubBinding[] {
    if (this.#bindings.length > 0) return this.#bindings;
    return this.#options.initialBindings ?? [];
  }

  /**
   * First pass for this scope. It starts at the HEAD, not at the deployment
   * block: history is the bounded backfill's job, and until the backfill
   * reaches a family's floor that family's coverage says so, which is what
   * stops a reader turning an unindexed range into an ABSENT.
   */
  async #coldStart(
    head: ChainIndexObservedHead,
    /** `runOnce`'s pre-RPC stamp for the head above; see its comment. */
    headFetchedAtMs: number,
    blockRequests: number,
    signal: AbortSignal,
  ): Promise<ChainIndexTickResult> {
    const { scope, store, registry, deploymentBlockNumber } = this.#options;
    // A node with an existing folded prefix resumes at ITS cursor; a genuinely
    // cold one starts at the head and lets the bounded backfill walk down.
    const resumeFrom = this.#options.resumeFromBlockNumber;
    const liveFrom = Math.max(
      deploymentBlockNumber,
      resumeFrom !== undefined && Number.isSafeInteger(resumeFrom)
        ? Math.min(resumeFrom + 1, head.number - this.#options.reorgHoldbackBlocks)
        : head.number - this.#options.reorgHoldbackBlocks,
    );
    const lineage = normalizeChainEventLogHash(
      await this.ports.readBlockHash(deploymentBlockNumber, signal),
    );
    blockRequests += 1;
    if (lineage === undefined) {
      // No lineage, no scope. Without it a redeployed chain with deterministic
      // addresses is indistinguishable from the old one, and `node-ui.db`
      // outlives a chain reset (`chain-reset-wipe.ts:56-58`).
      return this.#result('endpoint-lagging', { head, blockRequests, logRequests: 0 });
    }

    const fetchThrough = this.#catchUpThrough(liveFrom - 1, head.number);
    const fetch = await this.#fetchRange(liveFrom, fetchThrough, signal);
    this.#bindings = fetch.bindings;
    const settledTarget = Math.max(
      liveFrom - 1,
      Math.min(fetchThrough, head.number - this.#options.reorgHoldbackBlocks),
    );
    const settled = settledTarget >= liveFrom
      ? await this.#readBoundary(
          settledTarget,
          head,
          { number: liveFrom - 1, hash: CHAIN_EVENT_LOG_ZERO_HASH },
          signal,
        )
      : { number: liveFrom - 1, hash: CHAIN_EVENT_LOG_ZERO_HASH, blockRequests: 0 };
    blockRequests += settled.blockRequests;

    const topicSetVersion = chainEventLogTopicSetVersion(registry.topicSet());
    const revision = await store.commit(scope, undefined, {
      cursor: {
        lineage,
        deploymentBlockNumber,
        settledBlockNumber: settled.number,
        settledBlockHash: settled.hash,
        head: { ...head, fetchedAtMs: headFetchedAtMs },
        topicSetVersion,
      },
      rows: this.#flagRows(fetch.rows, settled.number),
      replacedRange: { fromBlockNumber: liveFrom, throughBlockNumber: fetchThrough },
      coverage: this.#extendCoverage([], fetch, true),
    });
    return this.#result(revision === undefined ? 'cas-lost' : 'advanced', {
      head,
      settledBlockNumber: settled.number,
      fetchedRows: fetch.rows.length,
      blockRequests,
      logRequests: fetch.logRequests,
    });
  }

  /**
   * Re-read the hash AT the cursor, every pass — and the lineage whenever that
   * read could not happen.
   *
   * Review S5: dropping this to "every ~25 blocks" to save a request is what
   * lets "inactive is final, zero RPC" and the write-once memos answer from a
   * chain that no longer exists. One request per tick is the price of the whole
   * log being trustworthy.
   *
   * `verified` is the ONLY thing that may clear a held fork suspicion, so a
   * pass that read nothing leaves the suspicion exactly where it was.
   */
  async #verifyChainIdentity(
    state: ChainEventLogState,
    signal: AbortSignal,
  ): Promise<ChainIndexVerification> {
    const cursor = state.cursor;
    if (cursor.settledBlockHash === CHAIN_EVENT_LOG_ZERO_HASH) {
      // Nothing settled to check against yet, so this pass proves nothing about
      // the height — but the lineage is answerable at any height.
      return this.#verifyLineage(state, 0, signal);
    }
    const observed = normalizeChainEventLogHash(
      await this.ports.readBlockHash(cursor.settledBlockNumber, signal),
    );
    if (observed === cursor.settledBlockHash) {
      return Object.freeze({ verified: true, blockRequests: 1 });
    }
    if (observed === undefined) {
      // An endpoint that cannot answer for a block it claims to be past is a
      // transport problem — and it is also precisely what a redeployed chain
      // shorter than this cursor looks like. The deployment block is low enough
      // that both can answer for it, and only the redeploy answers differently.
      return this.#verifyLineage(state, 1, signal);
    }
    return this.#suspect(state, cursor.settledBlockNumber, 1);
  }

  /**
   * Re-read the block hash the scope's lineage was pinned to.
   *
   * The lineage is checked at cold start and then never again, which left a
   * live cursor with no defence at all on the one path that skips the settled
   * read. `node-ui.db` survives a chain reset by design
   * (`chain-reset-wipe.ts`), and a deterministic redeploy reproduces every
   * address, so this hash is the only thing that can tell the two chains apart.
   */
  async #verifyLineage(
    state: ChainEventLogState,
    blockRequests: number,
    signal: AbortSignal,
  ): Promise<ChainIndexVerification> {
    const cursor = state.cursor;
    const observed = normalizeChainEventLogHash(
      await this.ports.readBlockHash(cursor.deploymentBlockNumber, signal),
    );
    const spent = blockRequests + 1;
    // A matching lineage says the CHAIN is the same one; it says nothing about
    // the settled height, so it is not a verification and may not clear a
    // suspicion. An unanswerable one is a transport problem, as above.
    if (observed === undefined || observed === cursor.lineage) {
      return Object.freeze({ verified: false, blockRequests: spent });
    }
    return this.#suspect(state, cursor.deploymentBlockNumber, spent);
  }

  /**
   * S4. Destroy only on a CONFIRMED mismatch: the same height must come back
   * wrong on a second pass, which a single desynchronized or dishonest answer
   * cannot arrange on its own.
   */
  #suspect(
    state: ChainEventLogState,
    blockNumber: number,
    blockRequests: number,
  ): ChainIndexVerification {
    if (state.suspectedForkBlockNumber === blockNumber) {
      return Object.freeze({ outcome: 'tombstoned' as const, verified: false, blockRequests });
    }
    return Object.freeze({
      outcome: 'fork-suspected' as const,
      suspectedForkBlockNumber: blockNumber,
      verified: false,
      blockRequests,
    });
  }

  async #resolveSettledBoundary(
    cursor: ChainEventLogCursor,
    head: ChainIndexObservedHead,
    settledTarget: number,
    signal: AbortSignal,
  ): Promise<Readonly<{ number: number; hash: string; blockRequests: number }>> {
    if (settledTarget <= cursor.settledBlockNumber) {
      return Object.freeze({
        number: cursor.settledBlockNumber,
        hash: cursor.settledBlockHash,
        blockRequests: 0,
      });
    }
    return this.#readBoundary(
      settledTarget,
      head,
      { number: cursor.settledBlockNumber, hash: cursor.settledBlockHash },
      signal,
    );
  }

  async #readBoundary(
    settledTarget: number,
    head: ChainIndexObservedHead,
    previous: Readonly<{ number: number; hash: string }>,
    signal: AbortSignal,
  ): Promise<Readonly<{ number: number; hash: string; blockRequests: number }>> {
    if (settledTarget === head.number) {
      return Object.freeze({ number: settledTarget, hash: head.hash, blockRequests: 0 });
    }
    const hash = normalizeChainEventLogHash(
      await this.ports.readBlockHash(settledTarget, signal),
    );
    if (hash === undefined) {
      // Do not settle what cannot be named. Keep the previously VERIFIED
      // boundary exactly: neither advancing its height nor replacing its hash
      // with the zero sentinel may turn an unread prefix into settled history.
      // The fetched rows stay in the tail and the next pass tries again.
      return Object.freeze({
        number: previous.number,
        hash: previous.hash,
        blockRequests: 1,
      });
    }
    return Object.freeze({ number: settledTarget, hash, blockRequests: 1 });
  }

  /**
   * One `eth_getLogs` for the whole address array, split only where a Hub
   * rotation makes a single filter wrong for part of the range.
   */
  async #fetchRange(
    fromBlock: number,
    throughBlock: number,
    signal: AbortSignal,
    restrictToAddresses?: readonly string[],
  ): Promise<ChainIndexFetchResult> {
    const { registry } = this.#options;
    const topicSet = registry.topicSet();
    const rows: ChainEventLogFetchedRow[] = [];
    const lookedFrom = new Map<string, number>();
    const lookedThrough = new Map<string, number>();
    let logRequests = 0;
    let bindings = this.#bindings;

    const note = (
      addresses: readonly string[],
      rangeFrom: number,
      rangeThrough: number,
    ): void => {
      for (const address of addresses) {
        const lowest = lookedFrom.get(address);
        if (lowest === undefined || rangeFrom < lowest) lookedFrom.set(address, rangeFrom);
        const highest = lookedThrough.get(address);
        if (highest === undefined || rangeThrough > highest) {
          lookedThrough.set(address, rangeThrough);
        }
      }
    };
    const request = async (
      addresses: readonly string[],
      rangeFrom: number,
      rangeThrough: number,
    ): Promise<readonly ChainEventLogFetchedRow[]> => {
      if (addresses.length === 0 || rangeThrough < rangeFrom) return [];
      logRequests += 1;
      note(addresses, rangeFrom, rangeThrough);
      return this.ports.readLogs({
        addresses,
        topic0: topicSet.topic0,
        fromBlock: rangeFrom,
        toBlock: rangeThrough,
      }, signal);
    };

    for (const range of splitRangeAtHubRotations(bindings, fromBlock, throughBlock)) {
      const bound = hubBoundAddressesForRange(bindings, range.fromBlock, range.throughBlock);
      // The Hub itself is always in the array: it is the root of the scope and
      // the only thing that can tell the tick the array is wrong.
      const candidates = new Set<string>([...topicSet.addresses, ...bound]);
      const addresses = restrictToAddresses === undefined
        ? [...candidates].sort()
        : restrictToAddresses.filter((address) => candidates.has(address));
      const page = await request(addresses, range.fromBlock, range.throughBlock);
      rows.push(...page);

      // Hub rows of THIS page decide the address array for the rest of it.
      const rotation = reduceHubBindings(bindings, registry.decodeHubRotations(
        page.map((row) => ({ ...row, settled: false })),
      ));
      bindings = rotation.bindings;
      for (const rebound of rotation.rebound) {
        if (restrictToAddresses !== undefined) continue;
        if (topicSet.addresses.includes(rebound.address)) continue;
        // SAME tick. The page above was fetched with the old array, so the new
        // address's blocks from the rotation onwards were never looked at. A
        // gap here would be invisible: coverage would claim the range is held.
        rows.push(...await request(
          [rebound.address],
          Math.max(rebound.fromBlock, range.fromBlock),
          range.throughBlock,
        ));
      }
    }

    // Applied AFTER the whole range, and to the final bindings rather than to
    // this page's rotations alone: a rebind stays in force for every later
    // pass, and the pass that first sees it is the last one that would notice
    // it from its own rows.
    const successions = hubBindingSuccessions(bindings);
    for (const succession of successions) {
      const claimed = lookedThrough.get(succession.retiredAddress);
      if (claimed === undefined) continue;
      // `fromBlock - 1`, not `fromBlock`: the rebind transaction sits INSIDE
      // that block, so the rest of it belongs to the new contract, whose logs
      // this address's rows cannot account for.
      const ceiling = succession.fromBlock - 1;
      if (ceiling < claimed) lookedThrough.set(succession.retiredAddress, ceiling);
    }

    return Object.freeze({
      rows: Object.freeze(rows),
      bindings,
      logRequests,
      lookedFrom,
      lookedThrough,
      successions,
    });
  }

  #flagRows(
    rows: readonly ChainEventLogFetchedRow[],
    settledThroughBlockNumber: number,
  ): readonly ChainEventLogRow[] {
    return Object.freeze(rows.map((row) => Object.freeze({
      ...row,
      address: normalizeChainEventLogAddress(row.address) ?? row.address.toLowerCase(),
      // Topics are lowercased on the way IN, beside the address, because the
      // store filters them with a plain `IN (…)` and every reader builds its
      // filter with `toString(16)`. Leaving the provider's casing to chance
      // makes a per-graph read answer an empty list instead of raising.
      topics: Object.freeze(row.topics.map((topic) => topic.toLowerCase())),
      settled: row.blockNumber <= settledThroughBlockNumber,
    })));
  }

  /**
   * Every (family, address) this pass may record coverage for.
   *
   * The registry's own addresses, plus the address a rotation moved each of
   * them to. The successor inherits the families of the address it replaced —
   * the registry cannot name it, because the registry was built before the
   * rotation — and its floor is the REBIND block: nothing below that was this
   * name's history, and the adapter's rebuilt runtime lowers the floor to the
   * contract's deploy block when it re-resolves it.
   */
  #coveredAddresses(
    family: typeof CHAIN_EVENT_LOG_FAMILIES[number],
    successions: readonly HubBindingSuccession[],
  ): readonly Readonly<{ address: string; floorBlock: number }>[] {
    const { registry, familyFloorBlocks, deploymentBlockNumber } = this.#options;
    const registered = registry.addressesFor(family);
    const covered = registered.map((address) => Object.freeze({
      address,
      floorBlock: familyFloorBlocks?.get(chainEventLogFloorKey(family, address))
        ?? familyFloorBlocks?.get(address)
        ?? deploymentBlockNumber,
    }));
    for (const succession of successions) {
      if (!registered.includes(succession.retiredAddress)) continue;
      // A pure removal has no successor to inherit this address's families.
      // Its retirement boundary still caps the old address above.
      if (succession.kind === 'removed') continue;
      // A name rebound onto an address the registry already knows needs no
      // second entry; a duplicate would only make the commit's two rows for it
      // order-dependent.
      if (registered.includes(succession.address)) continue;
      covered.push(Object.freeze({
        address: succession.address,
        floorBlock: succession.fromBlock,
      }));
    }
    return Object.freeze(covered);
  }

  #extendCoverage(
    previous: readonly ChainEventLogCoverage[],
    fetch: ChainIndexFetchResult,
    topicSetChanged: boolean,
  ): readonly ChainEventLogCoverage[] {
    const extended: ChainEventLogCoverage[] = [];
    for (const family of CHAIN_EVENT_LOG_FAMILIES) {
      for (const { address, floorBlock } of this.#coveredAddresses(family, fetch.successions)) {
        const from = fetch.lookedFrom.get(address);
        const through = fetch.lookedThrough.get(address);
        if (from === undefined || through === undefined) continue;
        // A retired address whose ceiling has fallen below everything this pass
        // looked at claims NOTHING new. Omitting the row leaves the stored one
        // exactly where the rebind stopped it (the store upserts per entry), so
        // every reader above that block refuses and keeps its own scan.
        if (through < from) continue;
        const next: ChainEventLogCoverage = Object.freeze({
          family,
          address,
          floorBlock,
          coveredFromBlock: from,
          coveredThroughBlock: through,
        });
        // A widened filter invalidates what the already-walked blocks PROVE:
        // they were walked without this topic. Restart that family's coverage
        // at the newly looked-at range so the backfill re-opens.
        const held = topicSetChanged
          ? undefined
          : findChainEventLogCoverage(previous, family, address);
        extended.push(extendChainEventLogCoverage(held, next));
      }
    }
    return Object.freeze(extended);
  }

  #normalizeHead(head: ChainIndexObservedHead): ChainIndexObservedHead {
    const hash = normalizeChainEventLogHash(head.hash);
    if (hash === undefined || !Number.isSafeInteger(head.number) || head.number < 0) {
      throw new Error('Chain index head is invalid');
    }
    return Object.freeze({
      number: head.number,
      hash,
      timestampSeconds: head.timestampSeconds,
    });
  }

  #result(
    outcome: ChainIndexTickOutcome,
    detail: Omit<ChainIndexTickResult, 'outcome'>,
  ): ChainIndexTickResult {
    return Object.freeze({ outcome, ...detail });
  }
}

export type { ChainEventLogHead };
