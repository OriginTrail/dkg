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
  isContextGraphAuthorityIndexRetryableError,
  type ContextGraphAuthorityIndexScanInput,
} from './context-graph-authority-index.js';
import type { ContextGraphAuthorityIndexState } from
  './context-graph-authority-index-checkpoint.js';
import {
  assertContextGraphAuthorityIndexId,
  type ContextGraphAuthorityIndexId,
} from './context-graph-authority-index-id.js';
import { isRpcEndpointFailoverEligible } from './evm-adapter-rpc.js';
import {
  contextGraphAuthorityEventTopics,
  decodeContextGraphAuthorityIndexLog,
} from './evm-context-graph-authority-source.js';
import { readAdaptiveEvmLogRange } from './evm-log-range.js';
import type { ReadOpts } from './rpc-failover-client.js';
import {
  withRpcRequestContext,
} from './rpc-request-transport.js';

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
  stabilizationOperation: string;
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
      (await withRpcRequestContext(
        { signal: lifecycleSignal },
        () => input.provider.getBlock(blockNumber),
      ))?.hash ?? null
    ),
    readPage: async (fromBlock, toBlock, lifecycleSignal) => {
      const logs = await readAdaptiveEvmLogRange({
        read: (rangeFrom, rangeTo) => withRpcRequestContext(
          { signal: lifecycleSignal },
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
      const stable = input.signal === undefined
        ? await input.provider.getBlock(input.finalized.number)
        : await withRpcRequestContext(
            { signal: input.signal },
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
): ContextGraphAuthorityIndexRevisionReader {
  const lifecycle = new EvmContextGraphAuthorityIndexRevisionReadLifecycleV1();
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
    options.signal?.throwIfAborted();
    await dependencies.initialize();
    options.signal?.throwIfAborted();
    const base = dependencies.requireContextGraphStorage();
    return dependencies.readTipProvider(
      operationLabel,
      (provider) => lifecycle.run(async () => {
        const finalized = await provider.getBlock('finalized');
        if (finalized === null || finalized.hash === null) {
          throw new Error('finalized Context Graph authority block is unavailable');
        }
        const contract = base.connect(provider) as Contract;
        const contractAddress = (await contract.getAddress()).toLowerCase();
        const deploymentBlockNumber = (await dependencies.resolveContractDeployBlock(
          contractAddress,
          operationLabel,
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
            stabilizationOperation: operationLabel,
          },
          (scan) => project(scan, { provider, contractAddress }),
        );
        await indexed.stabilize();
        return indexed.value;
      }),
      {
        signal: options.signal,
        isRetryable: (error: unknown) => (
          !options.signal?.aborted && (
            isContextGraphAuthorityIndexRetryableError(error)
            || isRpcEndpointFailoverEligible(error)
          )
        ),
        policy: 'wideLogScan',
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
        const chainId = (await provider.getNetwork()).chainId.toString(10);
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
    whenIdle(): Promise<void> {
      return lifecycle.whenIdle();
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
          const chainId = (await provider.getNetwork()).chainId.toString(10);
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
