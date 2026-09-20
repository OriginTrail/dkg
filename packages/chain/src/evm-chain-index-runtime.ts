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
 * They are not yet READERS of it either, and nothing in this file makes them
 * one: the binding is handed to the owning adapter alone
 * (`evm-adapter-base.ts:attachChainEventLog`), so every per-wallet adapter
 * keeps its full live scanner set, its own Hub rotation poll included. Threading
 * the binding down to them is the step that would make
 * `Hub_rotation_poll_getLogs` read zero on every wallet rather than on one.
 */

import { ethers, type JsonRpcProvider } from 'ethers';

import type {
  ChainEventLogBinding,
  ChainEventLogHubRotationWindow,
} from './chain-event-log-binding.js';
import {
  ChainEventDecoderRegistry,
  ChainIndexRunner,
  ChainIndexTick,
  chainEventLogFloorKey,
  createChainEventLogSubscription,
  createKnowledgeAssetReadModel,
  findChainEventLogCoverage,
  type ChainEventLogFetchedRow,
  type ChainEventLogStore,
  type ChainIndexLogRequest,
  type ChainIndexObservedHead,
  type ChainIndexTickResult,
  type HubBinding,
} from './chain-index/index.js';
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
}

export interface EvmChainIndexRuntime {
  /** What every adapter in this process reads instead of the chain. */
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
      initialBindings: chainIndexInitialBindings(options),
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
    const rotations = await subscription.readHubRotations(hubAddress, range);
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
  const binding: ChainEventLogBinding = Object.freeze({
    subscription,
    readHubRotationWindow,
    // The binding carries the addresses the TICK walked, not the ones a reader
    // resolves later: coverage is recorded per (family, address), so proving a
    // range against one address while reading another compares a range to
    // coverage that was never about it.
    ...(contextGraphStorageAddress === undefined ? {} : { contextGraphStorageAddress }),
    ...(options.knowledgeAssetStorage === undefined
      ? {}
      : { knowledgeAssetStorageAddress: options.knowledgeAssetStorage.address }),
    ...(contextGraphStorageAddress === undefined || options.knowledgeAssetStorage === undefined
      ? {}
      : {
        knowledgeAssets: createKnowledgeAssetReadModel({
          scope: options.scope,
          store: options.store,
          registry,
          contextGraphStorageAddress,
          knowledgeAssetStorageAddress: options.knowledgeAssetStorage.address,
        }),
      }),
  });

  return Object.freeze({
    binding,
    tick,
    start(): void {
      runner.start();
    },
    stop(): Promise<void> {
      return runner.stop();
    },
  });
}
