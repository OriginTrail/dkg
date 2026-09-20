// SPDX-License-Identifier: Apache-2.0

/**
 * The composition root of the node's ONE chain log.
 *
 * Everything the log needed already existed — the tick, the runner, the
 * decoders, the store — and none of it was ever constructed, so every reader
 * kept its own scanner and the savings were zero. This file is that
 * construction, and it lives in the chain package because the adapter is the
 * only thing that holds what the tick needs: resolved Hub bindings, the
 * `ethers.Interface`s the existing decoders were written against, the deploy
 * blocks, and ONE failover transport.
 *
 * ONE per node, not one per adapter. It is built only for an adapter given a
 * {@link ChainEventLogStore}, and the daemon gives exactly one
 * (`lifecycle.ts`); the per-wallet publisher adapters
 * (`publisher-runner.ts:createPublisherWalletChain`) get none, so they cannot
 * become a second TICK.
 *
 * Per-wallet adapters may BORROW the owning adapter's current binding through a
 * late-bound source. That grants read access only: they still receive no store,
 * cannot build or stop the runtime, reject a different chain/Hub scope, and
 * return to their live scanner whenever the owner has no current generation.
 */

import { ethers, type JsonRpcProvider } from 'ethers';

import type {
  ChainEventLogAuthoritySource,
  ChainEventLogBinding,
  ChainEventLogHubRotationWindow,
} from './chain-event-log-binding.js';
import {
  ChainEventDecoderRegistry,
  ChainIndexRunner,
  ChainIndexTick,
  chainEventLogFloorKey,
  chainEventLogStateReadRefusal,
  chainIndexAuthorityAnchorHolds,
  createChainEventLogSubscription,
  createChainIndexAuthorityPageSource,
  createKnowledgeAssetReadModel,
  findChainEventLogCoverage,
  resolveChainIndexAuthorityAnchor,
  type ChainEventLogFetchedRow,
  type ChainEventLogStore,
  type ChainIndexAnchorResult,
  type ChainIndexAuthorityAnchor,
  type ChainIndexLogRequest,
  type ChainIndexObservedHead,
  type ChainIndexTickResult,
  type HubBinding,
} from './chain-index/index.js';
import {
  CONTEXT_GRAPH_AUTHORITY_INDEX_HEAD_TIMESTAMP_TOLERANCE_MS,
  CONTEXT_GRAPH_AUTHORITY_INDEX_STALE_FLOOR_MS,
  resolveContextGraphAuthorityIndexStaleMs,
} from './context-graph-authority-index-projection.js';
import type { ReadOpts } from './rpc-failover-client.js';

/** One contract the tick indexes, as the adapter already holds it. */
export interface EvmChainIndexContract {
  readonly address: string;
  readonly contractInterface: ethers.Interface;
  /** Block this contract was deployed at; the floor of its families. */
  readonly deploymentBlockNumber: number;
  /**
   * The Hub registry entry this address was resolved THROUGH, when there is
   * one. It seeds {@link ChainIndexTickOptions.initialBindings}, which is what
   * lets the tick recognise a rotation of this contract as a move off this
   * address rather than as a name it is seeing for the first time.
   */
  readonly hubBinding?: Pick<HubBinding, 'name' | 'kind'>;
}

export type EvmChainIndexReadProvider = <T>(
  label: string,
  fn: (provider: JsonRpcProvider) => Promise<T>,
  opts?: ReadOpts,
) => Promise<T>;

export interface EvmChainIndexRuntimeOptions {
  readonly scope: string;
  readonly store: ChainEventLogStore;
  /** `chain.indexTickMs` (T). One pass per T; every staleness bound is T. */
  readonly intervalMs: number;
  /** Blocks held back from the settled prefix; the reorg tail. */
  readonly reorgHoldbackBlocks: number;
  readonly backfillPageBlocks: number;
  readonly maxCatchUpBlocks: number;
  /** Existing authority-index prefix used only for the first one-log pass. */
  readonly resumeFromBlockNumber?: number;
  readonly hub: EvmChainIndexContract;
  readonly contextGraphStorage?: EvmChainIndexContract;
  readonly knowledgeAssetStorage?: EvmChainIndexContract;
  /**
   * TIP-SENSITIVE transport. The tick's head, its settled-hash re-read and its
   * one `eth_getLogs` must all stay canonical-fresh and preference-transparent
   * for exactly the reason `evm-adapter-events.ts:29-35` documents: a lagging
   * sticky backend that clamps `toBlock` to its own tip would let the cursor
   * advance past blocks it never looked at.
   */
  readonly readTipProvider: EvmChainIndexReadProvider;
  readonly onResult?: (result: ChainIndexTickResult) => void;
  readonly onError?: (error: unknown) => void;
  /** Injected wall clock; late-bound so a faked `Date` is honoured. */
  readonly now?: () => number;
}

export interface EvmChainIndexRuntime {
  /** What eligible adapters in this process may borrow instead of the chain. */
  readonly binding: ChainEventLogBinding;
  readonly tick: ChainIndexTick;
  start(): void;
  stop(): Promise<void>;
}

/**
 * Map one provider log onto a stored row.
 *
 * Fail-CLOSED on a malformed entry rather than storing a row the decoders
 * would later have to guess about: a log without a block hash cannot be placed
 * on a fork, and the tail's whole reorg story is "the row is in the next tail
 * or it is not".
 */
function chainIndexFetchedRow(log: ethers.Log): ChainEventLogFetchedRow | undefined {
  const blockHash = typeof log.blockHash === 'string' ? log.blockHash.toLowerCase() : undefined;
  const transactionHash = typeof log.transactionHash === 'string'
    ? log.transactionHash.toLowerCase()
    : undefined;
  const logIndex = typeof log.index === 'number' ? log.index : undefined;
  if (blockHash === undefined || transactionHash === undefined || logIndex === undefined) {
    return undefined;
  }
  if (!Number.isSafeInteger(log.blockNumber)) return undefined;
  return Object.freeze({
    blockNumber: log.blockNumber,
    blockHash,
    logIndex,
    transactionHash,
    address: log.address.toLowerCase(),
    topics: Object.freeze(log.topics.map((topic) => topic.toLowerCase())),
    data: log.data,
  });
}

/**
 * Build the registry from the contracts the adapter resolved.
 *
 * A contract the Hub does not bind is simply not registered: what that costs
 * is recorded by the missing coverage row, which every reader already treats
 * as "cannot answer" rather than "nothing happened".
 */
function chainIndexRegistry(
  options: EvmChainIndexRuntimeOptions,
): ChainEventDecoderRegistry {
  const registry = new ChainEventDecoderRegistry();
  registry.registerHub(options.hub.address, options.hub.contractInterface);
  const contextGraphStorage = options.contextGraphStorage;
  if (contextGraphStorage !== undefined) {
    registry.registerContextGraphAuthority(
      contextGraphStorage.address,
      contextGraphStorage.contractInterface,
    );
    registry.registerContextGraphKnowledgeAssets(
      contextGraphStorage.address,
      contextGraphStorage.contractInterface,
    );
  }
  const knowledgeAssetStorage = options.knowledgeAssetStorage;
  if (knowledgeAssetStorage !== undefined) {
    registry.registerKnowledgeAssets(
      knowledgeAssetStorage.address,
      knowledgeAssetStorage.contractInterface,
    );
  }
  return registry;
}

/**
 * Per-family floors.
 *
 * Keyed by (family, address) rather than by address, because one address hosts
 * two families with different floors: see
 * {@link chainEventLogFloorKey}'s own note.
 */
function chainIndexFloorBlocks(
  options: EvmChainIndexRuntimeOptions,
): ReadonlyMap<string, number> {
  const floors = new Map<string, number>();
  const put = (family: string, contract: EvmChainIndexContract | undefined): void => {
    if (contract === undefined) return;
    floors.set(chainEventLogFloorKey(family, contract.address), contract.deploymentBlockNumber);
  };
  put('hub', options.hub);
  put('context-graph-authority', options.contextGraphStorage);
  put('context-graph-ka', options.contextGraphStorage);
  put('knowledge-asset', options.knowledgeAssetStorage);
  return floors;
}

/**
 * The Hub bindings these addresses were resolved from.
 *
 * Seeded rather than learned, because the tick only ever learns a binding from
 * a rotation it witnesses — and the rotation that matters most is the FIRST one
 * of a contract the runtime was built with. Without a binding to close, that
 * rotation would leave the retired proxy looking current and its coverage would
 * keep growing over blocks the contract no longer speaks for.
 */
function chainIndexInitialBindings(
  options: EvmChainIndexRuntimeOptions,
): readonly HubBinding[] {
  const bindings: HubBinding[] = [];
  for (const contract of [options.contextGraphStorage, options.knowledgeAssetStorage]) {
    const hubBinding = contract?.hubBinding;
    if (contract === undefined || hubBinding === undefined) continue;
    bindings.push(Object.freeze({
      name: hubBinding.name,
      kind: hubBinding.kind,
      address: contract.address,
      fromBlock: contract.deploymentBlockNumber,
    }));
  }
  return Object.freeze(bindings);
}

/**
 * How stale the log's own head may be before the Hub window stops being an
 * answer at all.
 *
 * `readHubRotationWindow` is the one reader that cannot be allowed to degrade
 * quietly: its "nothing new" window is indistinguishable from a tick that has
 * stopped committing, and the listener treats any window as handled and skips
 * its live scan. The rotation invalidation it drives is what flushes the
 * resolved-address memo, whose 30s TTL exists precisely as the missed-rotation
 * backstop — so a frozen log must send the listener back to the chain instead
 * of holding that invalidation for as long as the tick stays quiet.
 *
 * `max(3T, floor)` is the shape the sibling projection cache already uses
 * (`context-graph-authority-index-projection.ts:16-21`): three missed passes
 * for an operator-sized T, never shorter than one slow failover pass.
 *
 * FETCH time, not chain time. An idle devnet legitimately produces no blocks
 * for an hour, and refusing the window there would put the live scan back for
 * good — which is the cost this whole change exists to remove. What this guard
 * is about is whether the TICK is still running, and the tick's tip-sensitive
 * transport is what keeps the head it commits canonical.
 */
function chainIndexHubWindowMaxAgeMs(intervalMs: number): number {
  return Math.max(3 * intervalMs, CONTEXT_GRAPH_AUTHORITY_INDEX_STALE_FLOOR_MS);
}

/**
 * How old the tick's head may be before it can no longer ANCHOR an authority
 * read: `min(max(3T, floor), 5m)`, which is the projection cache's `staleMs`
 * to the millisecond.
 *
 * `max(3T, floor)` is the shape every age bound in this node shares — three
 * missed passes for an operator-sized T, never shorter than one slow failover
 * pass — and the CEILING is why this is not simply the Hub window's helper
 * reused.
 *
 * WHY THE CEILING. The authority log path is documented as the projection
 * cache's four gates minus the tick gate, and a reader is entitled to conclude
 * from that that the log can never answer something the cache would have
 * refused. Without the cap it can. The cache takes
 * `min(max(3T, 15s), CONTEXT_GRAPH_AUTHORITY_INDEX_HEAD_TIMESTAMP_TOLERANCE_MS)`,
 * so the two agree for every `T <= 100s` and diverge above it — at T=150s the
 * cache stops at 300s while an uncapped log ran to 450s, and a 400s-old anchor
 * then served through the log and was refused by the cache holding the same
 * view. `resolveContextGraphAuthorityIndexTickMs` accepts any positive integer,
 * so that T is legal configuration, and the chain-time gate does not save it:
 * a host clock behind the chain's, or a devnet after `evm_increaseTime`, is a
 * case both sides already contemplate as normal.
 *
 * The ceiling is the cache's own, for the cache's own stated reason: five
 * minutes is the RFC-64 accepted-authority refresh interval, so no link in that
 * path may be staler. It caps the useful value of `chain.indexTickMs` here
 * exactly as the cache documents it capping it there — above ~100s the log
 * refuses after two missed passes rather than three, which costs the live scan
 * that was there before the log existed and nothing else.
 *
 * NOT applied to the Hub rotation window above. That bound is not claimed
 * equivalent to anything the cache does, it gates rotation detection rather
 * than an authority answer, and its own note says what it is for: whether the
 * TICK is still running. Capping it would be borrowing a rationale that is not
 * about it.
 */
function chainIndexAuthorityAnchorMaxAgeMs(intervalMs: number): number {
  return resolveContextGraphAuthorityIndexStaleMs(intervalMs);
}

/**
 * Construct — and only construct — the one log for this process.
 *
 * `start()` is separate from construction and never awaited by the caller: a
 * cold node's first pass reads a head and one log range, and daemon startup
 * must not wait on either. Until the first pass commits, every reader's
 * coverage check refuses and it does exactly what it did before the log
 * existed.
 */
export function createEvmChainIndexRuntime(
  options: EvmChainIndexRuntimeOptions,
): EvmChainIndexRuntime {
  const registry = chainIndexRegistry(options);
  const readTip = options.readTipProvider;
  const now = options.now ?? (() => Date.now());

  const tick = new ChainIndexTick(
    {
      readHead: async (signal): Promise<ChainIndexObservedHead> => {
        const block = await readTip(
          'chainIndex tick head',
          (provider) => provider.getBlock('latest'),
          { signal, policy: 'watchdogPointRead' },
        );
        if (block === null || block.hash === null) {
          throw new Error('chain index head is unavailable');
        }
        return {
          number: block.number,
          hash: block.hash,
          // CHAIN time (review S2), carried to every age guard downstream.
          timestampSeconds: block.timestamp,
        };
      },
      readBlockHash: async (blockNumber, signal): Promise<string | null> => (
        (await readTip(
          `chainIndex tick block ${blockNumber}`,
          (provider) => provider.getBlock(blockNumber),
          { signal, policy: 'watchdogPointRead' },
        ))?.hash ?? null
      ),
      readLogs: async (
        request: ChainIndexLogRequest,
        signal,
      ): Promise<readonly ChainEventLogFetchedRow[]> => {
        // THE one `eth_getLogs`. One address array, one OR'd topic0 set, one
        // range — for every contract and every event the node indexes.
        const logs = await readTip(
          'chainIndex tick getLogs',
          (provider) => provider.getLogs({
            address: [...request.addresses],
            topics: [[...request.topic0]],
            fromBlock: request.fromBlock,
            toBlock: request.toBlock,
          }),
          { signal, policy: 'watchdogWideLogScan' },
        );
        const rows: ChainEventLogFetchedRow[] = [];
        for (const log of logs) {
          const row = chainIndexFetchedRow(log);
          if (row !== undefined) rows.push(row);
        }
        return Object.freeze(rows);
      },
    },
    {
      scope: options.scope,
      store: options.store,
      registry,
      deploymentBlockNumber: options.hub.deploymentBlockNumber,
      familyFloorBlocks: chainIndexFloorBlocks(options),
      reorgHoldbackBlocks: options.reorgHoldbackBlocks,
      backfillPageBlocks: options.backfillPageBlocks,
      maxCatchUpBlocks: options.maxCatchUpBlocks,
      resumeFromBlockNumber: options.resumeFromBlockNumber,
      initialBindings: chainIndexInitialBindings(options),
      ...(options.now === undefined ? {} : { now: options.now }),
    },
  );

  const runner = new ChainIndexRunner(tick, {
    intervalMs: options.intervalMs,
    onResult: options.onResult,
    onError: options.onError,
  });

  const subscription = createChainEventLogSubscription({
    scope: options.scope,
    store: options.store,
    registry,
  });
  const hubAddress = options.hub.address;

  /**
   * The Hub window, clamped to what the log PROVES it walked.
   *
   * This is the arithmetic `HubRotationPoller.scanFromBlock` used to do
   * against a live head, moved to the side that owns coverage. The listener's
   * `reorgBufferBlocks` re-scan is preserved exactly: a rotation that lands in
   * the tail and is then replaced on another fork is re-read on the next pass
   * and the listener's own idempotence absorbs it.
   *
   * Returns `undefined` — fall back to the chain — whenever coverage cannot
   * carry the window, including the case where the listener's cursor sits
   * BELOW the log's floor, because the blocks between them were never walked
   * and a rotation in that gap would be silently skipped forever.
   */
  async function readHubRotationWindow(
    lastScannedBlock: number | undefined,
    reorgBufferBlocks: number,
  ): Promise<ChainEventLogHubRotationWindow | undefined> {
    const state = await options.store.load(options.scope);
    if (state === undefined) return undefined;
    // The suspicion pass deliberately keeps coverage while it waits for a
    // second hash read. It also refreshes fetchedAtMs, so the age guard below
    // cannot distinguish those retained, possibly wrong-fork rows from a good
    // pass. Refuse before the baseline and empty-window shortcuts can suppress
    // the listener's live scan without consulting `servableRange`.
    // AGE FIRST, before any branch can answer. A tick that stopped committing
    // — a lagging endpoint returns before the commit, and the runner then backs
    // off to 16×T — leaves coverage frozen, and frozen coverage is exactly what
    // the "nothing new walked" window below is made of. Undefined here is the
    // listener's cue to do what it did before the log existed.
    if (chainEventLogStateReadRefusal(state, {
      nowMs: now(),
      maxHeadAgeMs: chainIndexHubWindowMaxAgeMs(options.intervalMs),
    }) !== undefined) return undefined;
    const coverage = findChainEventLogCoverage(state.coverage, 'hub', hubAddress);
    if (coverage === undefined) return undefined;
    const through = coverage.coveredThroughBlock;
    if (lastScannedBlock === undefined) {
      // BASELINE. The old listener took its baseline from a live head so the
      // first scheduled poll would not replay history; the log's covered top
      // is the same promise, and it must be made before the backfill walks
      // real rotations in underneath it.
      return Object.freeze({
        fromBlockNumber: through + 1,
        throughBlockNumber: through,
        rotations: Object.freeze([]),
      });
    }
    if (through <= lastScannedBlock) {
      // Nothing new walked. Not a refusal: re-scanning the same blocks would
      // only re-dispatch what the listener already saw.
      return Object.freeze({
        fromBlockNumber: lastScannedBlock + 1,
        throughBlockNumber: lastScannedBlock,
        rotations: Object.freeze([]),
      });
    }
    const from = Math.max(
      0,
      Math.min(lastScannedBlock + 1 - reorgBufferBlocks, through - reorgBufferBlocks),
    );
    // `servableRange` is the ONE place that decides whether a range is proven;
    // a floor check here as well would be a second opinion that can drift from
    // it, and it would be unreachable besides — it already refuses a bottom
    // below `coveredFromBlock`. The refusal is what sends the listener back to
    // its own scan, so the blocks between its cursor and the log's floor are
    // never treated as walked.
    const range = await subscription.servableRange('hub', hubAddress, from, through);
    if (range === undefined) return undefined;
    // `latest`, not `finalized`: the old listener scanned to the head and
    // deduplicated, so holding a rotation back to the settled cursor would
    // make every Hub rotation `reorgHoldbackBlocks` later to invalidate than
    // it is today. The listener re-scans the buffer and is idempotent.
    const rotations = await subscription.readHubRotations(range);
    return Object.freeze({
      fromBlockNumber: range.fromBlockNumber,
      throughBlockNumber: range.throughBlockNumber,
      rotations: Object.freeze(rotations.map((rotation) => Object.freeze({
        blockNumber: rotation.blockNumber,
        logIndex: rotation.logIndex,
        contractName: rotation.contractName,
      }))),
    });
  }

  const contextGraphStorageAddress = options.contextGraphStorage?.address;

  /**
   * The authority index's whole view of the chain, when the Hub binds a
   * `ContextGraphStorage`.
   *
   * Built here and not by the reader because everything the guards need — the
   * scope, the store, the tick interval that sizes every age bound — lives in
   * this composition root, and a reader that assembled its own would be free to
   * assemble a weaker one.
   */
  const contextGraphAuthority: ChainEventLogAuthoritySource | undefined =
    contextGraphStorageAddress === undefined ? undefined : Object.freeze({
      contractAddress: contextGraphStorageAddress,
      pageSource: createChainIndexAuthorityPageSource({
        scope: options.scope,
        store: options.store,
        registry,
        contractAddress: contextGraphStorageAddress,
        // The log knows the hash of every block that emitted an indexed event
        // plus its own cursor; an EMPTY block in between still needs the chain,
        // and this is a point read, never a scan.
        readBlockHash: async (blockNumber, signal) => (
          (await readTip(
            `chainIndex authority block ${blockNumber}`,
            (provider) => provider.getBlock(blockNumber),
            { signal, policy: 'watchdogPointRead' },
          ))?.hash ?? null
        ),
      }),
      async resolveAnchor(input: Readonly<{
        deploymentBlockNumber: number;
        finalityConfirmations: number;
        requiredBlockNumber?: number;
      }>): Promise<ChainIndexAnchorResult> {
        return resolveChainIndexAuthorityAnchor({
          state: await options.store.load(options.scope),
          contractAddress: contextGraphStorageAddress,
          deploymentBlockNumber: input.deploymentBlockNumber,
          finalityConfirmations: input.finalityConfirmations,
          nowMs: now(),
          maxHeadAgeMs: chainIndexAuthorityAnchorMaxAgeMs(options.intervalMs),
          // The SAME chain-time tolerance the projection cache refuses to serve
          // a cached head past. One number, so a scan anchored on the log can
          // never be older than an answer the cache would already have dropped.
          headTimestampToleranceMs: CONTEXT_GRAPH_AUTHORITY_INDEX_HEAD_TIMESTAMP_TOLERANCE_MS,
          ...(input.requiredBlockNumber === undefined
            ? {}
            : { requiredBlockNumber: input.requiredBlockNumber }),
        });
      },
      anchorHolds(anchor: ChainIndexAuthorityAnchor): Promise<boolean> {
        return chainIndexAuthorityAnchorHolds(
          () => options.store.load(options.scope),
          anchor,
        );
      },
    });

  type MutableChainEventLogBinding = {
    -readonly [Key in keyof ChainEventLogBinding]: ChainEventLogBinding[Key];
  };
  const binding: MutableChainEventLogBinding = {
    scope: options.scope,
    subscription,
    readHubRotationWindow,
  };
  if (contextGraphAuthority !== undefined) {
    binding.contextGraphAuthority = contextGraphAuthority;
  }
  // The binding carries the addresses the TICK walked, not the ones a reader
  // resolves later: coverage is recorded per (family, address), so proving a
  // range against one address while reading another compares a range to
  // coverage that was never about it.
  if (contextGraphStorageAddress !== undefined) {
    binding.contextGraphStorageAddress = contextGraphStorageAddress;
    binding.knowledgeAssets = createKnowledgeAssetReadModel({
      scope: options.scope,
      store: options.store,
      registry,
      contextGraphStorageAddress,
      // The authority anchor's bound exactly — `min(max(3T, 15s), 5m)`,
      // ceiling included, because these reads answer the same catalog traffic
      // from the same stored rows and there is no reason for one to outlive the
      // other. Every reader of a frozen tick degrades to the chain.
      maxHeadAgeMs: chainIndexAuthorityAnchorMaxAgeMs(options.intervalMs),
      now,
    });
  }
  if (options.knowledgeAssetStorage !== undefined) {
    binding.knowledgeAssetStorageAddress = options.knowledgeAssetStorage.address;
  }

  return Object.freeze({
    binding: Object.freeze(binding),
    tick,
    start(): void {
      runner.start();
    },
    stop(): Promise<void> {
      return runner.stop();
    },
  });
}
