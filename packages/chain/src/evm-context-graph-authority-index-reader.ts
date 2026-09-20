// SPDX-License-Identifier: Apache-2.0

import { ethers, type Contract, type JsonRpcProvider } from 'ethers';
import type {
  ContextGraphAuthorityReadOptions,
  ContextGraphAuthoritySnapshot,
  ContextGraphAuthorityIndexRevisionReader,
} from './chain-adapter.js';
import {
  ContextGraphAuthorityIndex,
  ContextGraphAuthorityIndexRetryableError,
  isContextGraphAuthorityIndexRetryableError,
  type ContextGraphAuthorityIndexScanInput,
} from './context-graph-authority-index.js';
import type { ContextGraphAuthorityIndexState } from
  './context-graph-authority-index-checkpoint.js';
import {
  contextGraphAuthorityIndexScope,
  type ContextGraphAuthorityIndexCompletedProjection,
  type ContextGraphAuthorityIndexProjection,
} from './context-graph-authority-index-projection.js';
import type {
  ContextGraphAuthorityIndexSnapshots,
} from './context-graph-authority-index-snapshot.js';
import type { ChainEventLogAuthoritySource } from './chain-event-log-binding.js';
import type { ChainIndexAuthorityAnchor } from './chain-index/index.js';
import {
  assertContextGraphAuthorityIndexId,
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
import { RPC_LOG_SCAN_TIMEOUT_MS } from './evm-adapter-constants.js';
import { resolveEvmFinalityAnchorWithHeadV1 } from './evm-finality-anchor.js';
import type { ReadOpts } from './rpc-failover-client.js';
import {
  withOwnedRpcRequestContext,
  withRpcRequestContext,
  withRpcRequestTimeout,
} from './rpc-request-transport.js';

/**
 * Keep authority-index eth_getLogs requests inside the strictest production
 * provider limit currently supported. The configured registry page size can
 * still be smaller, while stricter providers remain covered by the adaptive
 * range reader below.
 */
const CONTEXT_GRAPH_AUTHORITY_INDEX_MAX_LOG_RANGE_BLOCKS_V1 = 10_000;

/** Bound one physical authority-index RPC without capping the durable scan. */
export function readEvmContextGraphAuthorityIndexRpcV1<T>(
  operation: string,
  read: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const bounded = () => withRpcRequestTimeout(
    RPC_LOG_SCAN_TIMEOUT_MS,
    operation,
    read,
  );
  return signal === undefined
    ? bounded()
    : withRpcRequestContext({ signal }, bounded);
}

/**
 * The single fail-closed error both authority-anchor resolvers raise.
 *
 * The message is preserved verbatim as a prefix: it is the contract callers
 * (and operators reading logs) already recognize. The detail only says which
 * step of the anchor resolution failed.
 *
 * RETRYABLE by type, not by message. Every condition it reports — a head an
 * endpoint could not answer, an anchor below the configured depth, a block that
 * came back at the wrong height — is one that a different endpoint or a later
 * attempt can satisfy, so it must fail over rather than abort the authority
 * read that gates catalog admission. Typing it also keeps it away from
 * `classifyRpcRetryDisposition`'s message regex, which alternates bare
 * `429|503|502|500` with no word boundaries: the details here interpolate block
 * numbers, so a head of 31500123 would classify as `failover` and 31499123 as
 * `fail` purely on its digits.
 */
export function contextGraphAuthorityAnchorUnavailableV1(
  detail: string,
): ContextGraphAuthorityIndexRetryableError {
  return new ContextGraphAuthorityIndexRetryableError(
    `finalized Context Graph authority block is unavailable: ${detail}`,
  );
}

/**
 * Shared page/hash work belongs to the authority-index lifecycle, not to the
 * first caller whose AsyncLocalStorage context starts the single flight.
 */
function readOwnedAuthorityIndexRpcV1<T>(
  lifecycleSignal: AbortSignal,
  operation: string,
  read: () => Promise<T>,
): Promise<T> {
  return withOwnedRpcRequestContext(
    { signal: lifecycleSignal },
    () => readEvmContextGraphAuthorityIndexRpcV1(operation, read),
  );
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
      (await readOwnedAuthorityIndexRpcV1(
        lifecycleSignal,
        `${input.stabilizationOperation} block ${blockNumber}`,
        () => input.provider.getBlock(blockNumber),
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
      const stable = await readEvmContextGraphAuthorityIndexRpcV1(
        `${input.stabilizationOperation} stabilization block`,
        () => input.provider.getBlock(input.finalized.number),
        input.signal,
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
  readonly resolveContractDeployBlock: (
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

function snapshotAuthorityRevisionTargetsV1(
  contextGraphIds: unknown,
): readonly ContextGraphAuthorityIndexId[] {
  if (!Array.isArray(contextGraphIds)) {
    throw new Error('Context Graph authority revision target set is invalid');
  }
  const targets = new Set<ContextGraphAuthorityIndexId>();
  for (const contextGraphId of contextGraphIds as readonly unknown[]) {
    assertContextGraphAuthorityIndexId(
      contextGraphId,
      'Context Graph authority revision target id',
    );
    targets.add(contextGraphId);
  }
  return Object.freeze([...targets]);
}

function snapshotAuthorityNameHashTargetsV1(
  nameHashes: unknown,
): readonly string[] {
  if (!Array.isArray(nameHashes)) {
    throw new Error('Context Graph authority name-hash target set is invalid');
  }
  const targets = new Set<string>();
  for (const nameHash of nameHashes as readonly unknown[]) {
    if (typeof nameHash !== 'string' || !ethers.isHexString(nameHash, 32)) {
      throw new TypeError('Context Graph authority name-hash target must be bytes32');
    }
    const normalized = nameHash.toLowerCase();
    if (normalized !== ethers.ZeroHash) targets.add(normalized);
  }
  return Object.freeze([...targets]);
}

function authoritySnapshotV1(
  state: ContextGraphAuthorityIndexState,
  chainId: string,
  contractAddress: string,
): ContextGraphAuthoritySnapshot {
  return Object.freeze({
    chainId,
    governanceContract: contractAddress,
    ...state,
    contextGraphId: state.contextGraphId,
    ownershipEra: state.ownershipEra.toString(10),
    policyVersion: state.policyVersion.toString(10),
    rosterVersion: state.rosterVersion.toString(10),
    sourceBlockNumber: state.sourceBlockNumber.toString(10),
  });
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
  readContextGraphAuthoritySnapshot(
    contextGraphId: bigint,
    options?: ContextGraphAuthorityReadOptions,
  ): Promise<ContextGraphAuthoritySnapshot>;
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
      }>,
    ) => Promise<T>,
    /**
     * Whether an answer folded from the LOG is one this read may be given.
     *
     * The projection cache already refuses to serve a cached view that cannot
     * answer the caller's targets, so that "a graph registered seconds ago must
     * become visible at today's speed, and absence is only ever reported from a
     * projection that was scanned for this read". A log-anchored fold is at
     * most `max(3T, 15s)` behind the chain, which is the same order of
     * staleness — so it inherits the same rule rather than a weaker one: an
     * answer the caller would have rejected from the cache is discarded here
     * too, and the live scan below runs exactly as it did before the log
     * existed. `undefined` means the caller consumes no view (the durable
     * refresh), so there is no absence for it to mistake.
     */
    logAnswerServes?: (value: T) => boolean,
  ): Promise<T> => {
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
      (provider) => withRpcRequestContext({ signal: projectionSignal }, () => lifecycle.run(async () => {
        assertOpen();
        projectionSignal.throwIfAborted();
        const contract = base.connect(provider) as Contract;
        const contractAddress = (await contract.getAddress()).toLowerCase();
        ownScope = contextGraphAuthorityIndexScope(dependencies.deploymentId, contractAddress);
        const deploymentBlockNumber = await dependencies.resolveContractDeployBlock(
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
        const source = dependencies.chainEventLogAuthority?.();
        if (source !== undefined && source.contractAddress === contractAddress) {
          const anchor = (await source.resolveAnchor({
            deploymentBlockNumber,
            finalityConfirmations: dependencies.finalityConfirmations(),
          })).anchor;
          if (anchor !== undefined) {
            const logged = await readEvmContextGraphAuthorityIndexProjectionV1(
              { ...readInput, finalized: anchor.finalized, logSource: { anchor, source } },
              (scan) => project(scan, {
                provider,
                contractAddress,
                finalized: anchor.finalized,
                head: anchor.head,
              }),
            );
            await logged.stabilize();
            if (logAnswerServes === undefined || logAnswerServes(logged.value)) {
              return logged.value;
            }
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
          readHead: () => readEvmContextGraphAuthorityIndexRpcV1(
            `${operationLabel} chain head`,
            () => provider.getBlock('latest'),
            options.signal,
          ),
          readBlockAt: (anchorBlockNumber) => readEvmContextGraphAuthorityIndexRpcV1(
            `${operationLabel} anchor block ${anchorBlockNumber}`,
            () => provider.getBlock(anchorBlockNumber),
            options.signal,
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
          }),
        );
        await indexed.stabilize();
        return indexed.value;
      })),
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
    const projected = await dependencies.index.projection({
      scope,
      signal: options.signal,
      project: read,
      onServed: options.onContextGraphAuthorityProjectionServed,
      refresh: () => rescanFinalizedProjection(
        operationLabel,
        options,
        async (scan, { provider, contractAddress, finalized, head }) => {
          const view = await dependencies.index.view(scan);
          const chainId = (await readEvmContextGraphAuthorityIndexRpcV1(
            `${operationLabel} network`,
            () => provider.getNetwork(),
            options.signal,
          )).chainId.toString(10);
          return Object.freeze({
            scope: scan.scope, chainId, contractAddress, finalized, head, view,
          });
        },
        // The SAME predicate the cache admits a projection by, applied to the
        // log-anchored fold. An absent target therefore still costs a live scan
        // at a live head; what the log retires is the reads whose answer it can
        // actually produce, which is the steady state.
        (completed) => {
          try { return accepts(completed.view); } catch { return false; }
        },
      ),
    });
    options.signal?.throwIfAborted();
    return projected;
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
      ({ view, chainId, contractAddress }) => {
        const snapshots = new Map<string, ContextGraphAuthoritySnapshot>();
        for (const [nameHash, state] of view.statesByNameHashes(nameHashes)) {
          snapshots.set(nameHash, authoritySnapshotV1(state, chainId, contractAddress));
        }
        return { complete: snapshots.size === nameHashes.length, value: snapshots };
      },
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
      refresh(options: ContextGraphAuthorityReadOptions = {}): Promise<void> {
        return rescanFinalizedProjection('refreshContextGraphAuthorityIndex', options,
          (scan) => dependencies.index.refresh(scan));
      },
    } satisfies ContextGraphAuthorityIndexSnapshots),
    async whenIdle(): Promise<void> {
      await Promise.all([
        lifecycle.whenIdle(),
        dependencies.index.whenIdle(),
      ]);
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
