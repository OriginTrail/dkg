// SPDX-License-Identifier: Apache-2.0

/**
 * Shared chain-snapshot and provider-consensus fences for Context Graph
 * name-hash reverse resolution. Both lookup lanes use this module so scope,
 * epoch, high-water, anchor, and exact-slot rules cannot drift apart.
 */

import { Contract, ethers, type JsonRpcProvider } from 'ethers';

import { RPC_READ_STALL_TIMEOUT_MS } from './evm-adapter-constants.js';
import { withTimeout } from './evm-adapter-rpc.js';
import { withRpcRequestAbortSignal } from './rpc-request-transport.js';
import type {
  ContextGraphNameHashSlotIndexAnchor,
  ContextGraphNameHashSlotIndexScope,
} from './context-graph-name-hash-resolver.js';

export interface EvmContextGraphNameHashFenceDependencies {
  readonly initialize: () => Promise<void>;
  readonly requireContextGraphStorage: () => Contract;
  readonly providers: () => readonly JsonRpcProvider[];
  readonly rpcUrls: () => readonly string[];
  readonly ensureConfiguredStaticChainIdValidated: (
    provider: JsonRpcProvider,
  ) => Promise<bigint>;
  readonly rebindContract: (
    contract: Contract,
    provider: JsonRpcProvider,
  ) => Contract;
  readonly readLatestBlock: () => Promise<{
    readonly number: number;
    readonly hash: string | null;
  } | null>;
  readonly readAnchorHash: (blockNumber: number) => Promise<string | null>;
  readonly scanPageSize: () => number;
  readonly resolveContractDeployBlock: (
    address: string,
    operationLabel: string,
    contractLabel: string,
  ) => Promise<{
    readonly fromBlock: number;
    readonly head: number;
    readonly scanProviders: ReadonlyArray<ContextGraphNameHashScanProvider>;
    readonly degradedFromGenesis?: boolean;
  }>;
  readonly queryEventLogsPage: (
    baseContract: Contract,
    filter: unknown,
    lo: number,
    hi: number,
    scanProviders: ReadonlyArray<ContextGraphNameHashScanProvider>,
    connected: Map<JsonRpcProvider, Contract>,
    label: string,
    preferred?: JsonRpcProvider,
  ) => Promise<{
    readonly logs: ReadonlyArray<ethers.EventLog | ethers.Log>;
    readonly provider: JsonRpcProvider;
  }>;
}

export interface ContextGraphNameHashProviderHighWaters {
  readonly latestId: bigint;
  readonly providerHighWaters: ReadonlyMap<JsonRpcProvider, bigint>;
}

export interface ContextGraphNameHashScopeToken {
  readonly epoch: number;
  readonly scope: ContextGraphNameHashSlotIndexScope;
}

export interface ContextGraphNameHashHistoricalHeadAnchor<TProvider> {
  readonly head: number;
  readonly headHash: string;
  readonly scanProviders: readonly TProvider[];
}

export interface ContextGraphNameHashScanProvider {
  readonly provider: JsonRpcProvider;
  readonly backendHead: number;
}

export interface ContextGraphNameHashAnchoredHistoricalScan {
  readonly headAnchor: ContextGraphNameHashHistoricalHeadAnchor<
    ContextGraphNameHashScanProvider
  >;
  readonly readContextGraphCreatedPage: (
    normalizedNameHash: string,
    lo: number,
    hi: number,
    preferred?: JsonRpcProvider,
  ) => Promise<{
    readonly ids: readonly bigint[];
    readonly provider: JsonRpcProvider;
  }>;
}

export interface ContextGraphNameHashHistoricalScan {
  readonly fromBlock: number;
  readonly head: number;
  readonly pageSize: number;
  readonly anchor: () => Promise<ContextGraphNameHashAnchoredHistoricalScan>;
}

/** Domain-shaped chain reader consumed by both reverse-resolution lanes. */
export interface EvmContextGraphNameHashReader {
  initialize(): Promise<void>;
  invalidate(): void;
  captureScope(): Promise<ContextGraphNameHashSlotIndexScope>;
  captureScopeToken(): Promise<ContextGraphNameHashScopeToken>;
  assertScopeCurrent(
    token: ContextGraphNameHashScopeToken,
    lane: 'current-slot resolution' | 'historical scan',
  ): Promise<void>;
  captureAnchor(): Promise<ContextGraphNameHashSlotIndexAnchor>;
  loadAnchorHash(blockNumber: number): Promise<string | null>;
  loadProviderHighWaters(): Promise<ContextGraphNameHashProviderHighWaters>;
  readCurrentNameHash(
    contextGraphId: bigint,
    signal?: AbortSignal,
    providerHighWaters?: ReadonlyMap<JsonRpcProvider, bigint>,
  ): Promise<string | null>;
  prepareHistoricalScan(): Promise<ContextGraphNameHashHistoricalScan>;
  loadHistoricalRegistryHighWaterAtHead(
    providers: readonly JsonRpcProvider[],
    head: number,
  ): Promise<bigint>;
  assertHistoricalHeadCurrent(
    anchor: Pick<ContextGraphNameHashHistoricalHeadAnchor<unknown>, 'head' | 'headHash'>,
    usedProviders: ReadonlySet<JsonRpcProvider>,
  ): Promise<void>;
}

function sameScope(
  a: ContextGraphNameHashSlotIndexScope,
  b: ContextGraphNameHashSlotIndexScope,
): boolean {
  return a.storageAddress === b.storageAddress
    && a.providers.length === b.providers.length
    && a.providers.every((provider, index) => provider === b.providers[index])
    && a.rpcUrls.length === b.rpcUrls.length
    && a.rpcUrls.every((url, index) => url === b.rpcUrls[index]);
}

function waitForContextGraphSlotRead<T>(
  work: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (!signal) return work;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(
      signal.reason instanceof Error
        ? signal.reason
        : Object.assign(new Error('Context Graph slot read aborted'), { name: 'AbortError' }),
    );
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

export class EvmContextGraphNameHashFence implements EvmContextGraphNameHashReader {
  private bindingEpoch = 0;

  constructor(
    private readonly dependencies: EvmContextGraphNameHashFenceDependencies,
  ) {}

  initialize(): Promise<void> {
    return this.dependencies.initialize();
  }

  invalidate(): void {
    this.bindingEpoch += 1;
  }

  async captureScope(): Promise<ContextGraphNameHashSlotIndexScope> {
    const cgs = this.dependencies.requireContextGraphStorage();
    return {
      storageAddress: (await cgs.getAddress()).toLowerCase(),
      providers: [...this.dependencies.providers()],
      rpcUrls: [...this.dependencies.rpcUrls()],
    };
  }

  async captureScopeToken(): Promise<ContextGraphNameHashScopeToken> {
    return {
      epoch: this.bindingEpoch,
      scope: await this.captureScope(),
    };
  }

  async assertScopeCurrent(
    token: ContextGraphNameHashScopeToken,
    lane: 'current-slot resolution' | 'historical scan',
  ): Promise<void> {
    const scopeAfter = await this.captureScope();
    if (this.bindingEpoch !== token.epoch || !sameScope(token.scope, scopeAfter)) {
      throw new Error(
        'resolveContextGraphIdByNameHash: chain provider or ContextGraphStorage ' +
        `binding changed during ${lane}`,
      );
    }
  }

  async captureAnchor(): Promise<ContextGraphNameHashSlotIndexAnchor> {
    const block = await this.dependencies.readLatestBlock();
    if (block === null || block.hash === null) {
      throw new Error(
        'resolveContextGraphIdByNameHash: latest canonical block has no hash',
      );
    }
    return {
      blockNumber: block.number,
      blockHash: block.hash.toLowerCase(),
    };
  }

  loadAnchorHash(blockNumber: number): Promise<string | null> {
    return this.dependencies.readAnchorHash(blockNumber);
  }

  /** Read all reachable providers and retain the largest observed counter. */
  async loadProviderHighWaters(): Promise<ContextGraphNameHashProviderHighWaters> {
    await this.dependencies.initialize();
    const cgs = this.dependencies.requireContextGraphStorage();
    const providers = [...this.dependencies.providers()];
    const reads = await Promise.allSettled(providers.map((provider) =>
      this.loadProviderHighWater(cgs, provider, 'current')));
    const providerHighWaters = new Map(reads.flatMap((result, index) =>
      result.status === 'fulfilled'
        ? [[providers[index]!, result.value] as const]
        : []));
    const failures = reads.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (providerHighWaters.size === 0) {
      throw failures[0]?.reason ?? new Error(
        'resolveContextGraphIdByNameHash: no RPC backend returned a current registry high-water',
      );
    }
    const latestId = [...providerHighWaters.values()].reduce(
      (maximum, value) => value > maximum ? value : maximum,
      0n,
    );
    return { latestId, providerHighWaters };
  }

  /** Require every provider at or above the slot to agree, including null. */
  async readCurrentNameHash(
    contextGraphId: bigint,
    signal?: AbortSignal,
    providerHighWaters?: ReadonlyMap<JsonRpcProvider, bigint>,
  ): Promise<string | null> {
    await this.dependencies.initialize();
    const cgs = this.dependencies.requireContextGraphStorage();
    const highWaters = providerHighWaters
      ?? (await this.loadProviderHighWaters()).providerHighWaters;
    const coveringProviders = [...highWaters].filter(
      ([, highWater]) => highWater >= contextGraphId,
    );
    signal?.throwIfAborted();
    const reads = await Promise.allSettled(coveringProviders.map(([provider]) =>
      this.loadProviderNameHash(cgs, provider, contextGraphId, signal)));
    if (signal?.aborted) signal.throwIfAborted();

    const observed = new Set(reads.flatMap((result) =>
      result.status === 'fulfilled' ? [result.value] : []));
    const failures = reads.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (failures.length > 0) {
      throw new Error(
        `resolveContextGraphIdByNameHash: ${failures.length} of ` +
        `${coveringProviders.length} covering RPC backends failed to read current slot ` +
        `${contextGraphId.toString()}`,
        { cause: failures[0]!.reason },
      );
    }
    if (observed.size === 0) {
      throw new Error(
        `resolveContextGraphIdByNameHash: no RPC backend could read slot ` +
        contextGraphId.toString(),
      );
    }
    if (observed.size !== 1) {
      throw new Error(
        `resolveContextGraphIdByNameHash: RPC backends disagree on current slot ` +
        contextGraphId.toString(),
      );
    }
    return observed.values().next().value ?? null;
  }

  /** Build one exact-topic historical scan session behind a domain boundary. */
  async prepareHistoricalScan(): Promise<ContextGraphNameHashHistoricalScan> {
    await this.dependencies.initialize();
    const contextGraphStorage = this.dependencies.requireContextGraphStorage();
    const storageAddress = (await contextGraphStorage.getAddress()).toLowerCase();
    const {
      fromBlock,
      head,
      scanProviders: reachableProviders,
    } = await this.dependencies.resolveContractDeployBlock(
      storageAddress,
      'resolveContextGraphIdByNameHash',
      'ContextGraphStorage',
    );
    return {
      fromBlock,
      head,
      pageSize: this.dependencies.scanPageSize(),
      anchor: async () => {
        const headAnchor = await this.captureHistoricalHead(reachableProviders, head);
        const connected = new Map<JsonRpcProvider, Contract>();
        return {
          headAnchor,
          readContextGraphCreatedPage: async (
            normalizedNameHash,
            lo,
            hi,
            preferred,
          ) => {
            const filter = contextGraphStorage.filters.ContextGraphCreated(
              null,
              null,
              normalizedNameHash,
            );
            const page = await this.dependencies.queryEventLogsPage(
              contextGraphStorage,
              filter,
              lo,
              hi,
              headAnchor.scanProviders,
              connected,
              'resolveContextGraphIdByNameHash ContextGraphCreated',
              preferred,
            );
            const ids: bigint[] = [];
            for (const log of page.logs) {
              const parsed = contextGraphStorage.interface.parseLog({
                topics: [...log.topics],
                data: log.data,
              });
              if (parsed?.name === 'ContextGraphCreated') {
                ids.push(BigInt(parsed.args.contextGraphId));
              }
            }
            return { ids, provider: page.provider };
          },
        };
      },
    };
  }

  /** Pin the registry counter to the same canonical block as a log scan. */
  async loadHistoricalRegistryHighWaterAtHead(
    providers: readonly JsonRpcProvider[],
    head: number,
  ): Promise<bigint> {
    const cgs = this.dependencies.requireContextGraphStorage();
    const reads = await Promise.allSettled(providers.map((provider) =>
      this.loadProviderHighWater(cgs, provider, 'historical', head)));
    const observedHighWaters = new Set(reads.flatMap((result) =>
      result.status === 'fulfilled' ? [result.value] : []));
    const failures = reads.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (failures.length > 0) {
      throw new Error(
        `resolveContextGraphIdByNameHash: ${failures.length} of ` +
        `${providers.length} RPC backends failed to read registry high-water ` +
        `at historical head ${head}`,
        { cause: failures[0]!.reason },
      );
    }
    if (observedHighWaters.size === 0) {
      throw new Error(
        `resolveContextGraphIdByNameHash: no RPC backend could read registry ` +
        `high-water at historical head ${head}`,
      );
    }
    if (observedHighWaters.size !== 1) {
      throw new Error(
        `resolveContextGraphIdByNameHash: RPC backends disagree on registry ` +
        `high-water at historical head ${head}`,
      );
    }
    return observedHighWaters.values().next().value as bigint;
  }

  async captureHistoricalHead<T extends {
    readonly provider: JsonRpcProvider;
    readonly backendHead: number;
  }>(
    reachableProviders: readonly T[],
    head: number,
  ): Promise<ContextGraphNameHashHistoricalHeadAnchor<T>> {
    const headProviders = reachableProviders.filter(({ backendHead }) => backendHead >= head);
    let headHash: string | null = null;
    const observedHeadHashes = new Set<string>();
    const scanProviders: T[] = [];
    for (const candidate of headProviders) {
      try {
        const block = await withTimeout(
          candidate.provider.getBlock(head),
          RPC_READ_STALL_TIMEOUT_MS,
          'resolveContextGraphIdByNameHash historical head anchor',
        );
        const candidateHash = block?.hash?.toLowerCase() ?? null;
        if (candidateHash === null) continue;
        observedHeadHashes.add(candidateHash);
        if (headHash === null) headHash = candidateHash;
        if (candidateHash === headHash) scanProviders.push(candidate);
      } catch {
        // Keep collecting same-head providers; fail only when none can anchor.
      }
    }
    if (headHash === null || scanProviders.length === 0) {
      throw new Error(
        'resolveContextGraphIdByNameHash: no RPC backend could anchor the historical scan head',
      );
    }
    if (observedHeadHashes.size !== 1) {
      throw new Error(
        `resolveContextGraphIdByNameHash: RPC backends disagree on canonical ` +
        `block hash at historical head ${head}`,
      );
    }
    return { head, headHash, scanProviders };
  }

  async assertHistoricalHeadCurrent(
    anchor: Pick<ContextGraphNameHashHistoricalHeadAnchor<unknown>, 'head' | 'headHash'>,
    usedProviders: ReadonlySet<JsonRpcProvider>,
  ): Promise<void> {
    for (const provider of usedProviders) {
      const block = await withTimeout(
        provider.getBlock(anchor.head),
        RPC_READ_STALL_TIMEOUT_MS,
        'resolveContextGraphIdByNameHash historical head revalidation',
      );
      if (block?.hash?.toLowerCase() !== anchor.headHash) {
        throw new Error(
          'resolveContextGraphIdByNameHash: canonical chain anchor changed ' +
          'during historical scan',
        );
      }
    }
  }

  private async loadProviderHighWater(
    contextGraphStorage: Contract,
    provider: JsonRpcProvider,
    lane: 'current' | 'historical',
    blockTag?: number,
  ): Promise<bigint> {
    await withTimeout(
      this.dependencies.ensureConfiguredStaticChainIdValidated(provider),
      RPC_READ_STALL_TIMEOUT_MS,
      `resolveContextGraphIdByNameHash ${lane} high-water chainId validation`,
    );
    const connected = this.dependencies.rebindContract(contextGraphStorage, provider);
    const raw = await withTimeout(
      blockTag === undefined
        ? connected.getLatestContextGraphId()
        : connected.getLatestContextGraphId({ blockTag }),
      RPC_READ_STALL_TIMEOUT_MS,
      `resolveContextGraphIdByNameHash ${lane} high-water read`,
    );
    const highWater = BigInt(raw);
    if (highWater < 0n) {
      throw new Error(
        `resolveContextGraphIdByNameHash: getLatestContextGraphId returned ` +
        `invalid negative id ${highWater.toString()}` +
        (blockTag === undefined ? '' : ` at historical head ${blockTag}`),
      );
    }
    return highWater;
  }

  private async loadProviderNameHash(
    contextGraphStorage: Contract,
    provider: JsonRpcProvider,
    contextGraphId: bigint,
    signal?: AbortSignal,
  ): Promise<string | null> {
    signal?.throwIfAborted();
    const startRead = () => Promise.resolve(
      this.dependencies.rebindContract(
        contextGraphStorage,
        provider,
      ).getNameHash(contextGraphId) as Promise<string>,
    );
    const physicalRead = signal
      ? withRpcRequestAbortSignal(signal, startRead)
      : startRead();
    const raw: string = await withTimeout(
      waitForContextGraphSlotRead(physicalRead, signal),
      RPC_READ_STALL_TIMEOUT_MS,
      `resolveContextGraphIdByNameHash current-slot getNameHash(${contextGraphId.toString()})`,
    );
    return !raw || raw === ethers.ZeroHash ? null : raw.toLowerCase();
  }
}
