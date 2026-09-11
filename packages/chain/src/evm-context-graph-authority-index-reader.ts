// SPDX-License-Identifier: Apache-2.0

import { type Contract, type JsonRpcProvider } from 'ethers';
import type {
  ChainReadOptions,
  ContextGraphAuthorityIndexRevisionReader,
} from './chain-adapter.js';
import {
  ContextGraphAuthorityIndex,
  isContextGraphAuthorityIndexRetryableError,
  type ContextGraphAuthorityIndexScanInput,
} from './context-graph-authority-index.js';
import type { ContextGraphAuthorityIndexState } from
  './context-graph-authority-index-checkpoint.js';
import {
  assertContextGraphAuthorityIndexId,
  type ContextGraphAuthorityIndexId,
} from './context-graph-authority-index-id.js';
import { isRetryableRpcError } from './evm-adapter-rpc.js';
import {
  contextGraphAuthorityEventTopics,
  normalizeContextGraphAuthorityIndexLog,
} from './evm-context-graph-authority-source.js';
import { readAdaptiveEvmLogRange } from './evm-log-range.js';
import type { ReadOpts } from './rpc-failover-client.js';
import { withRpcRequestAbortSignal } from './rpc-request-transport.js';

export const CONTEXT_GRAPH_AUTHORITY_INDEX_REVISION_MAX_TARGETS = 4_096;

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
  stabilizationOperation: 'resolution' | 'revision scan';
  signal?: AbortSignal;
}>;

function authorityIndexScanInputV1(
  input: EvmContextGraphAuthorityIndexReadInputV1,
): ContextGraphAuthorityIndexScanInput {
  const authorityTopics = contextGraphAuthorityEventTopics(input.contract.interface);
  return {
    scope: [input.deploymentId, input.contractAddress].join(':'),
    readScope: input.provider,
    deploymentBlockNumber: input.deploymentBlockNumber,
    finalized: input.finalized,
    pageSize: input.pageSize,
    signal: input.signal,
    readBlockHash: async (blockNumber, lifecycleSignal) => (
      (await withRpcRequestAbortSignal(
        lifecycleSignal,
        () => input.provider.getBlock(blockNumber),
      ))?.hash ?? null
    ),
    readPage: async (fromBlock, toBlock, lifecycleSignal) => {
      const logs = await readAdaptiveEvmLogRange({
        read: (rangeFrom, rangeTo) => withRpcRequestAbortSignal(
          lifecycleSignal,
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
      return logs.map((log) => normalizeContextGraphAuthorityIndexLog(
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
      const stable = input.signal === undefined
        ? await input.provider.getBlock(input.finalized.number)
        : await withRpcRequestAbortSignal(
            input.signal,
            () => input.provider.getBlock(input.finalized.number),
          );
      if (stable?.hash?.toLowerCase() !== input.finalized.hash.toLowerCase()) {
        throw new Error(
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
  readonly resolveContractDeployBlock: (
    address: string,
    operationLabel: string,
    contractLabel: string,
  ) => Promise<Readonly<{ fromBlock: number }>>;
  readonly pageSize: () => number;
}

function snapshotAuthorityRevisionTargetsV1(
  contextGraphIds: unknown,
): readonly ContextGraphAuthorityIndexId[] {
  if (
    !Array.isArray(contextGraphIds)
    || contextGraphIds.length > CONTEXT_GRAPH_AUTHORITY_INDEX_REVISION_MAX_TARGETS
  ) {
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
): ContextGraphAuthorityIndexRevisionReader {
  const lifecycle = new EvmContextGraphAuthorityIndexRevisionReadLifecycleV1();
  return Object.freeze({
    whenIdle(): Promise<void> {
      return lifecycle.whenIdle();
    },
    async readContextGraphAuthorityIndexRevisions(
      contextGraphIds: readonly ContextGraphAuthorityIndexId[],
      options: ChainReadOptions = {},
    ): Promise<ReadonlyMap<ContextGraphAuthorityIndexId, string>> {
      const targets = snapshotAuthorityRevisionTargetsV1(contextGraphIds);
      options.signal?.throwIfAborted();
      if (targets.length === 0) return new Map();
      await dependencies.initialize();
      const base = dependencies.requireContextGraphStorage();
      return dependencies.readTipProvider(
        'readContextGraphAuthorityIndexRevisions',
        (provider) => lifecycle.run(async () => {
          const finalized = await provider.getBlock('finalized');
          if (finalized === null || finalized.hash === null) {
            throw new Error('finalized Context Graph authority block is unavailable');
          }
          const contract = base.connect(provider) as Contract;
          const contractAddress = (await contract.getAddress()).toLowerCase();
          const deploymentBlockNumber = (await dependencies.resolveContractDeployBlock(
            contractAddress,
            'readContextGraphAuthorityIndexRevisions',
            'ContextGraphStorage',
          )).fromBlock;
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
              stabilizationOperation: 'revision scan',
            },
            (scan) => dependencies.index.revisions({
              ...scan,
              contextGraphIds: targets,
            }),
          );
          await indexed.stabilize();
          return indexed.value;
        }),
        {
          signal: options.signal,
          isRetryable: (error: unknown) => (
            !options.signal?.aborted && (
              isContextGraphAuthorityIndexRetryableError(error)
              || isRetryableRpcError(error)
            )
          ),
          policy: 'wideLogScan',
        },
      );
    },
  });
}
