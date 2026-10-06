// SPDX-License-Identifier: Apache-2.0

import { setTimeout as sleep } from 'node:timers/promises';
import { contextGraphAuthorityProjectionAnchorProvenByLogV1, contextGraphFinalizedNameAbsenceAnchorHoldsV1, peekRetainedAuthoritySnapshotsV1 } from './evm-context-graph-authority-retained.js';
export { contextGraphAuthorityProjectionAnchorProvenByLogV1, contextGraphFinalizedNameAbsenceAnchorHoldsV1 } from './evm-context-graph-authority-retained.js';
import { snapshotAuthorityRevisionTargetsV1, snapshotAuthorityNameHashTargetsV1, authoritySnapshotV1, projectAuthoritySnapshotsByNameHashesV1 } from './evm-context-graph-authority-snapshot.js';
import { ethers, type Contract, type JsonRpcProvider } from 'ethers';
import type {
  ContextGraphAuthorityReadOptions,
  ContextGraphAuthoritySnapshot,
  ContextGraphFinalizedCreation,
  ContextGraphAuthorityIndexRevisionReader,
  ContextGraphLiveAuthority,
} from './chain-adapter.js';
import {
  ContextGraphAuthorityIndex,
  ContextGraphAuthorityIndexRetryableError,
  isContextGraphAuthorityIndexRetryableError,
  type ContextGraphAuthorityIndexScanInput,
} from './context-graph-authority-index.js';
import type { RawContextGraphAuthorityIndexEvent } from
  './context-graph-authority-index-reducer.js';
import {
  contextGraphAuthorityIndexProjectionFault,
  isContextGraphAuthorityIndexProjectionFault,
  resolveProjectionFetchedAtMs,
  contextGraphAuthorityIndexScope,
  type ContextGraphAuthorityIndexCompletedProjection,
  type ContextGraphAuthorityIndexProjection,
  type ContextGraphAuthorityIndexProjectionFault,
  type ContextGraphAuthorityIndexView,
} from './context-graph-authority-index-projection.js';
import type {
  ContextGraphAuthorityIndexSnapshots,
} from './context-graph-authority-index-snapshot.js';
import type { ChainEventLogAuthoritySource } from './chain-event-log-binding.js';
import type { ChainIndexAuthorityAnchor } from './chain-index/index.js';
import {
  contextGraphAuthorityIndexIdFromBigInt,
  type ContextGraphAuthorityIndexId,
} from './context-graph-authority-index-id.js';
import { CG_REGISTRY_REORG_BUFFER_BLOCKS } from './evm-adapter-constants.js';
import { isRpcEndpointFailoverEligible } from './evm-adapter-rpc.js';
import {
  contextGraphAuthorityEventTopics,
  decodeContextGraphAuthorityIndexLog,
} from './evm-context-graph-authority-source.js';
import { readAdaptiveEvmLogRange } from './evm-log-range.js';
import { resolveEvmFinalityAnchorWithHeadV1 } from './evm-finality-anchor.js';
import type { ReadOpts } from './rpc-failover-client.js';
import {
  withRpcRequestContext,
} from './rpc-request-transport.js';
import { withRpcUsageConsumer } from './rpc-usage.js';

import { readEvmContextGraphAuthorityIndexRpcV1, readOwnedAuthorityIndexRpcV1, retryCachedAuthorityIndexHeadV1 } from './evm-context-graph-authority-index-rpc.js';
export { readEvmContextGraphAuthorityIndexRpcV1 } from './evm-context-graph-authority-index-rpc.js';
import { contextGraphAuthorityAnchorUnavailableV1 } from './context-graph-authority-index-errors.js';
export { contextGraphAuthorityAnchorUnavailableV1 } from './context-graph-authority-index-errors.js';

/**
 * Keep authority-index eth_getLogs requests inside the strictest production
 * provider limit currently supported. The configured registry page size can
 * still be smaller, while stricter providers remain covered by the adaptive
 * range reader below.
 */
const CONTEXT_GRAPH_AUTHORITY_INDEX_MAX_LOG_RANGE_BLOCKS_V1 = 10_000;


type ContextGraphAuthorityLogFoldAdmission =
  | Readonly<{ kind: 'served' }>
  | Readonly<{ kind: 'fallback' }>
  | Readonly<{ kind: 'fault'; fault: unknown }>;

/** Decide a log fold explicitly, without throwing through transport layers. */
function admitContextGraphAuthorityLogFold<T>(
  predicate: ((value: T) => boolean) | undefined,
  value: T,
): ContextGraphAuthorityLogFoldAdmission {
  if (predicate === undefined) return Object.freeze({ kind: 'served' as const });
  try {
    return Object.freeze({ kind: predicate(value) ? 'served' as const : 'fallback' as const });
  } catch (fault) {
    return Object.freeze({ kind: 'fault' as const, fault });
  }
}

function boundedAuthorityIndexPageSizeV1(pageSize: number): number {
  return Number.isSafeInteger(pageSize)
    && pageSize > CONTEXT_GRAPH_AUTHORITY_INDEX_MAX_LOG_RANGE_BLOCKS_V1
    ? CONTEXT_GRAPH_AUTHORITY_INDEX_MAX_LOG_RANGE_BLOCKS_V1
    : pageSize;
}

interface EvmContextGraphAuthorityIndexReadV1<T> {
  readonly value: T;
  /** Final fence shared by state and revision projections. */
  stabilize(): Promise<void>;
}

type EvmContextGraphAuthorityIndexReadInputV1 = Readonly<{
  index: ContextGraphAuthorityIndex;
  deploymentId: string;
  contract: Contract;
  contractAddress: string;
  provider: JsonRpcProvider;
  deploymentBlockNumber: number;
  finalized: Readonly<{ number: number; hash: string }>;
  pageSize: number;
  /** Operator depth; bounds how far the DURABLE cursor may ratchet. */
  finalityConfirmations: number;
  stabilizationOperation: string;
  signal?: AbortSignal;
  /**
   * The one log, when it has PROVEN it can answer this read.
   *
   * `readPage`, `readBlockHash` and the stabilization fence are the only three
   * ports through which this index has ever seen the chain, so supplying them
   * from stored rows retires its `eth_getLogs` without touching the reducer,
   * the admission rules, the CAS or the JSON wire format other nodes consume.
   * Absent means today's provider scan, unchanged — which is what every
   * refusal in {@link resolveChainIndexAuthorityAnchor} falls back to.
   */
  logSource?: Readonly<{
    anchor: ChainIndexAuthorityAnchor;
    source: ChainEventLogAuthoritySource;
  }>;
}>;

/**
 * How far below the anchor the durable cursor is held back, for one depth.
 *
 * Matches `CG_REGISTRY_REORG_BUFFER_BLOCKS`, the depth the Context Graph
 * registry scan already treats as reorg-safe. A configured
 * `chain.finalityConfirmations` already buys `finalityConfirmations - 1` blocks
 * of exactly this protection, so only the remainder is held back; past that
 * depth the cursor tracks the anchor exactly, as it did before.
 */
export function contextGraphAuthorityIndexDurableHoldbackV1(
  finalityConfirmations: number,
  historySpanBlocks: number,
): number {
  // The holdback exists to stop a tip reorg from discarding a memo that is
  // EXPENSIVE to rebuild. On a history shorter than this, a full rebuild is a
  // handful of `eth_getLogs` calls, so holding anything back would cost the
  // durable index its whole purpose on short chains (a fresh devnet, or a
  // contract deployed minutes ago) to avoid a rescan that is already cheap.
  const HOLDBACK_WORTHWHILE_HISTORY_BLOCKS = CG_REGISTRY_REORG_BUFFER_BLOCKS * 10;
  if (
    !Number.isSafeInteger(historySpanBlocks)
    || historySpanBlocks < HOLDBACK_WORTHWHILE_HISTORY_BLOCKS
  ) {
    return 0;
  }
  const depth = Number.isSafeInteger(finalityConfirmations) && finalityConfirmations >= 1
    ? finalityConfirmations
    : 1;
  return Math.max(0, CG_REGISTRY_REORG_BUFFER_BLOCKS - (depth - 1));
}

/**
 * Everything about one scan that is the SAME whichever side answers its pages.
 *
 * Shared rather than duplicated because these are the bounds the index enforces
 * its own fail-closed rules against — the scope its checkpoint is keyed by, the
 * anchor it may not fold past, the holdback its durable cursor may not ratchet
 * past. A log-backed read that quietly differed in any of them would be a
 * second set of admission rules wearing the first one's name.
 */
function authorityIndexScanBoundsV1(
  input: EvmContextGraphAuthorityIndexReadInputV1,
): Omit<ContextGraphAuthorityIndexScanInput, 'readBlockHash' | 'readPage'> {
  return {
    scope: contextGraphAuthorityIndexScope(input.deploymentId, input.contractAddress),
    readScope: input.provider,
    deploymentBlockNumber: input.deploymentBlockNumber,
    finalized: input.finalized,
    // Preserve invalid values for ContextGraphAuthorityIndex's fail-closed
    // bounds validation; only a valid oversized configured page is clamped.
    pageSize: boundedAuthorityIndexPageSizeV1(input.pageSize),
    durableReorgHoldbackBlocks: contextGraphAuthorityIndexDurableHoldbackV1(
      input.finalityConfirmations,
      input.finalized.number - input.deploymentBlockNumber,
    ),
    signal: input.signal,
  };
}

function authorityIndexScanInputV1(
  input: EvmContextGraphAuthorityIndexReadInputV1,
): ContextGraphAuthorityIndexScanInput {
  const logged = input.logSource?.source.pageSource;
  if (logged !== undefined) {
    return {
      ...authorityIndexScanBoundsV1(input),
      readBlockHash: (blockNumber, lifecycleSignal) => (
        logged.readBlockHash(blockNumber, lifecycleSignal)
      ),
      // No `readAdaptiveEvmLogRange` here, and none is needed: the page source
      // refuses any range coverage does not PROVABLY hold, so there is no
      // provider limit to narrow around — only rows the tick already fetched.
      readPage: (fromBlock, toBlock, lifecycleSignal) => (
        logged.readPage(fromBlock, toBlock, lifecycleSignal)
      ),
    };
  }
  const authorityTopics = contextGraphAuthorityEventTopics(input.contract.interface);
  return {
    ...authorityIndexScanBoundsV1(input),
    readBlockHash: async (blockNumber, lifecycleSignal) => (
      (await withRpcUsageConsumer(
        'authorityIndex.lineage',
        () => readOwnedAuthorityIndexRpcV1(
          lifecycleSignal,
          `${input.stabilizationOperation} block ${blockNumber}`,
          () => input.provider.getBlock(blockNumber),
        ),
      ))?.hash ?? null
    ),
    readPage: async (fromBlock, toBlock, lifecycleSignal) => {
      const logs = await readAdaptiveEvmLogRange({
        read: (rangeFrom, rangeTo) => readOwnedAuthorityIndexRpcV1(
          lifecycleSignal,
          `${input.stabilizationOperation} logs ${rangeFrom}-${rangeTo}`,
          () => input.provider.getLogs({
            address: input.contractAddress,
            topics: [[...authorityTopics]],
            fromBlock: rangeFrom,
            toBlock: rangeTo,
          }),
        ),
        fromBlock,
        toBlock,
        signal: lifecycleSignal,
        provider: input.provider,
      });
      return logs.map((log) => decodeContextGraphAuthorityIndexLog(
        input.contract.interface,
        log,
      ));
    },
  };
}

async function readEvmContextGraphAuthorityIndexProjectionV1<T>(
  input: EvmContextGraphAuthorityIndexReadInputV1,
  project: (scan: ContextGraphAuthorityIndexScanInput) => Promise<T>,
): Promise<EvmContextGraphAuthorityIndexReadV1<T>> {
  const value = await project(authorityIndexScanInputV1(input));
  input.signal?.throwIfAborted();
  return Object.freeze({
    value,
    stabilize: async () => {
      input.signal?.throwIfAborted();
      const logSource = input.logSource;
      if (logSource !== undefined) {
        // The SAME fence, evaluated against the side that owns the rows. See
        // `chainIndexAuthorityAnchorHolds` for why the log's CAS token is a
        // stronger statement than the anchor hash re-read below, and why it
        // costs no RPC. Retryable for the same reason: a tick that committed
        // mid-fold is a re-read, not a broken node.
        if (!await logSource.source.anchorHolds(logSource.anchor)) {
          throw new ContextGraphAuthorityIndexRetryableError(
            `chain event log moved under ${input.stabilizationOperation}`,
          );
        }
        return;
      }
      const stable = await withRpcUsageConsumer(
        'authorityIndex.stabilize',
        () => readEvmContextGraphAuthorityIndexRpcV1(
          `${input.stabilizationOperation} stabilization block`,
          () => input.provider.getBlock(input.finalized.number),
          input.signal,
        ),
      );
      if (stable?.hash?.toLowerCase() !== input.finalized.hash.toLowerCase()) {
        // Anchored at the operator's depth the anchor can be the head, so a
        // routine single-block tip reorg reaches here during the 1-3s a page
        // scan plus `readCurrentState` takes. That is a re-read, not a broken
        // node: retryable, so the caller re-resolves against the new tip
        // instead of failing the authority read that gates catalog admission.
        throw new ContextGraphAuthorityIndexRetryableError(
          `finalized Context Graph authority anchor changed during ${input.stabilizationOperation}`,
        );
      }
    },
  });
}

/**
 * The head block's CHAIN time in seconds, or NaN when the endpoint gave none.
 * NaN is deliberate: the projection cache refuses to retain a projection whose
 * chain-time guard it could never evaluate, so such a read stays uncached.
 */
function evmContextGraphAuthorityHeadTimestampSecondsV1(head: unknown): number {
  const timestamp = (head as { timestamp?: unknown } | null | undefined)?.timestamp;
  return typeof timestamp === 'number' ? timestamp : Number.NaN;
}

interface EvmContextGraphAuthorityIndexRevisionReaderDependenciesV1 {
  readonly index: ContextGraphAuthorityIndex;
  readonly deploymentId: string;
  readonly initialize: () => Promise<void>;
  readonly requireContextGraphStorage: () => Contract;
  readonly readTipProvider: <T>(
    label: string,
    read: (provider: JsonRpcProvider) => Promise<T>,
    options?: ReadOpts,
  ) => Promise<T>;
  readonly resolveContractDeployBlockNumber: (
    address: string,
    operationLabel: string,
    contractLabel: string,
  ) => Promise<number>;
  readonly pageSize: () => number;
  /**
   * `chain.finalityConfirmations` — the node's SINGLE definition of finality.
   * Read per call so an adapter that re-resolves its configuration cannot leave
   * this reader pinned to a stale depth.
   */
  readonly finalityConfirmations: () => number;
  /**
   * The one log, or `undefined` on an adapter that has none (every per-wallet
   * publisher adapter, and this one until the first runtime attaches).
   *
   * Read per call, never captured: the binding is replaced wholesale when a Hub
   * rotation moves the log, so a reader holding the old one would be reading
   * coverage recorded for a retired `ContextGraphStorage`.
   */
  readonly chainEventLogAuthority?: () => ChainEventLogAuthoritySource | undefined;
}

/** Physical provider attempts outlive a cancelled caller and must be drained. */
class EvmContextGraphAuthorityIndexRevisionReadLifecycleV1 {
  readonly #active = new Set<Promise<unknown>>();
  #activityRevision = 0;

  run<T>(read: () => Promise<T>): Promise<T> {
    const pending = read();
    this.#activityRevision += 1;
    this.#active.add(pending);
    void pending.finally(() => {
      this.#active.delete(pending);
    }).catch(() => undefined);
    return pending;
  }

  async whenIdle(): Promise<void> {
    for (;;) {
      const activityRevision = this.#activityRevision;
      await Promise.allSettled(this.#active);
      if (activityRevision === this.#activityRevision && this.#active.size === 0) return;
    }
  }
}

/** Adapter-private reader surface shared by indexed point and batch reads. */
export interface EvmContextGraphAuthorityIndexReaderV1
  extends ContextGraphAuthorityIndexRevisionReader {
  readonly snapshots: ContextGraphAuthorityIndexSnapshots;
  /**
   * Liveness, access policy and roster from the index's retained projection,
   * or `undefined` when it cannot answer without going to the chain.
   *
   * Never escalates to a scan, and never reports `null`: absence here means
   * "not folded yet", which is not the adapter's "proved nonexistent".
   */
  peekContextGraphLiveAuthority(
    contextGraphId: bigint,
    options?: ContextGraphAuthorityReadOptions,
  ): Promise<ContextGraphLiveAuthority | undefined>;
  readContextGraphAuthoritySnapshot(
    contextGraphId: bigint,
    options?: ContextGraphAuthorityReadOptions,
  ): Promise<ContextGraphAuthoritySnapshot>;
  readContextGraphFinalizedCreation(
    contextGraphId: bigint,
    options?: ContextGraphAuthorityReadOptions,
  ): Promise<ContextGraphFinalizedCreation | undefined>;
}

/**
 * Build the sole adapter capability for complete finalized revision reads.
 * Transport, index advancement, projection, and the final anchor fence remain
 * internal to this collaborator rather than leaking as mixin prototype APIs.
 */
export function createEvmContextGraphAuthorityIndexRevisionReaderV1(
  dependencies: EvmContextGraphAuthorityIndexRevisionReaderDependenciesV1,
): EvmContextGraphAuthorityIndexReaderV1 {
  const lifecycle = new EvmContextGraphAuthorityIndexRevisionReadLifecycleV1();
  let lifecycleAbort = new AbortController();
  let ownScope: string | undefined;
  let closed = false;
  const assertOpen = (): void => {
    if (closed) throw new DOMException('Context Graph authority index reader is closed', 'AbortError');
  };
  const rescanFinalizedProjection = async <T>(
    operationLabel: string,
    options: ContextGraphAuthorityReadOptions,
    project: (
      scan: ContextGraphAuthorityIndexScanInput,
      context: Readonly<{
        provider: JsonRpcProvider;
        contractAddress: string;
        finalized: Readonly<{ number: number; hash: string }>;
        head: ContextGraphAuthorityIndexCompletedProjection['head'];
        /**
         * Explicit data provenance. The log path carries the instant the tick
         * stamped before its own head RPC; the live path identifies its scan.
         */
        origin: ContextGraphAuthorityIndexCompletedProjection['origin'];
      }>,
    ) => Promise<T>,
    /**
     * Whether an answer folded from the LOG is one this read may be given.
     *
     * THE RULE, EXACTLY. `#serve` in the projection cache applies four gates to
     * a cached candidate, and this path is equivalent on three of them:
     *
     *  - FETCH-TIME AGE. The cache refuses past `staleMs`; the log refuses past
     *    its anchor's `maxHeadAgeMs` in `resolveChainIndexAuthorityAnchor`.
     *    Both are `min(max(3T, 15s), 5m)` — the SAME number at every T, the
     *    ceiling included. The ceiling is not decoration: without it the log's
     *    bound is `max(3T, 15s)`, which equals the cache's only up to T=100s
     *    and runs LOOSER above it (450s against 300s at T=150s), so a 400s-old
     *    anchor served through the log while the cache holding the same view
     *    refused it. `resolveContextGraphAuthorityIndexStaleMs` supplies the
     *    shared value to both paths.
     *
     *    The instant both bounds measure from is the tick's HEAD-READ instant,
     *    not the commit that stored it (`ChainEventLogHead.fetchedAtMs`), so a
     *    slow pass spends its own duration out of this budget instead of being
     *    handed a fresh one at commit.
     *  - CHAIN-TIME TOLERANCE. Literally the same constant, checked on the
     *    tick's own head in the same resolver.
     *  - `project(candidate).complete`. THIS predicate, which is the caller's
     *    own projection and not a restatement of it — so a target the caller
     *    would have rejected from the cache is rejected here too, an absence
     *    still costs a live scan at a live head, and the answer the log retires
     *    is the one it can actually produce.
     *
     * NOT EQUIVALENT, deliberately: the cache's TICK GATE. `#serve` refuses any
     * candidate that has reached `tickMs`, so the cache re-scans every T. This
     * path does not, and cannot usefully: the background tick is itself the
     * refresh, it is self-scheduling with a fixed DELAY of T after each pass,
     * and the cache's miss lands at exactly `stamp + T` — which is a tick
     * commit instant plus T, always strictly before the next commit. A gate of
     * "younger than T" would therefore refuse the log on the very read that
     * follows each of its own successes, every window, for any pass duration at
     * all. Measured at T=6s that is ~290 live scans per 30 minutes against 1 —
     * i.e. exactly the per-tick scan rate the projection cache already
     * delivered without a log, so the log would retire nothing.
     *
     * What this costs is stated rather than hidden: an answer from this path is
     * as old as the moment the tick's last committed pass ASKED for its head,
     * bounded by `min(max(3T, 15s), 5m)` and by the chain-time tolerance, NOT
     * by T. The fold is reported and retained under that true instant
     * (`context.origin` above), so the cache ages it from when its
     * data was fetched, `onServed` reports that age, and it can never be
     * re-served as a FRESH cache entry for a further T.
     *
     * That discriminant is also the cache's PROVENANCE signal: `kind: 'log'`
     * declares "I folded stored rows, I fetched nothing", which is why
     * `onServed` reports `log` for this answer and never `scan`. An answer
     * that touched no endpoint may not be handed to a consumer as evidence
     * that the endpoints are alive — the RFC-64 authority circuit breaker is
     * one, and a fold reported as `scan` could close it while every endpoint
     * was still down.
     *
     * `undefined` means the caller consumes no view (the durable refresh), so
     * there is no absence for it to mistake.
     */
    logAnswerServes?: (value: T) => boolean,
  ): Promise<T | ContextGraphAuthorityIndexProjectionFault> => {
    assertOpen();
    const projectionSignal = lifecycleAbort.signal;
    options.signal?.throwIfAborted();
    await dependencies.initialize();
    assertOpen();
    projectionSignal.throwIfAborted();
    options.signal?.throwIfAborted();
    const base = dependencies.requireContextGraphStorage();
    return dependencies.readTipProvider(
      operationLabel,
      (provider) => retryCachedAuthorityIndexHeadV1(
        () => withRpcRequestContext({ signal: projectionSignal }, () => lifecycle.run(async () => {
        assertOpen();
        projectionSignal.throwIfAborted();
        const contract = base.connect(provider) as Contract;
        const contractAddress = (await contract.getAddress()).toLowerCase();
        ownScope = contextGraphAuthorityIndexScope(dependencies.deploymentId, contractAddress);
        const deploymentBlockNumber = await dependencies.resolveContractDeployBlockNumber(
          contractAddress,
          operationLabel,
          'ContextGraphStorage',
        );
        const readInput = {
          index: dependencies.index,
          deploymentId: dependencies.deploymentId,
          contract,
          contractAddress,
          provider,
          deploymentBlockNumber,
          pageSize: dependencies.pageSize(),
          finalityConfirmations: dependencies.finalityConfirmations(),
          stabilizationOperation: operationLabel,
        };

        // THE LOG FIRST, and only when it can PROVE every guarantee the live
        // path below gives: a head fresh in fetch AND chain time, an anchor no
        // shallower than `chain.finalityConfirmations`, coverage back to this
        // contract's deployment, no held fork suspicion — and, after the fold,
        // the fence. Any one of those missing is a refusal, and a refusal falls
        // straight through to the scan that was here before.
        //
        // Bound to the address the TICK walked. A rotation the adapter has not
        // yet rebuilt around leaves these unequal, and reading the log then
        // would prove a range against coverage recorded for a retired proxy.
        for (let logAttempt = 0; logAttempt < 2; logAttempt += 1) {
          // A concurrent reader may advance the durable authority cursor after
          // this tick supplied an anchor. Reacquire the live log generation
          // once before spending an RPC scan on that ordinary local race.
          const source = dependencies.chainEventLogAuthority?.();
          if (source === undefined || source.contractAddress !== contractAddress) break;
          const anchor = (await source.resolveAnchor({
            deploymentBlockNumber,
            finalityConfirmations: dependencies.finalityConfirmations(),
          })).anchor;
          if (anchor === undefined) break;
          try {
            const logged = await readEvmContextGraphAuthorityIndexProjectionV1(
              { ...readInput, finalized: anchor.finalized, logSource: { anchor, source } },
              (scan) => project(scan, {
                provider,
                contractAddress,
                finalized: anchor.finalized,
                head: anchor.head,
                // The instant the tick asked for this head — stamped before its
                // head RPC, so the pass that fetched these rows is INSIDE the
                // age rather than in front of it. Carried so the cache ages and
                // reports the fold by its own age instead of by this read's
                // clock.
                // The anchor rides along so a LATER revalidation of this
                // retained fold can ask whether the local one-log generation
                // moved. This inherits the log's tick/freshness-bounded view of
                // chain canonicality; it is not a fresh chain observation.
                origin: Object.freeze({
                  kind: 'log' as const,
                  dataFetchedAtMs: anchor.fetchedAtMs,
                  anchor,
                }),
              }),
            );
            await logged.stabilize();
            // The fence belongs to the captured source generation. A Hub
            // rotation, runtime rebuild, or shutdown may replace/remove that
            // source while `anchorHolds` is awaiting the store. Re-read the
            // late-bound owner after the await and refuse the old generation
            // even when it happened to retain the same physical address.
            options.signal?.throwIfAborted();
            const currentSource = dependencies.chainEventLogAuthority?.();
            if (currentSource === source
              && currentSource.contractAddress === contractAddress) {
              const admission = admitContextGraphAuthorityLogFold(logAnswerServes, logged.value);
              if (admission.kind === 'served') return logged.value;
              if (admission.kind === 'fault') {
                return contextGraphAuthorityIndexProjectionFault(admission.fault);
              }
            }
          } catch (error) {
            options.signal?.throwIfAborted();
            projectionSignal.throwIfAborted();
            if (!isContextGraphAuthorityIndexRetryableError(error)
              || error.reason !== 'cursor-ahead') throw error;
            if (logAttempt === 0) {
              await sleep(300, undefined, { signal: projectionSignal });
              continue;
            }
            // The second local anchor also lags the durable cursor. Let the
            // fresh provider scan below establish a new finalized boundary.
          }
        }

        // Anchor the whole projection at the operator-configured finality depth,
        // NOT at the endpoint's `finalized` tag. The tag lags head by ~600
        // blocks / ~20 minutes on Base Sepolia, which made a freshly registered
        // Context Graph invisible to the authority index for that entire window
        // — both peers fenced each other's catalog traffic and the replica lost
        // rows while reporting itself complete. Head and anchor come from the
        // same provider, so the pair can never be spliced across endpoints.
        const { finalized, head } = await resolveEvmFinalityAnchorWithHeadV1({
          finalityConfirmations: dependencies.finalityConfirmations(),
          readHead: () => withRpcUsageConsumer(
            'authorityIndex.head',
            () => readEvmContextGraphAuthorityIndexRpcV1(
              `${operationLabel} chain head`,
              () => provider.getBlock('latest'),
              options.signal,
            ),
          ),
          readBlockAt: (anchorBlockNumber) => withRpcUsageConsumer(
            'authorityIndex.anchor',
            () => readEvmContextGraphAuthorityIndexRpcV1(
              `${operationLabel} anchor block ${anchorBlockNumber}`,
              () => provider.getBlock(anchorBlockNumber),
              options.signal,
            ),
          ),
          unavailable: contextGraphAuthorityAnchorUnavailableV1,
        });
        // Contract, scope and deploy block are resolved ABOVE, before the log
        // fast path, because that path needs both the address it must match the
        // tick's binding against and the block coverage has to reach back to.
        const headHash = head.hash;
        const indexed = await readEvmContextGraphAuthorityIndexProjectionV1(
          { ...readInput, finalized: { number: finalized.number, hash: finalized.hash } },
          (scan) => project(scan, {
            provider,
            contractAddress,
            finalized: { number: finalized.number, hash: finalized.hash },
            // The anchor resolver already failed closed on an unusable head.
            head: {
              number: head.number,
              hash: headHash,
              timestampSeconds: evmContextGraphAuthorityHeadTimestampSecondsV1(head),
            },
            origin: Object.freeze({ kind: 'scan' as const }),
          }),
        );
        await indexed.stabilize();
        return indexed.value;
        })),
        projectionSignal,
        options.signal,
      ),
      {
        signal: options.signal,
        isRetryable: (error: unknown) => (
          !options.signal?.aborted && (
            isContextGraphAuthorityIndexRetryableError(error)
            || isRpcEndpointFailoverEligible(error)
          )
        ),
        policy: 'durablePagedLogScan',
      },
    );
  };

  /**
   * The same retained-projection read, minus the escalation.
   *
   * {@link readFinalizedProjection} answers at any cost: a miss ends in
   * `rescanFinalizedProjection`, which is a live head read plus a paged
   * `eth_getLogs` walk back to the deployment block. That is right for a caller
   * that needs the answer.
   *
   * A bounded-freshness caller is trying to avoid ONE `eth_call`. Escalating
   * its miss into a full rescan would cost orders of magnitude more than the
   * read it was avoiding, and would do it precisely when the index is cold — at
   * startup, after a Hub rotation, on first contact with a graph — which is
   * when the most callers arrive together. So a miss is reported as a miss and
   * the caller does what it would have done anyway.
   *
   * Anchor validation is deliberately kept: a retained projection carrying an
   * unsettled tail is admitted here by exactly the rule the escalating path
   * uses, so relaxing freshness never relaxes reorg safety.
   */
  const peekFinalizedProjection = async <T>(
    operationLabel: string,
    options: ContextGraphAuthorityReadOptions,
    read: (projection: ContextGraphAuthorityIndexProjection) => Readonly<{
      complete: boolean;
      value: T;
    }>,
  ): Promise<Readonly<{ hit: true; value: T } | { hit: false }>> => {
    assertOpen();
    options.signal?.throwIfAborted();
    await dependencies.initialize();
    assertOpen();
    options.signal?.throwIfAborted();
    const scope = contextGraphAuthorityIndexScope(
      dependencies.deploymentId,
      await dependencies.requireContextGraphStorage().getAddress(),
    );
    return dependencies.index.peekProjection({
      scope,
      signal: options.signal,
      project: read,
      validateAnchor: async (cached) => {
        // THE SAME short-circuit the escalating read uses. Without it a bounded
        // reader pays a block read the live path would have avoided, which
        // inverts the whole point: the read that was trying to save an
        // `eth_call` ends up costing an `eth_getBlockByNumber` the live caller
        // never spends.
        const provenByLog = await contextGraphAuthorityProjectionAnchorProvenByLogV1(
          cached,
          dependencies.chainEventLogAuthority?.(),
          await dependencies.requireContextGraphStorage().getAddress(),
        );
        options.signal?.throwIfAborted();
        if (provenByLog === true) return true;
        return dependencies.readTipProvider(
          `${operationLabel} cached projection anchor`,
          async (provider) => {
            const anchor = await withRpcUsageConsumer(
              'authorityProjection.validateAnchor',
              () => readEvmContextGraphAuthorityIndexRpcV1(
                `${operationLabel} cached projection anchor block`,
                () => provider.getBlock(cached.finalized.number),
                options.signal,
              ),
            );
            if (anchor?.hash == null) return undefined;
            return anchor.hash.toLowerCase() === cached.finalized.hash.toLowerCase();
          },
          { signal: options.signal },
        );
      },
      onServed: options.onContextGraphAuthorityProjectionServed,
    });
  };

  /**
   * Every finalized READ of this capability. It is answered from the index's
   * last completed projection while that is younger than `chain.indexTickMs`;
   * otherwise `rescanFinalizedProjection` above runs exactly as it always has
   * (head, cursor admission, scan, stabilize) and its result is kept. The
   * projection is handed over only AFTER the stabilization fence, so a scan
   * whose anchor moved is never retained.
   *
   * `snapshots.refresh` is NOT routed through here: the core's background loop
   * must advance the durable cursor every pass and feeds only the servable
   * durable snapshot.
   */
  const readFinalizedProjection = async <T>(
    operationLabel: string,
    options: ContextGraphAuthorityReadOptions,
    read: (projection: ContextGraphAuthorityIndexProjection) => Readonly<{
      complete: boolean;
      value: T;
    }>,
    validateIncomplete?: (projection: ContextGraphAuthorityIndexProjection) => Promise<boolean>,
  ): Promise<T> => {
    assertOpen();
    options.signal?.throwIfAborted();
    await dependencies.initialize();
    assertOpen();
    options.signal?.throwIfAborted();
    // Keyed by the contract this adapter is bound to NOW, never by the scope a
    // previous read happened to see: a rotated ContextGraphStorage is a miss
    // even if nothing told the index to clear.
    const scope = contextGraphAuthorityIndexScope(
      dependencies.deploymentId,
      await dependencies.requireContextGraphStorage().getAddress(),
    );
    // A floor for the synthetic candidate below, taken before the cache takes
    // its own: a fold that reports no fetch instant of its own is treated as
    // being as of this read, which can only OVER-report its age.
    const askedAtMs = Date.now();
    const projected = await dependencies.index.projection({
      scope,
      signal: options.signal,
      project: read,
      ...(validateIncomplete === undefined ? {} : { validateIncomplete }),
      validateAnchor: async (cached) => {
        const provenByLog = await contextGraphAuthorityProjectionAnchorProvenByLogV1(
          cached,
          dependencies.chainEventLogAuthority?.(),
          await dependencies.requireContextGraphStorage().getAddress(),
        );
        // `anchorHolds` has no caller signal of its own. Re-check after that
        // await before either serving the cache or beginning provider fallback.
        options.signal?.throwIfAborted();
        if (provenByLog === true) return true;
        return dependencies.readTipProvider(
          `${operationLabel} cached projection anchor`,
          async (provider) => {
            const anchor = await withRpcUsageConsumer(
              'authorityProjection.validateAnchor',
              () => readEvmContextGraphAuthorityIndexRpcV1(
                `${operationLabel} cached projection anchor block`,
                () => provider.getBlock(cached.finalized.number),
                options.signal,
              ),
            );
            if (anchor?.hash == null) return undefined;
            return anchor.hash.toLowerCase() === cached.finalized.hash.toLowerCase();
          },
          { signal: options.signal },
        );
      },
      onServed: options.onContextGraphAuthorityProjectionServed,
      refresh: () => rescanFinalizedProjection(
        operationLabel,
        options,
        async (scan, { provider, contractAddress, finalized, head, origin }) => {
          const view = await dependencies.index.view(scan);
          const chainId = (await readEvmContextGraphAuthorityIndexRpcV1(
            `${operationLabel} network`,
            () => provider.getNetwork(),
            options.signal,
          )).chainId.toString(10);
          return Object.freeze({
            scope: scan.scope,
            chainId,
            contractAddress,
            finalized,
            head,
            requiresAnchorValidation: (scan.durableReorgHoldbackBlocks ?? 0) > 0,
            view,
            origin,
          });
        },
        // The SAME predicate the cache admits a projection by, applied to the
        // log-anchored fold. An absent target therefore still costs a live scan
        // at a live head; what the log retires is the reads whose answer it can
        // actually produce, which is the steady state.
        //
        // That predicate IS `project(candidate).complete` — `read` here — so
        // the fold is admitted by the identical rule and not by a restatement
        // of it that could drift. `read` is a pure projection, so evaluating it
        // here and again on the projection the cache publishes costs only the
        // projection.
        //
        // `fetchedAtMs` is the one field the PROJECTION type adds, so the
        // candidate has to supply it. A fold from the log knows the answer —
        // `origin.dataFetchedAtMs`, the instant the tick asked for the head it
        // committed, up to `min(max(3T, 15s), 5m)` before this read — and that
        // is what it must carry: stamping this read's clock would move the age
        // towards zero, the single direction the field exists to forbid.
        // `askedAtMs` is only the floor for a fold that reported no believable
        // instant of its own.
        //
        // Stamped by the CACHE'S OWN constructor, not by a local expression
        // that says the same thing. The candidate this predicate judges and the
        // projection the cache then ages and reports must not be able to
        // disagree, and a restatement can drift from the rule without anything
        // noticing — this one had: the `Math.min` that stood here believed a
        // NaN or fractional `dataFetchedAtMs` the cache rejects. The floors are
        // deliberately different: `askedAtMs` is taken before the cache takes
        // its own, so an absent or unbelievable instant leaves the candidate
        // stamped at or before the published projection, which can only
        // OVER-report age.
        //
        // Exceptions PROPAGATE. A projection that throws on the fold throws
        // again on the live scan's own projection — the conditions it throws on
        // (an invalid target, a name hash ambiguous across finalized graphs)
        // are properties of the caller's targets and of chain state that a
        // later anchor only ever sees MORE of — so swallowing here would buy a
        // paid scan and then rethrow the same error, which is exactly the
        // "exceptions never become cache misses or extra paid scans" the cache
        // documents. Admission returns faults as data until the projection
        // cache has crossed both transport-classification boundaries.
        //
        // The candidate is stamped by the cache's OWN resolver, not by a second
        // copy of the rule here. The copy that used to sit at this line had
        // already drifted: a bare `Math.min` believed a NaN or fractional
        // `dataFetchedAtMs` that the resolver rejects, so the view a read was
        // ADMITTED by could be stamped differently from the one the cache then
        // aged and reported. The floors differ deliberately — `askedAtMs`
        // precedes the cache's own stamp — and only ever over-report, which is
        // the safe direction.
        (completed) => read({
          ...completed,
          fetchedAtMs: resolveProjectionFetchedAtMs(askedAtMs, completed.origin),
        }).complete,
      ),
    });
    options.signal?.throwIfAborted();
    return projected;
  };

  // An absent name binding is reusable only at the SAME finalized block and
  // hash. A live caller proves that against the provider. A bounded caller may
  // instead use the chain event log's generation fence: its tick/freshness
  // contract bounds staleness, and a moved local generation declines to the
  // provider path. This keeps repeatable query/sync authorization available
  // while a single endpoint is saturated without weakening mutation/key gates.
  const validateFinalizedNameAbsence = (
    operationLabel: string,
    options: ContextGraphAuthorityReadOptions,
  ) => async (cached: ContextGraphAuthorityIndexProjection): Promise<boolean> => {
    const contractAddress = await dependencies.requireContextGraphStorage().getAddress();
    return contextGraphFinalizedNameAbsenceAnchorHoldsV1(cached, options, {
      currentSource: dependencies.chainEventLogAuthority?.(),
      contractAddress,
      readCurrentFinalized: async () => {
        const current = await dependencies.readTipProvider(
          `${operationLabel} absent-name finality`,
          (provider) => resolveEvmFinalityAnchorWithHeadV1({
            finalityConfirmations: dependencies.finalityConfirmations(),
            readHead: () => withRpcUsageConsumer(
              'authorityProjection.absentNameHead',
              () => readEvmContextGraphAuthorityIndexRpcV1(
                `${operationLabel} absent-name chain head`,
                () => provider.getBlock('latest'),
                options.signal,
              ),
            ),
            readBlockAt: (blockNumber) => withRpcUsageConsumer(
              'authorityProjection.absentNameAnchor',
              () => readEvmContextGraphAuthorityIndexRpcV1(
                `${operationLabel} absent-name anchor block ${blockNumber}`,
                () => provider.getBlock(blockNumber),
                options.signal,
              ),
            ),
            unavailable: contextGraphAuthorityAnchorUnavailableV1,
          }),
          { signal: options.signal },
        );
        return current.finalized;
      },
    });
  };

  const resolveFinalizedIdsByNameHashes = async (
    rawNameHashes: readonly string[],
    options: ContextGraphAuthorityReadOptions,
    operationLabel = 'resolveFinalizedContextGraphIdsByNameHashes',
  ): Promise<ReadonlyMap<string, bigint>> => {
    const nameHashes = snapshotAuthorityNameHashTargetsV1(rawNameHashes);
    options.signal?.throwIfAborted();
    if (nameHashes.length === 0) return new Map();
    return readFinalizedProjection(
      operationLabel,
      options,
      ({ view }) => {
        const resolved = new Map<string, bigint>();
        for (const [nameHash, state] of view.statesByNameHashes(nameHashes)) {
          resolved.set(nameHash, BigInt(state.contextGraphId));
        }
        return { complete: resolved.size === nameHashes.length, value: resolved };
      },
      validateFinalizedNameAbsence(operationLabel, options),
    );
  };

  const resolveFinalizedSnapshotsByNameHashes = async (
    rawNameHashes: readonly string[],
    options: ContextGraphAuthorityReadOptions,
    operationLabel = 'resolveFinalizedContextGraphAuthoritySnapshotsByNameHashes',
  ): Promise<ReadonlyMap<string, ContextGraphAuthoritySnapshot>> => {
    const nameHashes = snapshotAuthorityNameHashTargetsV1(rawNameHashes);
    options.signal?.throwIfAborted();
    if (nameHashes.length === 0) return new Map();
    return readFinalizedProjection(
      operationLabel,
      options,
      (projection) => projectAuthoritySnapshotsByNameHashesV1(nameHashes, projection),
      validateFinalizedNameAbsence(operationLabel, options),
    );
  };

  return Object.freeze({
    snapshots: Object.freeze({
      open(): void {
        if (lifecycleAbort.signal.aborted) lifecycleAbort = new AbortController();
        dependencies.index.open();
        closed = false;
      },
      async close(): Promise<void> {
        closed = true;
        ownScope = undefined;
        lifecycleAbort.abort(new DOMException('Context Graph authority reader lifecycle closed', 'AbortError'));
        await Promise.all([dependencies.index.close(), lifecycle.whenIdle()]);
      },
      async exportSnapshot(request) {
        if (closed || request?.scope !== ownScope) return null;
        return dependencies.index.exportSnapshot(request);
      },
      async refresh(options: ContextGraphAuthorityReadOptions = {}): Promise<void> {
        const result = await rescanFinalizedProjection(
          'refreshContextGraphAuthorityIndex',
          options,
          (scan) => dependencies.index.refresh(scan),
        );
        // This call supplies no log admission predicate, so the fault arm is
        // unreachable. Keep the guard at the boundary if that ever changes.
        if (isContextGraphAuthorityIndexProjectionFault(result)) throw result.fault;
      },
    } satisfies ContextGraphAuthorityIndexSnapshots),
    async whenIdle(): Promise<void> {
      await Promise.all([
        lifecycle.whenIdle(),
        dependencies.index.whenIdle(),
      ]);
    },
    async peekContextGraphLiveAuthority(
      contextGraphId: bigint,
      options: ContextGraphAuthorityReadOptions = {},
    ): Promise<ContextGraphLiveAuthority | undefined> {
      const target = contextGraphAuthorityIndexIdFromBigInt(contextGraphId);
      const peeked = await peekFinalizedProjection<ContextGraphLiveAuthority | undefined>(
        'peekContextGraphLiveAuthority',
        options,
        ({ view }) => {
          // ONE fold position answers all three fields, or none of them does.
          // Composing liveness from the fold with a roster from anywhere else
          // is how a policy and the membership it governs come to disagree.
          const complete = view.has(target);
          if (!complete) return { complete, value: undefined };
          const state = view.resolve(target);
          return {
            complete,
            value: Object.freeze({
              active: state.active,
              accessPolicy: state.accessPolicy,
              participantAgents: Object.freeze([...state.participantAgents]),
            }),
          };
        },
      );
      // ABSENCE IS `undefined`, NEVER `null`. `null` is the adapter's proof
      // that the chain does not have this id — terminal, never retried. The
      // index not having folded a creation event yet proves nothing of the
      // sort: the graph may have been created one block ago. Returning `null`
      // here would turn "not indexed yet" into "does not exist".
      return peeked.hit ? peeked.value : undefined;
    },
    async readContextGraphAuthoritySnapshot(
      contextGraphId: bigint,
      options: ContextGraphAuthorityReadOptions = {},
    ): Promise<ContextGraphAuthoritySnapshot> {
      const target = contextGraphAuthorityIndexIdFromBigInt(contextGraphId);
      const snapshot = await readFinalizedProjection<ContextGraphAuthoritySnapshot | undefined>(
        'getContextGraphAuthoritySnapshot',
        options,
        ({ view, chainId, contractAddress }) => {
          const complete = view.has(target);
          return {
            complete,
            value: complete
              ? authoritySnapshotV1(view.resolve(target), chainId, contractAddress)
              : undefined,
          };
        },
      );
      if (snapshot === undefined) {
        throw new Error(`Context Graph ${target} has no finalized creation event`);
      }
      return snapshot;
    },
    async readContextGraphFinalizedCreation(
      contextGraphId: bigint,
      options: ContextGraphAuthorityReadOptions = {},
    ): Promise<ContextGraphFinalizedCreation | undefined> {
      const target = contextGraphAuthorityIndexIdFromBigInt(contextGraphId);
      assertOpen();
      options.signal?.throwIfAborted();
      await dependencies.initialize();
      assertOpen();
      options.signal?.throwIfAborted();
      const projectionSignal = lifecycleAbort.signal;
      projectionSignal.throwIfAborted();
      const base = dependencies.requireContextGraphStorage();
      return dependencies.readTipProvider(
        'getContextGraphFinalizedCreation',
        (provider) => withRpcRequestContext(
          { signal: projectionSignal },
          () => lifecycle.run(async () => {
            const contract = base.connect(provider) as Contract;
            const contractAddress = (await contract.getAddress()).toLowerCase();
            const source = dependencies.chainEventLogAuthority?.();
            if (source === undefined || source.contractAddress !== contractAddress) {
              return undefined;
            }
            const deploymentBlockNumber = await dependencies.resolveContractDeployBlockNumber(
              contractAddress,
              'getContextGraphFinalizedCreation',
              'ContextGraphStorage',
            );
            const anchor = (await source.resolveAnchor({
              deploymentBlockNumber,
              finalityConfirmations: dependencies.finalityConfirmations(),
            })).anchor;
            if (anchor === undefined) return undefined;

            let view: ContextGraphAuthorityIndexView;
            let creation: Extract<
              RawContextGraphAuthorityIndexEvent,
              Readonly<{ name: 'ContextGraphCreated' }>
            > | undefined;
            try {
              const logged = await readEvmContextGraphAuthorityIndexProjectionV1(
                {
                  index: dependencies.index,
                  deploymentId: dependencies.deploymentId,
                  contract,
                  contractAddress,
                  provider,
                  deploymentBlockNumber,
                  pageSize: dependencies.pageSize(),
                  finalityConfirmations: dependencies.finalityConfirmations(),
                  finalized: anchor.finalized,
                  stabilizationOperation: 'getContextGraphFinalizedCreation',
                  signal: projectionSignal,
                  logSource: { anchor, source },
                },
                async (scan) => {
                  const indexedView = await dependencies.index.view(scan);
                  const creationEvents = (await source.pageSource.readContextGraphEvents(
                    contextGraphId,
                    deploymentBlockNumber,
                    anchor.finalized.number,
                    projectionSignal,
                  )).filter((event): event is Extract<
                    RawContextGraphAuthorityIndexEvent,
                    Readonly<{ name: 'ContextGraphCreated' }>
                  > => event.name === 'ContextGraphCreated'
                    && BigInt(event.contextGraphId as bigint) === contextGraphId);
                  return { indexedView, creationEvents };
                },
              );
              await logged.stabilize();
              view = logged.value.indexedView;
              creation = logged.value.creationEvents.length === 1
                ? logged.value.creationEvents[0]
                : undefined;
            } catch {
              options.signal?.throwIfAborted();
              projectionSignal.throwIfAborted();
              // Incomplete coverage, a moved lineage/revision, or any local
              // projection fault is an optimization miss. The borrower keeps
              // the live point-read behavior it had before this seam.
              return undefined;
            }

            // Re-read every generation/scope dependency after the final fence
            // await. The caller performs the stronger binding-object fence too.
            const currentContractAddress = (
              await dependencies.requireContextGraphStorage().getAddress()
            ).toLowerCase();
            options.signal?.throwIfAborted();
            projectionSignal.throwIfAborted();
            if (currentContractAddress !== contractAddress
              || dependencies.chainEventLogAuthority?.() !== source
              || !view.has(target)
              || creation === undefined) {
              return undefined;
            }
            const state = view.resolve(target);
            const nameHash = typeof creation.nameHash === 'string'
              ? creation.nameHash.toLowerCase()
              : undefined;
            const accessPolicy = typeof creation.accessPolicy === 'number'
              ? creation.accessPolicy
              : Number(creation.accessPolicy);
            if (nameHash === undefined
              || !ethers.isHexString(nameHash, 32)
              || nameHash === ethers.ZeroHash
              || (accessPolicy !== 0 && accessPolicy !== 1)
              || state.nameHash !== nameHash
              || state.accessPolicy !== accessPolicy) {
              return undefined;
            }
            return Object.freeze({
              nameHash,
              accessPolicy: accessPolicy as 0 | 1,
            });
          }),
        ),
        {
          signal: options.signal,
          isRetryable: () => false,
          policy: 'durablePagedLogScan',
        },
      );
    },
    async resolveFinalizedContextGraphIdByNameHash(
      nameHash: string,
      options: ContextGraphAuthorityReadOptions = {},
    ): Promise<bigint | null> {
      const normalized = snapshotAuthorityNameHashTargetsV1([nameHash]);
      if (normalized.length === 0) return null;
      const resolved = await resolveFinalizedIdsByNameHashes(
        normalized,
        options,
        'resolveFinalizedContextGraphIdByNameHash',
      );
      return resolved.get(normalized[0]!) ?? null;
    },
    resolveFinalizedContextGraphIdsByNameHashes(
      nameHashes: readonly string[],
      options: ContextGraphAuthorityReadOptions = {},
    ): Promise<ReadonlyMap<string, bigint>> {
      return resolveFinalizedIdsByNameHashes(nameHashes, options);
    },
    async resolveFinalizedContextGraphAuthoritySnapshotByNameHash(
      nameHash: string,
      options: ContextGraphAuthorityReadOptions = {},
    ): Promise<ContextGraphAuthoritySnapshot | null> {
      const nameHashes = snapshotAuthorityNameHashTargetsV1([nameHash]);
      if (nameHashes.length === 0) return null;
      const snapshots = await resolveFinalizedSnapshotsByNameHashes(
        nameHashes,
        options,
        'resolveFinalizedContextGraphAuthoritySnapshotByNameHash',
      );
      return snapshots.get(nameHashes[0]!) ?? null;
    },
    resolveFinalizedContextGraphAuthoritySnapshotsByNameHashes(
      nameHashes: readonly string[],
      options: ContextGraphAuthorityReadOptions = {},
    ): Promise<ReadonlyMap<string, ContextGraphAuthoritySnapshot>> {
      return resolveFinalizedSnapshotsByNameHashes(nameHashes, options);
    },
    async peekFinalizedContextGraphAuthoritySnapshotsByNameHashes(
      nameHashes: readonly string[],
      options: ContextGraphAuthorityReadOptions = {},
    ): Promise<ReadonlyMap<string, ContextGraphAuthoritySnapshot> | undefined> {
      assertOpen();
      options.signal?.throwIfAborted();
      // No initialize/getAddress: either could resolve a dependency using RPC.
      if (ownScope === undefined) return undefined;
      const contractAddress = dependencies.requireContextGraphStorage().target;
      if (typeof contractAddress !== 'string' || !ethers.isAddress(contractAddress)) return undefined;
      const result = await peekRetainedAuthoritySnapshotsV1({
        index: dependencies.index, deploymentId: dependencies.deploymentId,
        contractAddress, currentSource: dependencies.chainEventLogAuthority,
      }, nameHashes, options);
      assertOpen();
      options.signal?.throwIfAborted();
      if (dependencies.requireContextGraphStorage().target !== contractAddress) return undefined;
      return result;
    },
    async readContextGraphAuthorityIndexRevisions(
      contextGraphIds: readonly ContextGraphAuthorityIndexId[],
      options: ContextGraphAuthorityReadOptions = {},
    ): Promise<ReadonlyMap<ContextGraphAuthorityIndexId, string>> {
      const targets = snapshotAuthorityRevisionTargetsV1(contextGraphIds);
      options.signal?.throwIfAborted();
      if (targets.length === 0) return new Map();
      return readFinalizedProjection(
        'readContextGraphAuthorityIndexRevisions',
        options,
        ({ view }) => {
          const revisions = view.revisions(targets);
          return { complete: revisions.size === targets.length, value: revisions };
        },
      );
    },
    async readContextGraphAuthorityIndexSnapshots(
      contextGraphIds: readonly ContextGraphAuthorityIndexId[],
      options: ContextGraphAuthorityReadOptions = {},
    ): Promise<ReadonlyMap<
      ContextGraphAuthorityIndexId,
      ContextGraphAuthoritySnapshot
    >> {
      const targets = snapshotAuthorityRevisionTargetsV1(contextGraphIds);
      options.signal?.throwIfAborted();
      if (targets.length === 0) return new Map();
      return readFinalizedProjection(
        'readContextGraphAuthorityIndexSnapshots',
        options,
        ({ view, chainId, contractAddress }) => {
          const snapshots = new Map<
            ContextGraphAuthorityIndexId,
            ContextGraphAuthoritySnapshot
          >();
          for (const [target, state] of view.states(targets)) {
            snapshots.set(target, authoritySnapshotV1(state, chainId, contractAddress));
          }
          return { complete: snapshots.size === targets.length, value: snapshots };
        },
      );
    },
  });
}
