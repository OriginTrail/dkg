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
import type { ChainEventDecoderRegistry, ChainEventLogFamily } from './chain-event-decoders.js';
import {
  hubBoundAddressesForRange,
  reduceHubBindings,
  splitRangeAtHubRotations,
  type HubBinding,
} from './hub-bindings.js';

export const CHAIN_EVENT_LOG_ZERO_HASH = `0x${'00'.repeat(32)}`;

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
  /** Per-family floors, so a contract deployed later is complete at ITS deploy block. */
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

interface ChainIndexFetchResult {
  readonly rows: readonly ChainEventLogFetchedRow[];
  readonly bindings: readonly HubBinding[];
  readonly logRequests: number;
  /** Per address, the lowest block this fetch actually looked at. */
  readonly lookedFrom: ReadonlyMap<string, number>;
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
    this.#bindings = this.#seedBindings(state);

    const head = await this.ports.readHead(signal);
    let blockRequests = 1;
    const observedHead = this.#normalizeHead(head);

    if (state === undefined) return this.#coldStart(observedHead, blockRequests, signal);

    const cursor = state.cursor;
    // S4. A cursor ABOVE the endpoint's head says nothing about the chain; it
    // says this endpoint is behind. Treating that as evidence is what turns one
    // lagging provider into a repeated wipe of the node's only chain truth.
    if (observedHead.number < cursor.settledBlockNumber) {
      return this.#result('endpoint-lagging', { head: observedHead, blockRequests, logRequests: 0 });
    }

    const verification = await this.#verifySettledHash(state, signal);
    blockRequests += verification.blockRequests;
    if (verification.outcome !== undefined) {
      if (verification.outcome === 'tombstoned') {
        await store.tombstone(scope, cursor.revision);
      } else {
        await store.commit(scope, cursor.revision, {
          cursor: { ...cursor, head: { ...observedHead, fetchedAtMs: this.#now() } },
          rows: [],
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

    const topicSetVersion = chainEventLogTopicSetVersion(registry.topicSet());
    const headUnchanged = observedHead.number === cursor.head.number
      && observedHead.hash === cursor.head.hash
      && topicSetVersion === cursor.topicSetVersion;
    const fetchFrom = cursor.settledBlockNumber + 1;
    if (headUnchanged && fetchFrom > observedHead.number) {
      // Nothing above the cursor and nothing new subscribed: record the fresh
      // head so the age guards see a live tick, and issue no log request.
      const revision = await store.commit(scope, cursor.revision, {
        cursor: { ...cursor, head: { ...observedHead, fetchedAtMs: this.#now() } },
        rows: [],
        coverage: [],
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
      head: { ...observedHead, fetchedAtMs: this.#now() },
      topicSetVersion,
    };
    const revision = await store.commit(scope, cursor.revision, {
      cursor: nextCursor,
      rows: this.#flagRows(fetch.rows, settled.number),
      // `fetchThrough`, NOT the head: coverage is what was actually looked at.
      // Claiming the head while a catch-up is still climbing is exactly how an
      // unindexed range becomes an "indexed and absent" answer.
      coverage: this.#extendCoverage(
        state.coverage,
        fetch.lookedFrom,
        fetchThrough,
        topicSetVersion !== cursor.topicSetVersion,
      ),
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
    const throughBlock = incomplete.coveredFromBlock - 1;
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

  #seedBindings(state: ChainEventLogState | undefined): readonly HubBinding[] {
    if (this.#bindings.length > 0) return this.#bindings;
    if (state === undefined) return [];
    return this.#bindings;
  }

  /**
   * First pass for this scope. It starts at the HEAD, not at the deployment
   * block: history is the bounded backfill's job, and until the backfill
   * reaches a family's floor that family's coverage says so, which is what
   * stops a reader turning an unindexed range into an ABSENT.
   */
  async #coldStart(
    head: ChainIndexObservedHead,
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
      ? await this.#readBoundary(settledTarget, head, signal)
      : { number: liveFrom - 1, hash: CHAIN_EVENT_LOG_ZERO_HASH, blockRequests: 0 };
    blockRequests += settled.blockRequests;

    const topicSetVersion = chainEventLogTopicSetVersion(registry.topicSet());
    const revision = await store.commit(scope, undefined, {
      cursor: {
        lineage,
        deploymentBlockNumber,
        settledBlockNumber: settled.number,
        settledBlockHash: settled.hash,
        head: { ...head, fetchedAtMs: this.#now() },
        topicSetVersion,
      },
      rows: this.#flagRows(fetch.rows, settled.number),
      coverage: this.#extendCoverage([], fetch.lookedFrom, fetchThrough, true),
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
   * Re-read the hash AT the cursor, every pass.
   *
   * Review S5: dropping this to "every ~25 blocks" to save a request is what
   * lets "inactive is final, zero RPC" and the write-once memos answer from a
   * chain that no longer exists. One request per tick is the price of the whole
   * log being trustworthy.
   */
  async #verifySettledHash(
    state: ChainEventLogState,
    signal: AbortSignal,
  ): Promise<Readonly<{
    outcome?: 'fork-suspected' | 'tombstoned';
    suspectedForkBlockNumber?: number;
    blockRequests: number;
  }>> {
    const cursor = state.cursor;
    if (cursor.settledBlockHash === CHAIN_EVENT_LOG_ZERO_HASH) {
      return Object.freeze({ blockRequests: 0 });
    }
    const observed = normalizeChainEventLogHash(
      await this.ports.readBlockHash(cursor.settledBlockNumber, signal),
    );
    if (observed === cursor.settledBlockHash) return Object.freeze({ blockRequests: 1 });
    if (observed === undefined) {
      // An endpoint that cannot answer for a block it claims to be past is a
      // transport problem, not evidence of a fork.
      return Object.freeze({ blockRequests: 1 });
    }
    // S4. Destroy only on a CONFIRMED mismatch: the same cursor height must
    // come back wrong on a second pass, which a single desynchronized or
    // dishonest answer cannot arrange on its own.
    if (state.suspectedForkBlockNumber === cursor.settledBlockNumber) {
      return Object.freeze({ outcome: 'tombstoned' as const, blockRequests: 1 });
    }
    return Object.freeze({
      outcome: 'fork-suspected' as const,
      suspectedForkBlockNumber: cursor.settledBlockNumber,
      blockRequests: 1,
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
    return this.#readBoundary(settledTarget, head, signal);
  }

  async #readBoundary(
    settledTarget: number,
    head: ChainIndexObservedHead,
    signal: AbortSignal,
  ): Promise<Readonly<{ number: number; hash: string; blockRequests: number }>> {
    if (settledTarget === head.number) {
      return Object.freeze({ number: settledTarget, hash: head.hash, blockRequests: 0 });
    }
    const hash = normalizeChainEventLogHash(
      await this.ports.readBlockHash(settledTarget, signal),
    );
    if (hash === undefined) {
      // Do not settle what cannot be named. The rows stay in the tail and the
      // next pass tries again; nothing is lost and nothing is fixed in place.
      return Object.freeze({
        number: settledTarget - 1,
        hash: CHAIN_EVENT_LOG_ZERO_HASH,
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
    let logRequests = 0;
    let bindings = this.#bindings;

    const note = (addresses: readonly string[], rangeFrom: number): void => {
      for (const address of addresses) {
        const previous = lookedFrom.get(address);
        if (previous === undefined || rangeFrom < previous) lookedFrom.set(address, rangeFrom);
      }
    };
    const request = async (
      addresses: readonly string[],
      rangeFrom: number,
      rangeThrough: number,
    ): Promise<readonly ChainEventLogFetchedRow[]> => {
      if (addresses.length === 0 || rangeThrough < rangeFrom) return [];
      logRequests += 1;
      note(addresses, rangeFrom);
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

    return Object.freeze({
      rows: Object.freeze(rows),
      bindings,
      logRequests,
      lookedFrom,
    });
  }

  #flagRows(
    rows: readonly ChainEventLogFetchedRow[],
    settledThroughBlockNumber: number,
  ): readonly ChainEventLogRow[] {
    return Object.freeze(rows.map((row) => Object.freeze({
      ...row,
      address: normalizeChainEventLogAddress(row.address) ?? row.address.toLowerCase(),
      settled: row.blockNumber <= settledThroughBlockNumber,
    })));
  }

  #extendCoverage(
    previous: readonly ChainEventLogCoverage[],
    lookedFrom: ReadonlyMap<string, number>,
    throughBlock: number,
    topicSetChanged: boolean,
  ): readonly ChainEventLogCoverage[] {
    const { registry, familyFloorBlocks, deploymentBlockNumber } = this.#options;
    const families: ChainEventLogFamily[] = ['context-graph-authority', 'hub'];
    const extended: ChainEventLogCoverage[] = [];
    for (const family of families) {
      for (const address of registry.addressesFor(family)) {
        const from = lookedFrom.get(address);
        if (from === undefined) continue;
        const floorBlock = familyFloorBlocks?.get(address) ?? deploymentBlockNumber;
        const next: ChainEventLogCoverage = Object.freeze({
          family,
          address,
          floorBlock,
          coveredFromBlock: from,
          coveredThroughBlock: throughBlock,
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
