// SPDX-License-Identifier: Apache-2.0

import { ethers, type Contract, type JsonRpcProvider } from 'ethers';
import type {
  ChainReadOptions,
  ContextGraphAuthoritySnapshot,
  ContextGraphAuthorityIndexRevisionReader,
} from './chain-adapter.js';
import { CONTEXT_GRAPH_AUTHORITY_INDEX_MAX_TARGETS } from './chain-adapter.js';
import {
  ContextGraphAuthorityIndex,
  ContextGraphAuthorityIndexRetryableError,
  isContextGraphAuthorityIndexRetryableError,
  type ContextGraphAuthorityIndexScanInput,
} from './context-graph-authority-index.js';
import type { ContextGraphAuthorityIndexState } from
  './context-graph-authority-index-checkpoint.js';
import type { ContextGraphAuthorityIndexSnapshots } from './context-graph-authority-index-snapshot.js';
import {
  assertContextGraphAuthorityIndexId,
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
import { resolveEvmFinalityAnchorBlockV1 } from './evm-finality-anchor.js';
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

function authorityIndexScanInputV1(
  input: EvmContextGraphAuthorityIndexReadInputV1,
): ContextGraphAuthorityIndexScanInput {
  const authorityTopics = contextGraphAuthorityEventTopics(input.contract.interface);
  return {
    scope: [input.deploymentId, input.contractAddress].join(':'),
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

/** Resolve one state while keeping the persisted checkpoint private to the index. */
export function readEvmContextGraphAuthorityStateV1(
  input: EvmContextGraphAuthorityIndexReadInputV1 & Readonly<{
    contextGraphId: ContextGraphAuthorityIndexId;
  }>,
): Promise<EvmContextGraphAuthorityIndexReadV1<ContextGraphAuthorityIndexState>> {
  return readEvmContextGraphAuthorityIndexProjectionV1(
    input,
    (scan) => input.index.resolve({ ...scan, contextGraphId: input.contextGraphId }),
  );
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

/**
 * Build the sole adapter capability for complete finalized revision reads.
 * Transport, index advancement, projection, and the final anchor fence remain
 * internal to this collaborator rather than leaking as mixin prototype APIs.
 */
export function createEvmContextGraphAuthorityIndexRevisionReaderV1(
  dependencies: EvmContextGraphAuthorityIndexRevisionReaderDependenciesV1,
): ContextGraphAuthorityIndexRevisionReader & Readonly<{
  snapshots: ContextGraphAuthorityIndexSnapshots;
}> {
  const lifecycle = new EvmContextGraphAuthorityIndexRevisionReadLifecycleV1();
  let lifecycleAbort = new AbortController();
  let ownScope: string | undefined;
  let closed = false;
  const assertOpen = (): void => {
    if (closed) throw new DOMException('Context Graph authority index reader is closed', 'AbortError');
  };
  const runFinalizedProjection = async <T>(
    operationLabel: string,
    options: ChainReadOptions,
    project: (
      scan: ContextGraphAuthorityIndexScanInput,
      context: Readonly<{
        provider: JsonRpcProvider;
        contractAddress: string;
      }>,
    ) => Promise<T>,
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
        // Anchor the whole projection at the operator-configured finality depth,
        // NOT at the endpoint's `finalized` tag. The tag lags head by ~600
        // blocks / ~20 minutes on Base Sepolia, which made a freshly registered
        // Context Graph invisible to the authority index for that entire window
        // — both peers fenced each other's catalog traffic and the replica lost
        // rows while reporting itself complete. Head and anchor come from the
        // same provider, so the pair can never be spliced across endpoints.
        const finalized = await resolveEvmFinalityAnchorBlockV1({
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
        const contract = base.connect(provider) as Contract;
        const contractAddress = (await contract.getAddress()).toLowerCase();
        ownScope = [dependencies.deploymentId, contractAddress].join(':');
        const deploymentBlockNumber = await dependencies.resolveContractDeployBlockNumber(
          contractAddress,
          operationLabel,
          'ContextGraphStorage',
        );
        const indexed = await readEvmContextGraphAuthorityIndexProjectionV1(
          {
            index: dependencies.index,
            deploymentId: dependencies.deploymentId,
            contract,
            contractAddress,
            provider,
            deploymentBlockNumber,
            finalized: { number: finalized.number, hash: finalized.hash },
            pageSize: dependencies.pageSize(),
            finalityConfirmations: dependencies.finalityConfirmations(),
            stabilizationOperation: operationLabel,
          },
          (scan) => project(scan, { provider, contractAddress }),
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

  const resolveFinalizedIdsByNameHashes = async (
    rawNameHashes: readonly string[],
    options: ChainReadOptions,
    operationLabel = 'resolveFinalizedContextGraphIdsByNameHashes',
  ): Promise<ReadonlyMap<string, bigint>> => {
    const nameHashes = snapshotAuthorityNameHashTargetsV1(rawNameHashes);
    options.signal?.throwIfAborted();
    if (nameHashes.length === 0) return new Map();
    return runFinalizedProjection(
      operationLabel,
      options,
      async (scan) => {
        const resolved = new Map<string, bigint>();
        for (
          let offset = 0;
          offset < nameHashes.length;
          offset += CONTEXT_GRAPH_AUTHORITY_INDEX_MAX_TARGETS
        ) {
          options.signal?.throwIfAborted();
          const ownedNameHashes = nameHashes.slice(
            offset,
            offset + CONTEXT_GRAPH_AUTHORITY_INDEX_MAX_TARGETS,
          );
          const states = await dependencies.index.statesByNameHashes({
            ...scan,
            nameHashes: ownedNameHashes,
          });
          options.signal?.throwIfAborted();
          for (const nameHash of ownedNameHashes) {
            const state = states.get(nameHash);
            if (state !== undefined) resolved.set(nameHash, BigInt(state.contextGraphId));
          }
        }
        return resolved;
      },
    );
  };

  const resolveFinalizedSnapshotsByNameHashes = async (
    rawNameHashes: readonly string[],
    options: ChainReadOptions,
    operationLabel = 'resolveFinalizedContextGraphAuthoritySnapshotsByNameHashes',
  ): Promise<ReadonlyMap<string, ContextGraphAuthoritySnapshot>> => {
    const nameHashes = snapshotAuthorityNameHashTargetsV1(rawNameHashes);
    options.signal?.throwIfAborted();
    if (nameHashes.length === 0) return new Map();
    return runFinalizedProjection(
      operationLabel,
      options,
      async (scan, { provider, contractAddress }) => {
        const chainId = (await readEvmContextGraphAuthorityIndexRpcV1(
          `${operationLabel} network`,
          () => provider.getNetwork(),
          options.signal,
        )).chainId.toString(10);
        const snapshots = new Map<string, ContextGraphAuthoritySnapshot>();
        for (
          let offset = 0;
          offset < nameHashes.length;
          offset += CONTEXT_GRAPH_AUTHORITY_INDEX_MAX_TARGETS
        ) {
          options.signal?.throwIfAborted();
          const ownedNameHashes = nameHashes.slice(
            offset,
            offset + CONTEXT_GRAPH_AUTHORITY_INDEX_MAX_TARGETS,
          );
          const states = await dependencies.index.statesByNameHashes({
            ...scan,
            nameHashes: ownedNameHashes,
          });
          options.signal?.throwIfAborted();
          for (const nameHash of ownedNameHashes) {
            const state = states.get(nameHash);
            if (state !== undefined) {
              snapshots.set(
                nameHash,
                authoritySnapshotV1(state, chainId, contractAddress),
              );
            }
          }
        }
        return snapshots;
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
      refresh(options: ChainReadOptions = {}): Promise<void> {
        return runFinalizedProjection('refreshContextGraphAuthorityIndex', options,
          (scan) => dependencies.index.refresh(scan));
      },
    } satisfies ContextGraphAuthorityIndexSnapshots),
    async whenIdle(): Promise<void> {
      await Promise.all([
        lifecycle.whenIdle(),
        dependencies.index.whenIdle(),
      ]);
    },
    async resolveFinalizedContextGraphIdByNameHash(
      nameHash: string,
      options: ChainReadOptions = {},
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
      options: ChainReadOptions = {},
    ): Promise<ReadonlyMap<string, bigint>> {
      return resolveFinalizedIdsByNameHashes(nameHashes, options);
    },
    async resolveFinalizedContextGraphAuthoritySnapshotByNameHash(
      nameHash: string,
      options: ChainReadOptions = {},
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
      options: ChainReadOptions = {},
    ): Promise<ReadonlyMap<string, ContextGraphAuthoritySnapshot>> {
      return resolveFinalizedSnapshotsByNameHashes(nameHashes, options);
    },
    async readContextGraphAuthorityIndexRevisions(
      contextGraphIds: readonly ContextGraphAuthorityIndexId[],
      options: ChainReadOptions = {},
    ): Promise<ReadonlyMap<ContextGraphAuthorityIndexId, string>> {
      const targets = snapshotAuthorityRevisionTargetsV1(contextGraphIds);
      options.signal?.throwIfAborted();
      if (targets.length === 0) return new Map();
      return runFinalizedProjection(
        'readContextGraphAuthorityIndexRevisions',
        options,
        async (scan) => {
          const revisions = new Map<ContextGraphAuthorityIndexId, string>();
          for (
            let offset = 0;
            offset < targets.length;
            offset += CONTEXT_GRAPH_AUTHORITY_INDEX_MAX_TARGETS
          ) {
            options.signal?.throwIfAborted();
            const ownedTargets = targets.slice(
              offset,
              offset + CONTEXT_GRAPH_AUTHORITY_INDEX_MAX_TARGETS,
            );
            const projected = await dependencies.index.revisions({
              ...scan,
              contextGraphIds: ownedTargets,
            });
            options.signal?.throwIfAborted();
            for (const target of ownedTargets) {
              const revision = projected.get(target);
              if (revision !== undefined) revisions.set(target, revision);
            }
          }
          return revisions;
        },
      );
    },
    async readContextGraphAuthorityIndexSnapshots(
      contextGraphIds: readonly ContextGraphAuthorityIndexId[],
      options: ChainReadOptions = {},
    ): Promise<ReadonlyMap<
      ContextGraphAuthorityIndexId,
      ContextGraphAuthoritySnapshot
    >> {
      const targets = snapshotAuthorityRevisionTargetsV1(contextGraphIds);
      options.signal?.throwIfAborted();
      if (targets.length === 0) return new Map();
      return runFinalizedProjection(
        'readContextGraphAuthorityIndexSnapshots',
        options,
        async (scan, { provider, contractAddress }) => {
          const chainId = (await readEvmContextGraphAuthorityIndexRpcV1(
            'readContextGraphAuthorityIndexSnapshots network',
            () => provider.getNetwork(),
            options.signal,
          )).chainId.toString(10);
          const snapshots = new Map<
            ContextGraphAuthorityIndexId,
            ContextGraphAuthoritySnapshot
          >();
          for (
            let offset = 0;
            offset < targets.length;
            offset += CONTEXT_GRAPH_AUTHORITY_INDEX_MAX_TARGETS
          ) {
            options.signal?.throwIfAborted();
            const ownedTargets = targets.slice(
              offset,
              offset + CONTEXT_GRAPH_AUTHORITY_INDEX_MAX_TARGETS,
            );
            const states = await dependencies.index.states({
              ...scan,
              contextGraphIds: ownedTargets,
            });
            options.signal?.throwIfAborted();
            for (const target of ownedTargets) {
              const state = states.get(target);
              if (state !== undefined) {
                snapshots.set(
                  target,
                  authoritySnapshotV1(state, chainId, contractAddress),
                );
              }
            }
          }
          return snapshots;
        },
      );
    },
  });
}
