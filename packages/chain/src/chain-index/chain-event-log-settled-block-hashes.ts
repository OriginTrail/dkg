// SPDX-License-Identifier: Apache-2.0

/**
 * Settled block hashes, read from the chain at most once.
 *
 * The one log can name the hash of every block that emitted an indexed event,
 * of its settled boundary and of its head. An EMPTY block in between still
 * needed a point `eth_getBlockByNumber` on every read, and the authority index
 * asks for exactly those blocks: the page ends of a walk up from the contract's
 * deployment block, and the block its durable checkpoint stopped at. A walk
 * reads the same page ends every time it runs, and the steady-state admission
 * re-reads the boundary the previous scan stopped at, so the same few thousand
 * blocks were read again and again — while every one of them sits below the
 * settled height, where the chain the log follows can no longer change it.
 *
 * So a settled hash is read once and kept: in memory, and in the log's own
 * durable store when the store offers a memo.
 *
 * WHAT MAY BE KEPT. A block at or below the cursor's settled height, and only
 * while all of this holds:
 *  - the scope has a live cursor. A tombstoned scope loads as `undefined`.
 *  - the cursor's lineage is the one the memo was filled under. A devnet reset
 *    or a redeploy changes the hash at the deployment block, so a hash from
 *    the previous chain can never be served.
 *  - no tombstone happened in between. A reorg below the tail is repaired by a
 *    tombstone and a re-initialization that keeps the SAME lineage, so the
 *    process-local tombstone generation is part of the binding as well, and the
 *    store drops its durable rows in the tombstone's own transaction.
 *  - no settled-hash mismatch is held. While a fork is suspected the memo
 *    serves nothing and takes nothing; the suspicion ends in a tombstone (which
 *    empties it) or in a matching re-read (which proves it still holds).
 * The reorg tail is never kept: a block above the settled height is read from
 * the chain exactly as before.
 *
 * WHAT A MISS DOES. What the read did before the memo existed: `blockHashAt`
 * first, then the chain through the same transport, label, policy and RPC
 * consumer, so every fail-closed rule above this port sees the same answers.
 * Concurrent misses for one settled block share one request; a caller that
 * gives up leaves the others' request running.
 *
 * WHAT IT TRUSTS. One observation of a settled block — the trust the log
 * already gives a settled row's block hash, which it writes once and never
 * re-reads. The tick's own settled check is untouched and still reads the
 * chain on every pass: it is what proves that the whole settled prefix, and
 * with it every hash kept here, is still the chain's.
 */

import { AbortableKeyedSingleFlight } from '../keyed-ttl-single-flight-cache.js';
import {
  activeRpcRequestContext,
  withOwnedRpcRequestContext,
  type RpcRequestClass,
} from '../rpc-request-transport.js';
import {
  normalizeChainEventLogHash,
  type ChainEventLogState,
  type ChainEventLogStore,
} from './chain-event-log.js';
import { chainEventLogTombstoneGeneration } from './chain-event-log-tombstones.js';

const ZERO_HASH = `0x${'00'.repeat(32)}`;

/**
 * In-memory entries kept in front of the store.
 *
 * About a megabyte at the bound. The durable memo is what carries a walk's
 * page ends across restarts; memory only spares the store a read for the hot
 * entries, and is the whole memo for a store that offers none.
 */
export const DEFAULT_CHAIN_EVENT_LOG_SETTLED_BLOCK_HASH_ENTRIES = 8_192;

/**
 * How far below the settled height a block must be before its hash is written
 * to the durable memo.
 *
 * The steady-state reads sit a few blocks below the boundary — the checkpoint
 * the previous scan stopped at — and no restart needs them again: one per
 * tick, they would grow the table by thousands of rows a day. Memory keeps
 * them. What a restart does need again is a walk's page ends, and those are
 * all far deeper than this.
 */
export const CHAIN_EVENT_LOG_SETTLED_BLOCK_HASH_DURABLE_DEPTH_BLOCKS = 1_000;

export interface ChainEventLogSettledBlockHashesOptions {
  readonly scope: string;
  readonly store: ChainEventLogStore;
  /**
   * The chain read for a miss, unchanged from before the memo: same transport,
   * label, policy and RPC consumer.
   */
  readonly readBlockHash: (blockNumber: number, signal: AbortSignal) => Promise<string | null>;
  /** In-memory bound; the least recently used entry goes first. */
  readonly maxEntries?: number;
}

export interface ChainEventLogSettledBlockHashStats {
  /** Entries held in memory now. */
  readonly entries: number;
  readonly memoryHits: number;
  readonly durableHits: number;
  /** Physical chain reads for a settled block, after sharing. */
  readonly chainReads: number;
  /** Settled-block misses that joined a request already in flight. */
  readonly sharedReads: number;
}

export interface ChainEventLogSettledBlockHashes {
  /** Drop-in for the page source's chain read; see the module note. */
  readBlockHash(blockNumber: number, signal: AbortSignal): Promise<string | null>;
  stats(): ChainEventLogSettledBlockHashStats;
}

/** What the memo is filled under. Any change empties it. */
interface ChainEventLogSettledBlockHashBinding {
  readonly lineage: string;
  readonly generation: number;
}

/** One read's view: the binding, and how high it may keep a hash. */
interface ChainEventLogSettledBlockHashRead {
  readonly binding: ChainEventLogSettledBlockHashBinding;
  readonly settledBlockNumber: number;
}

export function createChainEventLogSettledBlockHashes(
  options: ChainEventLogSettledBlockHashesOptions,
): ChainEventLogSettledBlockHashes {
  const { scope, store } = options;
  const maxEntries = options.maxEntries ?? DEFAULT_CHAIN_EVENT_LOG_SETTLED_BLOCK_HASH_ENTRIES;
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
    throw new Error('Chain event log settled block hash bound must be a positive integer');
  }

  let bound: ChainEventLogSettledBlockHashBinding | undefined;
  let entries = new Map<number, string>();
  // One flight table per binding. A read still in flight when the binding
  // changes finishes for its own callers and keeps nothing; a caller after the
  // change starts a request of its own.
  let flights = new AbortableKeyedSingleFlight<string, string | null>();
  let memoryHits = 0;
  let durableHits = 0;
  let chainReads = 0;
  let sharedReads = 0;

  const reset = (next: ChainEventLogSettledBlockHashBinding | undefined): void => {
    bound = next;
    entries = new Map();
    flights = new AbortableKeyedSingleFlight();
  };

  const remember = (blockNumber: number, hash: string): void => {
    entries.delete(blockNumber);
    entries.set(blockNumber, hash);
    while (entries.size > maxEntries) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      entries.delete(oldest);
    }
  };

  const recall = (blockNumber: number): string | undefined => {
    const hash = entries.get(blockNumber);
    if (hash === undefined) return undefined;
    entries.delete(blockNumber);
    entries.set(blockNumber, hash);
    return hash;
  };

  /** Still the binding the read started under, by object identity and generation. */
  const holds = (binding: ChainEventLogSettledBlockHashBinding): boolean => (
    bound === binding && chainEventLogTombstoneGeneration(scope) === binding.generation
  );

  /**
   * Load the scope and decide what this read may use. The generation is read
   * on BOTH sides of the load, as the knowledge-asset ordinal cache does: a
   * tombstone landing between the two may have handed back either the dead
   * log or its re-initialization, and neither may be paired with entries
   * filled before it.
   */
  const bind = async (): Promise<ChainEventLogSettledBlockHashRead | undefined> => {
    const before = chainEventLogTombstoneGeneration(scope);
    let state: ChainEventLogState | undefined;
    try {
      state = await store.load(scope);
    } catch {
      // The read this sits behind never loaded the cursor before, so a load
      // that fails must not fail it: no memo, and the path it always took.
      return undefined;
    }
    const after = chainEventLogTombstoneGeneration(scope);
    const lineage = normalizeChainEventLogHash(state?.cursor.lineage);
    if (state === undefined || lineage === undefined || before !== after) {
      if (bound !== undefined) reset(undefined);
      return undefined;
    }
    if (bound === undefined || bound.lineage !== lineage || bound.generation !== after) {
      reset(Object.freeze({ lineage, generation: after }));
    }
    const binding = bound!;
    // Held, not cleared: a suspicion may still be withdrawn by a matching
    // re-read, and a confirmed one tombstones the scope, which empties this.
    if (state.suspectedForkBlockNumber !== undefined) return undefined;
    const settledBlockNumber = state.cursor.settledBlockNumber;
    if (!Number.isSafeInteger(settledBlockNumber) || settledBlockNumber < 0) return undefined;
    // The boundary itself is the one hash the tick re-verifies every pass.
    // `blockHashAt` names it only while it IS the boundary; the checkpoint the
    // authority index stopped at is usually the previous one, so keep it.
    const settledHash = normalizeChainEventLogHash(state.cursor.settledBlockHash);
    if (settledHash !== undefined && settledHash !== ZERO_HASH
      && entries.get(settledBlockNumber) !== settledHash) {
      remember(settledBlockNumber, settledHash);
    }
    return Object.freeze({ binding, settledBlockNumber });
  };

  /** Deep enough below the boundary to be worth a durable row; see the constant. */
  const durableDepth = (read: ChainEventLogSettledBlockHashRead, blockNumber: number): boolean => (
    read.settledBlockNumber - blockNumber >= CHAIN_EVENT_LOG_SETTLED_BLOCK_HASH_DURABLE_DEPTH_BLOCKS
  );

  /**
   * Keep one chain answer. Runs once per physical read, when it completes,
   * whichever of its callers are still waiting — a caller that gave up does
   * not stop the others' answer from being kept.
   */
  const keep = (
    read: ChainEventLogSettledBlockHashRead,
    table: AbortableKeyedSingleFlight<string, string | null>,
    blockNumber: number,
    value: string | null,
  ): void => {
    const hash = normalizeChainEventLogHash(value);
    // Checked synchronously before the write: the tick bumps the generation
    // only after its tombstone has committed, and a re-initialized scope needs
    // a later pass, so a binding that still holds here cannot be pairing this
    // hash with a rebuilt log. The store re-checks lineage, height and fork
    // suspicion in the write itself.
    if (hash === undefined || table !== flights || !holds(read.binding)) return;
    const write = store.rememberSettledBlockHash;
    if (write === undefined || !durableDepth(read, blockNumber)) {
      remember(blockNumber, hash);
      return;
    }
    void (async (): Promise<boolean> => {
      try {
        return await write.call(store, scope, read.binding.lineage, blockNumber, hash);
      } catch {
        // A memo that cannot be written is a memo that is not used: the read
        // already has its answer, and the next one goes to the chain again.
        return false;
      }
    })().then((stored) => {
      // `false` is the store refusing it — the scope moved, or two reads of
      // the block disagreed — and then memory must not keep it either.
      if (stored && table === flights && holds(read.binding)) remember(blockNumber, hash);
    }).catch(() => undefined);
  };

  const readChain = async (
    read: ChainEventLogSettledBlockHashRead,
    blockNumber: number,
    signal: AbortSignal,
  ): Promise<string | null> => {
    // Keyed by admission class as well: a foreground read must never queue
    // behind a background request, nor a background one borrow the foreground
    // reserve, so the two classes never share one physical read.
    const requestClass: RpcRequestClass = activeRpcRequestContext().requestClass;
    const table = flights;
    let initiated = false;
    const value = await table.run(
      `${requestClass}:${blockNumber}`,
      (sharedSignal) => {
        initiated = true;
        chainReads += 1;
        // The request belongs to the flight, not to whichever caller opened
        // it: only the last caller to leave may cancel it.
        return withOwnedRpcRequestContext(
          { requestClass, signal: sharedSignal },
          () => options.readBlockHash(blockNumber, sharedSignal),
        );
      },
      signal,
      (answer) => {
        try {
          keep(read, table, blockNumber, answer);
        } catch {
          // Keeping is best effort; it must never fail the read it rides on.
        }
      },
    );
    if (!initiated) sharedReads += 1;
    return value;
  };

  return Object.freeze({
    async readBlockHash(blockNumber: number, signal: AbortSignal): Promise<string | null> {
      signal.throwIfAborted();
      const read = await bind();
      // The log's own rows and cursor first, exactly as before.
      const known = await store.blockHashAt(scope, blockNumber);
      if (known !== undefined) return known;
      if (
        read === undefined
        || !Number.isSafeInteger(blockNumber)
        || blockNumber < 0
        || blockNumber > read.settledBlockNumber
      ) {
        // The reorg tail, or a scope the memo cannot vouch for: the chain, as
        // before, and nothing kept.
        return options.readBlockHash(blockNumber, signal);
      }
      const held = recall(blockNumber);
      if (held !== undefined) {
        memoryHits += 1;
        return held;
      }
      // Only a block deep enough to have been written can be there.
      if (store.readSettledBlockHash !== undefined && durableDepth(read, blockNumber)) {
        let durable: string | undefined;
        try {
          durable = normalizeChainEventLogHash(
            await store.readSettledBlockHash(scope, read.binding.lineage, blockNumber),
          );
        } catch {
          durable = undefined;
        }
        if (durable !== undefined) {
          durableHits += 1;
          if (holds(read.binding)) remember(blockNumber, durable);
          return durable;
        }
      }
      signal.throwIfAborted();
      return readChain(read, blockNumber, signal);
    },

    stats(): ChainEventLogSettledBlockHashStats {
      return Object.freeze({
        entries: entries.size,
        memoryHits,
        durableHits,
        chainReads,
        sharedReads,
      });
    },
  });
}
