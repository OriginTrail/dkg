// SPDX-License-Identifier: Apache-2.0

/**
 * Shared chain-snapshot and provider-consensus fences for Context Graph
 * name-hash reverse resolution. Both lookup lanes use this module so scope,
 * epoch, high-water, anchor, and exact-slot rules cannot drift apart.
 */

import { Contract, ethers, type JsonRpcProvider } from 'ethers';

import {
  CG_REGISTRY_MAX_SCAN_PAGES,
  RPC_READ_STALL_TIMEOUT_MS,
} from './evm-adapter-constants.js';
import { withTimeout } from './evm-adapter-rpc.js';
import { withRpcRequestAbortSignal } from './rpc-request-transport.js';

/**
 * Maximum current high-water id for the fast getNameHash enumeration. Above
 * this threshold the adapter switches before any per-id read to its bounded,
 * deploy-anchored exact-topic event scan.
 */
export const CONTEXT_GRAPH_NAME_HASH_FAST_ENUMERATION_MAX_IDS = 1_024n;

/** Fixed pressure bound for the current-state getNameHash enumeration. */
export const CONTEXT_GRAPH_NAME_HASH_ENUMERATION_CONCURRENCY = 4;

interface ContextGraphNameHashSlotScope {
  readonly storageAddress: string;
  readonly providers: readonly object[];
  readonly rpcUrls: readonly string[];
}

interface ContextGraphNameHashSlot {
  readonly id: bigint;
  readonly nameHash: string | null;
}

interface ContextGraphNameHashSlotAnchor {
  readonly blockNumber: number;
  readonly blockHash: string;
}

type ContextGraphNameHashCurrentResolution =
  | { readonly mode: 'current'; readonly id: bigint | null; readonly highWater: bigint }
  | { readonly mode: 'historical' };

interface ContextGraphNameHashSlotState {
  readonly scope: ContextGraphNameHashSlotScope;
  readonly highWater: bigint;
  readonly anchor: ContextGraphNameHashSlotAnchor;
  readonly idsByHash: ReadonlyMap<string, readonly bigint[]>;
}

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
  readonly scope: ContextGraphNameHashSlotScope;
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

/** High-level chain source; temporal fencing remains an implementation detail. */
export interface EvmContextGraphNameHashSource {
  /** Monotonic generation of committed current-slot snapshots. */
  readonly currentSlotRevision: number;
  resolve(normalizedNameHash: string): Promise<bigint | null>;
  invalidate(): void;
}

function sameScope(
  a: ContextGraphNameHashSlotScope,
  b: ContextGraphNameHashSlotScope,
): boolean {
  return a.storageAddress === b.storageAddress
    && a.providers.length === b.providers.length
    && a.providers.every((provider, index) => provider === b.providers[index])
    && a.rpcUrls.length === b.rpcUrls.length
    && a.rpcUrls.every((url, index) => url === b.rpcUrls[index]);
}

function copyScope(
  scope: ContextGraphNameHashSlotScope,
): ContextGraphNameHashSlotScope {
  return {
    storageAddress: scope.storageAddress,
    providers: [...scope.providers],
    rpcUrls: [...scope.rpcUrls],
  };
}

function cloneIdsByHash(
  source: ReadonlyMap<string, readonly bigint[]> | undefined,
): Map<string, bigint[]> {
  return new Map(
    [...(source ?? [])].map(([nameHash, ids]) => [nameHash, [...ids]]),
  );
}

function appendSlots(
  idsByHash: Map<string, bigint[]>,
  slots: readonly ContextGraphNameHashSlot[],
  firstId: bigint,
  lastId: bigint,
): void {
  const expectedCount = lastId < firstId ? 0 : Number(lastId - firstId + 1n);
  if (slots.length !== expectedCount) {
    throw new Error(
      `resolveContextGraphIdByNameHash: current-slot refresh returned ` +
      `${slots.length} rows for ${expectedCount} ids`,
    );
  }
  const seen = new Set<bigint>();
  for (const slot of slots) {
    if (slot.id < firstId || slot.id > lastId || seen.has(slot.id)) {
      throw new Error(
        `resolveContextGraphIdByNameHash: invalid current-slot refresh id ` +
        `${slot.id.toString()} for range [${firstId.toString()}, ${lastId.toString()}]`,
      );
    }
    seen.add(slot.id);
    if (slot.nameHash === null || slot.nameHash === ethers.ZeroHash) continue;
    const normalized = slot.nameHash.toLowerCase();
    const ids = idsByHash.get(normalized) ?? [];
    ids.push(slot.id);
    idsByHash.set(normalized, ids);
  }
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

export class EvmContextGraphNameHashFence implements EvmContextGraphNameHashSource {
  private bindingEpoch = 0;

  private currentSlotState: ContextGraphNameHashSlotState | undefined;

  private currentSlotTail: Promise<void> = Promise.resolve();

  private currentSlotGeneration = 0;

  get currentSlotRevision(): number {
    return this.currentSlotGeneration;
  }

  constructor(
    private readonly dependencies: EvmContextGraphNameHashFenceDependencies,
  ) {}

  private initialize(): Promise<void> {
    return this.dependencies.initialize();
  }

  invalidate(): void {
    this.bindingEpoch += 1;
    this.currentSlotState = undefined;
  }

  /**
   * Resolve through one cohesive chain-read boundary. The current and
   * historical lanes are private implementation details so callers cannot
   * accidentally omit or reorder a scope, high-water, or canonical-head
   * fence.
   */
  async resolve(normalizedNameHash: string): Promise<bigint | null> {
    await this.initialize();
    const requestScope = await this.captureScopeToken();
    const current = await this.enqueueCurrentSlotResolution(
      normalizedNameHash,
      requestScope,
    );
    return current.mode === 'historical'
      ? this.resolveHistorical(normalizedNameHash)
      : current.id;
  }

  /** Serialize complete current-slot resolutions onto the one adapter-owned index. */
  private enqueueCurrentSlotResolution(
    normalizedNameHash: string,
    requestScope: ContextGraphNameHashScopeToken,
  ): Promise<ContextGraphNameHashCurrentResolution> {
    const run = this.currentSlotTail.then(
      () => this.resolveCurrentSlots(normalizedNameHash, requestScope),
      () => this.resolveCurrentSlots(normalizedNameHash, requestScope),
    );
    this.currentSlotTail = run.then(() => undefined, () => undefined);
    return run;
  }

  /**
   * Own the complete bounded current-slot refresh, commit, and verification
   * sequence without delegating chain reads back through a generic callback
   * layer.
   */
  private async resolveCurrentSlots(
    normalizedNameHash: string,
    requestScope: ContextGraphNameHashScopeToken,
  ): Promise<ContextGraphNameHashCurrentResolution> {
    const highWaterSnapshot = await this.loadProviderHighWaters();
    const { latestId } = highWaterSnapshot;
    if (latestId < 0n) {
      throw new Error(
        `resolveContextGraphIdByNameHash: getLatestContextGraphId returned ` +
        `invalid negative id ${latestId.toString()}`,
      );
    }
    if (latestId > CONTEXT_GRAPH_NAME_HASH_FAST_ENUMERATION_MAX_IDS) {
      return { mode: 'historical' };
    }

    const previous = this.currentSlotState;
    let rebuild = previous === undefined
      || !sameScope(previous.scope, requestScope.scope)
      || latestId < previous.highWater;
    if (!rebuild && previous !== undefined) {
      const currentAnchorHash = await this.loadAnchorHash(previous.anchor.blockNumber);
      rebuild = currentAnchorHash?.toLowerCase() !== previous.anchor.blockHash;
    }

    const firstId = rebuild ? 1n : (previous?.highWater ?? 0n) + 1n;
    const nextAnchor = rebuild || firstId <= latestId
      ? await this.captureAnchor()
      : previous?.anchor;
    const staged = firstId <= latestId
      ? await this.loadSlots(firstId, latestId, highWaterSnapshot)
      : [];

    if (nextAnchor === undefined) {
      throw new Error(
        'resolveContextGraphIdByNameHash: current-slot refresh has no chain anchor',
      );
    }
    if (rebuild || staged.length > 0) {
      const currentAnchorHash = await this.loadAnchorHash(nextAnchor.blockNumber);
      if (currentAnchorHash?.toLowerCase() !== nextAnchor.blockHash) {
        throw new Error(
          'resolveContextGraphIdByNameHash: canonical chain anchor changed ' +
          'during current-slot refresh',
        );
      }
    }

    await this.assertScopeCurrent(requestScope, 'current-slot refresh');

    let state = previous;
    if (rebuild || staged.length > 0) {
      const idsByHash = rebuild
        ? new Map<string, bigint[]>()
        : cloneIdsByHash(previous?.idsByHash);
      appendSlots(idsByHash, staged, firstId, latestId);
      state = {
        scope: copyScope(requestScope.scope),
        highWater: latestId,
        anchor: nextAnchor,
        idsByHash,
      };
      this.currentSlotState = state;
      this.currentSlotGeneration += 1;
    }

    const ids = state?.idsByHash.get(normalizedNameHash) ?? [];
    if (ids.length !== 0 && ids.length !== 1) {
      throw new Error(
        `resolveContextGraphIdByNameHash: ambiguous ${normalizedNameHash}; ` +
        `getNameHash commits it to ${ids.length} numeric ids`,
      );
    }
    const id = ids[0] ?? null;

    const verification = await this.loadProviderHighWaters();
    if (verification.latestId !== latestId) {
      throw new Error(
        `resolveContextGraphIdByNameHash: Context Graph registry advanced from ` +
        `${latestId.toString()} to ${verification.latestId.toString()} ` +
        'during current-slot resolution',
      );
    }
    if (id !== null) {
      const currentHash = await this.readCurrentNameHash(
        id,
        undefined,
        verification.providerHighWaters,
      );
      if (currentHash !== normalizedNameHash) {
        throw new Error(
          `resolveContextGraphIdByNameHash: indexed slot ${id.toString()} ` +
          `currently commits ${currentHash ?? ethers.ZeroHash}, expected ` +
          normalizedNameHash,
        );
      }
    }

    await this.assertScopeCurrent(requestScope, 'current-slot resolution');
    return { mode: 'current', id, highWater: latestId };
  }

  /** Fixed-concurrency staged range loader for the bounded current lane. */
  private async loadSlots(
    firstId: bigint,
    lastId: bigint,
    highWaterSnapshot: ContextGraphNameHashProviderHighWaters,
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
          const currentHash = await this.readCurrentNameHash(
            contextGraphId,
            scanController.signal,
            highWaterSnapshot.providerHighWaters,
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

  async captureScope(): Promise<ContextGraphNameHashSlotScope> {
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
    lane: 'current-slot refresh' | 'current-slot resolution' | 'historical scan',
  ): Promise<void> {
    const scopeAfter = await this.captureScope();
    if (this.bindingEpoch !== token.epoch || !sameScope(token.scope, scopeAfter)) {
      throw new Error(
        'resolveContextGraphIdByNameHash: chain provider or ContextGraphStorage ' +
        `binding changed during ${lane}`,
      );
    }
  }

  async captureAnchor(): Promise<ContextGraphNameHashSlotAnchor> {
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

  /** Entire historical fence choreography, kept behind the chain source. */
  private async resolveHistorical(normalizedNameHash: string): Promise<bigint | null> {
    const scopeToken = await this.captureScopeToken();
    const scan = await this.prepareHistoricalScan();
    const { fromBlock, head, pageSize } = scan;
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

    const anchoredScan = await scan.anchor();
    const { headAnchor } = anchoredScan;
    const scannedRegistryHighWater = await this.loadHistoricalRegistryHighWaterAtHead(
      headAnchor.scanProviders.map(({ provider }) => provider),
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

    const usedProviders = new Set<JsonRpcProvider>([
      headAnchor.scanProviders[0]!.provider,
    ]);
    const assertScanCurrent = async (): Promise<void> => {
      await this.assertScopeCurrent(scopeToken, 'historical scan');
      await this.assertHistoricalHeadCurrent(headAnchor, usedProviders);
    };

    if (fromBlock > head) {
      await assertScanCurrent();
      await assertHistoricalRegistryCurrent();
      await assertScanCurrent();
      return null;
    }

    const ids = new Set<bigint>();
    let preferred: JsonRpcProvider | undefined;
    for (let lo = fromBlock; lo <= head; lo += pageSize) {
      const hi = Math.min(lo + pageSize - 1, head);
      const page = await anchoredScan.readContextGraphCreatedPage(
        normalizedNameHash,
        lo,
        hi,
        preferred,
      );
      preferred = page.provider;
      usedProviders.add(page.provider);
      for (const id of page.ids) {
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
    const currentHash = await this.readCurrentNameHash(id);
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
