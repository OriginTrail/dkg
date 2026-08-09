// SPDX-License-Identifier: Apache-2.0

/**
 * EVM-specific reverse resolution for Context Graph name-hash commitments.
 *
 * This class owns the complete reverse-lookup lifecycle: deployment-scoped
 * single-flight/negative caching, the bounded current-slot index, provider
 * high-water consensus, canonical-anchor fencing, and the bounded exact-topic
 * historical fallback. The adapter supplies only low-level EVM primitives;
 * orchestration stays inside this object so there is one owner for its cache,
 * fences, provider-consensus rules, and historical fallback.
 */

import { Contract, ethers, type JsonRpcProvider } from 'ethers';
import {
  CG_REGISTRY_MAX_SCAN_PAGES,
  RPC_READ_STALL_TIMEOUT_MS,
} from './evm-adapter-constants.js';
import { withTimeout } from './evm-adapter-rpc.js';
import { withRpcRequestAbortSignal } from './rpc-request-transport.js';
import {
  CONTEXT_GRAPH_NAME_HASH_ENUMERATION_CONCURRENCY,
  ContextGraphNameHashResolver,
  ContextGraphNameHashSlotIndex,
  type ContextGraphNameHashSlot,
  type ContextGraphNameHashSlotIndexAnchor,
  type ContextGraphNameHashSlotIndexScope,
} from './context-graph-name-hash-resolver.js';

export interface ContextGraphNameHashProviderHighWaters {
  readonly latestId: bigint;
  readonly providerHighWaters: ReadonlyMap<JsonRpcProvider, bigint>;
}

interface ContextGraphNameHashScanProvider {
  readonly provider: JsonRpcProvider;
  readonly backendHead: number;
}

export interface EvmContextGraphNameHashResolverDependencies {
  readonly initialize: () => Promise<void>;
  readonly requireContextGraphStorage: () => Contract;
  readonly providers: () => readonly JsonRpcProvider[];
  readonly rpcUrls: () => readonly string[];
  readonly scanPageSize: () => number;
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

export class EvmContextGraphNameHashResolver {
  private readonly resolutionCache: ContextGraphNameHashResolver;

  private readonly slotIndex = new ContextGraphNameHashSlotIndex();

  private bindingEpoch = 0;

  constructor(
    private readonly dependencies: EvmContextGraphNameHashResolverDependencies,
  ) {
    this.resolutionCache = new ContextGraphNameHashResolver({
      load: (nameHash) => this.loadFromChain(nameHash),
    });
  }

  resolve(nameHash: string, signal?: AbortSignal): Promise<bigint | null> {
    return this.resolutionCache.resolve(nameHash, signal);
  }

  invalidateAll(): void {
    this.bindingEpoch += 1;
    this.slotIndex.clear();
    this.resolutionCache.invalidateAll();
  }

  /** One uncached lookup across the current-slot or historical EVM lane. */
  async loadFromChain(normalizedNameHash: string): Promise<bigint | null> {
    await this.dependencies.initialize();
    const bindingEpoch = this.bindingEpoch;
    const scopeBefore = await this.captureScope();
    const assertCurrentLaneBinding = async (): Promise<void> => {
      const scopeAfter = await this.captureScope();
      if (
        this.bindingEpoch !== bindingEpoch
        || !this.sameScope(scopeBefore, scopeAfter)
      ) {
        throw new Error(
          'resolveContextGraphIdByNameHash: chain provider or ContextGraphStorage ' +
          'binding changed during current-slot resolution',
        );
      }
    };
    let providerHighWaters: ReadonlyMap<JsonRpcProvider, bigint> | undefined;
    const result = await this.slotIndex.resolve(
      normalizedNameHash,
      {
        captureScope: () => this.captureScope(),
        captureAnchor: () => this.captureAnchor(),
        loadAnchorHash: (blockNumber) => this.loadAnchorHash(blockNumber),
        loadLatestId: async () => {
          const snapshot = await this.loadProviderHighWaters();
          providerHighWaters = snapshot.providerHighWaters;
          return snapshot.latestId;
        },
        loadRange: (firstId, lastId) => {
          if (providerHighWaters === undefined) {
            throw new Error(
              'resolveContextGraphIdByNameHash: current provider high-water snapshot is missing',
            );
          }
          return this.loadSlots(firstId, lastId, providerHighWaters);
        },
        onCommit: () => this.resolutionCache.invalidateAll(),
      },
    );
    if (result.mode === 'historical') {
      return this.loadHistorical(normalizedNameHash);
    }
    if (result.id !== null) {
      const verification = await this.loadProviderHighWaters();
      if (verification.latestId !== result.highWater) {
        throw new Error(
          `resolveContextGraphIdByNameHash: Context Graph registry advanced from ` +
          `${result.highWater.toString()} to ${verification.latestId.toString()} ` +
          'during current-slot resolution',
        );
      }
      const currentHash = await this.getNameHashRetryingNull(
        result.id,
        undefined,
        verification.providerHighWaters,
      );
      if (currentHash !== normalizedNameHash) {
        throw new Error(
          `resolveContextGraphIdByNameHash: indexed slot ${result.id.toString()} ` +
          `currently commits ${currentHash ?? ethers.ZeroHash}, expected ` +
          normalizedNameHash,
        );
      }
    }
    await assertCurrentLaneBinding();
    return result.id;
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

  async captureScope(): Promise<ContextGraphNameHashSlotIndexScope> {
    const cgs = this.dependencies.requireContextGraphStorage();
    return {
      storageAddress: (await cgs.getAddress()).toLowerCase(),
      providers: [...this.dependencies.providers()],
      rpcUrls: [...this.dependencies.rpcUrls()],
    };
  }

  sameScope(
    a: ContextGraphNameHashSlotIndexScope,
    b: ContextGraphNameHashSlotIndexScope,
  ): boolean {
    return a.storageAddress === b.storageAddress
      && a.providers.length === b.providers.length
      && a.providers.every((provider, index) => provider === b.providers[index])
      && a.rpcUrls.length === b.rpcUrls.length
      && a.rpcUrls.every((url, index) => url === b.rpcUrls[index]);
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

  /** Fixed-concurrency staged range loader for the bounded current lane. */
  async loadSlots(
    firstId: bigint,
    lastId: bigint,
    providerHighWaters: ReadonlyMap<JsonRpcProvider, bigint>,
  ): Promise<readonly ContextGraphNameHashSlot[]> {
    const scanController = new AbortController();
    const slots: ContextGraphNameHashSlot[] = [];
    let nextId = firstId;
    let failed = false;
    let firstFailure: unknown;
    const worker = async (): Promise<void> => {
      while (!failed) {
        const contextGraphId = nextId;
        if (contextGraphId > lastId) return;
        nextId += 1n;
        try {
          const currentHash = await this.getNameHashRetryingNull(
            contextGraphId,
            scanController.signal,
            providerHighWaters,
          );
          slots.push({ id: contextGraphId, nameHash: currentHash });
        } catch (cause) {
          if (!failed) {
            failed = true;
            firstFailure = cause;
            scanController.abort(cause);
          }
          return;
        }
      }
    };

    const workerCount = Math.min(
      CONTEXT_GRAPH_NAME_HASH_ENUMERATION_CONCURRENCY,
      Number(lastId - firstId + 1n),
    );
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    if (failed) throw firstFailure;
    return slots;
  }

  /** Require every provider at or above the slot to agree, including null. */
  async getNameHashRetryingNull(
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

  /** Pin the registry counter to the same canonical block as the log scan. */
  private async loadHistoricalRegistryHighWaterAtHead(
    contextGraphStorage: Contract,
    scanProviders: ReadonlyArray<ContextGraphNameHashScanProvider>,
    head: number,
  ): Promise<bigint> {
    const reads = await Promise.allSettled(scanProviders.map(({ provider }) =>
      this.loadProviderHighWater(contextGraphStorage, provider, 'historical', head)));
    const observedHighWaters = new Set(reads.flatMap((result) =>
      result.status === 'fulfilled' ? [result.value] : []));
    const failures = reads.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (failures.length > 0) {
      throw new Error(
        `resolveContextGraphIdByNameHash: ${failures.length} of ` +
        `${scanProviders.length} RPC backends failed to read registry high-water ` +
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

  /** Bounded deploy-anchored exact-topic fallback for large registries. */
  async loadHistorical(normalizedNameHash: string): Promise<bigint | null> {
    await this.dependencies.initialize();
    const bindingEpoch = this.bindingEpoch;
    const scopeBefore = await this.captureScope();
    const cgs = this.dependencies.requireContextGraphStorage();
    const storageAddress = (await cgs.getAddress()).toLowerCase();
    const { fromBlock, head, scanProviders: reachableProviders } =
      await this.dependencies.resolveContractDeployBlock(
        storageAddress,
        'resolveContextGraphIdByNameHash',
        'ContextGraphStorage',
      );
    const pageSize = this.dependencies.scanPageSize();
    const pages = fromBlock > head
      ? 0
      : Math.ceil((head - fromBlock + 1) / pageSize);
    if (pages > CG_REGISTRY_MAX_SCAN_PAGES) {
      throw new Error(
        `resolveContextGraphIdByNameHash: historical ContextGraphCreated scan ` +
        `would need ${pages} eth_getLogs calls over blocks ` +
        `[${fromBlock}, ${head}] at a ${pageSize}-block window ` +
        `(budget ${CG_REGISTRY_MAX_SCAN_PAGES} pages).`,
      );
    }

    const headProviders = reachableProviders.filter(({ backendHead }) => backendHead >= head);
    let headHash: string | null = null;
    const observedHeadHashes = new Set<string>();
    const scanProviders: ContextGraphNameHashScanProvider[] = [];
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
    const scannedRegistryHighWater = await this.loadHistoricalRegistryHighWaterAtHead(
      cgs,
      scanProviders,
      head,
    );
    const assertHistoricalRegistryCurrent = async (): Promise<void> => {
      const currentBoundary = await this.loadProviderHighWaters();
      if (currentBoundary.latestId !== scannedRegistryHighWater) {
        throw new Error(
          `resolveContextGraphIdByNameHash: registry high-water changed from ` +
          `${scannedRegistryHighWater.toString()} to ` +
          `${currentBoundary.latestId.toString()} during historical scan`,
        );
      }
    };

    const usedProviders = new Set<JsonRpcProvider>([scanProviders[0]!.provider]);
    const assertScanCurrent = async (): Promise<void> => {
      const scopeAfter = await this.captureScope();
      if (
        this.bindingEpoch !== bindingEpoch
        || !this.sameScope(scopeBefore, scopeAfter)
      ) {
        throw new Error(
          'resolveContextGraphIdByNameHash: chain provider or ContextGraphStorage ' +
          'binding changed during historical scan',
        );
      }
      for (const provider of usedProviders) {
        const block = await withTimeout(
          provider.getBlock(head),
          RPC_READ_STALL_TIMEOUT_MS,
          'resolveContextGraphIdByNameHash historical head revalidation',
        );
        if (block?.hash?.toLowerCase() !== headHash) {
          throw new Error(
            'resolveContextGraphIdByNameHash: canonical chain anchor changed ' +
            'during historical scan',
          );
        }
      }
    };

    if (fromBlock > head) {
      await assertScanCurrent();
      await assertHistoricalRegistryCurrent();
      await assertScanCurrent();
      return null;
    }

    const filter = cgs.filters.ContextGraphCreated(null, null, normalizedNameHash);
    const connected = new Map<JsonRpcProvider, Contract>();
    const ids = new Set<bigint>();
    let preferred: JsonRpcProvider | undefined;
    for (let lo = fromBlock; lo <= head; lo += pageSize) {
      const hi = Math.min(lo + pageSize - 1, head);
      const page = await this.dependencies.queryEventLogsPage(
        cgs,
        filter,
        lo,
        hi,
        scanProviders,
        connected,
        'resolveContextGraphIdByNameHash ContextGraphCreated',
        preferred,
      );
      preferred = page.provider;
      usedProviders.add(page.provider);
      for (const log of page.logs) {
        const parsed = cgs.interface.parseLog({ topics: [...log.topics], data: log.data });
        if (parsed?.name !== 'ContextGraphCreated') continue;
        const id = BigInt(parsed.args.contextGraphId);
        if (id <= 0n) {
          throw new Error(
            `resolveContextGraphIdByNameHash: invalid Context Graph id ` +
            `${id.toString()} for ${normalizedNameHash}`,
          );
        }
        ids.add(id);
      }
    }

    await assertScanCurrent();
    if (ids.size === 0) {
      await assertHistoricalRegistryCurrent();
      await assertScanCurrent();
      return null;
    }
    if (ids.size !== 1) {
      throw new Error(
        `resolveContextGraphIdByNameHash: ambiguous ${normalizedNameHash}; ` +
        `ContextGraphCreated committed it to ${ids.size} numeric ids`,
      );
    }

    const id = ids.values().next().value as bigint;
    const currentHash = await this.getNameHashRetryingNull(id);
    if (currentHash !== normalizedNameHash) {
      throw new Error(
        `resolveContextGraphIdByNameHash: slot ${id.toString()} currently commits ` +
        `${currentHash ?? ethers.ZeroHash}, expected ${normalizedNameHash}`,
      );
    }
    await assertScanCurrent();
    await assertHistoricalRegistryCurrent();
    await assertScanCurrent();
    return id;
  }
}
